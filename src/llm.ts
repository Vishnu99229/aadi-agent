import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  MessageCreateParamsNonStreaming,
  MessageParam as AnthropicMessage,
  TextBlockParam,
  ToolResultBlockParam,
  ToolUnion as AnthropicTool,
} from "@anthropic-ai/sdk/resources/messages/messages";
import OpenAI from "openai";
import type {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { getTaskBackend } from "./chat_backend.js";
import { config } from "./config.js";
import { assertLocalModelAllowed } from "./local_llm_guard.js";
import {
  estimateLlmCostUsd,
  isHaiku55Model,
  logTokenUsage,
  type EffortLevel,
  type UsageTask,
} from "./usage.js";

const MAX_TOKENS = 4096;
const MAX_SERVER_CONTINUATIONS = 8;
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
/** Official OpenAI-compatible base (api-docs.deepseek.com). */
const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

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

export type LlmContentPart =
  | { type: "text"; text: string }
  | {
      type: "image";
      mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
      data: string;
    }
  | {
      type: "document";
      mediaType: "application/pdf";
      data: string;
    };

export type LlmMessage =
  | { role: "user"; content: string | LlmContentPart[] }
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

export type LlmBackend =
  | "claude"
  | "haiku"
  | "cloud-gemma"
  | "local-gemma"
  | "deepseek"
  | "deepseek-reasoner";

export interface CompleteParams {
  system: LlmSystemPrompt;
  messages: LlmMessage[];
  tools: LlmTool[];
  /** Override the default chat model (used for background classification). */
  model?: string;
  /**
   * Per-call backend. When omitted, uses the persisted chat-task /model choice.
   */
  backend?: LlmBackend;
  maxTokens?: number;
  timeoutMs?: number;
  /** Logged to usage_log (counts only). */
  task?: UsageTask;
  /** Haiku 5.5 / Sonnet 5.5 output_config.effort. Omitted: Haiku low, Sonnet API default. */
  effort?: EffortLevel;
  /** Prompt-cache TTL. Omitted: 1h for chat-like tasks, 5m for one-burst jobs. */
  cacheTtl?: "5m" | "1h";
  skipUsageLog?: boolean;
  /** Anthropic output_config.format json_schema for structured background calls. */
  jsonSchema?: Record<string, unknown>;
}

export interface CompleteResult {
  textParts: string[];
  toolCalls: ToolCall[];
  usage: LlmUsage;
  stopReason: LlmStopReason;
}

const anthropic = config.anthropicApiKey
  ? new Anthropic({ apiKey: config.anthropicApiKey })
  : undefined;

const openRouter = config.openRouterApiKey
  ? new OpenAI({
      apiKey: config.openRouterApiKey,
      baseURL: OPENROUTER_BASE_URL,
      defaultHeaders: {
        "HTTP-Referer": "http://localhost",
        "X-OpenRouter-Title": "Aadi",
      },
    })
  : undefined;

const deepseek = config.deepseekApiKey
  ? new OpenAI({
      apiKey: config.deepseekApiKey,
      baseURL: DEEPSEEK_BASE_URL,
      timeout: 45_000,
    })
  : undefined;

const localLlm = new OpenAI({
  apiKey: "ollama",
  baseURL: config.localLlmBaseUrl,
  timeout: 15 * 60 * 1000,
});

let loggedOpenRouterWebSearchDisabled = false;

function withEstimatedCost(
  usage: Omit<LlmUsage, "estimatedCostUsd">,
  inputIncludesCacheTokens: boolean,
  model: string,
): LlmUsage {
  return {
    ...usage,
    estimatedCostUsd: estimateLlmCostUsd(
      {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheWriteTokens: usage.cacheCreationInputTokens,
        cacheReadTokens: usage.cacheReadInputTokens,
        inputIncludesCacheTokens,
      },
      model,
    ),
  };
}

function cacheWriteSplit(usage: Anthropic.Messages.Usage): {
  cacheWriteTokens: number;
  cacheWrite1hTokens: number;
} {
  const total = usage.cache_creation_input_tokens ?? 0;
  const details = (
    usage as Anthropic.Messages.Usage & {
      cache_creation?: {
        ephemeral_5m_input_tokens?: number;
        ephemeral_1h_input_tokens?: number;
      };
    }
  ).cache_creation;
  const cacheWrite1hTokens = details?.ephemeral_1h_input_tokens ?? 0;
  return { cacheWriteTokens: total, cacheWrite1hTokens };
}

function recordUsage(
  params: CompleteParams,
  model: string,
  usage: Omit<LlmUsage, "estimatedCostUsd">,
  inputIncludesCacheTokens: boolean,
): LlmUsage {
  const withCost = withEstimatedCost(usage, inputIncludesCacheTokens, model);
  if (!params.skipUsageLog) {
    logTokenUsage(params.task ?? "other", model, {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheWriteTokens: usage.cacheCreationInputTokens,
      cacheReadTokens: usage.cacheReadInputTokens,
      inputIncludesCacheTokens,
    });
  }
  return withCost;
}

type CacheTtl = "5m" | "1h";

function cacheTtlForTask(task?: UsageTask): CacheTtl {
  if (
    task === "brief" ||
    task === "classification" ||
    task === "document" ||
    task === "contract_review" ||
    task === "memory_extraction" ||
    task === "other"
  ) {
    return "5m";
  }
  return "1h";
}

function cacheControl(ttl: CacheTtl): {
  type: "ephemeral";
  ttl?: "1h";
} {
  return ttl === "1h"
    ? { type: "ephemeral", ttl: "1h" }
    : { type: "ephemeral" };
}

function jsonSchemaFormat(
  schema: Record<string, unknown> | undefined,
): { type: "json_schema"; schema: Record<string, unknown> } | undefined {
  if (!schema) {
    return undefined;
  }
  return { type: "json_schema", schema };
}

function buildClaudeMessageCreateParams(
  model: string,
  system: LlmSystemPrompt,
  messages: AnthropicMessage[],
  tools: AnthropicTool[],
  maxTokens: number,
  effort: EffortLevel | undefined,
  cacheTtl: CacheTtl,
  jsonSchema?: Record<string, unknown>,
): MessageCreateParamsNonStreaming {
  const base: MessageCreateParamsNonStreaming = {
    model,
    max_tokens: maxTokens,
    system: toAnthropicSystem(system, cacheTtl),
    messages: withLatestMessageCacheBreakpoint(messages),
    tools: withToolsCacheBreakpoint(tools, cacheTtl),
  };
  const format = jsonSchemaFormat(jsonSchema);
  if (!isHaiku55Model(model) && !effort && !format) {
    return base;
  }
  const haikuEffort = effort ?? "low";
  if (isHaiku55Model(model) && haikuEffort === "low") {
    return {
      ...base,
      thinking: { type: "disabled" },
      output_config: {
        effort: "low",
        ...(format ? { format } : {}),
      },
    };
  }
  return {
    ...base,
    ...(isHaiku55Model(model) ? { thinking: { type: "adaptive" as const } } : {}),
    output_config: {
      ...(effort || isHaiku55Model(model)
        ? { effort: effort ?? haikuEffort }
        : {}),
      ...(format ? { format } : {}),
    },
  };
}

function toAnthropicUserContent(
  content: string | LlmContentPart[],
): string | ContentBlockParam[] {
  if (typeof content === "string") {
    return content;
  }
  return content.map((part): ContentBlockParam => {
    if (part.type === "text") {
      return { type: "text", text: part.text };
    }
    if (part.type === "image") {
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: part.mediaType,
          data: part.data,
        },
      };
    }
    return {
      type: "document",
      source: {
        type: "base64",
        media_type: part.mediaType,
        data: part.data,
      },
    };
  });
}

function toAnthropicMessages(messages: LlmMessage[]): AnthropicMessage[] {
  const converted: AnthropicMessage[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];

    if (message.role === "user") {
      converted.push({
        role: "user",
        content: toAnthropicUserContent(message.content),
      });
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
  return tools.map((tool): AnthropicTool => {
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
}

function withToolsCacheBreakpoint(
  tools: AnthropicTool[],
  ttl: CacheTtl,
): AnthropicTool[] {
  const lastTool = tools.at(-1);
  if (!lastTool) {
    return tools;
  }
  const next = [...tools];
  next[next.length - 1] = {
    ...lastTool,
    cache_control: cacheControl(ttl),
  } as AnthropicTool;
  return next;
}

function toAnthropicSystem(
  system: LlmSystemPrompt,
  ttl: CacheTtl,
): TextBlockParam[] {
  const blocks: TextBlockParam[] = [
    {
      type: "text",
      text: system.cacheable,
      cache_control: cacheControl(ttl),
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
  const cacheTtl = params.cacheTtl ?? cacheTtlForTask(params.task);
  const effort = params.effort ?? (isHaiku55Model(model) ? "low" : undefined);
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
    // uses three: tools and the stable system prompt (1h for chat, 5m for
    // one-burst jobs), plus a 5-minute rolling breakpoint on the latest
    // message for incremental agent turns. Date, memories, and the latest
    // user text sit in system.dynamic / messages after those breakpoints.
    const response = await anthropic.messages.create(
      buildClaudeMessageCreateParams(
        model,
        params.system,
        messages,
        tools,
        params.maxTokens ?? MAX_TOKENS,
        effort,
        cacheTtl,
        params.jsonSchema,
      ),
      params.timeoutMs ? { timeout: params.timeoutMs } : undefined,
    );
    lastResponse = response;

    const cacheWrites = cacheWriteSplit(response.usage);
    usage.inputTokens += response.usage.input_tokens;
    usage.outputTokens += response.usage.output_tokens;
    usage.cacheCreationInputTokens =
      (usage.cacheCreationInputTokens ?? 0) + cacheWrites.cacheWriteTokens;
    usage.cacheReadInputTokens =
      (usage.cacheReadInputTokens ?? 0) +
      (response.usage.cache_read_input_tokens ?? 0);
    if (!params.skipUsageLog) {
      logTokenUsage(params.task ?? "other", model, {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheWriteTokens: cacheWrites.cacheWriteTokens,
        cacheWrite1hTokens: cacheWrites.cacheWrite1hTokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      });
    }

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
        usage: withEstimatedCost(usage, false, model),
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
    usage: withEstimatedCost(usage, false, model),
    stopReason: "pause_turn",
  };
}

function toOpenAiUserContent(
  content: string | LlmContentPart[],
): string | ChatCompletionContentPart[] {
  if (typeof content === "string") {
    return content;
  }
  return content.map((part): ChatCompletionContentPart => {
    if (part.type === "text") {
      return { type: "text", text: part.text };
    }
    if (part.type === "image") {
      return {
        type: "image_url",
        image_url: {
          url: `data:${part.mediaType};base64,${part.data}`,
        },
      };
    }
    throw new Error(
      "PDF document parts are not supported on OpenAI-compatible backends; render pages as images first.",
    );
  });
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
        return { role: "user", content: toOpenAiUserContent(message.content) };
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

async function completeWithOpenAiCompatible(
  client: OpenAI,
  params: CompleteParams,
  model: string,
  label: string,
  options: { thinking?: boolean } = {},
): Promise<CompleteResult> {
  const webSearchRequested = params.tools.some(
    (tool) => tool.type === "web_search",
  );
  if (webSearchRequested && !loggedOpenRouterWebSearchDisabled) {
    console.log(
      `Web search disabled for ${label}: Anthropic server-side web search is unavailable and no paid search API is configured.`,
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
  const response = await client.chat.completions.create(
    {
      model,
      messages: toOpenRouterMessages(system, params.messages),
      ...(tools.length > 0 ? { tools } : {}),
      max_tokens: params.maxTokens ?? MAX_TOKENS,
      ...(options.thinking
        ? {
            reasoning_effort: "high" as const,
            thinking: { type: "enabled" },
          }
        : label.startsWith("deepseek")
          ? { thinking: { type: "disabled" } }
          : {}),
    } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
    params.timeoutMs ? { timeout: params.timeoutMs } : undefined,
  );
  const choice = response.choices[0];

  if (!choice) {
    throw new Error(`${label} returned no completion choices.`);
  }

  const promptDetails = response.usage?.prompt_tokens_details as
    | {
        cached_tokens?: number;
        cache_write_tokens?: number;
      }
    | undefined;

  const usage = recordUsage(
    params,
    model,
    {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      cacheCreationInputTokens: promptDetails?.cache_write_tokens,
      cacheReadInputTokens: promptDetails?.cached_tokens,
    },
    true,
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

async function completeWithNamedBackend(
  backend: LlmBackend,
  params: CompleteParams,
): Promise<CompleteResult> {
  if (backend === "claude" || backend === "haiku") {
    const model =
      params.model ??
      (backend === "haiku" ? config.backgroundModel : config.claudeModel);
    return completeWithClaude({ ...params, model });
  }
  if (backend === "cloud-gemma") {
    if (!openRouter) {
      throw new Error(
        "cloud-gemma requires OPENROUTER_API_KEY. It is unused unless a call sets backend=cloud-gemma.",
      );
    }
    return completeWithOpenAiCompatible(
      openRouter,
      params,
      config.gemmaCloudModel,
      "cloud-gemma",
    );
  }
  if (backend === "deepseek" || backend === "deepseek-reasoner") {
    if (!deepseek) {
      throw new Error(
        "deepseek requires DEEPSEEK_API_KEY in .env (add it locally; Aadi never writes .env).",
      );
    }
    const model =
      params.model ??
      (backend === "deepseek-reasoner"
        ? config.deepseekReasonerModel
        : config.deepseekModel);
    return completeWithOpenAiCompatible(
      deepseek,
      params,
      model,
      backend,
      { thinking: backend === "deepseek-reasoner" },
    );
  }
  await assertLocalModelAllowed();
  return completeWithOpenAiCompatible(
    localLlm,
    params,
    config.localLlmModel,
    "local-gemma",
  );
}

export async function complete(
  params: CompleteParams,
): Promise<CompleteResult> {
  const backend = params.backend ?? getTaskBackend("chat");
  try {
    return await completeWithNamedBackend(backend, params);
  } catch (error) {
    if (backend === "claude") {
      throw error;
    }
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(
      `Backend ${backend} failed (${errorType}); retrying on Claude.`,
    );
    return completeWithNamedBackend("claude", {
      ...params,
      backend: "claude",
      model: config.claudeModel,
      effort: undefined,
    });
  }
}

export async function completeBackground(
  params: Omit<CompleteParams, "model" | "backend">,
): Promise<CompleteResult> {
  if (config.deepseekApiKey) {
    return complete({
      ...params,
      backend: "deepseek",
      model: config.deepseekModel,
      task: params.task ?? "classification",
      effort: params.effort ?? "low",
    });
  }
  return complete({
    ...params,
    backend: "claude",
    model: config.backgroundModel,
    task: params.task ?? "classification",
    effort: params.effort ?? "low",
  });
}
