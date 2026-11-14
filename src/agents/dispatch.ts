import type { ToolCall } from "../llm.js";
import { isSuccessfulToolResult } from "../receipt.js";
import { assertTestSeam } from "../test_seam.js";
import { tools as toolRegistry, type ToolTurn } from "../tools/index.js";
import { authorize, type AuthGrant } from "./auth.js";
import { toolOwnership } from "./registry.js";
import {
  beginInlineTask,
  closeInlineWorkflow,
  endInlineTask,
  openInlineWorkflow,
  type WorkflowOrigin,
} from "./store.js";
import { CORE_OWNER } from "./types.js";
import { cacheBypassed, cacheGet, cachePut, invalidateOwner, isCacheable } from "./cache.js";
import { CACHE_POLICIES, ownerWantsFresh, VOLATILE } from "./cache_policy.js";
import { contactQuestionAsked, contactQuestionMark } from "../contact_questions.js";
import { acquire } from "../governor.js";

/**
 * The single route from a model's tool call to a tool handler. Whoever asks
 * (Aadi's loop, or a specialist's), the call is checked against the caller's
 * allowlist and the turn's grant, handed to the agent that owns the tool, and
 * recorded as a delegated task.
 */
export const WORKER_ID = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
const INLINE_LEASE_MS = 10 * 60 * 1000;
const PREVIEW_CHARS = 200;

export interface ToolOutcome {
  content: string;
  isError?: boolean;
}

type ToolInterceptor = (call: ToolCall, turn: ToolTurn) => string | undefined;
let toolInterceptor: ToolInterceptor | undefined;

/** Lets a test or eval see which tools would run and answer them itself, so
 *  nothing real happens. Returning undefined runs the real tool. */
export function setToolInterceptorForTests(interceptor: ToolInterceptor | undefined): void {
  assertTestSeam("setToolInterceptorForTests");
  toolInterceptor = interceptor;
}

/** A tool call made inside a delegated task. */
export interface WorkflowToolRun {
  tool: string;
  ok: boolean;
  content: string;
}

const MAX_TRACKED_WORKFLOWS = 50;
const MAX_RUNS_PER_WORKFLOW = 60;
const workflowToolRuns = new Map<string, WorkflowToolRun[]>();

function noteWorkflowToolRun(workflowId: string, run: WorkflowToolRun): void {
  let runs = workflowToolRuns.get(workflowId);
  if (!runs) {
    if (workflowToolRuns.size >= MAX_TRACKED_WORKFLOWS) {
      workflowToolRuns.delete(workflowToolRuns.keys().next().value!);
    }
    runs = [];
    workflowToolRuns.set(workflowId, runs);
  }
  if (runs.length < MAX_RUNS_PER_WORKFLOW) {
    runs.push(run);
  }
}

/**
 * The tool calls the agents made while working on a workflow, handed over once.
 * Aadi uses it to know what a delegated job actually did (kept in memory only).
 */
export function takeWorkflowToolRuns(workflowId: string): WorkflowToolRun[] {
  const runs = workflowToolRuns.get(workflowId) ?? [];
  workflowToolRuns.delete(workflowId);
  return runs;
}

export interface TurnContext {
  /** Whose loop is asking: Aadi, or a specialist by id. */
  actor: string;
  origin: WorkflowOrigin;
  title: string;
  chatId?: number;
  grant?: AuthGrant;
  /** When set, nothing outside this list runs. */
  allowed?: ReadonlySet<string>;
  /** What the model is told about a tool outside the list. */
  notAllowedMessage?: string;
  /** Set when these calls happen inside a delegated task. */
  parentTaskId?: string;
  depth?: number;
  workflowId?: string;
  correlationId?: string;
  /** The call is already a recorded task of its own, so don't record it again. */
  skipRecord?: boolean;
  /** Results of writes already done this turn, so a repeated call can't do it twice. */
  doneWrites: Map<string, string>;
  /** Every successful call this turn, so a provider fallback can be handed the same result. */
  doneCalls: Map<string, string>;
  /** The model answering this step is a fallback. An identical call is not run again. */
  suppressRepeat: boolean;
  /** One entry per call, in order: what ran and who ran it. */
  trace: Array<{ tool: string; owner: string; ok: boolean; reused?: boolean; cached?: boolean; ms: number }>;
  /** Calls refused because the turn's grant doesn't allow them. */
  refused: number;
  /** Calls answered from the shared result cache. */
  cacheHits: number;
  /** Calls running right now, so an identical write started alongside waits for it. */
  inflight: Map<string, Promise<ToolOutcome>>;
}

export function newTurnContext(input: {
  actor?: string;
  origin?: WorkflowOrigin;
  title: string;
  chatId?: number;
  grant?: AuthGrant;
  allowed?: ReadonlySet<string>;
  notAllowedMessage?: string;
  parentTaskId?: string;
  depth?: number;
  workflowId?: string;
  correlationId?: string;
  skipRecord?: boolean;
}): TurnContext {
  return {
    actor: input.actor ?? CORE_OWNER,
    origin: input.origin ?? "chat",
    title: input.title,
    chatId: input.chatId,
    grant: input.grant,
    allowed: input.allowed,
    notAllowedMessage: input.notAllowedMessage,
    parentTaskId: input.parentTaskId,
    depth: input.depth,
    workflowId: input.workflowId,
    correlationId: input.correlationId,
    skipRecord: input.skipRecord,
    doneWrites: new Map(),
    doneCalls: new Map(),
    suppressRepeat: false,
    trace: [],
    refused: 0,
    cacheHits: 0,
    inflight: new Map(),
  };
}

function stableKey(name: string, input: unknown): string {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(sort);
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, sort(child)]),
      );
    }
    return value;
  };
  try {
    return `${name}:${JSON.stringify(sort(input))}`;
  } catch {
    return `${name}:?`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function withoutFresh(input: Record<string, unknown>): Record<string, unknown> {
  const { fresh: _fresh, ...rest } = input;
  return rest;
}

function ensureWorkflow(ctx: TurnContext): void {
  if (ctx.workflowId && ctx.correlationId) {
    return;
  }
  const opened = openInlineWorkflow({ title: ctx.title, origin: ctx.origin, chatId: ctx.chatId });
  ctx.workflowId = opened.workflowId;
  ctx.correlationId = opened.correlationId;
}

/** Marks the turn's workflow finished. Safe to call when no tool ran. */
export function closeTurnContext(ctx: TurnContext): void {
  if (!ctx.workflowId || ctx.parentTaskId) {
    return;
  }
  try {
    closeInlineWorkflow(ctx.workflowId);
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(`agent dispatch: close workflow failed (${errorType}).`);
  }
}

export async function dispatchTool(
  call: ToolCall,
  turn: ToolTurn,
  ctx: TurnContext,
): Promise<ToolOutcome> {
  if (ctx.allowed && !ctx.allowed.has(call.name)) {
    return {
      content: ctx.notAllowedMessage ?? "Tool is not available for a forwarded message.",
      isError: true,
    };
  }
  const tool = toolRegistry[call.name];
  const ownership = toolOwnership(call.name);
  if (!tool || !ownership) {
    return { content: `Unknown tool: ${call.name}`, isError: true };
  }
  // Under another agent's request, only a tool that is itself open to other agents runs.
  const decision = authorize(ctx.grant, {
    effect: ownership.effect,
    tool: call.name,
    remoteExposed: ownership.remoteExposed,
  });
  if (!decision.ok) {
    ctx.refused += 1;
    console.log(
      `agent dispatch: refused agent=${ownership.owner} capability=${call.name} source=${ctx.grant?.source ?? "none"}`,
    );
    return { content: `Not done: ${decision.reason}`, isError: true };
  }

  // `fresh` is for the cache only; the tool never sees it.
  const fresh = isRecord(call.input) && call.input.fresh === true;
  const input = isRecord(call.input) && "fresh" in call.input ? withoutFresh(call.input) : call.input;
  const repeatable = ownership.effect === "read";
  const key = stableKey(call.name, input);
  // A write is never run twice in a turn. A read is, unless this answer is a
  // fallback for a provider that already ran the same call.
  const prior = ctx.doneCalls.get(key);
  if (prior !== undefined && (!repeatable || ctx.suppressRepeat)) {
    ctx.trace.push({ tool: call.name, owner: ownership.owner, ok: true, reused: true, ms: 0 });
    console.log(
      `agent dispatch: duplicate skipped agent=${ownership.owner} capability=${call.name} fallback=${ctx.suppressRepeat}`,
    );
    return { content: prior };
  }

  // The same write started twice in one step (parallel calls): the second waits
  // for the first and gets its result instead of doing it again.
  const running = ctx.inflight.get(key);
  if (running && (!repeatable || ctx.suppressRepeat)) {
    const first = await running;
    ctx.trace.push({ tool: call.name, owner: ownership.owner, ok: !first.isError, reused: true, ms: 0 });
    console.log(`agent dispatch: duplicate joined agent=${ownership.owner} capability=${call.name}`);
    return first;
  }
  const execution = runCall(call, input, key, repeatable, fresh, ownership, turn, ctx);
  ctx.inflight.set(key, execution);
  try {
    return await execution;
  } finally {
    ctx.inflight.delete(key);
  }
}

async function runCall(
  call: ToolCall,
  input: unknown,
  key: string,
  repeatable: boolean,
  fresh: boolean,
  ownership: NonNullable<ReturnType<typeof toolOwnership>>,
  turn: ToolTurn,
  ctx: TurnContext,
): Promise<ToolOutcome> {
  const tool = toolRegistry[call.name]!;
  // The shared cache, behind every check above: only a caller allowed this tool
  // under its own grant ever sees a cached result for it. Data that changes
  // with his day is fetched again when his words ask for the current state.
  const cacheable = repeatable && isCacheable(call.name, input);
  const policy = CACHE_POLICIES[call.name];
  const wantsFresh = fresh || (policy !== undefined && VOLATILE.has(policy.freshness) && ownerWantsFresh(turn.userText ?? ctx.grant?.ownerText));
  if (cacheable && wantsFresh) {
    cacheBypassed(call.name, ctx.actor);
  } else if (cacheable) {
    const hit = cacheGet(call.name, input, ctx.actor);
    if (hit) {
      ctx.doneCalls.set(key, hit.result);
      ctx.cacheHits += 1;
      ctx.trace.push({ tool: call.name, owner: ownership.owner, ok: true, cached: true, ms: 0 });
      if (ctx.parentTaskId && ctx.workflowId) {
        noteWorkflowToolRun(ctx.workflowId, { tool: call.name, ok: true, content: hit.result });
      }
      console.log(`agent dispatch: cache hit actor=${ctx.actor} capability=${call.name} key=${hit.cacheKey}`);
      return { content: hit.result };
    }
  }
  const askChat = turn.confirmation?.chatId ?? ctx.chatId;
  const askMark = cacheable ? contactQuestionMark(askChat) : 0;

  let taskId: string | undefined;
  if (!ctx.skipRecord) {
    try {
      ensureWorkflow(ctx);
      taskId = beginInlineTask({
        workflowId: ctx.workflowId!,
        correlationId: ctx.correlationId!,
        parentTaskId: ctx.parentTaskId,
        agentId: ownership.owner,
        capability: call.name,
        input,
        authRef: ctx.grant?.ref,
        depth: ctx.depth,
        leaseOwner: WORKER_ID,
        leaseMs: INLINE_LEASE_MS,
      });
    } catch (error) {
      // The record is for the audit trail. Losing it must not lose the answer.
      const errorType = error instanceof Error ? error.name : "UnknownError";
      console.error(`agent dispatch: record failed (${errorType}).`);
    }
  }

  // A slot in the global scheduler; queued, not refused, when tools are busy.
  const slot = await acquire("tools");
  const startedAt = Date.now();
  let outcome: ToolOutcome;
  // A test stand-in that throws is simulating a crash, not a tool error: it is
  // recorded like any failure and then thrown on, as it always was.
  let crash: { error: unknown } | undefined;
  try {
    // The test seam stands in for the handler only: every check above still ran.
    let intercepted: string | undefined;
    try {
      intercepted = toolInterceptor?.(call, turn);
    } catch (error) {
      crash = { error };
      throw error;
    }
    outcome = { content: intercepted !== undefined ? intercepted : await tool.handler(input, turn) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outcome = { content: `Tool failed: ${message}`, isError: true };
  } finally {
    slot.release();
  }
  const ms = Date.now() - startedAt;
  const ok = isSuccessfulToolResult(outcome.content, outcome.isError);
  if (ok) {
    ctx.doneCalls.set(key, outcome.content);
    if (!repeatable) {
      ctx.doneWrites.set(key, outcome.content);
      // Something changed: this agent's cached reads may no longer be true.
      invalidateOwner(ownership.owner);
    }
  }
  // A read that asked Vishnu "which one?" opened a question; its answer isn't a reusable result.
  if (ok && cacheable && !contactQuestionAsked(askChat, askMark)) {
    try {
      cachePut(call.name, input, outcome.content, ctx.actor);
    } catch (error) {
      const errorType = error instanceof Error ? error.name : "UnknownError";
      console.error(`agent dispatch: cache write failed (${errorType}).`);
    }
  }
  ctx.trace.push({ tool: call.name, owner: ownership.owner, ok, ms });
  if (ctx.parentTaskId && ctx.workflowId) {
    noteWorkflowToolRun(ctx.workflowId, { tool: call.name, ok, content: outcome.content });
  }
  if (taskId) {
    try {
      endInlineTask(taskId, {
        state: outcome.isError ? "failed" : "completed",
        preview: outcome.content.slice(0, PREVIEW_CHARS),
        ...(outcome.isError
          ? {
              error: {
                code: "failed" as const,
                message: outcome.content.slice(0, PREVIEW_CHARS),
                retryable: false,
                uncertain: ownership.effect === "external",
              },
            }
          : {}),
      });
    } catch (error) {
      const errorType = error instanceof Error ? error.name : "UnknownError";
      console.error(`agent dispatch: record failed (${errorType}).`);
    }
  }
  console.log(
    `agent dispatch: actor=${ctx.actor} agent=${ownership.owner} capability=${call.name} ok=${ok} ms=${ms}`,
  );
  if (crash) {
    throw crash.error;
  }
  return outcome;
}
