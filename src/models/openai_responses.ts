import type {
  CompleteParams,
  LlmContentPart,
  LlmMessage,
  LlmStopReason,
  LlmTool,
  ToolCall,
} from "../llm.js";
import type { ModelSpec } from "./registry.js";

/**
 * OpenAI's Responses API, translated to and from Aadi's provider-neutral
 * messages. Pure functions only: llm.ts makes the call and records the usage.
 *
 * Requests are stateless (store: false). A reasoning model's encrypted
 * reasoning items are carried on the assistant message and sent back on the
 * next step of the same turn, as OpenAI asks for manual tool loops. Function
 * calls are sent back without OpenAI's own item id, so a turn that started on
 * another provider can continue here.
 */
export interface ResponsesUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
}

export interface ParsedResponse {
  textParts: string[];
  toolCalls: ToolCall[];
  providerItems?: { provider: "openai"; items: unknown[] };
  stopReason: LlmStopReason;
  usage: ResponsesUsage;
}

type InputItem = Record<string, unknown>;

const MAX_TOKENS = 4096;
/** Reasoning tokens count against max_output_tokens, so leave room for them. */
const REASONING_ALLOWANCE: Record<string, number> = { low: 4096, medium: 8192, high: 16384 };

function userContent(content: string | LlmContentPart[]): string | InputItem[] {
  if (typeof content === "string") {
    return content;
  }
  return content.map((part): InputItem => {
    if (part.type === "text") {
      return { type: "input_text", text: part.text };
    }
    if (part.type === "image") {
      return { type: "input_image", image_url: `data:${part.mediaType};base64,${part.data}`, detail: "auto" };
    }
    return { type: "input_file", filename: "document.pdf", file_data: `data:${part.mediaType};base64,${part.data}` };
  });
}

export function toResponsesInput(messages: LlmMessage[]): InputItem[] {
  const input: InputItem[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      input.push({ role: "user", content: userContent(message.content) });
      continue;
    }
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId,
        output: message.isError ? `Tool error: ${message.content}` : message.content,
      });
      continue;
    }
    if (message.providerItems?.provider === "openai") {
      for (const item of message.providerItems.items) {
        input.push(item as InputItem);
      }
    }
    const text = message.textParts.join("\n").trim();
    if (text) {
      input.push({ role: "assistant", content: text });
    }
    for (const call of message.toolCalls) {
      // A provider-run tool (Claude's own web search) has no client result to pair with.
      if (call.execution !== "client") {
        continue;
      }
      input.push({
        type: "function_call",
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.input ?? {}),
      });
    }
  }
  return input;
}

function functionTools(tools: LlmTool[]): InputItem[] {
  return tools
    .filter((tool): tool is Extract<LlmTool, { type: "function" }> => tool.type === "function")
    .map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      // Aadi's schemas use optional fields; strict mode would make every field required.
      strict: false,
    }));
}

export function buildResponsesRequest(params: CompleteParams, spec: ModelSpec): Record<string, unknown> {
  const tools = functionTools(params.tools);
  const effort = params.effort ?? "low";
  const instructions = [params.system.cacheable, params.system.dynamic].filter(Boolean).join("\n\n");
  const toolChoice =
    tools.length === 0 || !params.toolChoice
      ? undefined
      : params.toolChoice === "required"
        ? "required"
        : { type: "function", name: params.toolChoice.name };
  const outputBudget = (params.maxTokens ?? MAX_TOKENS) + (spec.supportsReasoning ? REASONING_ALLOWANCE[effort] ?? 4096 : 0);
  return {
    model: spec.modelId,
    instructions,
    input: toResponsesInput(params.messages),
    ...(tools.length > 0 ? { tools, parallel_tool_calls: true } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    max_output_tokens: outputBudget,
    store: false,
    ...(spec.supportsReasoning ? { reasoning: { effort }, include: ["reasoning.encrypted_content"] } : {}),
    ...(params.jsonSchema
      ? { text: { format: { type: "json_schema", name: "result", schema: params.jsonSchema, strict: false } } }
      : {}),
  };
}

function parseArguments(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

interface ResponseLike {
  status?: string | null;
  incomplete_details?: { reason?: string | null } | null;
  output?: Array<Record<string, unknown>> | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number } | null;
    output_tokens_details?: { reasoning_tokens?: number } | null;
  } | null;
}

export function parseResponsesOutput(response: ResponseLike): ParsedResponse {
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  const reasoning: unknown[] = [];
  let refused = false;
  for (const item of response.output ?? []) {
    if (item.type === "message") {
      for (const part of (item.content as Array<Record<string, unknown>> | undefined) ?? []) {
        if (part.type === "output_text" && typeof part.text === "string" && part.text) {
          textParts.push(part.text);
        } else if (part.type === "refusal" && typeof part.refusal === "string") {
          refused = true;
          textParts.push(part.refusal);
        }
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: String(item.call_id ?? item.id ?? `call-${toolCalls.length}`),
        name: String(item.name ?? ""),
        input: parseArguments(String(item.arguments ?? "")),
        execution: "client",
      });
    } else if (item.type === "reasoning" && typeof item.encrypted_content === "string") {
      // Sent back as-is on the next step. Opaque: never logged.
      reasoning.push({
        type: "reasoning",
        id: item.id,
        summary: Array.isArray(item.summary) ? item.summary : [],
        encrypted_content: item.encrypted_content,
      });
    }
  }
  const stopReason: LlmStopReason =
    toolCalls.length > 0
      ? "tool_use"
      : refused || response.incomplete_details?.reason === "content_filter"
        ? "refusal"
        : response.status === "incomplete" && response.incomplete_details?.reason === "max_output_tokens"
          ? "max_tokens"
          : response.status === "completed" || response.status === undefined || response.status === null
            ? "end_turn"
            : "other";
  return {
    textParts,
    toolCalls,
    ...(reasoning.length > 0 ? { providerItems: { provider: "openai" as const, items: reasoning } } : {}),
    stopReason,
    usage: {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      cachedTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
      reasoningTokens: response.usage?.output_tokens_details?.reasoning_tokens ?? 0,
    },
  };
}
