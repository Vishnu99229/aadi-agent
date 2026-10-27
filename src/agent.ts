import type {
  LlmBackend,
  LlmMessage,
  LlmTool,
  ToolCall,
} from "./llm.js";
import { readFile } from "node:fs/promises";
import { getTaskBackend, getTaskEffort, type ModelTask } from "./chat_backend.js";
import { shouldForceCalendarTool } from "./calendar_guard.js";
import { looksLikeDeferredAction } from "./deferred_action.js";
import {
  CONVERSATION_SUMMARY_KEY,
  CONVERSATION_SUMMARY_UNTIL_KEY,
  getRecentMessages,
  getSetting,
  saveMessage,
  setSetting,
  type StoredMessage,
} from "./db.js";
import { complete } from "./llm.js";
import type { UsageTask } from "./usage.js";
import { memoryContextLine } from "./memory.js";
import { recentUploadLine } from "./recent_upload.js";
import {
  TOOL_ORDER,
  tools as customTools,
  type ToolTurn,
} from "./tools/index.js";
import {
  formatPendingDraftContext,
  type SendConfirmation,
} from "./approvals.js";
import { assertTestSeam } from "./test_seam.js";

const TIME_ZONE = "Asia/Kolkata";
const MAX_ITERATIONS = 8;
const HISTORY_KEEP = 8;
const HISTORY_LOOKBACK = 40;

const webSearchTool: LlmTool = {
  type: "web_search",
  maxUses: 5,
};

const toolDefinitions: LlmTool[] = [
  ...TOOL_ORDER.map((name) => customTools[name]!.definition),
  webSearchTool,
];

function formatCurrentTime(): string {
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "full",
    timeStyle: "long",
    timeZone: TIME_ZONE,
  }).format(new Date());
}

type ToolInterceptor = (call: ToolCall, turn: ToolTurn) => string | undefined;
let toolInterceptor: ToolInterceptor | undefined;

/** Lets a test or eval see which tools the model would call and answer them
 *  itself, so nothing real runs. Returning undefined runs the real tool. */
export function setToolInterceptorForTests(
  interceptor: ToolInterceptor | undefined,
): void {
  assertTestSeam("setToolInterceptorForTests");
  toolInterceptor = interceptor;
}

function sendIntentContext(confirmation: SendConfirmation | undefined): string {
  if (!confirmation) {
    return "";
  }
  return formatPendingDraftContext(confirmation);
}

async function runTool(
  call: ToolCall,
  turn: ToolTurn,
): Promise<Extract<LlmMessage, { role: "tool" }>> {
  const intercepted = toolInterceptor?.(call, turn);
  if (intercepted !== undefined) {
    return { role: "tool", toolCallId: call.id, content: intercepted };
  }
  const tool = customTools[call.name];

  if (!tool) {
    return {
      role: "tool",
      toolCallId: call.id,
      content: `Unknown tool: ${call.name}`,
      isError: true,
    };
  }

  try {
    const result = await tool.handler(call.input, turn);
    return {
      role: "tool",
      toolCallId: call.id,
      content: result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      role: "tool",
      toolCallId: call.id,
      content: `Tool failed: ${message}`,
      isError: true,
    };
  }
}

function saveConversation(
  userText: string,
  reply: string,
  saveUserMessage: boolean,
  saveAssistantMessage: boolean,
): string {
  if (saveUserMessage) {
    saveMessage("user", userText);
  }
  if (saveAssistantMessage) {
    saveMessage("assistant", reply);
  }
  return reply;
}

export interface RunAgentOptions {
  saveUserMessage?: boolean;
  saveAssistantMessage?: boolean;
  /** Per-job backend. Overrides task if both are set. */
  backend?: LlmBackend;
  /** Persisted /model task. Omitted = chat. */
  task?: ModelTask;
  /** usage_log task. Omitted = derived from task. */
  usageTask?: UsageTask;
  skipHistory?: boolean;
  /** User's own words, without quoted-message context, for tool guards. */
  guardText?: string;
  /** Set only for Vishnu's own chat message (typed or voice). Enables
   *  confirm_send_pending_draft for drafts shown before that message. */
  sendConfirmation?: SendConfirmation;
}

async function summariseOlderMessages(
  older: StoredMessage[],
  previous: string,
): Promise<string> {
  const lines = older.map(
    (message) => `${message.role}: ${message.content.slice(0, 400)}`,
  );
  const result = await complete({
    backend: getTaskBackend("chat"),
    effort: "low",
    cacheTtl: "5m",
    task: "other",
    maxTokens: 400,
    tools: [],
    system: {
      cacheable:
        "Summarise this Telegram chat for Aadi. Keep names, dates, decisions, and open tasks. Plain text, under 120 words. No secrets.",
    },
    messages: [
      {
        role: "user",
        content: `${previous ? `Previous summary:\n${previous}\n\n` : ""}New turns:\n${lines.join("\n")}`,
      },
    ],
  });
  return result.textParts.join("\n").trim() || previous;
}

async function historyForAgent(skipHistory: boolean): Promise<{
  summary: string;
  messages: StoredMessage[];
}> {
  if (skipHistory) {
    return { summary: "", messages: [] };
  }
  const all = getRecentMessages(HISTORY_LOOKBACK);
  if (all.length <= HISTORY_KEEP) {
    return {
      summary: getSetting(CONVERSATION_SUMMARY_KEY) ?? "",
      messages: all,
    };
  }
  const older = all.slice(0, -HISTORY_KEEP);
  const recent = all.slice(-HISTORY_KEEP);
  const untilId = older.at(-1)!.id;
  const storedUntil = Number(getSetting(CONVERSATION_SUMMARY_UNTIL_KEY) ?? 0);
  let summary = getSetting(CONVERSATION_SUMMARY_KEY) ?? "";
  if (storedUntil !== untilId) {
    try {
      summary = await summariseOlderMessages(older, summary);
      setSetting(CONVERSATION_SUMMARY_KEY, summary);
      setSetting(CONVERSATION_SUMMARY_UNTIL_KEY, String(untilId));
    } catch (error) {
      const errorType = error instanceof Error ? error.name : "UnknownError";
      console.error(`Conversation summary failed (${errorType}).`);
    }
  }
  return { summary, messages: recent };
}

function usageTaskForAgent(task: ModelTask | undefined): UsageTask {
  switch (task) {
    case "brief":
      return "brief";
    case "documents":
      return "document";
    case "meetings":
      return "meeting_brief";
    case "drafting":
      return "drafting";
    default:
      return "chat";
  }
}

export async function runAgent(
  userText: string,
  options: RunAgentOptions = {},
): Promise<string> {
  const saveUserMessage = options.saveUserMessage ?? true;
  const saveAssistantMessage = options.saveAssistantMessage ?? true;
  const promptUrl = new URL("../prompts/system.md", import.meta.url);
  const basePrompt = await readFile(promptUrl, "utf8");
  const recentUpload = recentUploadLine();
  const memories = memoryContextLine(userText);
  const history = await historyForAgent(options.skipHistory === true);
  const system = {
    cacheable: basePrompt.trim(),
    dynamic: [
      `Current date and time in ${TIME_ZONE}: ${formatCurrentTime()}`,
      sendIntentContext(options.sendConfirmation),
      recentUpload,
      "If Vishnu asked a specific question about a document or photo, answer only that question. Do not dump a full summary unless he asked for a summary.",
      memories,
      history.summary
        ? `Earlier conversation summary:\n${history.summary}`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
  };

  const messages: LlmMessage[] = history.messages.map((message) =>
    message.role === "user"
      ? { role: "user", content: message.content }
      : {
          role: "assistant",
          textParts: [message.content],
          toolCalls: [],
        },
  );
  messages.push({ role: "user", content: userText });

  const collectedText: string[] = [];
  const task = options.task ?? "chat";
  const backend = options.backend ?? getTaskBackend(task);
  const effort =
    backend === "claude" || backend === "haiku"
      ? getTaskEffort(task)
      : undefined;
  let deferredRetryUsed = false;
  let calendarRetryUsed = false;
  const toolsUsed = new Set<string>();
  const guardText = options.guardText ?? userText;

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration += 1) {
    const response = await complete({
      system,
      tools: toolDefinitions,
      messages,
      backend,
      task: options.usageTask ?? usageTaskForAgent(options.task),
      effort,
    });

    const responseText = response.textParts.join("\n").trim();
    if (responseText) {
      collectedText.push(responseText);
    }

    const calledTools = response.toolCalls.map((call) => call.name);
    for (const name of calledTools) {
      toolsUsed.add(name);
    }
    const cacheCreationTokens = response.usage.cacheCreationInputTokens ?? 0;
    const cacheReadTokens = response.usage.cacheReadInputTokens ?? 0;

    console.log(
      `Agent iteration ${iteration}: backend=${backend}, tools=[${calledTools.join(", ")}], input_tokens=${response.usage.inputTokens}, output_tokens=${response.usage.outputTokens}, cache_creation_input_tokens=${cacheCreationTokens}, cache_read_input_tokens=${cacheReadTokens}, estimated_cost_usd=${response.usage.estimatedCostUsd.toFixed(6)}`,
    );

    if (response.stopReason === "tool_use") {
      const clientToolCalls = response.toolCalls.filter(
        (call) => call.execution === "client",
      );
      if (clientToolCalls.length === 0) {
        throw new Error("LLM requested tool use without a client tool call.");
      }

      // Independent calls can arrive together and are all executed. Consecutive
      // tool messages are serialized by the Claude adapter as one user message
      // containing every matching tool_result block. Calls that depend on an
      // earlier result are left for the model to request on a later iteration.
      const turn: ToolTurn = {
        iteration,
        calledTools: clientToolCalls.map((call) => call.name),
        confirmation: options.sendConfirmation,
        userText: options.guardText ?? userText,
      };
      const toolResults = await Promise.all(
        clientToolCalls.map((call) => runTool(call, turn)),
      );
      messages.push({
        role: "assistant",
        textParts: response.textParts,
        toolCalls: response.toolCalls,
      });
      messages.push(...toolResults);
      continue;
    }

    if (
      !calendarRetryUsed &&
      response.toolCalls.length === 0 &&
      shouldForceCalendarTool(guardText, [...toolsUsed])
    ) {
      calendarRetryUsed = true;
      console.log(`Calendar-tool retry: iteration=${iteration}`);
      messages.push({
        role: "assistant",
        textParts: response.textParts,
        toolCalls: [],
      });
      messages.push({
        role: "user",
        content:
          "This question is about meetings, the schedule, or the calendar. Call list_events now. Use Asia/Kolkata dates (call get_current_time first if you do not yet know today's date). Omit account so both the personal and work calendars are read, unless Vishnu named only one. Answer from the tool result. Do not say there are no meetings unless list_events returned none.",
      });
      continue;
    }

    if (
      !deferredRetryUsed &&
      response.toolCalls.length === 0 &&
      looksLikeDeferredAction(responseText)
    ) {
      deferredRetryUsed = true;
      console.log(`Deferred-action retry: iteration=${iteration}`);
      messages.push({
        role: "assistant",
        textParts: response.textParts,
        toolCalls: [],
      });
      messages.push({
        role: "user",
        content:
          "Do that now. Call the necessary tool in this turn and reply with the result. Do not say you will do it later.",
      });
      continue;
    }

    if (response.stopReason === "pause_turn") {
      const partialReply =
        collectedText.join("\n\n") || "I couldn't finish the request.";
      return saveConversation(
        userText,
        `${partialReply}\n\nNote: the server-side tool continuation limit was reached.`,
        saveUserMessage,
        saveAssistantMessage,
      );
    }

    const finalReply =
      responseText ||
      collectedText.at(-1) ||
      "I couldn't produce a text response.";
    return saveConversation(
      userText,
      finalReply,
      saveUserMessage,
      saveAssistantMessage,
    );
  }

  const partialReply =
    collectedText.join("\n\n") || "I couldn't finish the request.";
  return saveConversation(
    userText,
    `${partialReply}\n\nNote: I hit the 8-iteration safety limit.`,
    saveUserMessage,
    saveAssistantMessage,
  );
}
