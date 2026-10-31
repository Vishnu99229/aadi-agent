import type { LlmBackend, LlmMessage, LlmTool, ToolCall } from "./llm.js";
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
import type { ReactionSession } from "./contextual_react.js";
import {
  isSuccessfulToolResult,
  receiptFailureMessage,
  receiptRetryPrompt,
  unreceiptedClaims,
  type ToolReceipt,
} from "./receipt.js";
import {
  parseSearchSources,
  withSearchCitations,
  type SearchHit,
} from "./web_search.js";
import {
  SUMMARISE_SYSTEM,
  historyLimits,
  planHistoryWindow,
  redactSecrets,
  stubLongToolOutputs,
} from "./chat_history.js";

const TIME_ZONE = "Asia/Kolkata";
const MAX_ITERATIONS = 8;

const toolDefinitions: LlmTool[] = TOOL_ORDER.map(
  (name) => customTools[name]!.definition,
);

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

function saveAssistantReply(reply: string, saveAssistantMessage: boolean): string {
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
  /** Telegram context so react_to_message can call ctx.react. */
  ctx?: { react: (emoji: string) => Promise<unknown> };
  /** Parallel 👀 / 👍 on Vishnu's message when this turn uses tools. */
  reactions?: ReactionSession;
}

async function summariseOlderMessages(
  older: StoredMessage[],
  previous: string,
): Promise<string> {
  const lines = older.map((message) => {
    const body = redactSecrets(message.content).slice(0, 400);
    return `${message.role}: ${body}`;
  });
  const result = await complete({
    backend: getTaskBackend("chat"),
    effort: "low",
    cacheTtl: "5m",
    task: "other",
    maxTokens: 500,
    tools: [],
    system: {
      cacheable: SUMMARISE_SYSTEM,
    },
    messages: [
      {
        role: "user",
        content: redactSecrets(
          `${previous ? `Previous summary:\n${previous}\n\n` : ""}New turns:\n${lines.join("\n")}`,
        ),
      },
    ],
  });
  return redactSecrets(result.textParts.join("\n").trim() || previous);
}

function storedToLlmMessages(stored: StoredMessage[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  for (const message of stored) {
    if (message.role === "user") {
      out.push({ role: "user", content: message.content });
      continue;
    }
    const last = out.at(-1);
    if (last && last.role === "assistant") {
      last.textParts.push(message.content);
    } else {
      out.push({
        role: "assistant",
        textParts: [message.content],
        toolCalls: [],
      });
    }
  }
  return out;
}

async function historyForAgent(skipHistory: boolean): Promise<{
  summary: string;
  messages: StoredMessage[];
}> {
  if (skipHistory) {
    return { summary: "", messages: [] };
  }
  const lookback = historyLimits().keepMax + historyLimits().fold * 5;
  const all = getRecentMessages(lookback);
  const storedUntil = Number(getSetting(CONVERSATION_SUMMARY_UNTIL_KEY) ?? 0);
  let summary = getSetting(CONVERSATION_SUMMARY_KEY) ?? "";
  const plan = planHistoryWindow(all, storedUntil);
  let foldedBlocks = 0;
  for (const block of plan.folds) {
    const last = block.at(-1);
    if (!last) {
      continue;
    }
    try {
      summary = await summariseOlderMessages(block, summary);
      foldedBlocks += 1;
      setSetting(CONVERSATION_SUMMARY_KEY, summary);
      setSetting(CONVERSATION_SUMMARY_UNTIL_KEY, String(last.id));
      console.log(
        `history fold: count=${block.length} until_id=${last.id}`,
      );
    } catch (error) {
      const errorType = error instanceof Error ? error.name : "UnknownError";
      console.error(`Conversation summary failed (${errorType}).`);
      break;
    }
  }
  const dropped = plan.folds
    .slice(0, foldedBlocks)
    .reduce((count, block) => count + block.length, 0);
  const remaining = stubLongToolOutputs(
    all.filter((message) => message.id > storedUntil),
  );
  return { summary, messages: remaining.slice(dropped) };
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
  if (saveUserMessage) {
    saveMessage("user", userText);
  }
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

  const messages: LlmMessage[] = storedToLlmMessages(history.messages);
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
  let succeeded = false;
  let toolFailed = false;
  let receiptRetryUsed = false;
  const receipts: ToolReceipt[] = [];
  let searchSources: SearchHit[] = [];

  try {
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

      const taskTools = calledTools.filter((name) => name !== "react_to_message");
      if (taskTools.length > 0) {
        options.reactions?.noteWorking();
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
        ctx: options.ctx,
      };
      const toolResults = await Promise.all(
        clientToolCalls.map((call) => runTool(call, turn)),
      );
      if (toolResults.some((result) => result.isError)) {
        toolFailed = true;
      }
      for (let i = 0; i < clientToolCalls.length; i += 1) {
        const call = clientToolCalls[i]!;
        const result = toolResults[i]!;
        const success = isSuccessfulToolResult(result.content, result.isError);
        receipts.push({
          name: call.name,
          success,
        });
        if (call.name === "web_search" && success) {
          const hits = parseSearchSources(result.content);
          if (hits.length > 0) {
            searchSources = hits;
          }
        }
        if (saveAssistantMessage) {
          saveMessage("tool", result.content, call.name);
        }
      }
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
      return saveAssistantReply(
        `${partialReply}\n\nNote: the server-side tool continuation limit was reached.`,
        saveAssistantMessage,
      );
    }

    const reacted = toolsUsed.has("react_to_message");
    const finalReply =
      responseText ||
      collectedText.at(-1) ||
      (reacted ? "" : "I couldn't produce a text response.");
    if (!finalReply) {
      succeeded = !toolFailed;
      return "";
    }
    const missing = unreceiptedClaims(finalReply, receipts);
    if (missing.length > 0) {
      if (!receiptRetryUsed) {
        receiptRetryUsed = true;
        console.log(`receipt check: retry actions=${missing.join(",")}`);
        messages.push({
          role: "assistant",
          textParts: response.textParts,
          toolCalls: [],
        });
        messages.push({
          role: "user",
          content: receiptRetryPrompt(missing),
        });
        continue;
      }
      console.log(`receipt check: blocked actions=${missing.join(",")}`);
      succeeded = !toolFailed;
      return saveAssistantReply(
        receiptFailureMessage(missing),
        saveAssistantMessage,
      );
    }
    succeeded = !toolFailed;
    return saveAssistantReply(
      withSearchCitations(finalReply, searchSources),
      saveAssistantMessage,
    );
  }

  const partialReply =
    collectedText.join("\n\n") || "I couldn't finish the request.";
  return saveAssistantReply(
    `${partialReply}\n\nNote: I hit the 8-iteration safety limit.`,
    saveAssistantMessage,
  );
  } finally {
    void Promise.resolve(options.reactions?.finish(succeeded)).catch(
      () => undefined,
    );
  }
}
