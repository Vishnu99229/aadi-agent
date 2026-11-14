import { config } from "./config.js";
import type { LlmBackend, LlmMessage, LlmTool, ModelRoute, ToolCall, ToolChoice } from "./llm.js";
import { resolveAgentModel, type ReasoningTier, type ResolvedAgentModel } from "./models/agent_models.js";
import { historyForSpecialist, type ContextMeasure } from "./agents/context.js";
import { readFile } from "node:fs/promises";
import { getTaskBackend, getTaskEffort, type ModelTask } from "./chat_backend.js";
import { shouldForceCalendarTool } from "./calendar_guard.js";
import { contactQuestionAsked, contactQuestionMark } from "./contact_questions.js";
import { draftBodyFromCall, shortenDraftReply } from "./draft_confirm.js";
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
import { backendForcesTools, complete } from "./llm.js";
import {
  COMMAND_TOOLS,
  commandFamilyTools,
  commandIntents,
  forcedCommandTool,
  commandNotRunMessage,
  commandRetryPrompt,
  echoesEarlierReply,
  sequenceTargets,
  type CommandKind,
} from "./command_intent.js";
import type { UsageTask } from "./usage.js";
import { memoryContextLine } from "./memory.js";
import {
  getRecentUpload,
  getRecentUploads,
  recentUploadLine,
} from "./recent_upload.js";
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
  "Sending email: when Vishnu tells you in this message, in any language, to send an email or to reply to someone, call send_email straight away with the names as he said them. It finds the address and writes the email, so never ask him for an address or for wording first, and don't look the address up yourself. For a reply, find the thread with search_emails and pass thread_id. Ask him only when send_email tells you to. Never set send_immediately: it only makes a Send card. draft_new_email and draft_reply are for when he says draft, write or prepare. \"Remind me to email X\" stays set_reminder, and \"follow up on my email to X\" or \"remind me to follow up with X\" is start_sequence. Calendar: when he tells you to create an event, block his calendar or add something to it, call create_event right away, on the work calendar and 30 minutes unless he said otherwise, and don't ask which calendar or how long; to meet with someone, call book_meeting with the names as he said them; to delete, cancel or move an event, call delete_calendar_event or move_event. None of these needs a card or a tap, and create_meeting is unavailable. Use propose_calendar_event only when he says propose or park. For add_calendar_attendee, pass the name as he said it in attendee_email. Sending later: when he says send on Monday or a date or time, call send_email with send_on (and send_time if he gave one), and a short subject for a new email; these timers do exist. A date inside what the email should say isn't a send date. To cancel one, call cancel_scheduled_send.";

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
   * Tools that other agents ran while carrying this out. They count toward the
   * turn's "was the command actually run" check exactly as if called here.
   */
  toolsRun?: ReadonlyArray<{ tool: string; ok: boolean; content: string }>;
  /**
   * The work is paused for Vishnu's answer or still running elsewhere. The turn's
   * "was the command run" check stands down, so the model isn't pushed into
   * doing the action itself with a guessed value, or doing it twice.
   */
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
  /** The run ended with an answer and no failed tool or unrun command. */
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
  turnContext: TurnContext;
  meta: Map<string, MetaTool>;
  widen: () => void;
  stop: (reply: string) => void;
  /** Records tools that ran on this loop's behalf inside a delegated job. */
  credit: (runs: ReadonlyArray<{ tool: string; ok: boolean; content: string }>) => void;
  /** The command is in hand elsewhere (paused or still running). */
  defer: () => void;
}

/** Every tool call goes to the agent that owns the tool, through the dispatcher. */
async function runTool(
  call: ToolCall,
  turn: ToolTurn,
  state: ToolScope,
): Promise<Extract<LlmMessage, { role: "tool" }>> {
  const meta = state.meta.get(call.name);
  if (meta) {
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
      if (result.deferred) {
        state.defer();
      }
      return {
        role: "tool",
        toolCallId: call.id,
        content: result.content,
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
    ...(outcome.isError ? { isError: true } : {}),
  };
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
  let primaryKey: string = route?.models[0]?.key ?? legacyBackend;
  const backend = legacyBackend;
  if (report) {
    report.backend = primaryKey;
    report.modelAgent = route ? options.modelAgent : undefined;
    report.primaryModel = primaryKey;
  }
  if (resolved) {
    console.log(
      `agent model: agent=${resolved.agentId} mode=${resolved.mode} tier=${resolved.tier} route=[${resolved.models.map((spec) => spec.key).join(", ")}]${resolved.skipped.length > 0 ? ` skipped=[${resolved.skipped.map((item) => `${item.key}:${item.reason}`).join("; ")}]` : ""}${resolved.safetyNet ? " safety_net=true" : ""}`,
    );
  }
  let effort =
    route
      ? resolved!.effort
      : backend === "claude" || backend === "haiku"
        ? getTaskEffort(task)
        : undefined;
  const routeForcesTools = (): boolean => route?.models[0]?.forcesTools ?? false;
  let deferredRetryUsed = false;
  let calendarRetryUsed = false;
  let documentRewriteRetryUsed = false;
  let documentMultiReadRetryUsed = false;
  const toolsUsed = new Set<string>();
  const documentsRead = new Set<number>();
  const guardText = options.guardText ?? userText;
  // The nudges below read Vishnu's message. A delegated task isn't his message.
  const nudgeText = options.delegation ? "" : guardText;
  const defaults = defaultToolNames(config.sendOnCommandEnabled);
  const scopedNames: readonly string[] | undefined =
    options.toolNames ??
    (specialist
      ? [
          ...defaults.filter((name) => specialist.toolNames().includes(name)),
          // Tools only this specialist is offered (Aadi's own list doesn't have them).
          ...SPECIALIST_ONLY_TOOLS.filter((name) => specialist.toolNames().includes(name)),
        ]
      : undefined);
  const metaTools = new Map((options.metaTools ?? []).map((tool) => [tool.definition.name, tool]));
  const metaDefinitions: LlmTool[] = (options.metaTools ?? []).map((tool) => tool.definition);
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
  let commandDeferred = false;
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
    defer: () => {
      commandDeferred = true;
    },
    credit: (runs) => {
      for (const run of runs) {
        toolsUsed.add(run.tool);
        receipts.push({ name: run.tool, success: run.ok });
        if (isFamilyTool(run.tool)) {
          freshResults.push(run.content);
        }
        if (isActionTool(run.tool)) {
          actionResults.push(run.content);
        }
      }
    },
  };
  /** A specialist that needs another domain hands the turn back to Aadi. */
  const widenToAadi = async (): Promise<void> => {
    if (!specialist || turnContext.allowed === undefined || options.delegation) {
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
  const outsideScope = (name: string): boolean =>
    turnContext.allowed !== undefined && !turnContext.allowed.has(name);
  let succeeded = false;
  let toolFailed = false;
  let receiptRetryUsed = false;
  const receipts: ToolReceipt[] = [];
  const draftBodies: string[] = [];
  let searchSources: SearchHit[] = [];
  /** The official release pages a release check read. They are cited ahead of search hits. */
  let releaseSources: SearchHit[] = [];

  // An explicit command in his own message has to be answered by a tool that runs
  // this turn. Models, DeepSeek especially, can otherwise repeat an old answer
  // from the chat history without checking anything. Forwarded messages have no
  // confirmation and a fixed tool list, so this never applies to them.
  const ownTurnIntents: CommandKind[] =
    options.sendConfirmation && !options.toolNames ? commandIntents(guardText) : [];
  // A delegated task is one step of his request, so the whole-turn check stays with Aadi.
  const intents: CommandKind[] = options.delegation ? [] : ownTurnIntents;
  const earlierReplies = history.messages
    .filter((message) => message.role !== "user")
    .map((message) => message.content);
  const earlierToolResults = history.messages
    .filter((message) => message.role === "tool")
    .map((message) => message.content);
  // Results from this turn's command tools: lookups included (anything said this
  // turn is fresh), and the actions alone (what an echo is replaced with).
  const freshResults: string[] = [];
  const actionResults: string[] = [];
  const isFamilyTool = (name: string): boolean =>
    intents.some((kind) => commandFamilyTools(kind).includes(name));
  const isActionTool = (name: string): boolean =>
    intents.some((kind) => COMMAND_TOOLS[kind].includes(name));
  const forcing = (kinds: readonly CommandKind[]): { name: string } | undefined => {
    const forces = route ? routeForcesTools() : backendForcesTools(backend);
    const name = forces ? forcedCommandTool(kinds) : undefined;
    return name ? { name } : undefined;
  };
  const firstForced = forcing(intents);
  let toolChoice: ToolChoice | undefined = firstForced;
  let commandRetryUsed = false;
  let sequenceRunInCode = false;
  if (intents.length > 0) {
    console.log(`Command turn: kinds=${intents.join(",")} forced=${firstForced?.name ?? "none"}`);
  }

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
    const response = await complete({
      system,
      tools: activeTools,
      messages,
      ...(route ? { route } : { backend }),
      task: options.usageTask ?? usageTaskForAgent(options.task),
      effort,
      ...(toolChoice ? { toolChoice } : {}),
    });
    toolChoice = undefined;
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
      };
      const toolResults = await Promise.all(
        clientToolCalls.map((call) => runTool(call, turn, allowedTools)),
      );
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
        receipts.push({
          name: call.name,
          success,
        });
        const draftBody = draftBodyFromCall(call.name, call.input, success);
        if (draftBody) {
          draftBodies.push(draftBody);
        }
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
        if (call.name === "latest_release" && success) {
          const pages = parseSearchSources(result.content);
          if (pages.length > 0) {
            releaseSources = pages;
          }
        }
        if (isFamilyTool(call.name)) {
          freshResults.push(result.content);
        }
        if (isActionTool(call.name)) {
          actionResults.push(result.content);
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
      messages.push(...toolResults);
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
        return saveAssistantReply(stoppedReply, saveAssistantMessage);
      }
      continue;
    }

    const missingKinds = commandDeferred
      ? []
      : intents.filter((kind) => !commandFamilyTools(kind).some((name) => toolsUsed.has(name)));
    if (response.toolCalls.length === 0 && missingKinds.length > 0) {
      // A sequence request names the person in his words, so code runs the check
      // itself rather than trusting the model's answer.
      const targets =
        missingKinds.includes("sequence") && !sequenceRunInCode ? sequenceTargets(guardText) : undefined;
      if (targets) {
        sequenceRunInCode = true;
        console.log(`Command check: start_sequence run in code, targets=${targets.length} iteration=${iteration}`);
        const calls: ToolCall[] = targets.map((target, index) => ({
          id: `code_start_sequence_${iteration}_${index}`,
          name: "start_sequence",
          input: { prospect: target },
          execution: "client",
        }));
        const turn: ToolTurn = {
          iteration,
          calledTools: calls.map((call) => call.name),
          confirmation: options.sendConfirmation,
          userText: guardText,
          ctx: options.ctx,
        };
        const results: Array<Extract<LlmMessage, { role: "tool" }>> = [];
        for (const call of calls) {
          const result = await runTool(call, turn, allowedTools);
          results.push(result);
          toolsUsed.add(call.name);
          receipts.push({ name: call.name, success: isSuccessfulToolResult(result.content, result.isError) });
          freshResults.push(result.content);
          actionResults.push(result.content);
          if (result.isError) {
            toolFailed = true;
          }
          if (saveAssistantMessage) {
            saveMessage("tool", result.content, call.name);
          }
        }
        messages.push({ role: "assistant", textParts: [], toolCalls: calls });
        messages.push(...results);
        continue;
      }
      if (!commandRetryUsed) {
        commandRetryUsed = true;
        console.log(`Command check: retry kinds=${missingKinds.join(",")} iteration=${iteration}`);
        toolChoice = forcing(missingKinds);
        messages.push({
          role: "assistant",
          textParts: response.textParts,
          toolCalls: [],
        });
        messages.push({ role: "user", content: commandRetryPrompt(missingKinds) });
        continue;
      }
      console.log(`Command check: not run kinds=${missingKinds.join(",")}`);
      succeeded = false;
      return saveAssistantReply(commandNotRunMessage(missingKinds), saveAssistantMessage);
    }

    if (
      !calendarRetryUsed &&
      response.toolCalls.length === 0 &&
      shouldForceCalendarTool(nudgeText, [...toolsUsed])
    ) {
      calendarRetryUsed = true;
      console.log(`Calendar-tool retry: iteration=${iteration}`);
      if (outsideScope("list_events")) {
        await widenToAadi();
      }
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
      nudgeText,
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
      if (outsideScope("read_document")) {
        await widenToAadi();
      }
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
      looksLikeDocumentRewrite(nudgeText) &&
      recentUpload
    ) {
      documentRewriteRetryUsed = true;
      if (outsideScope("read_document")) {
        await widenToAadi();
      }
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
    if (
      intents.length > 0 &&
      echoesEarlierReply(finalReply, earlierReplies, freshResults, earlierToolResults)
    ) {
      // A tool ran, but the words are an earlier turn's. Show what the action said
      // now, or, when only a lookup ran, that nothing was done.
      console.log("Command check: reply repeated an earlier answer; using this turn's result");
      succeeded = !toolFailed && actionResults.length > 0;
      return saveAssistantReply(
        actionResults.length > 0 ? actionResults.join("\n\n") : commandNotRunMessage(intents),
        saveAssistantMessage,
      );
    }
    const missing = unreceiptedClaims(finalReply, receipts, {
      ownerText: guardText,
      isReadTool: (name) => toolOwnership(name)?.effect === "read",
    });
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
      // When the release list itself was read, it is the source. Articles a
      // search also turned up are cited only if the reply used them.
      withSearchCitations(
        shortenDraftReply(finalReply, draftBodies),
        releaseSources.length > 0 ? releaseSources : searchSources,
      ),
      saveAssistantMessage,
    );
  }

  const partialReply =
    collectedText.join("\n\n") || "I couldn't finish the request.";
  return saveAssistantReply(
    `${partialReply}\n\nNote: I hit the ${maxIterations}-iteration safety limit.`,
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
