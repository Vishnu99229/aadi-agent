import { config } from "./config.js";
import type { LlmBackend, LlmMessage, LlmTool, ToolCall } from "./llm.js";
import { readFile } from "node:fs/promises";
import { getTaskBackend, getTaskEffort, type ModelTask } from "./chat_backend.js";
import { shouldForceCalendarTool } from "./calendar_guard.js";
import { looksLikeDeferredAction } from "./deferred_action.js";
import {
  documentMultiReadRetryPrompt,
  documentRewriteRetryPrompt,
  looksLikeDocumentRewrite,
  resolveReferencedDocumentIds,
} from "./document_rewrite.js";
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
import {
  getRecentUpload,
  getRecentUploads,
  recentUploadLine,
} from "./recent_upload.js";
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
  buildSummarizerInput,
  historyLimits,
  planHistoryWindow,
  redactAllSecrets,
  stubLongToolOutputs,
} from "./chat_history.js";

const TIME_ZONE = "Asia/Kolkata";
const MAX_ITERATIONS = 8;

const COMMAND_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "send_email",
  "create_event",
  "book_meeting",
  "move_event",
  "cancel_scheduled_send",
]);

/** Off leaves the tool list exactly as it was, so nothing changes for the cached prefix. */
export function defaultToolNames(sendOnCommand: boolean): string[] {
  return TOOL_ORDER.filter((name) =>
    sendOnCommand ? name !== "create_meeting" : !COMMAND_ONLY_TOOLS.has(name),
  );
}

const toolDefinitions: LlmTool[] = defaultToolNames(config.sendOnCommandEnabled).map(
  (name) => customTools[name]!.definition,
);

const SPOKEN_ANSWER_NOTE =
  "Vishnu sent this as a voice note and will only hear your answer. Write it the way you'd say it out loud: no markdown, bullet points, numbered lists, headings, links, IDs or emoji, and say times and numbers the way people say them. Keep it short and easy to listen to, a few sentences and under about 80 words. If the full answer is long, such as a list, a document or many items, say a short summary and end with exactly: Want me to send that in writing? Buttons from any card a tool made appear on your voice note, so you can say \"tap Send\" or \"tap the one you mean\".";

const WRITTEN_ANSWER_NOTE =
  "Vishnu sent this as a voice note but wants the answer in writing. Give the full, detailed text answer. If he's saying yes to your offer to send something in writing, write out in full what you summarised before.";

const SEND_ON_COMMAND_NOTE =
  "Sending email: when Vishnu tells you in this message, in any language, to send an email or to reply to someone, call send_email straight away with the names as he said them. It finds the address and writes the email, so never ask him for an address or for wording first, and don't look the address up yourself. For a reply, find the thread with search_emails and pass thread_id. Ask him only when send_email tells you to. Never set send_immediately: it only makes a Send card. draft_new_email and draft_reply are for when he says draft, write or prepare. \"Remind me to email X\" stays set_reminder and \"follow up on my email to X\" stays track_thread. Calendar: when he tells you to create an event, block his calendar or add something to it, call create_event right away, on the work calendar and 30 minutes unless he said otherwise, and don't ask which calendar or how long; to meet with someone, call book_meeting with the names as he said them; to delete, cancel or move an event, call delete_calendar_event or move_event. None of these needs a card or a tap, and create_meeting is unavailable. Use propose_calendar_event only when he says propose or park. For add_calendar_attendee, pass the name as he said it in attendee_email. Sending later: when he says send on Monday or a date or time, call send_email with send_on (and send_time if he gave one), and a short subject for a new email; these timers do exist. A date inside what the email should say isn't a send date. To cancel one, call cancel_scheduled_send.";

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
  allowed?: ReadonlySet<string>,
): Promise<Extract<LlmMessage, { role: "tool" }>> {
  if (allowed && !allowed.has(call.name)) {
    return {
      role: "tool",
      toolCallId: call.id,
      content: "Tool is not available for a forwarded message.",
      isError: true,
    };
  }
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
  /** A voice note from Vishnu: answer as speech, or in full writing when he asked. */
  voiceAnswer?: "spoken" | "written";
  /** When set, only these tools are offered and executed. */
  toolNames?: readonly string[];
}

async function summariseOlderMessages(
  older: StoredMessage[],
  previous: string,
): Promise<string> {
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
        content: buildSummarizerInput(older, previous),
      },
    ],
  });
  return redactAllSecrets(result.textParts.join("\n").trim() || previous);
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
      config.sendOnCommandEnabled ? SEND_ON_COMMAND_NOTE : "",
      options.voiceAnswer === "spoken"
        ? SPOKEN_ANSWER_NOTE
        : options.voiceAnswer === "written"
          ? WRITTEN_ANSWER_NOTE
          : "",
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
  let documentRewriteRetryUsed = false;
  let documentMultiReadRetryUsed = false;
  const toolsUsed = new Set<string>();
  const documentsRead = new Set<number>();
  const guardText = options.guardText ?? userText;
  const allowedTools = options.toolNames ? new Set(options.toolNames) : undefined;
  const activeTools: LlmTool[] = options.toolNames
    ? options.toolNames.map((name) => {
        const tool = customTools[name];
        if (!tool) {
          throw new Error(`Unknown tool: ${name}`);
        }
        return tool.definition;
      })
    : toolDefinitions;
  let succeeded = false;
  let toolFailed = false;
  let receiptRetryUsed = false;
  const receipts: ToolReceipt[] = [];
  let searchSources: SearchHit[] = [];

  try {
  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration += 1) {
    const response = await complete({
      system,
      tools: activeTools,
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
        clientToolCalls.map((call) => runTool(call, turn, allowedTools)),
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
        if (call.name === "read_document") {
          const id = (call.input as { id?: unknown }).id;
          if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) {
            documentsRead.add(id);
          }
        }
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

    const neededDocIds = resolveReferencedDocumentIds(
      guardText,
      getRecentUploads(),
    );
    const missingDocIds = neededDocIds.filter((id) => !documentsRead.has(id));
    if (
      !documentMultiReadRetryUsed &&
      response.toolCalls.length === 0 &&
      neededDocIds.length > 0 &&
      missingDocIds.length > 0
    ) {
      documentMultiReadRetryUsed = true;
      console.log(
        `Document-multi-read retry: iteration=${iteration} ids=${missingDocIds.join(",")}`,
      );
      messages.push({
        role: "assistant",
        textParts: response.textParts,
        toolCalls: [],
      });
      messages.push({
        role: "user",
        content: documentMultiReadRetryPrompt(missingDocIds),
      });
      continue;
    }

    const recentUpload = getRecentUpload();
    if (
      !documentRewriteRetryUsed &&
      response.toolCalls.length === 0 &&
      !toolsUsed.has("read_document") &&
      looksLikeDocumentRewrite(guardText) &&
      recentUpload
    ) {
      documentRewriteRetryUsed = true;
      console.log(
        `Document-rewrite retry: iteration=${iteration} document_id=${recentUpload.documentId}`,
      );
      messages.push({
        role: "assistant",
        textParts: response.textParts,
        toolCalls: [],
      });
      messages.push({
        role: "user",
        content: documentRewriteRetryPrompt(recentUpload.documentId),
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
