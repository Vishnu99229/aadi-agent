import { db } from "../db.js";
import { resolveGrant, type AuthGrant } from "./auth.js";
import { WORKER_ID } from "./dispatch.js";
import type { AgentHandle, DependencyResult, ExecutionEnv } from "./handle.js";
import { findCapability, getAgent } from "./registry.js";
import {
  appendConversationMessage,
  claimTask,
  createApproval,
  createWorkflow,
  extendLease,
  forceTaskState,
  getCheckpoint,
  getTask,
  getWorkflow,
  listOrphanedInlineTasks,
  listPausedTasks,
  listRecoverableTasks,
  listWorkflowTasks,
  parseContextRefs,
  parseTaskError,
  parseTaskInput,
  parseTaskResult,
  pruneFinishedWorkflows,
  refreshWorkflowState,
  resolveApprovals,
  resumeTask,
  setCheckpoint,
  setRemoteTaskId,
  setTaskStatusMessage,
  settleTask,
  taskDependencies,
  type NewTask,
  type TaskRecord,
  type WorkflowOrigin,
  type WorkflowRecord,
} from "./store.js";
import { forgetGoalMetersForTests, goalLimits } from "./goal_policy.js";
import { messageBytes, resultMessage, taskMessage, toAgentResult, toMessagePriority } from "./protocol.js";
import { recordAgentMessage, recordWorkflowRun } from "../metrics.js";
import { currentPriority } from "../governor.js";
import {
  GOAL_CAPABILITY,
  isTerminal,
  type AgentTaskResult,
  type DelegationRequest,
  type TaskError,
  type TaskState,
} from "./types.js";

/**
 * Runs workflows. A task is written to SQLite before it is dispatched, claimed
 * by one worker, and moved between states in transactions. New work starts
 * straight away; a scan picks up whatever a restart or a retry delay left behind.
 */
export const MAX_CONCURRENT_TASKS = 3;
export const MAX_DELEGATION_DEPTH = 2;
const LEASE_MS = 3 * 60 * 1000;
const LEASE_RENEW_MS = 60 * 1000;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;
/** A chat turn waits this long for a retry before leaving it to the scan. */
const INLINE_RETRY_WAIT_MS = 8_000;
const RESUME_CHECKPOINT = "resume_input";

let backoffBaseMs = BACKOFF_BASE_MS;

/** Tests shorten the retry delay. */
export function setBackoffBaseMsForTests(ms: number | undefined): void {
  backoffBaseMs = ms ?? BACKOFF_BASE_MS;
}

export function backoffMs(attempt: number, base = backoffBaseMs): number {
  return Math.min(BACKOFF_MAX_MS, base * 2 ** Math.max(0, attempt - 1));
}

interface Running {
  controller: AbortController;
  promise: Promise<void>;
  cancelRequested: boolean;
}

const running = new Map<string, Running>();
const activeWorkflows = new Map<string, Promise<WorkflowSummary>>();

type WorkflowListener = (summary: WorkflowSummary) => void | Promise<void>;
let workflowListener: WorkflowListener | undefined;

/** Called when a durable workflow settles outside the turn that started it. */
export function setWorkflowListener(listener: WorkflowListener | undefined): void {
  workflowListener = listener;
}

export interface TaskSummary {
  key: string;
  taskId: string;
  contextId: string;
  agentId: string;
  capability: string;
  state: TaskState;
  attempts: number;
  text?: string;
  output?: Record<string, unknown>;
  nextAction?: string;
  inputRequired?: AgentTaskResult["inputRequired"];
  error?: TaskError;
  /** True when this task was created earlier under the same idempotency key. */
  reused?: boolean;
}

export interface WorkflowSummary {
  workflowId: string;
  title: string;
  state: TaskState;
  tasks: TaskSummary[];
}

function summarizeTask(task: TaskRecord, reused = false): TaskSummary {
  const result = parseTaskResult(task);
  return {
    key: task.task_key,
    taskId: task.task_id,
    contextId: task.context_id,
    agentId: task.agent_id,
    capability: task.capability,
    state: task.state,
    attempts: task.attempts,
    text: result?.text,
    output: result?.output,
    nextAction: result?.nextAction,
    inputRequired: result?.inputRequired,
    error: parseTaskError(task),
    ...(reused ? { reused: true } : {}),
  };
}

export function summarizeWorkflow(workflowId: string): WorkflowSummary | undefined {
  const workflow = getWorkflow(workflowId);
  if (!workflow) {
    return undefined;
  }
  return {
    workflowId,
    title: workflow.title,
    state: workflow.state,
    tasks: listWorkflowTasks(workflowId).map((task) => summarizeTask(task)),
  };
}

function toRequest(task: TaskRecord): DelegationRequest {
  return {
    workflowId: task.workflow_id,
    taskId: task.task_id,
    parentTaskId: task.parent_task_id ?? undefined,
    agentId: task.agent_id,
    capability: task.capability,
    input: parseTaskInput(task),
    contextRefs: parseContextRefs(task),
    contextId: task.context_id,
    correlationId: task.correlation_id,
    idempotencyKey: task.idempotency_key ?? undefined,
    deadline: task.deadline_at ?? undefined,
    authRef: task.auth_ref ?? undefined,
    depth: task.depth,
  };
}

function dependencyResults(task: TaskRecord): Record<string, DependencyResult> {
  const out: Record<string, DependencyResult> = {};
  for (const id of taskDependencies(task.task_id)) {
    const dep = getTask(id);
    if (!dep) {
      continue;
    }
    const result = parseTaskResult(dep);
    out[dep.task_key] = {
      key: dep.task_key,
      agentId: dep.agent_id,
      capability: dep.capability,
      state: dep.state,
      text: result?.text,
      output: result?.output,
    };
  }
  return out;
}

function buildEnv(task: TaskRecord, controller: AbortController, usage: { llmCalls: number; costUsd: number }): ExecutionEnv {
  const resume = getCheckpoint<Record<string, unknown>>(task.task_id, RESUME_CHECKPOINT);
  return {
    grant: resolveGrant(task.auth_ref ?? undefined),
    signal: controller.signal,
    resume: resume ? { input: resume } : undefined,
    dependencies: dependencyResults(task),
    checkpoint: {
      get: (name) => getCheckpoint(task.task_id, name),
      set: (name, value) => setCheckpoint(task.task_id, name, value),
    },
    remoteTaskId: task.remote_task_id ?? undefined,
    setRemoteTaskId: (remoteTaskId) => setRemoteTaskId(task.task_id, remoteTaskId),
    onStatus: (message) => setTaskStatusMessage(task.task_id, message),
    onUsage: (delta) => {
      usage.llmCalls += delta.llmCalls;
      usage.costUsd += delta.costUsd;
    },
    budgetUsd: task.budget_usd ?? undefined,
    attempt: task.attempts,
  };
}

function reject(task: TaskRecord, state: "rejected" | "failed", error: TaskError): void {
  settleTask(task.task_id, WORKER_ID, { state, error, statusMessage: error.message });
}

/** What to do with an attempt whose outcome isn't known. */
async function resolveUncertain(
  agent: AgentHandle,
  task: TaskRecord,
  env: ExecutionEnv,
  error: TaskError,
): Promise<{ state: TaskState; error?: TaskError; note: string; retryAt?: string }> {
  const policy = agent.retryPolicy(task.capability);
  const attemptsLeft = task.attempts < task.max_attempts;
  const retryAt = new Date(Date.now() + backoffMs(task.attempts)).toISOString();
  if (policy === "safe") {
    return attemptsLeft
      ? { state: "submitted", note: `retry after ${error.code}`, retryAt }
      : { state: "failed", error: { ...error, retryable: false }, note: "out of attempts" };
  }
  if (policy === "reconcile" && agent.reconcile) {
    const verdict = await agent.reconcile(toRequest(task), env).catch(() => "unknown" as const);
    if (verdict === "done") {
      return { state: "completed", note: "reconciled: already done" };
    }
    if (verdict === "not_done") {
      return attemptsLeft
        ? { state: "submitted", note: "reconciled: not done, retry", retryAt }
        : { state: "failed", error: { ...error, retryable: false }, note: "out of attempts" };
    }
  }
  return {
    state: "failed",
    error: {
      code: "uncertain_outcome",
      message: `${error.message} It may or may not have happened, so it was not run again. Check before repeating it.`,
      retryable: false,
      uncertain: true,
    },
    note: "uncertain outcome, not retried",
  };
}

async function executeClaimed(task: TaskRecord): Promise<void> {
  const controller = new AbortController();
  const usage = { llmCalls: 0, costUsd: 0 };
  const entry = running.get(task.task_id);
  if (entry) {
    entry.controller = controller;
  }
  const agent = getAgent(task.agent_id);
  if (!agent) {
    reject(task, "rejected", {
      code: "unknown_agent",
      message: `No agent named ${task.agent_id} is registered.`,
      retryable: false,
    });
    return;
  }
  if (!findCapability(task.agent_id, task.capability)) {
    reject(task, "rejected", {
      code: "unknown_capability",
      message: `${agent.manifest.name} has no capability "${task.capability}".`,
      retryable: false,
    });
    return;
  }
  if (task.depth > MAX_DELEGATION_DEPTH) {
    reject(task, "rejected", {
      code: "depth_exceeded",
      message: `Delegation is limited to ${MAX_DELEGATION_DEPTH} levels.`,
      retryable: false,
    });
    return;
  }
  const deadlineMs = task.deadline_at ? Date.parse(task.deadline_at) - Date.now() : undefined;
  if (deadlineMs !== undefined && deadlineMs <= 0) {
    reject(task, "failed", {
      code: "deadline_exceeded",
      message: "The deadline passed before this could start.",
      retryable: false,
    });
    return;
  }

  const env = buildEnv(task, controller, usage);
  const request = toRequest(task);
  // The typed task message, handed to the agent as an object (never serialized
  // to travel inside this process). Its size is measured for the experiment.
  const message = taskMessage(request, env.dependencies, { priority: toMessagePriority(currentPriority()) });
  env.message = message;
  recordAgentMessage(task.workflow_id, messageBytes(message));
  appendConversationMessage(task.context_id, task.task_id, "orchestrator", {
    capability: task.capability,
    attempt: task.attempts,
    ...(env.resume ? { resume: true, fields: Object.keys(env.resume.input) } : {}),
  });

  const renew = setInterval(() => {
    extendLease(task.task_id, WORKER_ID, LEASE_MS);
  }, LEASE_RENEW_MS);
  let deadlineTimer: NodeJS.Timeout | undefined;
  let deadlineHit = false;
  const deadline =
    deadlineMs === undefined
      ? undefined
      : new Promise<never>((_, rejectPromise) => {
          deadlineTimer = setTimeout(() => {
            deadlineHit = true;
            controller.abort();
            rejectPromise(new Error("deadline"));
          }, deadlineMs);
        });
  const aborted = new Promise<never>((_, rejectPromise) => {
    controller.signal.addEventListener("abort", () => rejectPromise(new Error("aborted")), { once: true });
  });
  aborted.catch(() => undefined);
  deadline?.catch(() => undefined);

  let result: AgentTaskResult;
  try {
    const work = env.resume ? agent.continueTask(request, env) : agent.executeTask(request, env);
    result = await Promise.race([work, aborted, ...(deadline ? [deadline] : [])]);
  } catch (error) {
    const cancelRequested = running.get(task.task_id)?.cancelRequested === true;
    const message = error instanceof Error ? error.message : String(error);
    result = {
      taskId: task.task_id,
      contextId: task.context_id,
      state: cancelRequested ? "canceled" : "failed",
      error: deadlineHit
        ? { code: "deadline_exceeded", message: "The deadline passed while this was running.", retryable: false, uncertain: true }
        : cancelRequested
          ? { code: "canceled", message: "Canceled.", retryable: false }
          : { code: "failed", message: message.slice(0, 300), retryable: false, uncertain: true },
    };
  } finally {
    clearInterval(renew);
    if (deadlineTimer) {
      clearTimeout(deadlineTimer);
    }
  }

  if (result.usage) {
    usage.llmCalls += result.usage.llmCalls;
    usage.costUsd += result.usage.costUsd;
  }
  recordAgentMessage(task.workflow_id, messageBytes(resultMessage(message, toAgentResult(result))));
  let state = result.state;
  let error = result.error;
  let note: string | undefined;
  let nextAttemptAt: string | undefined;
  if (state === "failed" && error && (error.retryable || error.uncertain) && error.code !== "deadline_exceeded") {
    const effect = findCapability(task.agent_id, task.capability)?.effect ?? "external";
    if (error.retryable && effect === "read") {
      // A read that failed changed nothing: just try it again.
      if (task.attempts < task.max_attempts) {
        state = "submitted";
        nextAttemptAt = new Date(Date.now() + backoffMs(task.attempts)).toISOString();
        note = `retry after ${error.code}`;
      }
    } else {
      const resolved = await resolveUncertain(agent, task, env, error);
      state = resolved.state;
      error = resolved.error;
      note = resolved.note;
      nextAttemptAt = resolved.retryAt;
    }
  }

  const paused = state === "input-required" || state === "auth-required";
  const settled = settleTask(task.task_id, WORKER_ID, {
    state,
    statusMessage: paused ? result.inputRequired?.question ?? result.text : state === "submitted" ? note : undefined,
    result:
      state === "submitted"
        ? undefined
        : {
            text: result.text,
            output: result.output,
            nextAction: result.nextAction,
            inputRequired: result.inputRequired,
          },
    error: state === "submitted" ? undefined : error,
    attemptError: result.error,
    artifacts: result.artifacts,
    usage,
    nextAttemptAt,
    note,
  });
  if (settled && env.resume && state !== "submitted") {
    setCheckpoint(task.task_id, RESUME_CHECKPOINT, null);
  }
  if (settled && paused) {
    // What the task is waiting on, on record until it is answered, dropped or expires.
    resolveApprovals(task.task_id, "expired");
    createApproval(
      task.task_id,
      state === "auth-required" ? "authorization" : "input",
      result.inputRequired?.question ?? result.text ?? "",
    );
  }
  if (settled) {
    appendConversationMessage(task.context_id, task.task_id, "agent", {
      state,
      ...(paused && result.inputRequired ? { question: result.inputRequired.question } : {}),
      ...(error ? { error: error.code } : {}),
    });
  }
  console.log(
    `agent engine: task=${task.task_id} agent=${task.agent_id} capability=${task.capability} state=${state} attempt=${task.attempts} llm_calls=${usage.llmCalls} cost_usd=${usage.costUsd.toFixed(6)}`,
  );
}

function startTask(taskId: string): boolean {
  if (running.has(taskId)) {
    return false;
  }
  const claimed = claimTask(taskId, WORKER_ID, LEASE_MS);
  if (!claimed) {
    return false;
  }
  const entry: Running = {
    controller: new AbortController(),
    cancelRequested: false,
    promise: Promise.resolve(),
  };
  running.set(taskId, entry);
  entry.promise = executeClaimed(claimed)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`agent engine: task=${taskId} crashed (${message.slice(0, 120)}).`);
      settleTask(taskId, WORKER_ID, {
        state: "failed",
        error: { code: "failed", message: message.slice(0, 300), retryable: false, uncertain: true },
      });
    })
    .finally(() => {
      running.delete(taskId);
    });
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function driveWorkflow(workflowId: string): Promise<WorkflowSummary> {
  const driveStartedAt = Date.now();
  let maxParallel = 0;
  for (;;) {
    const tasks = listWorkflowTasks(workflowId);
    const byId = new Map(tasks.map((task) => [task.task_id, task]));
    const now = Date.now();
    let started = 0;
    let soonest: number | undefined;
    for (const task of tasks) {
      if (task.state !== "submitted") {
        continue;
      }
      const deps = taskDependencies(task.task_id).map((id) => byId.get(id) ?? getTask(id));
      const broken = deps.find(
        (dep) => !dep || dep.state === "failed" || dep.state === "canceled" || dep.state === "rejected",
      );
      if (deps.length > 0 && broken !== undefined) {
        forceTaskState(task.task_id, "failed", {
          error: {
            code: "dependency_failed",
            message: `Not run: it depends on "${broken?.task_key ?? "a missing task"}", which ${broken?.state ?? "is missing"}.`,
            retryable: false,
          },
        });
        started += 1;
        continue;
      }
      if (deps.some((dep) => dep && dep.state !== "completed")) {
        continue;
      }
      const dueAt = task.next_attempt_at ? Date.parse(task.next_attempt_at) : 0;
      if (dueAt > now) {
        soonest = soonest === undefined ? dueAt : Math.min(soonest, dueAt);
        continue;
      }
      // startTask puts a task in `running` at once, so this count is already current.
      const inFlight = tasks.filter((item) => running.has(item.task_id));
      if (inFlight.length >= MAX_CONCURRENT_TASKS) {
        continue;
      }
      if (
        task.capability === GOAL_CAPABILITY &&
        inFlight.filter((item) => item.capability === GOAL_CAPABILITY).length >= goalLimits().maxConcurrent
      ) {
        continue;
      }
      if (startTask(task.task_id)) {
        started += 1;
      }
    }
    const inFlight = tasks
      .map((task) => running.get(task.task_id)?.promise)
      .filter((promise): promise is Promise<void> => promise !== undefined);
    maxParallel = Math.max(maxParallel, inFlight.length);
    if (inFlight.length > 0) {
      await Promise.race(inFlight);
      continue;
    }
    if (started > 0) {
      continue;
    }
    if (soonest !== undefined) {
      const wait = soonest - Date.now();
      const durable = tasks.some((task) => task.durable === 1 && task.state === "submitted");
      if (wait <= INLINE_RETRY_WAIT_MS) {
        await sleep(Math.max(0, wait));
        continue;
      }
      if (!durable) {
        // Nothing will come back for these, so don't leave them waiting forever.
        for (const task of tasks) {
          if (task.state === "submitted" && task.next_attempt_at) {
            forceTaskState(task.task_id, "failed", {
              error: { code: "transient", message: "Still failing after retries.", retryable: false },
            });
          }
        }
        continue;
      }
    }
    break;
  }
  refreshWorkflowState(workflowId);
  const summary = summarizeWorkflow(workflowId)!;
  const records = listWorkflowTasks(workflowId);
  recordWorkflowRun({
    workflowId,
    origin: getWorkflow(workflowId)?.origin,
    tasks: records.length,
    agents: records.map((task) => task.agent_id),
    maxParallel,
    ms: Date.now() - driveStartedAt,
    // Results the engine handed from one agent to the next with no model call in between.
    directHandoffs: records.filter((task) => taskDependencies(task.task_id).length > 0).length,
    completed: summary.tasks.every((task) => task.state === "completed"),
  });
  return summary;
}

/**
 * Runs everything in a workflow that can run now, and returns when nothing more
 * can: all done, or waiting on input, approval, or a later retry.
 */
export function runWorkflow(workflowId: string): Promise<WorkflowSummary> {
  const active = activeWorkflows.get(workflowId);
  if (active) {
    return active;
  }
  const promise = driveWorkflow(workflowId).finally(() => {
    activeWorkflows.delete(workflowId);
  });
  activeWorkflows.set(workflowId, promise);
  return promise;
}

export interface WorkflowPlan {
  title: string;
  origin: WorkflowOrigin;
  chatId?: number;
  grant?: AuthGrant;
  /** Survive a restart and be picked up by the recovery scan. */
  durable?: boolean;
  tasks: Array<Omit<NewTask, "authRef" | "durable">>;
}

/** Persists a workflow and starts it at once. */
export async function startWorkflow(plan: WorkflowPlan): Promise<WorkflowSummary> {
  const created = createWorkflow({
    title: plan.title,
    origin: plan.origin,
    chatId: plan.chatId,
    tasks: plan.tasks.map((task) => ({
      ...task,
      authRef: plan.grant?.ref,
      durable: plan.durable === true,
    })),
  });
  const summary = await runWorkflow(created.workflow.workflow_id);
  if (created.reused.size === 0) {
    return summary;
  }
  // A task that already existed under its idempotency key is reported, not re-run.
  const reused = [...created.reused.entries()].map(([key, task]) => ({
    ...summarizeTask(getTask(task.task_id) ?? task, true),
    key,
  }));
  return { ...summary, tasks: [...summary.tasks, ...reused] };
}

export interface DelegateInput {
  agentId: string;
  capability: string;
  input: Record<string, unknown>;
  title?: string;
  origin?: WorkflowOrigin;
  chatId?: number;
  grant?: AuthGrant;
  idempotencyKey?: string;
  durable?: boolean;
  deadlineMs?: number;
  budgetUsd?: number;
  maxAttempts?: number;
  parentTaskId?: string;
  depth?: number;
}

function toResult(task: TaskSummary): AgentTaskResult {
  return {
    taskId: task.taskId,
    contextId: task.contextId,
    state: task.state,
    text: task.text,
    output: task.output,
    nextAction: task.nextAction,
    inputRequired: task.inputRequired,
    error: task.error,
  };
}

/** One task for one agent: persisted, run now, and its result returned. */
export async function delegate(input: DelegateInput): Promise<AgentTaskResult> {
  const summary = await startWorkflow({
    title: input.title ?? `${input.agentId}.${input.capability}`,
    origin: input.origin ?? "delegate",
    chatId: input.chatId,
    grant: input.grant,
    durable: input.durable,
    tasks: [
      {
        key: "task",
        agentId: input.agentId,
        capability: input.capability,
        input: input.input,
        idempotencyKey: input.idempotencyKey,
        deadline: input.deadlineMs ? new Date(Date.now() + input.deadlineMs).toISOString() : undefined,
        budgetUsd: input.budgetUsd,
        maxAttempts: input.maxAttempts,
        parentTaskId: input.parentTaskId,
        depth: input.depth,
      },
    ],
  });
  return toResult(summary.tasks[0]!);
}

/**
 * Answers an input-required (or auth-required) task and runs it again. It is the
 * same task in the same conversation: no new task is created.
 */
export async function continueTask(
  taskId: string,
  input: Record<string, unknown>,
  grant?: AuthGrant,
): Promise<AgentTaskResult | undefined> {
  const task = getTask(taskId);
  if (!task || (task.state !== "input-required" && task.state !== "auth-required")) {
    return undefined;
  }
  setCheckpoint(taskId, RESUME_CHECKPOINT, input);
  const resumed = resumeTask(taskId, "answer received");
  if (!resumed) {
    return undefined;
  }
  resolveApprovals(taskId, "granted");
  if (grant) {
    reassignGrant(taskId, grant);
  }
  const summary = await runWorkflow(task.workflow_id);
  const settled = summary.tasks.find((item) => item.taskId === taskId);
  return settled ? toResult(settled) : undefined;
}


/** A continued task runs under the approval of the message that continued it. */
function reassignGrant(taskId: string, grant: AuthGrant): void {
  db.prepare(`UPDATE agent_tasks SET auth_ref = ? WHERE task_id = ?`).run(grant.ref, taskId);
}

export async function cancelTask(taskId: string, reason = "Canceled."): Promise<boolean> {
  const task = getTask(taskId);
  if (!task || isTerminal(task.state)) {
    return false;
  }
  const entry = running.get(taskId);
  if (entry) {
    entry.cancelRequested = true;
  }
  const agent = getAgent(task.agent_id);
  try {
    await agent?.cancelTask(task.remote_task_id ?? taskId);
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(`agent engine: cancel at agent failed (${errorType}).`);
  }
  forceTaskState(taskId, "canceled", {
    error: { code: "canceled", message: reason, retryable: false },
    note: "canceled",
  });
  resolveApprovals(taskId, "denied");
  entry?.controller.abort();
  refreshWorkflowState(task.workflow_id);
  return true;
}

export async function cancelWorkflow(workflowId: string, reason = "Canceled."): Promise<number> {
  let count = 0;
  for (const task of listWorkflowTasks(workflowId)) {
    if (!isTerminal(task.state) && (await cancelTask(task.task_id, reason))) {
      count += 1;
    }
  }
  refreshWorkflowState(workflowId);
  return count;
}

export async function getTaskStatus(taskId: string): Promise<TaskSummary | undefined> {
  const task = getTask(taskId);
  return task ? summarizeTask(task) : undefined;
}

export interface RecoveryReport {
  interrupted: number;
  resumed: number;
  uncertain: number;
  workflows: string[];
}

/**
 * Picks up what a restart or a retry delay left behind. A durable task that was
 * mid-attempt when the process died has an unknown outcome: it is retried only
 * if that is safe, or if the agent can confirm the work didn't happen.
 */
export async function recoverTasks(options: { wait?: boolean } = {}): Promise<RecoveryReport> {
  const report: RecoveryReport = { interrupted: 0, resumed: 0, uncertain: 0, workflows: [] };
  const now = new Date();
  for (const task of listOrphanedInlineTasks(now, WORKER_ID)) {
    // A task of a workflow this process is driving is waiting its turn, not lost.
    if (running.has(task.task_id) || activeWorkflows.has(task.workflow_id)) {
      continue;
    }
    const effect = findCapability(task.agent_id, task.capability)?.effect;
    forceTaskState(task.task_id, "failed", {
      error: {
        code: "interrupted",
        message: "Aadi restarted while this was running.",
        retryable: false,
        uncertain: effect !== undefined && effect !== "read",
      },
      note: "interrupted by restart",
    });
    refreshWorkflowState(task.workflow_id);
    report.interrupted += 1;
  }

  const workflows = new Set<string>();
  for (const task of listRecoverableTasks(now, WORKER_ID)) {
    if (running.has(task.task_id) || activeWorkflows.has(task.workflow_id)) {
      continue;
    }
    if (task.state === "working") {
      const agent = getAgent(task.agent_id);
      const lost: TaskError = {
        code: "interrupted",
        message: "Aadi restarted while this was running.",
        retryable: false,
        uncertain: true,
      };
      const controller = new AbortController();
      const resolved = agent
        ? await resolveUncertain(agent, task, buildEnv(task, controller, { llmCalls: 0, costUsd: 0 }), lost)
        : { state: "failed" as TaskState, error: lost, note: "agent no longer registered" };
      if (resolved.state === "submitted") {
        forceTaskState(task.task_id, "submitted", { note: resolved.note, nextAttemptAt: resolved.retryAt });
        report.resumed += 1;
      } else if (resolved.state === "completed") {
        // Take it back under this worker so the result can be recorded properly.
        forceTaskState(task.task_id, "submitted", { note: resolved.note });
        const claimed = claimTask(task.task_id, WORKER_ID, LEASE_MS);
        if (claimed) {
          settleTask(task.task_id, WORKER_ID, {
            state: "completed",
            result: { text: "Already done before the restart." },
            note: resolved.note,
          });
        }
        report.resumed += 1;
      } else {
        forceTaskState(task.task_id, "failed", { error: resolved.error, note: resolved.note });
        report.uncertain += 1;
      }
    } else {
      report.resumed += 1;
    }
    workflows.add(task.workflow_id);
  }

  report.workflows = [...workflows];
  const runs = report.workflows.map(async (workflowId) => {
    const summary = await runWorkflow(workflowId);
    if (workflowListener && summary.state !== "working") {
      await Promise.resolve(workflowListener(summary)).catch(() => undefined);
    }
  });
  if (options.wait) {
    await Promise.all(runs);
  } else {
    for (const run of runs) {
      run.catch((error: unknown) => {
        const errorType = error instanceof Error ? error.name : "UnknownError";
        console.error(`agent engine: recovery run failed (${errorType}).`);
      });
    }
  }
  if (report.interrupted + report.resumed + report.uncertain > 0) {
    console.log(
      `agent engine: recovery interrupted=${report.interrupted} resumed=${report.resumed} uncertain=${report.uncertain}`,
    );
  }
  return report;
}

const PAUSED_EXPIRY_MS = 3 * 86_400_000;

/** A question nobody answered for days is closed, so it can't be answered by accident later. */
export function expirePausedTasks(now = new Date()): number {
  let expired = 0;
  for (const task of listPausedTasks()) {
    if (now.getTime() - Date.parse(task.updated_at) < PAUSED_EXPIRY_MS) {
      continue;
    }
    forceTaskState(task.task_id, "canceled", {
      error: { code: "canceled", message: "Nobody answered, so this was dropped.", retryable: false },
      note: "expired while paused",
    });
    resolveApprovals(task.task_id, "expired");
    refreshWorkflowState(task.workflow_id);
    expired += 1;
  }
  return expired;
}

/** The periodic scan: recovery, then housekeeping. */
export async function recoveryTick(): Promise<void> {
  await recoverTasks();
  expirePausedTasks();
  pruneFinishedWorkflows();
}

export function runningTaskCount(): number {
  return running.size;
}

/** Forgets in-flight bookkeeping, as a process restart would. Tests only. */
export function simulateRestartForTests(): void {
  if (process.env.AADI_DB_PATH !== ":memory:") {
    throw new Error("simulateRestartForTests is only available in tests.");
  }
  running.clear();
  activeWorkflows.clear();
  forgetGoalMetersForTests();
}

export type { WorkflowRecord };
