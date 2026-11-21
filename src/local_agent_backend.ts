import net from "node:net";
import type { CompleteResult, LlmMessage, LlmSystemPrompt, LlmTool, ToolCall } from "./llm.js";
import type { LocalAgentModel } from "./models/local_agent_models.js";

/**
 * One step of an agent's loop on the laptop model, through Ollama's /api/chat
 * (docs.ollama.com/api/chat): stream false, thinking off, function tools in the
 * OpenAI shape, tool results sent back as role "tool" with tool_name. It returns
 * what complete() returns, so the agent loop treats it like any model.
 */
const LOCAL_NUM_PREDICT = 2048;

export type LocalFailure = "unreachable" | "slow" | "error";

export class LocalModelUnavailable extends Error {
  constructor(
    readonly reason: LocalFailure,
    message: string,
  ) {
    super(message);
    this.name = "LocalModelUnavailable";
  }
}

type OllamaToolCall = { function?: { name?: unknown; arguments?: unknown } };

type OllamaMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: Array<{ type: "function"; function: { name: string; arguments: unknown } }> }
  | { role: "tool"; tool_name: string; content: string };

async function assertConnectable(url: string, timeoutMs: number): Promise<void> {
  const parsed = new URL(url);
  const port = parsed.port !== "" ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host: parsed.hostname, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new LocalModelUnavailable("unreachable", `no connection within ${timeoutMs}ms`));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(new LocalModelUnavailable("unreachable", error.message));
    });
  });
}

function userText(content: Extract<LlmMessage, { role: "user" }>["content"]): string {
  return typeof content === "string"
    ? content
    : content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n");
}

export function toOllamaMessages(system: LlmSystemPrompt, messages: LlmMessage[]): OllamaMessage[] {
  const out: OllamaMessage[] = [
    { role: "system", content: [system.cacheable, system.dynamic ?? ""].filter(Boolean).join("\n\n") },
  ];
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", content: userText(message.content) });
    } else if (message.role === "assistant") {
      const calls = message.toolCalls.filter((call) => call.execution === "client");
      for (const call of calls) {
        toolNames.set(call.id, call.name);
      }
      out.push({
        role: "assistant",
        content: message.textParts.join("\n"),
        ...(calls.length > 0
          ? { tool_calls: calls.map((call) => ({ type: "function" as const, function: { name: call.name, arguments: call.input ?? {} } })) }
          : {}),
      });
    } else {
      out.push({ role: "tool", tool_name: toolNames.get(message.toolCallId) ?? "", content: message.content });
    }
  }
  return out;
}

function toOllamaTools(tools: LlmTool[]) {
  return tools.flatMap((tool) =>
    tool.type === "function"
      ? [{ type: "function" as const, function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }]
      : [],
  );
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") {
    return value ?? {};
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

let callSeq = 0;

export async function completeOnLocalModel(params: {
  system: LlmSystemPrompt;
  messages: LlmMessage[];
  tools: LlmTool[];
  local: LocalAgentModel;
  /** Date.now() by which the whole local run must be done. */
  deadline: number;
  /** The run's own cancel. Its abort is rethrown as is, not as a local failure. */
  signal?: AbortSignal;
}): Promise<CompleteResult> {
  const endpoint = `${params.local.url}/api/chat`;
  const remaining = params.deadline - Date.now();
  if (remaining <= 0) {
    throw new LocalModelUnavailable("slow", "local run deadline passed");
  }
  await assertConnectable(endpoint, Math.min(params.local.connectTimeoutMs, remaining));
  const timeout = AbortSignal.timeout(Math.max(1, params.deadline - Date.now()));
  const signal = params.signal ? AbortSignal.any([params.signal, timeout]) : timeout;
  const tools = toOllamaTools(params.tools);
  let payload: {
    message?: { content?: unknown; tool_calls?: OllamaToolCall[] };
    prompt_eval_count?: unknown;
    eval_count?: unknown;
  };
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: params.local.model,
        messages: toOllamaMessages(params.system, params.messages),
        ...(tools.length > 0 ? { tools } : {}),
        stream: false,
        think: false,
        options: { num_predict: LOCAL_NUM_PREDICT },
      }),
      signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new LocalModelUnavailable("error", `HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }
    payload = (await response.json()) as typeof payload;
  } catch (error) {
    if (params.signal?.aborted) {
      throw error;
    }
    if (error instanceof LocalModelUnavailable) {
      throw error;
    }
    if (timeout.aborted) {
      throw new LocalModelUnavailable("slow", `no answer within the local run's ${params.local.totalTimeoutMs}ms`);
    }
    if (error instanceof SyntaxError) {
      throw new LocalModelUnavailable("error", "the answer was not JSON");
    }
    throw new LocalModelUnavailable("unreachable", error instanceof Error ? error.message : String(error));
  }
  const content = typeof payload.message?.content === "string" ? payload.message.content.trim() : "";
  const toolCalls: ToolCall[] = (payload.message?.tool_calls ?? []).flatMap((call) => {
    const name = call.function?.name;
    if (typeof name !== "string" || !name) {
      return [];
    }
    callSeq += 1;
    return [{ id: `local-${callSeq}`, name, input: parseArguments(call.function?.arguments), execution: "client" as const }];
  });
  return {
    textParts: content ? [content] : [],
    toolCalls,
    usage: {
      inputTokens: typeof payload.prompt_eval_count === "number" ? payload.prompt_eval_count : 0,
      outputTokens: typeof payload.eval_count === "number" ? payload.eval_count : 0,
      estimatedCostUsd: 0,
    },
    stopReason: toolCalls.length > 0 ? "tool_use" : "end_turn",
    servedBy: `local:${params.local.model}`,
    servedModel: params.local.model,
  };
}
