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
  /** One entry per call, in order: what ran and who ran it. */
  trace: Array<{ tool: string; owner: string; ok: boolean; reused?: boolean; ms: number }>;
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
    trace: [],
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
    console.log(
      `agent dispatch: refused agent=${ownership.owner} capability=${call.name} source=${ctx.grant?.source ?? "none"}`,
    );
    return { content: `Not done: ${decision.reason}`, isError: true };
  }

  const repeatable = ownership.effect === "read";
  const key = repeatable ? "" : stableKey(call.name, call.input);
  if (!repeatable && ctx.doneWrites.has(key)) {
    ctx.trace.push({ tool: call.name, owner: ownership.owner, ok: true, reused: true, ms: 0 });
    console.log(`agent dispatch: duplicate skipped agent=${ownership.owner} capability=${call.name}`);
    return { content: ctx.doneWrites.get(key)! };
  }

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
        input: call.input,
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
    outcome = { content: intercepted !== undefined ? intercepted : await tool.handler(call.input, turn) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outcome = { content: `Tool failed: ${message}`, isError: true };
  }
  const ms = Date.now() - startedAt;
  const ok = isSuccessfulToolResult(outcome.content, outcome.isError);
  if (!repeatable && ok) {
    ctx.doneWrites.set(key, outcome.content);
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
