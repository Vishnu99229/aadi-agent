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
  flagLlmBackend,
  flagProvider,
  getFallbackChain,
  isBackendUsable,
  isCreditOrAuthError,
  modelUnavailableReason,
  shortBackendReason,
  type LlmBackend,
} from "./llm_fallback.js";
import { buildResponsesRequest, parseResponsesOutput } from "./models/openai_responses.js";
import { modelForLegacyBackend, providerApiKey, type ModelSpec } from "./models/registry.js";
import { assertTestSeam } from "./test_seam.js";
import {
  estimateLlmCostUsd,
  isHaiku55Model,
  logTokenUsage,
  type EffortLevel,
  type UsageTask,
} from "./usage.js";

const MAX_TOKENS = 4096;
const MAX_SERVER_CONTINUATIONS = 8;
/** Official OpenAI-compatible base (api-docs.deepseek.com). Overridable for tests and proxies. */
const DEEPSEEK_BASE_URL = () => process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com";
/** Google Gemini's OpenAI-compatible endpoint. */
const GEMINI_BASE_URL = () =>
  process.env.GEMINI_BASE_URL?.trim() || "https://generativelanguage.googleapis.com/v1beta/openai/";
/** Moonshot's international OpenAI-compatible endpoint (api.moonshot.cn inside China). */
const KIMI_BASE_URL = () => process.env.KIMI_BASE_URL?.trim() || "https://api.moonshot.ai/v1";

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  execution: "client" | "provider";
  /**
   * Gemini's encrypted reasoning state for this function call. Google requires
   * it back, unchanged, on the next request of the same turn
   * (extra_content.google.thought_signature). Opaque: never logged.
   */
  thoughtSignature?: string;
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
  | {
      role: "assistant";
      textParts: string[];
      toolCalls: ToolCall[];
      /**
       * Provider state that must go back to the same provider on the next step
       * of the turn (OpenAI's encrypted reasoning items, Kimi's reasoning text).
       * Other providers ignore it. Opaque: never logged.
       */
      providerItems?: ProviderItems;
    }
  | {
      role: "tool";
      toolCallId: string;
      content: string;
      isError?: boolean;
    };

export interface ProviderItems {
  provider: string;
  items: unknown[];
}

/** An agent's models in the order to try them (agent_models.ts resolves it). */
export interface ModelRoute {
  agentId: string;
  models: ModelSpec[];
}

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

export type { LlmBackend } from "./llm_fallback.js";

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
  /** Only the named backend: fail rather than fall back to another model. */
  noFallback?: boolean;
  /**
   * Structured output. Anthropic uses output_config.format json_schema.
   * DeepSeek only supports response_format json_object (not json_schema);
   * the schema is then placed in the prompt. See api-docs.deepseek.com/guides/json_mode.
   */
  jsonSchema?: Record<string, unknown>;
  /** Make the model call this tool on this step instead of answering in text:
   *  code decides the tool must run, the model only fills in its input. Sent to
   *  OpenAI-compatible backends (DeepSeek, Gemini, local) only: Claude Sonnet 5.5
   *  rejects forced tool use with a 400, so on Claude this is ignored and the
   *  caller's own check has to cover it. */
  toolChoice?: ToolChoice;
  /**
   * An agent's own models. When set it replaces backend: the models are tried
   * in order, each through its provider's adapter, and nothing outside the
   * route is used unless a message needs a capability none of them has.
   */
  route?: ModelRoute;
}

export type ToolChoice = "required" | { name: string };

/** Backends that take a forced tool call. */
export function backendForcesTools(backend: LlmBackend): boolean {
  return backend !== "claude" && backend !== "haiku" && backend !== "deepseek-reasoner";
}

/** The OpenAI-compatible tool_choice (DeepSeek, Gemini, local) for a forced call. */
export function openAiToolChoice(
  choice: ToolChoice | undefined,
): "required" | { type: "function"; function: { name: string } } | undefined {
  if (!choice) {
    return undefined;
  }
  return choice === "required" ? "required" : { type: "function", function: { name: choice.name } };
}

export interface CompleteResult {
  textParts: string[];
  toolCalls: ToolCall[];
  usage: LlmUsage;
  stopReason: LlmStopReason;
  /**
   * What answered: a backend name, or a model key on a route. It differs from
   * what was asked for after a fallback.
   */
  servedBy?: string;
  /** The exact model id that answered. */
  servedModel?: string;
  providerItems?: ProviderItems;
}

/**
 * Provider clients are made on first use, from the key in the environment.
 * Keys are never stored anywhere else.
 */
const clients = new Map<string, Anthropic | OpenAI>();

function lazyClient<T extends Anthropic | OpenAI>(name: string, make: () => T | undefined): T | undefined {
  const existing = clients.get(name);
  if (existing) {
    return existing as T;
  }
  const made = make();
  if (made) {
    clients.set(name, made);
  }
  return made;
}

function anthropicClient(): Anthropic | undefined {
  return lazyClient("anthropic", () =>
    config.anthropicApiKey
      ? new Anthropic({
          apiKey: config.anthropicApiKey,
          ...(process.env.ANTHROPIC_BASE_URL?.trim() ? { baseURL: process.env.ANTHROPIC_BASE_URL.trim() } : {}),
        })
      : undefined,
  );
}

function geminiClient(): OpenAI | undefined {
  return lazyClient("gemini", () =>
    config.geminiApiKey ? new OpenAI({ apiKey: config.geminiApiKey, baseURL: GEMINI_BASE_URL(), timeout: 45_000 }) : undefined,
  );
}

function deepseekClient(): OpenAI | undefined {
  return lazyClient("deepseek", () =>
    config.deepseekApiKey ? new OpenAI({ apiKey: config.deepseekApiKey, baseURL: DEEPSEEK_BASE_URL(), timeout: 45_000 }) : undefined,
  );
}

function openaiClient(): OpenAI | undefined {
  return lazyClient("openai", () => {
    const apiKey = providerApiKey("openai");
    return apiKey
      ? new OpenAI({
          apiKey,
          ...(process.env.OPENAI_BASE_URL?.trim() ? { baseURL: process.env.OPENAI_BASE_URL.trim() } : {}),
          timeout: 60_000,
        })
      : undefined;
  });
}

function kimiClient(): OpenAI | undefined {
  return lazyClient("kimi", () => {
    const apiKey = providerApiKey("kimi");
    return apiKey ? new OpenAI({ apiKey, baseURL: KIMI_BASE_URL(), timeout: 60_000 }) : undefined;
  });
}

/** Tests point a provider at a local fake server, then make the client again. */
export function resetProviderClientsForTests(): void {
  assertTestSeam("resetProviderClientsForTests");
  clients.clear();
}

const localLlm = new OpenAI({
  apiKey: "ollama",
  baseURL: config.localLlmBaseUrl,
  timeout: 15 * 60 * 1000,
});


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
      // Direct calling: 20260318 defaults allowed_callers to code_execution,
      // which 400s on models without programmatic tool calling.
      return {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: tool.maxUses,
        allowed_callers: ["direct"],
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
  const anthropic = anthropicClient();
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

/** Gemini's OpenAI-compatible tool call carries the signature here. See thought-signatures. */
export function readGeminiThoughtSignature(toolCall: unknown): string | undefined {
  const google = (toolCall as { extra_content?: { google?: { thought_signature?: unknown } } } | null)
    ?.extra_content?.google;
  const signature = google?.thought_signature;
  return typeof signature === "string" && signature.length > 0 ? signature : undefined;
}

export function toOpenRouterMessages(
  system: LlmSystemPrompt,
  messages: LlmMessage[],
  options: { preserveThoughtSignatures?: boolean; reasoningProvider?: string } = {},
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

      const assistant: ChatCompletionMessageParam = {
        role: "assistant",
        content:
          message.textParts.length > 0 ? message.textParts.join("\n") : null,
      };
      // Kimi's thinking models need their reasoning text back within a turn.
      // Only the provider that wrote it is sent it.
      const reasoningText =
        options.reasoningProvider && message.providerItems?.provider === options.reasoningProvider
          ? message.providerItems.items.find((item): item is string => typeof item === "string")
          : undefined;
      if (reasoningText) {
        (assistant as { reasoning_content?: string }).reasoning_content = reasoningText;
      }
      if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
        assistant.tool_calls = message.toolCalls.map((toolCall) => ({
          type: "function" as const,
          id: toolCall.id,
          function: {
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.input),
          },
          // Only Gemini validates this, and only the signature it issued. Other
          // providers must not be sent a vendor field they didn't ask for.
          ...(options.preserveThoughtSignatures && toolCall.thoughtSignature
            ? { extra_content: { google: { thought_signature: toolCall.thoughtSignature } } }
            : {}),
        }));
      }
      return assistant;
    }),
  ];
}

function isDeepSeekLabel(label: string): boolean {
  return label === "deepseek" || label === "deepseek-reasoner";
}

/** DeepSeek JSON Output: json_object only; prompt must contain "json" and an example.
 *  Official docs: api-docs.deepseek.com/guides/json_mode — json_schema is rejected. */
export function deepSeekJsonMode(schema: Record<string, unknown> | undefined): {
  responseFormat?: { type: "json_object" };
  systemExtra?: string;
} {
  if (!schema) {
    return {};
  }
  return {
    responseFormat: { type: "json_object" },
    systemExtra: `Reply with a single json object only. The entire assistant message must be valid json, no markdown fences.
EXAMPLE JSON OUTPUT: fill every required key in this JSON schema from the source; use [] when a list has no items; never omit required keys.
JSON schema:
${JSON.stringify(schema)}`,
  };
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

function geminiToolCalls(message: {
  content?: string | null;
  tool_calls?: unknown[] | null;
  extra_content?: { google?: { thought_signature?: unknown } };
}): ToolCall[] {
  const calls = (message.tool_calls ?? []).filter(
    (toolCall): toolCall is { id?: string; type?: string; function?: { name?: string; arguments?: string } } =>
      (toolCall as { type?: string }).type === "function",
  );
  const messageSignature = readGeminiThoughtSignature(message);
  return calls.map((toolCall, index) => {
    const own = readGeminiThoughtSignature(toolCall);
    // Parallel calls carry the signature on the first function call only.
    const thoughtSignature = own ?? (index === 0 ? messageSignature : undefined);
    return {
      id: toolCall.id ?? `call-${index}`,
      name: toolCall.function?.name ?? "",
      input: parseToolInput(toolCall.function?.arguments ?? ""),
      execution: "client" as const,
      ...(thoughtSignature ? { thoughtSignature } : {}),
    };
  });
}

function openAiStopReason(reason: string | null): LlmStopReason {
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
  options: { thinking?: boolean; forcesTools?: boolean } = {},
): Promise<CompleteResult> {
  const tools = toOpenRouterTools(params.tools);
  let system = params.system;
  const jsonMode = isDeepSeekLabel(label)
    ? deepSeekJsonMode(params.jsonSchema)
    : {};
  if (jsonMode.systemExtra) {
    system = {
      cacheable: system.cacheable,
      dynamic: [system.dynamic, jsonMode.systemExtra].filter(Boolean).join("\n"),
    };
  }
  const forced =
    tools.length > 0 && !options.thinking && options.forcesTools !== false ? openAiToolChoice(params.toolChoice) : undefined;
  const response = await client.chat.completions.create(
    {
      model,
      messages: toOpenRouterMessages(system, params.messages, {
        preserveThoughtSignatures: label === "gemini",
        reasoningProvider: label === "kimi" ? "kimi" : undefined,
      }),
      ...(tools.length > 0 ? { tools } : {}),
      ...(forced ? { tool_choice: forced } : {}),
      max_tokens: params.maxTokens ?? MAX_TOKENS,
      ...(jsonMode.responseFormat
        ? { response_format: jsonMode.responseFormat }
        : {}),
      ...(options.thinking
        ? {
            reasoning_effort: "high" as const,
            thinking: { type: "enabled" },
          }
        : isDeepSeekLabel(label)
          ? { thinking: { type: "disabled" } }
          : label === "gemini"
            ? { reasoning_effort: params.effort ?? ("low" as const) }
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

  const reasoningText =
    label === "kimi" ? (choice.message as { reasoning_content?: unknown }).reasoning_content : undefined;
  return {
    textParts: choice.message.content ? [choice.message.content] : [],
    toolCalls: geminiToolCalls(choice.message),
    usage,
    stopReason: openAiStopReason(choice.finish_reason),
    ...(typeof reasoningText === "string" && reasoningText
      ? { providerItems: { provider: "kimi", items: [reasoningText] } }
      : {}),
  };
}

/** OpenAI through the Responses API (openai_responses.ts does the translation). */
async function completeWithOpenAiResponses(
  client: OpenAI,
  params: CompleteParams,
  spec: ModelSpec,
): Promise<CompleteResult> {
  const request = buildResponsesRequest(params, spec);
  const response = await client.responses.create(
    request as unknown as OpenAI.Responses.ResponseCreateParamsNonStreaming,
    params.timeoutMs ? { timeout: params.timeoutMs } : undefined,
  );
  const parsed = parseResponsesOutput(response as unknown as Parameters<typeof parseResponsesOutput>[0]);
  const usage = recordUsage(
    params,
    spec.modelId,
    {
      inputTokens: parsed.usage.inputTokens,
      outputTokens: parsed.usage.outputTokens,
      cacheReadInputTokens: parsed.usage.cachedTokens,
    },
    true,
  );
  return {
    textParts: parsed.textParts,
    toolCalls: parsed.toolCalls,
    usage,
    stopReason: parsed.stopReason,
    ...(parsed.providerItems ? { providerItems: parsed.providerItems } : {}),
  };
}

function missingKey(provider: string, envName: string): Error {
  return new Error(`${provider} requires ${envName} in .env (add it locally; Aadi never writes .env).`);
}

/** One call to one model, through its provider's adapter. */
export async function completeWithModel(spec: ModelSpec, params: CompleteParams): Promise<CompleteResult> {
  const call = { ...params, model: spec.modelId };
  switch (spec.provider) {
    case "anthropic":
      return completeWithClaude(call);
    case "openai": {
      const client = openaiClient();
      if (!client) {
        throw missingKey("openai", "OPENAI_API_KEY");
      }
      return completeWithOpenAiResponses(client, call, spec);
    }
    case "gemini": {
      const client = geminiClient();
      if (!client) {
        throw missingKey("gemini", "GEMINI_API_KEY");
      }
      return completeWithOpenAiCompatible(client, call, spec.modelId, "gemini", { forcesTools: spec.forcesTools });
    }
    case "deepseek": {
      const client = deepseekClient();
      if (!client) {
        throw missingKey("deepseek", "DEEPSEEK_API_KEY");
      }
      return completeWithOpenAiCompatible(client, call, spec.modelId, spec.thinking ? "deepseek-reasoner" : "deepseek", {
        thinking: spec.thinking === true,
        forcesTools: spec.forcesTools,
      });
    }
    case "kimi": {
      const client = kimiClient();
      if (!client) {
        throw missingKey("kimi", "KIMI_API_KEY");
      }
      return completeWithOpenAiCompatible(client, call, spec.modelId, "kimi", { forcesTools: spec.forcesTools });
    }
  }
}

let fakeComplete:
  | ((params: CompleteParams) => Promise<CompleteResult>)
  | undefined;
let namedBackendOverride:
  | ((backend: LlmBackend, params: CompleteParams) => Promise<CompleteResult>)
  | undefined;

async function completeWithNamedBackend(
  backend: LlmBackend,
  params: CompleteParams,
): Promise<CompleteResult> {
  if (namedBackendOverride) {
    return namedBackendOverride(backend, params);
  }
  if (backend === "claude" || backend === "haiku") {
    const model =
      params.model ??
      (backend === "haiku" ? config.backgroundModel : config.claudeModel);
    return completeWithClaude({ ...params, model });
  }
  if (backend === "gemini") {
    const gemini = geminiClient();
    if (!gemini) {
      throw new Error(
        "gemini requires GEMINI_API_KEY in .env (add it locally; Aadi never writes .env).",
      );
    }
    return completeWithOpenAiCompatible(
      gemini,
      params,
      config.geminiModel,
      "gemini",
    );
  }
  if (backend === "deepseek" || backend === "deepseek-reasoner") {
    const deepseek = deepseekClient();
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isAnthropicCreditError(error: unknown): boolean {
  return /credit balance is too low/i.test(errorText(error));
}

export { getFallbackChain, isCreditOrAuthError } from "./llm_fallback.js";

export function setCompleteForTests(
  fake: ((params: CompleteParams) => Promise<CompleteResult>) | undefined,
): void {
  assertTestSeam("setCompleteForTests");
  fakeComplete = fake;
}

function messagesHavePdf(params: CompleteParams): boolean {
  return params.messages.some(
    (message) =>
      message.role === "user" &&
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === "document"),
  );
}

function messagesHaveImage(params: CompleteParams): boolean {
  return params.messages.some(
    (message) =>
      message.role === "user" &&
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === "image"),
  );
}

let routeModelOverride:
  | ((spec: ModelSpec, params: CompleteParams) => Promise<CompleteResult>)
  | undefined;

/** Stands in for the provider call on an agent route; the route logic still runs. */
export function setRouteModelCompleteForTests(
  fake: ((spec: ModelSpec, params: CompleteParams) => Promise<CompleteResult>) | undefined,
): void {
  assertTestSeam("setRouteModelCompleteForTests");
  routeModelOverride = fake;
}

function modelFits(spec: ModelSpec, needs: { image: boolean; pdf: boolean; json: boolean }): boolean {
  return (!needs.image || spec.supportsVision) && (!needs.pdf || spec.supportsPdf);
}

/**
 * Tries an agent's models in order. A model whose key is missing or whose
 * provider is paused after a credit error is skipped. A credit or auth failure
 * pauses that provider for everyone. When a message holds an image or a PDF no
 * model on the route can read, the system's own chain for that is used.
 */
async function completeOnRoute(params: CompleteParams): Promise<CompleteResult> {
  const route = params.route!;
  const needs = { image: messagesHaveImage(params), pdf: messagesHavePdf(params), json: Boolean(params.jsonSchema) };
  const fitting = route.models.filter((spec) => modelFits(spec, needs));
  if (fitting.length === 0) {
    console.log(`LLM: agent=${route.agentId} route has no model for this content; using the system chain.`);
    return complete({ ...params, route: undefined, backend: undefined });
  }
  const failures: string[] = [];
  for (const spec of fitting) {
    const unavailable = modelUnavailableReason(spec);
    if (unavailable) {
      failures.push(`${spec.key}:${unavailable}`);
      continue;
    }
    try {
      const result = routeModelOverride
        ? await routeModelOverride(spec, params)
        : await completeWithModel(spec, {
            ...params,
            route: undefined,
            // Forced tool use only goes to a provider that accepts it.
            toolChoice: spec.forcesTools ? params.toolChoice : undefined,
          });
      if (failures.length > 0) {
        console.error(`LLM: agent=${route.agentId} using ${spec.key} after [${failures.join("; ")}].`);
      }
      return { ...result, servedBy: spec.key, servedModel: spec.modelId };
    } catch (error) {
      const reason = shortBackendReason(error);
      console.error(`LLM: agent=${route.agentId} model ${spec.key} failed (${reason}); trying next.`);
      if (isCreditOrAuthError(error)) {
        flagProvider(spec.provider, reason);
      }
      failures.push(`${spec.key}:${reason}`);
    }
  }
  throw new Error(`All models for ${route.agentId} failed: [${failures.join("; ")}]`);
}

export function setNamedBackendCompleteForTests(
  fake:
    | ((backend: LlmBackend, params: CompleteParams) => Promise<CompleteResult>)
    | undefined,
): void {
  assertTestSeam("setNamedBackendCompleteForTests");
  namedBackendOverride = fake;
}

export async function complete(
  params: CompleteParams,
): Promise<CompleteResult> {
  if (fakeComplete) {
    const result = await fakeComplete(params);
    // A scripted model on a route answers as the route's first model.
    return params.route && result.servedBy === undefined && params.route.models[0]
      ? { ...result, servedBy: params.route.models[0].key, servedModel: params.route.models[0].modelId }
      : result;
  }
  if (params.route && params.route.models.length > 0) {
    return completeOnRoute(params);
  }
  const primary = params.backend ?? getTaskBackend("chat");
  const chain = params.noFallback
    ? [primary]
    : getFallbackChain(primary, {
        hasImage: messagesHaveImage(params),
        hasPdf: messagesHavePdf(params),
      });
  if (chain.length === 0) {
    throw new Error("All LLM backends failed: none usable");
  }
  const failures: string[] = [];
  for (const backend of chain) {
    if (!isBackendUsable(backend)) {
      continue;
    }
    try {
      const result = await completeWithNamedBackend(backend, {
        ...params,
        backend,
        model: backend === primary ? params.model : undefined,
        jsonSchema: params.jsonSchema,
        effort:
          backend === "claude" || backend === "haiku"
            ? params.effort
            : undefined,
      });
      if (failures.length > 0) {
        console.error(`LLM: using ${backend}.`);
      }
      return { ...result, servedBy: backend, servedModel: modelForLegacyBackend(backend)?.modelId ?? params.model };
    } catch (error) {
      const reason = shortBackendReason(error);
      console.error(`Backend ${backend} failed (${reason}); trying next.`);
      if (isCreditOrAuthError(error)) {
        flagLlmBackend(backend, reason);
      }
      failures.push(`${backend}:${reason}`);
    }
  }
  throw new Error(`All LLM backends failed: [${failures.join("; ")}]`);
}

/** Same cascade as complete(); kept so job/document callers stay stable. */
export async function completeWithCreditFallback(
  params: CompleteParams,
): Promise<CompleteResult> {
  return complete(params);
}

export async function completeBackground(
  params: Omit<CompleteParams, "model" | "backend">,
): Promise<CompleteResult> {
  return complete({
    ...params,
    backend: getTaskBackend("background"),
    model: undefined,
    task: params.task ?? "classification",
    effort: params.effort ?? "low",
  });
}
