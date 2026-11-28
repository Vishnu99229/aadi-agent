import { config } from "./config.js";
import type { LlmBackend, LlmMessage, LlmTool, ModelRoute, ToolCall } from "./llm.js";
import { resolveAgentModel, type ReasoningTier, type ResolvedAgentModel } from "./models/agent_models.js";
import type { LocalAgentModel } from "./models/local_agent_models.js";
import { completeOnLocalModel, LocalModelUnavailable } from "./local_agent_backend.js";
import { historyForSpecialist, type ContextMeasure } from "./agents/context.js";
import { readFile } from "node:fs/promises";
import { getTaskBackend, getTaskEffort, type ModelTask } from "./chat_backend.js";
import { contactQuestionAsked, contactQuestionMark } from "./contact_questions.js";
import { draftBodyFromCall, shortenDraftReply } from "./draft_confirm.js";
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
  SPECIALIST_ONLY_TOOLS,
  TOOL_ORDER,
  tools as customTools,
  type ToolTurn,
} from "./tools/index.js";
import {
  formatPendingDraftContext,
  type SendConfirmation,
} from "./approvals.js";
import { issueGrant, revokeGrant, type AuthGrant } from "./agents/auth.js";
import {
  closeTurnContext,
  dispatchTool,
  newTurnContext,
  type TurnContext,
} from "./agents/dispatch.js";
import { specialistFor } from "./agents/index.js";
import { toolOwnership } from "./agents/registry.js";
import { AgentTaskError } from "./agents/types.js";
import type { ReactionSession } from "./contextual_react.js";
import { isSuccessfulToolResult, isDeliveryTool, type ToolReceipt } from "./receipt.js";
import { confirmedSentReads, deliveryReadsFromTool, recordedReceipt } from "./receipt_records.js";
import { emailRecoveryForModel, hasEmailRecovery, recordEmailRecovery, type EmailRecovery } from "./email_recovery.js";
import { addEmailOutcomes, currentEmailTurn, hasEmailOutcomeLines, newEmailTurn, renderEmailOutcomes, withEmailTurn } from "./email_outcomes.js";
import {
  changeLines,
  checkReply,
  checkRetryPrompt,
  NOT_CHECKED_LABEL,
  NOTHING_CHANGED_TEXT,
  UNCONFIRMED_TEXT,
  type CheckedTool,
  type CheckedToolStatus,
  type CheckInput,
  type CheckResult,
  type ReplyCheckRecord,
} from "./reply_checker.js";
import { FORMAT_PROBLEM_TEXT, isRawPayload } from "./raw_text_guard.js";
import type { WorkflowToolRun } from "./agents/dispatch.js";
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
import { maybeShadowFoldSummary } from "./local_model.js";
import { modelForLegacyBackend } from "./models/registry.js";
import { assertTestSeam } from "./test_seam.js";

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
  "Sending email: when Vishnu tells you in this message, in any language, to send an email or to reply to someone, call send_email straight away with the names as he said them. It finds the address and writes the email, so never ask him for an address or for wording first, and don't look the address up yourself. For a reply, find the thread with search_emails and pass thread_id. Ask him only when send_email tells you to. Use confirm_send_pending_draft for delivery of an existing draft. A bare affirmation can confirm only the live card the current message replies to. When the owner asks for follow-ups on this turn’s delivery, call start_sequence with source current_send after the send tool returns. Pass follow-up count, interval, CTA and Cc policy as structured arguments. draft_new_email and draft_reply are for when he says draft, write or prepare. \"Remind me to email X\" stays set_reminder, and \"follow up on my email to X\" or \"remind me to follow up with X\" is start_sequence. Calendar: when he tells you to create an event, block his calendar or add something to it, call create_event right away, on the work calendar and 30 minutes unless he said otherwise, and don't ask which calendar or how long; to meet with someone, call book_meeting with the names as he said them; to delete, cancel or move an event, call delete_calendar_event or move_event. None of these needs a card or a tap, and create_meeting is unavailable. Use propose_calendar_event only when he says propose or park. For add_calendar_attendee, pass the name as he said it in attendee_email. Sending later: when he says send on Monday or a date or time, call send_email with send_on (and send_time if he gave one), and a short subject for a new email; these timers do exist. To schedule a Gmail draft he means, also pass its draft_id; never pass a draft_id for a different email, even one to the same person. A date inside what the email should say isn't a send date. To cancel one, call cancel_scheduled_send.";

function formatCurrentTime(): string {
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "full",
    timeStyle: "long",
    timeZone: TIME_ZONE,
  }).format(new Date());
}

export { setToolInterceptorForTests } from "./agents/dispatch.js";

/** What a meta-tool tells the loop to do besides answering the model. */
export interface MetaToolResult {
  content: string;
  isError?: boolean;
  /** Give the loop Aadi's own prompt and every tool from here on. */
  widen?: boolean;
  /** End the loop now with this as the reply. */
  stop?: string;
  /**
   * Tools that other agents ran while carrying this out. They are this turn's
   * records exactly as if called here, for the outcome lines and the reply check.
   */
  toolsRun?: readonly WorkflowToolRun[];
  /** The work is paused for Vishnu's answer or still running elsewhere. */
  deferred?: boolean;
}

/**
 * A tool the loop's caller carries out itself: handing work to other agents,
 * asking for more input, or handing the turn back to Aadi. These are never part
 * of TOOL_ORDER, so the cached tool prefix is unchanged.
 */
export interface MetaTool {
  definition: Extract<LlmTool, { type: "function" }>;
  handler: (input: unknown, turn: ToolTurn) => Promise<MetaToolResult> | MetaToolResult;
}

/** Filled in by runAgent so the caller can see what the turn did and cost. */
export interface RunReport {
  /** Each reply check this run, and what the loop did after it. */
  replyChecks?: ReplyCheckRecord[];
  agentId: string;
  llmCalls: number;
  costUsd: number;
  /** Context size of the first call. */
  inputTokens: number;
  /** Every call's input, cache included, and output. */
  totalInputTokens: number;
  outputTokens: number;
  backend?: string;
  /** The agent whose model setting this run used ("aadi" or a specialist id). */
  modelAgent?: string;
  /** The model the agent's setting put first for this run. */
  primaryModel?: string;
  /** What answered each model call, in order. */
  servedModels: string[];
  /** Model calls answered by something other than the primary. */
  fallbacks: number;
  /** Milliseconds from the start of the run to the first model answer. */
  firstModelMs?: number;
  /** Tool calls the dispatcher refused for lack of authorization. */
  authRefused?: number;
  /** Time spent queued in the global scheduler (model and tool slots). */
  queueMs?: number;
  /** Tool calls answered from the shared result cache. */
  cacheHits?: number;
  /** Context this run was given, against what it would have been given uncompressed. */
  context?: ContextMeasure;
  /** The run ended with a checked answer and no failed tool. */
  succeeded?: boolean;
  widened: boolean;
  stopped?: string;
  /** The stop was "which person do you mean?": Vishnu's answer re-runs his request. */
  contactQuestion?: boolean;
  tools: Array<{ tool: string; owner: string; ok: boolean; reused?: boolean; ms: number }>;
}

export function newRunReport(): RunReport {
  return {
    agentId: "aadi",
    llmCalls: 0,
    costUsd: 0,
    inputTokens: 0,
    totalInputTokens: 0,
    outputTokens: 0,
    servedModels: [],
    fallbacks: 0,
    widened: false,
    tools: [],
  };
}

/** Where a delegated run sits in its workflow, and what it may do. */
export interface DelegationContext {
  grant?: AuthGrant;
  parentTaskId: string;
  workflowId: string;
  correlationId: string;
  depth: number;
  signal?: AbortSignal;
  budgetUsd?: number;
  /** Shared by every goal loop of the workflow: calls, spend and time. */
  meter?: { reserve(): string | undefined; add(costUsd: number): void };
}

function sendIntentContext(confirmation: SendConfirmation | undefined): string {
  if (!confirmation) {
    return "";
  }
  return formatPendingDraftContext(confirmation);
}

/** What this loop may call and how each call is carried out. */
interface ToolScope {
  /** Set by a failed reply check: only these tools on the retry. */
  retryToolAllowed?: (name: string) => boolean;
  turnContext: TurnContext;
  meta: Map<string, MetaTool>;
  widen: () => void;
  stop: (reply: string) => void;
  /** Records tools that ran on this loop's behalf inside a delegated job. */
  credit: (runs: readonly WorkflowToolRun[]) => void;
}

type AgentToolResult = Extract<LlmMessage, { role: "tool" }> & {
  emailRecovery?: EmailRecovery;
  /** Ids of the outcomes the tool's write recorded (deliveries, cards). */
  recordIds?: string[];
};

function toolResultForModel(result: AgentToolResult): LlmMessage {
  const { emailRecovery, recordIds: _recordIds, ...raw } = result;
  if (!emailRecovery) return raw;
  return {
    ...raw,
    content: raw.content.replace(/\bTry again\./gi, "").trim() + emailRecoveryForModel(emailRecovery),
  };
}

/** Every tool call goes to the agent that owns the tool, through the dispatcher. */
async function runTool(
  call: ToolCall,
  turn: ToolTurn,
  state: ToolScope,
): Promise<AgentToolResult> {
  if (state.retryToolAllowed && (state.meta.has(call.name) || !state.retryToolAllowed(call.name))) {
    return { role: "tool", toolCallId: call.id, content: "Not done: only read tools are available while the reply is being corrected.", isError: true };
  }
  const meta = state.meta.get(call.name);
  if (meta) {
    if (state.turnContext.emailTurn.uncertain) {
      return { role: "tool", toolCallId: call.id, content: "An email write is unconfirmed. Use read-only tools to check its status.", isError: true };
    }
    try {
      const result = await meta.handler(call.input, turn);
      if (result.widen) {
        state.widen();
      }
      if (result.stop !== undefined) {
        state.stop(result.stop);
      }
      if (result.toolsRun && result.toolsRun.length > 0) {
        state.credit(result.toolsRun);
      }
      return {
        role: "tool",
        toolCallId: call.id,
        content: result.content + (result.toolsRun ?? []).flatMap(run => run.emailRecovery ? [emailRecoveryForModel(run.emailRecovery)] : []).join(""),
        ...(result.isError ? { isError: true } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { role: "tool", toolCallId: call.id, content: `Tool failed: ${message}`, isError: true };
    }
  }
  const outcome = await dispatchTool(call, turn, state.turnContext);
  return {
    role: "tool",
    toolCallId: call.id,
    content: outcome.content,
    ...(outcome.emailRecovery ? { emailRecovery: outcome.emailRecovery } : {}),
    ...(outcome.emailOutcomes?.length ? { recordIds: outcome.emailOutcomes.map((item) => item.id) } : {}),
    ...(outcome.isError ? { isError: true } : {}),
  };
}

/** A tool's status for the reply check, from the call's own records. */
function toolStatus(success: boolean, recovery: EmailRecovery | undefined, isError: boolean | undefined): CheckedToolStatus {
  const reason = recovery?.reason;
  if (reason === "write_unconfirmed") {
    return "uncertain";
  }
  if (success && !recovery) {
    return "ok";
  }
  if (
    reason === "provider_read_failed" || reason === "provider_rejected" || reason === "card_not_shown" ||
    reason === "draft_missing" || reason === "message_missing" || reason === "draft_closed"
  ) {
    return "failed";
  }
  if (reason) {
    return "refused";
  }
  return isError ? "failed" : "refused";
}

function statusLine(content: string): string {
  return (content.trim().split("\n", 1)[0] ?? "").slice(0, 160);
}

const FORMAT_RETRY_PROMPT =
  "Your last reply was raw data (JSON, or a tool call written out as text), so it was not sent and nothing in it was run. To use a tool, make a real tool call. Otherwise answer Vishnu in plain words.";

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
  /** Run as this specialist: its own prompt and only its own tools. */
  agentId?: string;
  /** Tools the caller carries out itself. Offered after the fixed tool list. */
  metaTools?: readonly MetaTool[];
  /** Set when this run is a task Aadi delegated, not a chat turn. */
  delegation?: DelegationContext;
  /** Filled in with what the run did and cost. */
  report?: RunReport;
  /** Extra lines for the part of the system prompt that changes each turn. */
  extraContext?: string;
  /** Fewer steps than the default limit, for a delegated task. */
  maxIterations?: number;
  /**
   * The agent doing the reasoning ("aadi" or a specialist id). When set, the
   * model comes from that agent's own model setting, not from task or backend.
   */
  modelAgent?: string;
  /** A goal's complexity, which replaces the agent's own tier for this run. */
  modelTier?: ReasoningTier;
}

type FoldSummaryResult = {
  summary: string;
  input: string;
  cloudBackend: string;
  cloudModel: string;
};

async function summariseOlderMessages(
  older: StoredMessage[],
  previous: string,
): Promise<FoldSummaryResult> {
  const chatBackend = getTaskBackend("chat");
  const input = buildSummarizerInput(older, previous);
  const result = await complete({
    backend: chatBackend,
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
        content: input,
      },
    ],
  });
  const summary = redactAllSecrets(
    result.textParts.join("\n").trim() || previous,
  );
  const cloudBackend = result.servedBy ?? chatBackend;
  const cloudModel =
    result.servedModel ??
    modelForLegacyBackend(chatBackend)?.modelId ??
    chatBackend;
  return { summary, input, cloudBackend, cloudModel };
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
      const folded = await summariseOlderMessages(block, summary);
      summary = folded.summary;
      foldedBlocks += 1;
      setSetting(CONVERSATION_SUMMARY_KEY, summary);
      setSetting(CONVERSATION_SUMMARY_UNTIL_KEY, String(last.id));
      console.log(
        `history fold: count=${block.length} until_id=${last.id}`,
      );
      // Shadow only after cloud fold succeeded and was saved. Never await.
      maybeShadowFoldSummary({
        input: folded.input,
        cloudSummary: summary,
        cloudBackend: folded.cloudBackend,
        cloudModel: folded.cloudModel,
        untilId: last.id,
      });
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

/** Test seam: same fold path runAgent uses, including fire-and-forget shadow. */
export async function historyForAgentForTests(skipHistory = false): Promise<{
  summary: string;
  messages: StoredMessage[];
}> {
  assertTestSeam("historyForAgentForTests");
  return historyForAgent(skipHistory);
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

/** Lines added under a reply that the laptop model was meant to answer but didn't. */
const LOCAL_NOTES = {
  unreachable: "(answered by cloud: laptop unreachable)",
  slow: "(answered by cloud: laptop too slow)",
  error: "(answered by cloud: laptop model error)",
  memory: "(answered by cloud: needed a memory write)",
  tool: "(answered by cloud: needed a tool the laptop model can't use)",
} as const;
type LocalNote = keyof typeof LOCAL_NOTES;

/** A specialist's run on the laptop model: its own read tools only, one deadline for the whole run. */
interface LocalRun {
  model: LocalAgentModel;
  readTools: ReadonlySet<string>;
  deadline: number;
}

/** The local run asked for a tool it isn't given, so the turn is rerun on cloud. */
class LocalRunAbort extends Error {
  constructor(
    readonly reason: "memory" | "tool",
    tool: string,
  ) {
    super(`the local run called ${tool}`);
    this.name = "LocalRunAbort";
  }
}

function withLine(reply: string, line: string): string {
  return reply.trim() ? `${reply}\n\n${line}` : reply;
}

/**
 * A run that starts on the laptop model, or an ordinary run. The rule is
 * structural, never a reading of his words: the laptop model is only ever given
 * its agent's read tools, and a call to anything else (a write, a tool it wasn't
 * given, or handing the turn back to Aadi) stops the run before the call runs
 * and the turn reruns on cloud (LocalRunAbort).
 */
function localPlan(
  options: RunAgentOptions,
): { model: LocalAgentModel; readTools: Set<string> } | undefined {
  if (options.backend || options.toolNames || !options.modelAgent || options.agentId !== options.modelAgent) {
    return undefined;
  }
  const model = resolveAgentModel(options.modelAgent, { tier: options.modelTier }).local;
  const specialist = model ? specialistFor(options.modelAgent) : undefined;
  if (!model || !specialist) {
    return undefined;
  }
  return {
    model,
    readTools: new Set(specialist.definition.tools.filter((tool) => tool.effect === "read").map((tool) => tool.name)),
  };
}

/**
 * One agent turn. An agent switched to the laptop model (Knowledge only; see
 * local_agent_models.ts) answers there first with its read tools. If the laptop
 * can't be reached, is too slow, or the turn needs anything else, the same turn
 * runs on the agent's cloud models with its normal tools, and the reply says why.
 */
export async function runAgent(
  userText: string,
  options: RunAgentOptions = {},
): Promise<string> {
  if (!currentEmailTurn()) {
    const journal = newEmailTurn();
    return withEmailTurn(journal, async () => {
      try {
        const reply = await runAgent(userText, options);
        return options.delegation ? reply : renderEmailOutcomes(journal, reply);
      } catch (error) {
        if (options.delegation || (journal.writes.size === 0 && journal.notices.size === 0 && journal.recoveries.size === 0)) throw error;
        const reply = renderEmailOutcomes(journal, "");
        return saveAssistantReply(reply, options.saveAssistantMessage ?? true);
      }
    });
  }
  const plan = localPlan(options);
  if (!plan) {
    return runAgentLoop(userText, options);
  }
  const startedAt = Date.now();
  const localReport = options.report ? newRunReport() : undefined;
  try {
    const reply = await runAgentLoop(
      userText,
      // Nothing is saved until the laptop has answered: a fallback saves its own turn.
      { ...options, saveUserMessage: false, saveAssistantMessage: false, report: localReport },
      { model: plan.model, readTools: plan.readTools, deadline: startedAt + plan.model.totalTimeoutMs },
    );
    if (options.saveUserMessage ?? true) {
      saveMessage("user", userText);
    }
    if (options.saveAssistantMessage ?? true) {
      saveMessage("assistant", reply);
    }
    if (options.report && localReport) {
      Object.assign(options.report, localReport);
    }
    const ms = Date.now() - startedAt;
    console.log(`local model: agent=${options.modelAgent} model=${plan.model.model} answered ms=${ms}`);
    return withLine(reply, `(${plan.model.model}, local, ${Math.round(ms / 1000)}s)`);
  } catch (error) {
    const note: LocalNote | undefined =
      error instanceof LocalModelUnavailable || error instanceof LocalRunAbort ? error.reason : undefined;
    if (!note) {
      throw error;
    }
    console.log(
      `local model: agent=${options.modelAgent} model=${plan.model.model} fell back to cloud reason=${note} ms=${Date.now() - startedAt}`,
    );
    return withLine(await runAgentLoop(userText, options), LOCAL_NOTES[note]);
  }
}

async function runAgentLoop(
  userText: string,
  options: RunAgentOptions,
  local?: LocalRun,
): Promise<string> {
  const saveUserMessage = options.saveUserMessage ?? true;
  const saveAssistantMessage = options.saveAssistantMessage ?? true;
  const saveReply = (reply: string, save: boolean): string => {
    if (save) {
      const journal = currentEmailTurn();
      saveAssistantReply(journal && !options.delegation ? renderEmailOutcomes(journal, reply) : reply, true);
    }
    return reply;
  };
  const promptUrl = new URL("../prompts/system.md", import.meta.url);
  const specialist = options.agentId ? specialistFor(options.agentId) : undefined;
  if (options.agentId && !specialist) {
    throw new Error(`Unknown agent: ${options.agentId}`);
  }
  // Aadi's own prompt is read only when Aadi's loop runs (or a specialist hands back).
  const readAadiPrompt = async (): Promise<string> => (await readFile(promptUrl, "utf8")).trim();
  const basePrompt = specialist ? await specialist.prompt() : await readAadiPrompt();
  const report = options.report;
  if (report) {
    report.agentId = specialist?.definition.id ?? "aadi";
  }
  const recentUpload = recentUploadLine();
  const memories = memoryContextLine(userText);
  // A specialist's own turn gets only what the request needs from the chat,
  // never the whole conversation. Aadi keeps its full window.
  let history: { summary: string; messages: StoredMessage[] };
  let historyRefs: string[] = [];
  if (specialist && !options.delegation && options.skipHistory !== true) {
    const compressStarted = Date.now();
    const storedUntil = Number(getSetting(CONVERSATION_SUMMARY_UNTIL_KEY) ?? 0);
    const recent = stubLongToolOutputs(
      getRecentMessages(historyLimits().keepMax).filter((message) => message.id > storedUntil),
    );
    const compressed = historyForSpecialist(
      options.guardText ?? userText,
      recent,
      getSetting(CONVERSATION_SUMMARY_KEY) ?? "",
      compressStarted,
    );
    history = { summary: compressed.summary, messages: compressed.messages };
    historyRefs = compressed.refs;
    if (report) {
      report.context = compressed.measure;
    }
  } else {
    history = await historyForAgent(options.skipHistory === true);
  }
  if (saveUserMessage) {
    saveMessage("user", userText);
  }
  const system = {
    cacheable: basePrompt.trim(),
    dynamic: [
      `Current date and time in ${TIME_ZONE}: ${formatCurrentTime()}`,
      sendIntentContext(options.sendConfirmation),
      "Report a delivery as new only after a send succeeded in this turn. When a mail lookup shows an earlier delivery, answer about that message and its date.",
      config.sendOnCommandEnabled && (!specialist || specialist.usesCommandTools())
        ? SEND_ON_COMMAND_NOTE
        : "",
      options.extraContext ?? "",
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
      historyRefs.length > 0
        ? `Earlier tool results referenced (open with your tools if needed): ${historyRefs.join(", ")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
  };

  const messages: LlmMessage[] = storedToLlmMessages(history.messages);
  messages.push({ role: "user", content: userText });

  const collectedText: string[] = [];
  const task = options.task ?? "chat";
  const startedAt = Date.now();
  // An agent's reasoning runs on that agent's own models. Everything else
  // (briefs, documents, background work) keeps its system model.
  let resolved: ResolvedAgentModel | undefined =
    options.modelAgent && !options.backend
      ? resolveAgentModel(options.modelAgent, { tier: options.modelTier })
      : undefined;
  const legacyBackend: LlmBackend = options.backend ?? getTaskBackend(task);
  const routeFor = (value: ResolvedAgentModel | undefined): ModelRoute | undefined =>
    value && value.models.length > 0 ? { agentId: value.agentId, models: value.models } : undefined;
  let route = routeFor(resolved);
  /** What the run asked for first: a backend name, or the route's first model key. */
  let primaryKey: string = local ? `local:${local.model.model}` : (route?.models[0]?.key ?? legacyBackend);
  const backend = legacyBackend;
  if (report) {
    report.backend = primaryKey;
    report.modelAgent = route ? options.modelAgent : undefined;
    report.primaryModel = primaryKey;
  }
  if (resolved) {
    console.log(
      `agent model: agent=${resolved.agentId} mode=${resolved.mode} tier=${resolved.tier} route=[${resolved.models.map((spec) => spec.key).join(", ")}]${resolved.skipped.length > 0 ? ` skipped=[${resolved.skipped.map((item) => `${item.key}:${item.reason}`).join("; ")}]` : ""}${resolved.safetyNet ? " safety_net=true" : ""}${local ? ` local=${local.model.model}` : ""}`,
    );
  }
  let effort =
    route
      ? resolved!.effort
      : backend === "claude" || backend === "haiku"
        ? getTaskEffort(task)
        : undefined;
  const toolsUsed = new Set<string>();
  const guardText = options.guardText ?? userText;
  const defaults = defaultToolNames(config.sendOnCommandEnabled);
  const ownScope: readonly string[] | undefined =
    options.toolNames ??
    (specialist
      ? [
          ...defaults.filter((name) => specialist.toolNames().includes(name)),
          // Tools only this specialist is offered (Aadi's own list doesn't have them).
          ...SPECIALIST_ONLY_TOOLS.filter((name) => specialist.toolNames().includes(name)),
        ]
      : undefined);
  // On the laptop model only the agent's own read tools are offered or run.
  const scopedNames: readonly string[] | undefined =
    local && ownScope ? ownScope.filter((name) => local.readTools.has(name)) : ownScope;
  const metaTools = new Map((options.metaTools ?? []).map((tool) => [tool.definition.name, tool]));
  const metaDefinitions: LlmTool[] = (options.metaTools ?? []).map((tool) => tool.definition);
  // What a local run may call: its read tools, and the task plumbing (report_result,
  // request_input). Handing the turn back to Aadi, or anything else, reruns it on cloud.
  const localAllowed = local
    ? new Set([...(scopedNames ?? []), ...[...metaTools.keys()].filter((name) => name !== "escalate_to_aadi")])
    : undefined;
  let activeTools: LlmTool[] = [
    ...(scopedNames
      ? scopedNames.map((name) => {
          const tool = customTools[name];
          if (!tool) {
            throw new Error(`Unknown tool: ${name}`);
          }
          return tool.definition;
        })
      : toolDefinitions),
    ...metaDefinitions,
  ];
  // Aadi issues one grant per turn. Agents only ever see its ref.
  const ownGrant = options.delegation
    ? undefined
    : issueGrant({
        source: options.sendConfirmation ? "owner_chat" : options.toolNames ? "forwarded" : "background",
        confirmation: options.sendConfirmation,
        ownerText: guardText,
        ctx: options.ctx,
      });
  const turnContext = newTurnContext({
    actor: specialist?.definition.id,
    origin: options.delegation ? "delegate" : "chat",
    title: options.delegation ? `${specialist?.definition.id ?? "aadi"} goal` : "chat turn",
    chatId: options.sendConfirmation?.chatId,
    grant: options.delegation ? options.delegation.grant : ownGrant,
    allowed: scopedNames ? new Set(scopedNames) : undefined,
    notAllowedMessage: options.toolNames
      ? undefined
      : specialist
        ? `That tool belongs to another agent. Call escalate_to_aadi if the request needs it.`
        : undefined,
    parentTaskId: options.delegation?.parentTaskId,
    workflowId: options.delegation?.workflowId,
    correlationId: options.delegation?.correlationId,
    depth: options.delegation ? options.delegation.depth + 1 : 0,
  });
  let stoppedReply: string | undefined;
  // A tool that can't tell who he means opens a question for this chat. The loop
  // ends on it, so the model can't go on and pick someone itself.
  const askChatId = (options.delegation?.grant?.confirmation ?? options.sendConfirmation)?.chatId;
  const contactMark = contactQuestionMark(askChatId);
  let widened = false;
  let aadiPrompt: string | undefined;
  const allowedTools: ToolScope = {
    turnContext,
    meta: metaTools,
    widen: () => {
      widened = true;
    },
    stop: (reply) => {
      stoppedReply = reply;
    },
    credit: (runs) => {
      for (const run of runs) {
        if (run.emailOutcomes) {
          addEmailOutcomes(run.emailOutcomes.filter(outcome => outcome.recordedAt >= turnContext.emailTurn.startedAt));
        }
        if (run.emailRecoveryUpdate) recordEmailRecovery(turnContext.emailTurn, run.emailRecoveryUpdate);
        toolsUsed.add(run.tool);
        noteToolReceipt({ name: run.tool, success: run.ok, content: run.content }, {
          recovery: run.emailRecovery,
          isError: !run.ok,
          recordIds: run.emailOutcomes?.map((item) => item.id),
        });
      }
    },
  };
  /** A specialist that needs another domain hands the turn back to Aadi. */
  const widenToAadi = async (): Promise<void> => {
    if (!specialist || turnContext.allowed === undefined || options.delegation || options.toolNames) {
      return;
    }
    aadiPrompt ??= await readAadiPrompt();
    system.cacheable = aadiPrompt;
    // Aadi carries on with Aadi's own model, as on any of Aadi's turns.
    if (route) {
      resolved = resolveAgentModel("aadi");
      route = routeFor(resolved);
      primaryKey = route?.models[0]?.key ?? legacyBackend;
      effort = resolved.effort;
      if (report) {
        report.modelAgent = "aadi";
      }
    }
    activeTools = [
      ...toolDefinitions,
      ...metaDefinitions.filter((tool) => tool.type === "function" && tool.name !== "escalate_to_aadi"),
    ];
    turnContext.allowed = undefined;
    turnContext.actor = "aadi";
    if (report) {
      report.widened = true;
    }
    console.log(`agent routing: ${specialist.definition.id} handed the turn back to Aadi`);
  };
  let succeeded = false;
  let toolFailed = false;
  /**
   * One retry per turn after a failed reply check: read tools only after a claim
   * the records don't support, the normal tools when the reply was incomplete.
   */
  let checkRetry: "none" | "read_only" | "tools" = "none";
  let formatRetryUsed = false;
  const receipts: ToolReceipt[] = [];
  /** This turn's tools as the reply checker sees them: records only, no bodies. */
  const checkedTools: CheckedTool[] = [];
  const receiptReads: ReturnType<typeof deliveryReadsFromTool> = [];
  let writeFailed = false;
  function noteToolReceipt(
    receipt: ToolReceipt,
    extra: { recovery?: EmailRecovery; isError?: boolean; recordIds?: readonly string[] } = {},
  ): void {
    receipts.push(receipt);
    const effect = toolOwnership(receipt.name)?.effect;
    if (effect === "read" && receipt.success && receipt.content !== undefined) {
      receiptReads.push(...deliveryReadsFromTool(receipt.name, receipt.content));
    }
    if (effect && effect !== "read" && (!receipt.success || extra.recovery)) {
      writeFailed = true;
      const reason = extra.recovery?.userMessage ?? receipt.content;
      if (reason?.trim()) turnContext.emailTurn.notices.add(reason);
    }
    if (effect && effect !== "read" && receipt.success && !extra.recovery) {
      turnContext.emailTurn.changed.add(receipt.name);
    }
    const writes = effect === "draft" || effect === "write" || effect === "external";
    checkedTools.push({
      name: receipt.name,
      effect: effect ?? (metaTools.has(receipt.name) ? "task" : "unknown"),
      status: toolStatus(receipt.success, extra.recovery, extra.isError),
      records: [...(extra.recordIds ?? [])],
      ...(writes && receipt.content ? { note: statusLine(receipt.content) } : {}),
    });
  }
  const draftBodies: string[] = [];
  let searchSources: SearchHit[] = [];
  /** The official release pages a release check read. They are cited ahead of search hits. */
  let releaseSources: SearchHit[] = [];

  const journal = turnContext.emailTurn;
  // Every model-written reply that goes to Vishnu is checked. A delegated step goes
  // back to Aadi's own loop (whose reply is checked), and the morning brief is a
  // scheduled report started by code or /brief, not a reply.
  const checksReplies = !options.delegation && options.task !== "brief";
  /** Code-written lines for writes the email journal has no line for. */
  const fallbackLead = (nothingLine: boolean): string[] => {
    const lines = changeLines(checkedTools, (tool) => tool.records.length > 0 || hasEmailRecovery(tool.name));
    return lines.length > 0 || hasEmailOutcomeLines(journal) || !nothingLine ? lines : [NOTHING_CHANGED_TEXT];
  };
  /** The reply as the checker sees it: his words, the draft, and this turn's records. */
  const checkInputFor = (reply: string): CheckInput => ({
    ownerMessage: guardText,
    reply,
    tools: checkedTools,
    recordedOutcomes: [...journal.writes.values()].map(({ id, line }) => ({ id, line })),
    deliveryGrounded: recordedReceipt({
      outcomeIds: journal.writes.keys(),
      reads: receiptReads,
      deliveryAttempted: receipts.some((receipt) => isDeliveryTool(receipt.name)),
      writeFailed,
    }),
    sendsFoundByLookup: confirmedSentReads(receiptReads),
    availableLookups: activeTools.flatMap((tool) =>
      tool.type === "function" && toolOwnership(tool.name)?.effect === "read" ? [tool.name] : [],
    ),
  });
  const recordCheck = (result: CheckResult | "raw_payload" | "step_limit", action: ReplyCheckRecord["action"]): void => {
    const entry: ReplyCheckRecord =
      result === "raw_payload"
        ? { verdict: "raw_payload", issues: [], ms: 0, action }
        : result === "step_limit"
          ? { verdict: "unavailable", issues: [], reason: "step limit before a corrected reply", ms: 0, action }
          : result.status === "checked"
          ? { verdict: result.verdict, issues: result.issues, model: result.model, ms: result.ms, action }
          : { verdict: "unavailable", issues: [], reason: result.reason, ms: result.ms, action };
    if (report) {
      (report.replyChecks ??= []).push(entry);
    }
    console.log(
      `reply check: verdict=${entry.verdict} action=${action}${entry.model ? ` model=${entry.model}` : ""}${entry.reason ? ` reason=${entry.reason}` : ""} ms=${entry.ms}`,
    );
  };
  /** Outcome lines first, then the reply under a label: never blocked silently. */
  const unchecked = (reply: string): string => [...fallbackLead(true), `${NOT_CHECKED_LABEL}\n${reply}`].join("\n\n");
  const withheld = (): string => [...fallbackLead(true), UNCONFIRMED_TEXT].join("\n\n");
  const formatProblem = (): string => [...fallbackLead(false), FORMAT_PROBLEM_TEXT].join("\n\n");
  /** A model-written reply the loop can't retry any more: one check, then send, label or withhold. */
  const finishOnce = async (reply: string): Promise<string> => {
    if (options.delegation) {
      return reply;
    }
    if (isRawPayload(reply)) {
      recordCheck("raw_payload", "format_withheld");
      return formatProblem();
    }
    if (!checksReplies) {
      return reply;
    }
    const result = await checkReply(checkInputFor(reply));
    if (result.status === "unavailable") {
      recordCheck(result, "sent_unchecked");
      return unchecked(reply);
    }
    if (result.verdict !== "ok") {
      recordCheck(result, "withheld");
      return withheld();
    }
    recordCheck(result, "sent");
    return reply;
  };

  const maxIterations = Math.max(1, Math.min(MAX_ITERATIONS, options.maxIterations ?? MAX_ITERATIONS));
  let spentUsd = 0;

  try {
  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    if (options.delegation?.signal?.aborted) {
      throw new AgentTaskError({ code: "canceled", message: "Canceled.", retryable: false });
    }
    if (options.delegation?.budgetUsd !== undefined && spentUsd >= options.delegation.budgetUsd) {
      throw new AgentTaskError({
        code: "budget_exceeded",
        message: `Stopped: this task used its model budget ($${options.delegation.budgetUsd.toFixed(2)}).`,
        retryable: false,
        uncertain: turnContext.trace.some((entry) => entry.ok),
      });
    }
    const refused = options.delegation?.meter?.reserve();
    if (refused) {
      throw new AgentTaskError({
        code: "budget_exceeded",
        message: refused,
        retryable: false,
        uncertain: turnContext.trace.some((entry) => entry.ok),
      });
    }
    const canUseRetryTool = allowedTools.retryToolAllowed;
    const scopedTools = canUseRetryTool
      ? activeTools.filter(tool => tool.type === "function" && !metaTools.has(tool.name) && canUseRetryTool(tool.name))
      : activeTools;
    const iterationTools = turnContext.emailTurn.uncertain
      ? scopedTools.filter(tool => tool.type === "function" && toolOwnership(tool.name)?.effect === "read")
      : scopedTools;
    const response = local
      ? await completeOnLocalModel({
          system,
          tools: iterationTools,
          messages,
          local: local.model,
          deadline: local.deadline,
          signal: options.delegation?.signal,
        })
      : await complete({
          system,
          tools: iterationTools,
          messages,
          ...(route ? { route } : { backend }),
          task: options.usageTask ?? usageTaskForAgent(options.task),
          effort,
        });
    if (localAllowed) {
      // Checked before anything runs: a write the laptop model reaches for is never made by it.
      const outside = response.toolCalls.find((call) => !localAllowed.has(call.name));
      if (outside) {
        const ownWrite = specialist?.definition.tools.some((tool) => tool.name === outside.name && tool.effect !== "read");
        throw new LocalRunAbort(ownWrite ? "memory" : "tool", outside.name);
      }
    }
    // A fallback sees the tool results of the provider that failed. Repeating
    // those calls would run the side effect twice, so identical calls are replayed.
    // This holds whichever provider or agent model the fallback lands on.
    turnContext.suppressRepeat = response.servedBy !== undefined && response.servedBy !== primaryKey;

    const responseText = response.textParts.join("\n").trim();
    if (responseText) {
      collectedText.push(responseText);
    }

    const calledTools = response.toolCalls.map((call) => call.name);
    for (const name of calledTools) {
      toolsUsed.add(name);
    }
    spentUsd += response.usage.estimatedCostUsd;
    if (report && response.queueMs) {
      report.queueMs = (report.queueMs ?? 0) + response.queueMs;
    }
    options.delegation?.meter?.add(response.usage.estimatedCostUsd);
    if (report) {
      const served = response.servedBy ?? primaryKey;
      report.backend = served;
      report.servedModels.push(served);
      if (served !== primaryKey) {
        report.fallbacks += 1;
      }
      if (report.firstModelMs === undefined) {
        report.firstModelMs = Date.now() - startedAt;
      }
      report.llmCalls += 1;
      report.costUsd += response.usage.estimatedCostUsd;
      report.totalInputTokens +=
        response.usage.inputTokens +
        (response.usage.cacheCreationInputTokens ?? 0) +
        (response.usage.cacheReadInputTokens ?? 0);
      report.outputTokens += response.usage.outputTokens;
      if (report.llmCalls === 1) {
        report.inputTokens =
          response.usage.inputTokens +
          (response.usage.cacheCreationInputTokens ?? 0) +
          (response.usage.cacheReadInputTokens ?? 0);
      }
    }
    const cacheCreationTokens = response.usage.cacheCreationInputTokens ?? 0;
    const cacheReadTokens = response.usage.cacheReadInputTokens ?? 0;

    console.log(
      `Agent iteration ${iteration}: agent=${turnContext.actor}, backend=${response.servedBy ?? primaryKey}, tools=[${calledTools.join(", ")}], input_tokens=${response.usage.inputTokens}, output_tokens=${response.usage.outputTokens}, cache_creation_input_tokens=${cacheCreationTokens}, cache_read_input_tokens=${cacheReadTokens}, estimated_cost_usd=${response.usage.estimatedCostUsd.toFixed(6)}`,
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
        // These calls came from the model's own response, not from code.
        modelCalled: true,
      };
      const toolResults: AgentToolResult[] = [];
      if (clientToolCalls.some(call => hasEmailRecovery(call.name))) {
        // An uncertain result must be observed before starting a second
        // write from this same batch. The normal dispatcher still dedupes it.
        for (const call of clientToolCalls) {
          toolResults.push(await runTool(call, turn, allowedTools));
        }
      } else {
        toolResults.push(...await Promise.all(clientToolCalls.map(call => runTool(call, turn, allowedTools))));
      }
      if (widened) {
        widened = false;
        await widenToAadi();
      }
      if (toolResults.some((result) => result.isError)) {
        toolFailed = true;
      }
      for (let i = 0; i < clientToolCalls.length; i += 1) {
        const call = clientToolCalls[i]!;
        const result = toolResults[i]!;
        const success = isSuccessfulToolResult(result.content, result.isError);
        noteToolReceipt({ name: call.name, success, content: result.content }, {
          recovery: result.emailRecovery,
          isError: result.isError,
          recordIds: result.recordIds,
        });
        const draftBody = draftBodyFromCall(call.name, call.input, success);
        if (draftBody) {
          draftBodies.push(draftBody);
        }
        if (call.name === "web_search" && success) {
          const hits = parseSearchSources(result.content);
          if (hits.length > 0) {
            searchSources = hits;
          }
        }
        if (call.name === "latest_release" && success) {
          const pages = parseSearchSources(result.content);
          if (pages.length > 0) {
            releaseSources = pages;
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
        ...(response.providerItems ? { providerItems: response.providerItems } : {}),
      });
      messages.push(...toolResults.map(toolResultForModel));
      const whichPerson = stoppedReply === undefined ? contactQuestionAsked(askChatId, contactMark) : undefined;
      if (whichPerson) {
        console.log(`contact question: asked iteration=${iteration}`);
        stoppedReply = whichPerson.text;
        if (report) {
          report.contactQuestion = true;
        }
      }
      if (stoppedReply !== undefined) {
        if (report) {
          report.stopped = stoppedReply;
        }
        succeeded = !toolFailed;
        return saveReply(stoppedReply, saveAssistantMessage);
      }
      continue;
    }

    if (response.stopReason === "pause_turn") {
      const partialReply =
        collectedText.join("\n\n") || "I couldn't finish the request.";
      succeeded = !toolFailed;
      return saveReply(
        await finishOnce(`${partialReply}\n\nNote: the server-side tool continuation limit was reached.`),
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
    if (!options.delegation) {
      // Raw data is never a reply, and a tool call written as text is never run.
      if (isRawPayload(finalReply)) {
        if (!formatRetryUsed) {
          formatRetryUsed = true;
          recordCheck("raw_payload", "format_retry");
          messages.push({ role: "assistant", textParts: response.textParts, toolCalls: [] });
          messages.push({ role: "user", content: FORMAT_RETRY_PROMPT });
          continue;
        }
        recordCheck("raw_payload", "format_withheld");
        succeeded = false;
        return saveReply(formatProblem(), saveAssistantMessage);
      }
    }
    if (checksReplies) {
      // Whether the reply is true to this turn's records is the checker's call.
      const input = checkInputFor(finalReply);
      const result = await checkReply(input);
      if (result.status === "unavailable") {
        recordCheck(result, "sent_unchecked");
        succeeded = !toolFailed;
        return saveReply(unchecked(finalReply), saveAssistantMessage);
      }
      if (result.verdict !== "ok") {
        if (checkRetry === "none") {
          checkRetry = result.verdict === "incomplete" ? "tools" : "read_only";
          recordCheck(result, checkRetry === "tools" ? "retry_tools" : "retry_read_only");
          if (checkRetry === "read_only") {
            allowedTools.retryToolAllowed = (name) => toolOwnership(name)?.effect === "read";
          }
          messages.push({ role: "assistant", textParts: response.textParts, toolCalls: [] });
          messages.push({ role: "user", content: checkRetryPrompt(result, input) });
          continue;
        }
        recordCheck(result, "withheld");
        succeeded = false;
        return saveReply(withheld(), saveAssistantMessage);
      }
      recordCheck(result, "sent");
    }
    succeeded = !toolFailed;
    return saveReply(
      // Sources come from the search tool's own results, never from the reply's words.
      // When the release list itself was read, it is the source.
      withSearchCitations(
        turnContext.emailTurn.writes.size > 0 ? finalReply : shortenDraftReply(finalReply, draftBodies),
        releaseSources.length > 0 ? releaseSources : searchSources,
      ),
      saveAssistantMessage,
    );
  }

  if (checkRetry !== "none") {
    // The corrected reply never arrived within the step limit.
    recordCheck("step_limit", "withheld");
    return saveReply(withheld(), saveAssistantMessage);
  }
  const partialReply =
    collectedText.join("\n\n") || "I couldn't finish the request.";
  return saveReply(
    await finishOnce(`${partialReply}\n\nNote: I hit the ${maxIterations}-iteration safety limit.`),
    saveAssistantMessage,
  );
  } finally {
    if (report) {
      report.tools = turnContext.trace;
      report.authRefused = turnContext.refused;
      report.cacheHits = turnContext.cacheHits;
      report.succeeded = succeeded;
    }
    closeTurnContext(turnContext);
    revokeGrant(ownGrant?.ref);
    void Promise.resolve(options.reactions?.finish(succeeded)).catch(
      () => undefined,
    );
  }
}
