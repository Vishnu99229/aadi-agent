import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  MessageCreateParamsNonStreaming,
  MessageParam as AnthropicMessage,
  TextBlockParam,
  ToolResultBlockParam,
  ToolUnion as AnthropicTool,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type { ModelCostRates } from "./config.js";
import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { config } from "./config.js";

const MAX_TOKENS = 4096;
const MAX_SERVER_CONTINUATIONS = 8;
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  execution: "client" | "provider";
}

export interface ToolInputSchema extends Record<string, unknown> {
  type: "object";
  properties?: Record<string, unknown> | null;
  required?: string[] | null;
}

export type LlmMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; textParts: string[]; toolCalls: ToolCall[] }
  | {
      role: "tool";
      toolCallId: string;
      content: string;
      isError?: boolean;
    };

export type LlmTool =
  | {
      type: "function";
      name: string;
      description: string;
      inputSchema: ToolInputSchema;
    }
  | {
      type: "web_search";
      maxUses?: number;
    };

export interface LlmSystemPrompt {
  cacheable: string;
  dynamic?: string;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  estimatedCostUsd: number;
}

export type LlmStopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "pause_turn"
  | "refusal"
  | "other";

export interface CompleteParams {
  system: LlmSystemPrompt;
  messages: LlmMessage[];
  tools: LlmTool[];
  /** Override the default chat model (used for background classification). */
  model?: string;
}

export interface CompleteResult {
  textParts: string[];
  toolCalls: ToolCall[];
  usage: LlmUsage;
  stopReason: LlmStopReason;
}

const anthropic =
  config.llmProvider === "claude"
    ? new Anthropic({ apiKey: config.anthropicApiKey })
    : undefined;

const openRouter =
  config.llmProvider === "openrouter"
    ? new OpenAI({
        apiKey: config.openRouterApiKey,
        baseURL: OPENROUTER_BASE_URL,
        defaultHeaders: {
          "HTTP-Referer": "http://localhost",
          "X-OpenRouter-Title": "Aadi",
        },
      })
    : undefined;

let loggedOpenRouterWebSearchDisabled = false;

function costRatesForModel(model: string): ModelCostRates {
  if (model === config.backgroundModel) {
    return config.backgroundCostRates;
  }
  return config.chatCostRates;
}

function withEstimatedCost(
  usage: Omit<LlmUsage, "estimatedCostUsd">,
  inputIncludesCacheTokens: boolean,
  rates: ModelCostRates,
): LlmUsage {
  const cacheCreationTokens = usage.cacheCreationInputTokens ?? 0;
  const cacheReadTokens = usage.cacheReadInputTokens ?? 0;
  const regularInputTokens = inputIncludesCacheTokens
    ? Math.max(
        0,
        usage.inputTokens - cacheCreationTokens - cacheReadTokens,
      )
    : usage.inputTokens;
  const estimatedCostUsd =
    (regularInputTokens * rates.inputCostPerMillion +
      usage.outputTokens * rates.outputCostPerMillion +
      cacheCreationTokens * rates.cacheCreationCostPerMillion +
      cacheReadTokens * rates.cacheReadCostPerMillion) /
    1_000_000;

  return { ...usage, estimatedCostUsd };
}

/** Haiku 5.5 rejects custom temperature/top_p/top_k; use effort + disabled thinking for classification. */
function usesHaiku55RequestShape(model: string): boolean {
  return /haiku-5-5/i.test(model);
}

function buildClaudeMessageCreateParams(
  model: string,
  system: LlmSystemPrompt,
  messages: AnthropicMessage[],
  tools: AnthropicTool[],
): MessageCreateParamsNonStreaming {
  const base: MessageCreateParamsNonStreaming = {
    model,
    max_tokens: MAX_TOKENS,
    system: toAnthropicSystem(system),
    messages: withLatestMessageCacheBreakpoint(messages),
    tools,
  };
  if (!usesHaiku55RequestShape(model)) {
    return base;
  }
  return {
    ...base,
    thinking: { type: "disabled" },
    output_config: { effort: "low" },
  };
}

function toAnthropicMessages(messages: LlmMessage[]): AnthropicMessage[] {
  const converted: AnthropicMessage[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];

    if (message.role === "user") {
      converted.push({ role: "user", content: message.content });
      continue;
    }

    if (message.role === "assistant") {
      const content: ContentBlockParam[] = [
        ...message.textParts.map(
          (text): ContentBlockParam => ({ type: "text", text }),
        ),
        ...message.toolCalls.map(
          (toolCall): ContentBlockParam =>
            toolCall.execution === "provider"
              ? ({
                  type: "server_tool_use",
                  id: toolCall.id,
                  name: toolCall.name,
                  input: toolCall.input,
                } as ContentBlockParam)
              : {
                  type: "tool_use",
                  id: toolCall.id,
                  name: toolCall.name,
                  input: toolCall.input,
                },
        ),
      ];
      converted.push({ role: "assistant", content });
      continue;
    }

    const results: ToolResultBlockParam[] = [];
    let nextIndex = index;

    while (nextIndex < messages.length) {
      const toolMessage = messages[nextIndex];
      if (toolMessage.role !== "tool") {
        break;
      }

      results.push({
        type: "tool_result",
        tool_use_id: toolMessage.toolCallId,
        content: toolMessage.content,
        is_error: toolMessage.isError,
      });
      nextIndex += 1;
    }

    converted.push({ role: "user", content: results });
    index = nextIndex - 1;
  }

  return converted;
}

function withLatestMessageCacheBreakpoint(
  messages: AnthropicMessage[],
): AnthropicMessage[] {
  const converted = messages.map((message): AnthropicMessage => {
    if (typeof message.content === "string") {
      return { ...message };
    }

    return {
      ...message,
      content: message.content.map((block) => {
        const copy = { ...block } as ContentBlockParam & {
          cache_control?: unknown;
        };
        delete copy.cache_control;
        return copy as ContentBlockParam;
      }),
    };
  });
  const latestMessage = converted.at(-1);

  if (!latestMessage) {
    return converted;
  }

  if (typeof latestMessage.content === "string") {
    latestMessage.content = [
      {
        type: "text",
        text: latestMessage.content,
        cache_control: { type: "ephemeral" },
      },
    ];
    return converted;
  }

  const lastBlockIndex = latestMessage.content.length - 1;
  if (lastBlockIndex >= 0) {
    latestMessage.content[lastBlockIndex] = {
      ...latestMessage.content[lastBlockIndex],
      cache_control: { type: "ephemeral" },
    } as ContentBlockParam;
  }

  return converted;
}

function toAnthropicTools(tools: LlmTool[]): AnthropicTool[] {
  const converted = tools.map((tool): AnthropicTool => {
    if (tool.type === "web_search") {
      // web_search_20260318 defaults to code_execution-based programmatic
      // calling. Anthropic does not allow forced tool_choice settings or
      // disable_parallel_tool_use=true while programmatic calling is enabled.
      return {
        type: "web_search_20260318",
        name: "web_search",
        max_uses: tool.maxUses,
      };
    }

    return {
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    };
  });

  const lastTool = converted.at(-1);
  if (lastTool) {
    converted[converted.length - 1] = {
      ...lastTool,
      cache_control: { type: "ephemeral" },
    } as AnthropicTool;
  }

  return converted;
}

function toAnthropicSystem(system: LlmSystemPrompt): TextBlockParam[] {
  const blocks: TextBlockParam[] = [
    {
      type: "text",
      text: system.cacheable,
      cache_control: { type: "ephemeral" },
    },
  ];

  if (system.dynamic) {
    blocks.push({ type: "text", text: system.dynamic });
  }

  return blocks;
}

function anthropicStopReason(
  reason: Anthropic.StopReason | null,
): LlmStopReason {
  switch (reason) {
    case "end_turn":
    case "tool_use":
    case "max_tokens":
    case "pause_turn":
    case "refusal":
      return reason;
    default:
      return "other";
  }
}

async function completeWithClaude(
  params: CompleteParams,
): Promise<CompleteResult> {
  if (!anthropic) {
    throw new Error("Claude client is not configured.");
  }

  const model = params.model ?? config.claudeModel;
  const rates = costRatesForModel(model);
  const messages = toAnthropicMessages(params.messages);
  const tools = toAnthropicTools(params.tools);
  const usage: Omit<LlmUsage, "estimatedCostUsd"> = {
    inputTokens: 0,
    outputTokens: 0,
  };
  let lastResponse: Anthropic.Message | undefined;

  for (
    let continuation = 0;
    continuation < MAX_SERVER_CONTINUATIONS;
    continuation += 1
  ) {
    // Anthropic allows at most four explicit cache breakpoints. This request
    // uses three: the tool definitions, the stable system prompt, and a
    // rolling breakpoint on the latest message for incremental agent turns.
    const response = await anthropic.messages.create(
      buildClaudeMessageCreateParams(
        model,
        params.system,
        messages,
        tools,
      ),
    );
    lastResponse = response;

    usage.inputTokens += response.usage.input_tokens;
    usage.outputTokens += response.usage.output_tokens;
    usage.cacheCreationInputTokens =
      (usage.cacheCreationInputTokens ?? 0) +
      (response.usage.cache_creation_input_tokens ?? 0);
    usage.cacheReadInputTokens =
      (usage.cacheReadInputTokens ?? 0) +
      (response.usage.cache_read_input_tokens ?? 0);

    if (response.stop_reason !== "pause_turn") {
      return {
        textParts: response.content
          .filter(
            (block): block is Anthropic.TextBlock => block.type === "text",
          )
          .map((block) => block.text),
        toolCalls: response.content
          .filter(
            (
              block,
            ): block is Anthropic.ToolUseBlock | Anthropic.ServerToolUseBlock =>
              block.type === "tool_use" || block.type === "server_tool_use",
          )
          .map((block) => ({
            id: block.id,
            name: block.name,
            input: block.input,
            execution:
              block.type === "server_tool_use" ? "provider" : "client",
          })),
        usage: withEstimatedCost(usage, false, rates),
        stopReason: anthropicStopReason(response.stop_reason),
      };
    }

    messages.push({
      role: "assistant",
      content: response.content as ContentBlockParam[],
    });
  }

  return {
    textParts:
      lastResponse?.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text) ?? [],
    toolCalls: [],
    usage: withEstimatedCost(usage, false, rates),
    stopReason: "pause_turn",
  };
}

function toOpenRouterMessages(
  system: LlmSystemPrompt,
  messages: LlmMessage[],
): ChatCompletionMessageParam[] {
  return [
    { role: "system", content: system.cacheable },
    ...(system.dynamic
      ? ([{ role: "system", content: system.dynamic }] satisfies ChatCompletionMessageParam[])
      : []),
    ...messages.map((message): ChatCompletionMessageParam => {
      if (message.role === "user") {
        return { role: "user", content: message.content };
      }

      if (message.role === "tool") {
        return {
          role: "tool",
          tool_call_id: message.toolCallId,
          content: message.isError
            ? `Tool error: ${message.content}`
            : message.content,
        };
      }

      return {
        role: "assistant",
        content:
          message.textParts.length > 0 ? message.textParts.join("\n") : null,
        tool_calls: message.toolCalls.map((toolCall) => ({
          type: "function",
          id: toolCall.id,
          function: {
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.input),
          },
        })),
      };
    }),
  ];
}

function toOpenRouterTools(tools: LlmTool[]): ChatCompletionTool[] {
  return tools
    .filter(
      (
        tool,
      ): tool is Extract<LlmTool, { type: "function" }> =>
        tool.type === "function",
    )
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
}

function parseToolInput(argumentsText: string): unknown {
  try {
    return JSON.parse(argumentsText) as unknown;
  } catch {
    return argumentsText;
  }
}

function openRouterStopReason(reason: string | null): LlmStopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "other";
  }
}

async function completeWithOpenRouter(
  params: CompleteParams,
): Promise<CompleteResult> {
  if (!openRouter) {
    throw new Error("OpenRouter client is not configured.");
  }

  const webSearchRequested = params.tools.some(
    (tool) => tool.type === "web_search",
  );
  if (webSearchRequested && !loggedOpenRouterWebSearchDisabled) {
    console.log(
      "Web search disabled for OpenRouter: Anthropic server-side web search is unavailable and no paid search API is configured.",
    );
    loggedOpenRouterWebSearchDisabled = true;
  }

  const tools = toOpenRouterTools(params.tools);
  const system = webSearchRequested
    ? {
        ...params.system,
        dynamic: `${params.system.dynamic ?? ""}\nWeb search is unavailable for this provider. Be explicit about that limitation and do not present unverified current information as fresh.`,
      }
    : params.system;
  const response = await openRouter.chat.completions.create({
    model: params.model ?? config.openRouterModel,
    messages: toOpenRouterMessages(system, params.messages),
    ...(tools.length > 0 ? { tools } : {}),
    max_tokens: MAX_TOKENS,
  });
  const choice = response.choices[0];

  if (!choice) {
    throw new Error("OpenRouter returned no completion choices.");
  }

  // OpenRouter caching is automatic and model/provider-dependent. These are
  // the cache counters it returns when the selected route supports them.
  const promptDetails = response.usage?.prompt_tokens_details as
    | {
        cached_tokens?: number;
        cache_write_tokens?: number;
      }
    | undefined;

  const model = params.model ?? config.openRouterModel;
  const usage = withEstimatedCost(
    {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      cacheCreationInputTokens: promptDetails?.cache_write_tokens,
      cacheReadInputTokens: promptDetails?.cached_tokens,
    },
    true,
    costRatesForModel(model),
  );

  return {
    textParts: choice.message.content ? [choice.message.content] : [],
    toolCalls:
      choice.message.tool_calls
        ?.filter((toolCall) => toolCall.type === "function")
        .map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.function.name,
          input: parseToolInput(toolCall.function.arguments),
          execution: "client" as const,
        })) ?? [],
    usage,
    stopReason: openRouterStopReason(choice.finish_reason),
  };
}

export async function complete(
  params: CompleteParams,
): Promise<CompleteResult> {
  return config.llmProvider === "claude"
    ? completeWithClaude(params)
    : completeWithOpenRouter(params);
}

export async function completeBackground(
  params: Omit<CompleteParams, "model">,
): Promise<CompleteResult> {
  const model =
    config.llmProvider === "claude"
      ? config.backgroundModel
      : config.openRouterModel;
  return complete({ ...params, model });
}
