import { randomUUID } from "node:crypto";
import { db } from "../db.js";
import {
  isTerminal,
  type AgentTaskResult,
  type Artifact,
  type ContextRef,
  type TaskError,
  type TaskState,
} from "./types.js";

/**
 * SQLite persistence for workflows and delegated tasks. Every state change is
 * one transaction that also writes a row to agent_task_events, so the history
 * of a task can be read back after the fact.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_workflows (
    workflow_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    origin TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'submitted',
    correlation_id TEXT NOT NULL,
    chat_id INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_agent_workflows_state
    ON agent_workflows (state, updated_at);

  CREATE TABLE IF NOT EXISTS agent_tasks (
    task_id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    parent_task_id TEXT,
    task_key TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    input_json TEXT NOT NULL DEFAULT '{}',
    context_refs_json TEXT NOT NULL DEFAULT '[]',
    context_id TEXT NOT NULL,
    remote_task_id TEXT,
    correlation_id TEXT NOT NULL,
    idempotency_key TEXT,
    auth_ref TEXT,
    durable INTEGER NOT NULL DEFAULT 0,
    inline INTEGER NOT NULL DEFAULT 0,
    depth INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'submitted'
      CHECK (state IN ('submitted', 'working', 'input-required', 'auth-required',
                       'completed', 'failed', 'canceled', 'rejected')),
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    next_attempt_at TEXT,
    deadline_at TEXT,
    lease_owner TEXT,
    lease_expires_at TEXT,
    status_message TEXT,
    result_json TEXT,
    error_json TEXT,
    llm_calls INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    budget_usd REAL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_agent_tasks_workflow
    ON agent_tasks (workflow_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_agent_tasks_state
    ON agent_tasks (state, durable, next_attempt_at);
  CREATE INDEX IF NOT EXISTS idx_agent_tasks_context
    ON agent_tasks (context_id);

  CREATE TABLE IF NOT EXISTS agent_task_deps (
    task_id TEXT NOT NULL,
    depends_on_task_id TEXT NOT NULL,
    PRIMARY KEY (task_id, depends_on_task_id)
  );

  CREATE INDEX IF NOT EXISTS idx_agent_task_deps_parent
    ON agent_task_deps (depends_on_task_id);

  CREATE TABLE IF NOT EXISTS agent_task_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    attempt_no INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    outcome TEXT,
    error_code TEXT,
    error_message TEXT,
    duration_ms INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_agent_task_attempts_task
    ON agent_task_attempts (task_id, attempt_no);

  CREATE TABLE IF NOT EXISTS agent_task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    at TEXT NOT NULL,
    from_state TEXT,
    to_state TEXT NOT NULL,
    note TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_agent_task_events_task
    ON agent_task_events (task_id, id);

  CREATE TABLE IF NOT EXISTS agent_artifacts (
    artifact_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    body_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_agent_artifacts_task
    ON agent_artifacts (task_id);

  CREATE TABLE IF NOT EXISTS agent_checkpoints (
    task_id TEXT NOT NULL,
    name TEXT NOT NULL,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (task_id, name)
  );

  CREATE TABLE IF NOT EXISTS agent_idempotency (
    idem_key TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_conversations (
    context_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_conversation_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    context_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('orchestrator', 'agent')),
    body_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_agent_conversation_messages_context
    ON agent_conversation_messages (context_id, id);

  CREATE TABLE IF NOT EXISTS agent_approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    prompt TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending'
      CHECK (state IN ('pending', 'granted', 'denied', 'expired')),
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_agent_approvals_task
    ON agent_approvals (task_id, state);

  CREATE TABLE IF NOT EXISTS agent_goal_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    tier TEXT NOT NULL,
    backend TEXT NOT NULL,
    model TEXT NOT NULL,
    llm_calls INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cost_usd REAL NOT NULL,
    latency_ms INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    error_code TEXT,
    result_chars INTEGER NOT NULL,
    tools_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_agent_goal_runs_workflow
    ON agent_goal_runs (workflow_id, id);
`);

// A database created before the inline column existed gets it added.
if (
  !(db.prepare(`PRAGMA table_info(agent_tasks)`).all() as Array<{ name: string }>).some(
    (column) => column.name === "inline",
  )
) {
  db.exec(`ALTER TABLE agent_tasks ADD COLUMN inline INTEGER NOT NULL DEFAULT 0`);
}

export type WorkflowOrigin =
  | "chat"
  | "fast_path"
  | "delegate"
  | "background"
  | "a2a"
  | "command";

export interface WorkflowRecord {
  workflow_id: string;
  title: string;
  origin: WorkflowOrigin;
  state: TaskState;
  correlation_id: string;
  chat_id: number | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface TaskRecord {
  task_id: string;
  workflow_id: string;
  /** 1 for a recorded tool call, 0 for a planned task. */
  inline: number;
  parent_task_id: string | null;
  task_key: string;
  agent_id: string;
  capability: string;
  input_json: string;
  context_refs_json: string;
  context_id: string;
  remote_task_id: string | null;
  correlation_id: string;
  idempotency_key: string | null;
  auth_ref: string | null;
  durable: number;
  depth: number;
  state: TaskState;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string | null;
  deadline_at: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  status_message: string | null;
  result_json: string | null;
  error_json: string | null;
  llm_calls: number;
  cost_usd: number;
  budget_usd: number | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const nowIso = (): string => new Date().toISOString();

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function recordEvent(taskId: string, from: TaskState | null, to: TaskState, note?: string): void {
  db.prepare(
    `INSERT INTO agent_task_events (task_id, at, from_state, to_state, note)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(taskId, nowIso(), from, to, note ? note.slice(0, 300) : null);
}

export interface NewTask {
  /** Names the task inside its workflow, for depends_on. */
  key: string;
  agentId: string;
  capability: string;
  input: Record<string, unknown>;
  contextRefs?: ContextRef[];
  dependsOn?: string[];
  parentTaskId?: string;
  idempotencyKey?: string;
  authRef?: string;
  durable?: boolean;
  depth?: number;
  maxAttempts?: number;
  deadline?: string;
  budgetUsd?: number;
  /** Continue an existing agent conversation instead of opening a new one. */
  contextId?: string;
}

export interface CreatedWorkflow {
  workflow: WorkflowRecord;
  tasks: TaskRecord[];
  /** Tasks whose idempotency key had already been used, mapped to the first task. */
  reused: Map<string, TaskRecord>;
}

/**
 * Writes a workflow, its tasks and their dependencies in one transaction, before
 * anything is dispatched. A task whose idempotency key was already used is not
 * created: the earlier task is returned in its place.
 */
export function createWorkflow(input: {
  title: string;
  origin: WorkflowOrigin;
  chatId?: number | null;
  correlationId?: string;
  tasks: NewTask[];
}): CreatedWorkflow {
  const keys = new Set<string>();
  for (const task of input.tasks) {
    if (keys.has(task.key)) {
      throw new Error(`Duplicate task key in workflow: ${task.key}`);
    }
    keys.add(task.key);
  }
  for (const task of input.tasks) {
    for (const dep of task.dependsOn ?? []) {
      if (!keys.has(dep)) {
        throw new Error(`Task ${task.key} depends on unknown task ${dep}`);
      }
    }
  }
  assertAcyclic(input.tasks);

  const run = db.transaction((): CreatedWorkflow => {
    const at = nowIso();
    const workflowId = newId("wf");
    const correlationId = input.correlationId ?? newId("corr");
    db.prepare(
      `INSERT INTO agent_workflows
         (workflow_id, title, origin, state, correlation_id, chat_id, created_at, updated_at)
       VALUES (?, ?, ?, 'submitted', ?, ?, ?, ?)`,
    ).run(workflowId, input.title.slice(0, 200), input.origin, correlationId, input.chatId ?? null, at, at);

    const idByKey = new Map<string, string>();
    const reused = new Map<string, TaskRecord>();
    for (const task of input.tasks) {
      if (task.idempotencyKey) {
        const earlier = db
          .prepare(`SELECT task_id FROM agent_idempotency WHERE idem_key = ?`)
          .get(task.idempotencyKey) as { task_id: string } | undefined;
        const earlierTask = earlier ? getTask(earlier.task_id) : undefined;
        if (earlierTask) {
          idByKey.set(task.key, earlierTask.task_id);
          reused.set(task.key, earlierTask);
          continue;
        }
      }
      const taskId = newId("task");
      idByKey.set(task.key, taskId);
      const contextId = task.contextId ?? newId("ctx");
      db.prepare(
        `INSERT INTO agent_tasks
           (task_id, workflow_id, parent_task_id, task_key, agent_id, capability,
            input_json, context_refs_json, context_id, correlation_id, idempotency_key,
            auth_ref, durable, depth, state, max_attempts, deadline_at, budget_usd,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?, ?, ?)`,
      ).run(
        taskId,
        workflowId,
        task.parentTaskId ?? null,
        task.key,
        task.agentId,
        task.capability,
        JSON.stringify(task.input ?? {}),
        JSON.stringify(task.contextRefs ?? []),
        contextId,
        correlationId,
        task.idempotencyKey ?? null,
        task.authRef ?? null,
        task.durable ? 1 : 0,
        task.depth ?? 0,
        Math.max(1, task.maxAttempts ?? 3),
        task.deadline ?? null,
        task.budgetUsd ?? null,
        at,
        at,
      );
      if (task.idempotencyKey) {
        db.prepare(
          `INSERT INTO agent_idempotency (idem_key, task_id, created_at) VALUES (?, ?, ?)`,
        ).run(task.idempotencyKey, taskId, at);
      }
      db.prepare(
        `INSERT INTO agent_conversations (context_id, agent_id, workflow_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(context_id) DO UPDATE SET updated_at = excluded.updated_at`,
      ).run(contextId, task.agentId, workflowId, at, at);
      recordEvent(taskId, null, "submitted", "created");
    }
    for (const task of input.tasks) {
      if (reused.has(task.key)) {
        continue;
      }
      for (const dep of task.dependsOn ?? []) {
        db.prepare(
          `INSERT OR IGNORE INTO agent_task_deps (task_id, depends_on_task_id) VALUES (?, ?)`,
        ).run(idByKey.get(task.key)!, idByKey.get(dep)!);
      }
    }
    const workflow = getWorkflow(workflowId)!;
    const tasks = input.tasks
      .filter((task) => !reused.has(task.key))
      .map((task) => getTask(idByKey.get(task.key)!)!);
    return { workflow, tasks, reused };
  });
  return run();
}

/**
 * The light path for a tool call inside a chat turn: one row when it starts and
 * one update when it ends. These tasks are a record of what ran, not a queue:
 * they are never retried, and one left `working` by a dead process is closed as
 * interrupted on the next start.
 */
export function openInlineWorkflow(input: {
  title: string;
  origin: WorkflowOrigin;
  chatId?: number | null;
}): { workflowId: string; correlationId: string } {
  const at = nowIso();
  const workflowId = newId("wf");
  const correlationId = newId("corr");
  db.prepare(
    `INSERT INTO agent_workflows
       (workflow_id, title, origin, state, correlation_id, chat_id, created_at, updated_at)
     VALUES (?, ?, ?, 'working', ?, ?, ?, ?)`,
  ).run(workflowId, input.title.slice(0, 200), input.origin, correlationId, input.chatId ?? null, at, at);
  return { workflowId, correlationId };
}

export function beginInlineTask(input: {
  workflowId: string;
  correlationId: string;
  parentTaskId?: string;
  agentId: string;
  capability: string;
  input: unknown;
  authRef?: string;
  depth?: number;
  leaseOwner: string;
  leaseMs: number;
}): string {
  const at = nowIso();
  const taskId = newId("task");
  let inputJson = "{}";
  try {
    inputJson = JSON.stringify(input ?? {}).slice(0, 4000);
  } catch {
    inputJson = "{}";
  }
  db.prepare(
    `INSERT INTO agent_tasks
       (task_id, workflow_id, parent_task_id, task_key, agent_id, capability, input_json,
        context_id, correlation_id, auth_ref, durable, inline, depth, state, attempts, max_attempts,
        lease_owner, lease_expires_at, created_at, updated_at, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, 'working', 1, 1, ?, ?, ?, ?, ?)`,
  ).run(
    taskId,
    input.workflowId,
    input.parentTaskId ?? null,
    taskId,
    input.agentId,
    input.capability,
    inputJson,
    input.workflowId,
    input.correlationId,
    input.authRef ?? null,
    input.depth ?? 0,
    input.leaseOwner,
    new Date(Date.now() + input.leaseMs).toISOString(),
    at,
    at,
    at,
  );
  return taskId;
}

export function endInlineTask(
  taskId: string,
  outcome: { state: Extract<TaskState, "completed" | "failed" | "rejected">; preview: string; error?: TaskError },
): void {
  const at = nowIso();
  db.prepare(
    `UPDATE agent_tasks
     SET state = ?, result_json = ?, error_json = ?, lease_owner = NULL, lease_expires_at = NULL,
         updated_at = ?, finished_at = ?
     WHERE task_id = ? AND state = 'working'`,
  ).run(
    outcome.state,
    JSON.stringify({ text: outcome.preview }),
    outcome.error ? JSON.stringify(outcome.error) : null,
    at,
    at,
    taskId,
  );
}

export function closeInlineWorkflow(workflowId: string): void {
  refreshWorkflowState(workflowId);
}

function assertAcyclic(tasks: NewTask[]): void {
  const deps = new Map(tasks.map((task) => [task.key, task.dependsOn ?? []]));
  const state = new Map<string, 1 | 2>();
  const visit = (key: string): void => {
    if (state.get(key) === 2) {
      return;
    }
    if (state.get(key) === 1) {
      throw new Error(`Workflow dependencies form a loop at ${key}`);
    }
    state.set(key, 1);
    for (const dep of deps.get(key) ?? []) {
      visit(dep);
    }
    state.set(key, 2);
  };
  for (const key of deps.keys()) {
    visit(key);
  }
}

export function getWorkflow(workflowId: string): WorkflowRecord | undefined {
  return db
    .prepare(`SELECT * FROM agent_workflows WHERE workflow_id = ?`)
    .get(workflowId) as WorkflowRecord | undefined;
}

export function getTask(taskId: string): TaskRecord | undefined {
  return db.prepare(`SELECT * FROM agent_tasks WHERE task_id = ?`).get(taskId) as
    | TaskRecord
    | undefined;
}

/**
 * The tasks a workflow was planned with. Tool calls made while carrying one out
 * are recorded too (inline = 1) for the audit trail, but they are not steps of
 * the plan: they are never scheduled, summarised or shown as results.
 */
export function listWorkflowTasks(workflowId: string): TaskRecord[] {
  return db
    .prepare(`SELECT * FROM agent_tasks WHERE workflow_id = ? AND inline = 0 ORDER BY created_at ASC, rowid ASC`)
    .all(workflowId) as TaskRecord[];
}

/** The tool calls recorded under a workflow, oldest first. */
export function listWorkflowToolCalls(workflowId: string): TaskRecord[] {
  return db
    .prepare(`SELECT * FROM agent_tasks WHERE workflow_id = ? AND inline = 1 ORDER BY created_at ASC, rowid ASC`)
    .all(workflowId) as TaskRecord[];
}

export function taskDependencies(taskId: string): string[] {
  return (
    db
      .prepare(`SELECT depends_on_task_id FROM agent_task_deps WHERE task_id = ?`)
      .all(taskId) as Array<{ depends_on_task_id: string }>
  ).map((row) => row.depends_on_task_id);
}

export function taskDependents(taskId: string): string[] {
  return (
    db
      .prepare(`SELECT task_id FROM agent_task_deps WHERE depends_on_task_id = ?`)
      .all(taskId) as Array<{ task_id: string }>
  ).map((row) => row.task_id);
}

/**
 * Takes a submitted task for one worker. The UPDATE only matches a task that is
 * still submitted and due, so two workers can never both get it.
 */
export function claimTask(taskId: string, leaseOwner: string, leaseMs: number): TaskRecord | undefined {
  const run = db.transaction((): TaskRecord | undefined => {
    const at = nowIso();
    const result = db
      .prepare(
        `UPDATE agent_tasks
         SET state = 'working',
             attempts = attempts + 1,
             lease_owner = ?,
             lease_expires_at = ?,
             next_attempt_at = NULL,
             started_at = COALESCE(started_at, ?),
             updated_at = ?
         WHERE task_id = ?
           AND state = 'submitted'
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
      )
      .run(leaseOwner, new Date(Date.now() + leaseMs).toISOString(), at, at, taskId, at);
    if (result.changes !== 1) {
      return undefined;
    }
    const task = getTask(taskId)!;
    db.prepare(
      `INSERT INTO agent_task_attempts (task_id, attempt_no, started_at) VALUES (?, ?, ?)`,
    ).run(taskId, task.attempts, at);
    recordEvent(taskId, "submitted", "working", `attempt ${task.attempts}`);
    touchWorkflow(task.workflow_id, "working");
    return task;
  });
  return run();
}

function finishAttempt(task: TaskRecord, outcome: string, error?: TaskError): void {
  const at = nowIso();
  db.prepare(
    `UPDATE agent_task_attempts
     SET finished_at = ?, outcome = ?, error_code = ?, error_message = ?,
         duration_ms = CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER)
     WHERE task_id = ? AND attempt_no = ? AND finished_at IS NULL`,
  ).run(at, outcome, error?.code ?? null, error?.message.slice(0, 300) ?? null, at, task.task_id, task.attempts);
}

function touchWorkflow(workflowId: string, state?: TaskState): void {
  const at = nowIso();
  if (state) {
    db.prepare(
      `UPDATE agent_workflows SET state = ?, updated_at = ?,
         finished_at = CASE WHEN ? IN ('completed','failed','canceled','rejected') THEN ? ELSE NULL END
       WHERE workflow_id = ?`,
    ).run(state, at, state, at, workflowId);
  } else {
    db.prepare(`UPDATE agent_workflows SET updated_at = ? WHERE workflow_id = ?`).run(at, workflowId);
  }
}

/** The workflow's state, worked out from its tasks. */
export function refreshWorkflowState(workflowId: string): TaskState {
  // A plan is judged by its planned tasks; a plain chat turn has only tool calls.
  const planned = listWorkflowTasks(workflowId);
  const tasks = planned.length > 0 ? planned : listWorkflowToolCalls(workflowId);
  const states = tasks.map((task) => task.state);
  let state: TaskState;
  if (states.length === 0) {
    state = "completed";
  } else if (states.some((value) => value === "working")) {
    state = "working";
  } else if (states.some((value) => value === "input-required")) {
    state = "input-required";
  } else if (states.some((value) => value === "auth-required")) {
    state = "auth-required";
  } else if (states.some((value) => value === "submitted")) {
    state = "working";
  } else if (states.every((value) => value === "completed")) {
    state = "completed";
  } else if (states.every((value) => value === "canceled")) {
    state = "canceled";
  } else if (states.some((value) => value === "failed" || value === "rejected")) {
    state = "failed";
  } else {
    // Some completed, the rest canceled.
    state = states.some((value) => value === "completed") ? "completed" : "canceled";
  }
  touchWorkflow(workflowId, state);
  return state;
}

export interface TaskOutcome {
  state: TaskState;
  statusMessage?: string;
  result?: Pick<AgentTaskResult, "text" | "output" | "nextAction" | "inputRequired">;
  error?: TaskError;
  artifacts?: Artifact[];
  usage?: { llmCalls: number; costUsd: number };
  remoteTaskId?: string;
  /** For a retry: when the task may be claimed again. */
  nextAttemptAt?: string;
  /** What went wrong in this attempt, kept on the attempt even when the task goes on to retry. */
  attemptError?: TaskError;
  note?: string;
}

/**
 * Moves a task this worker holds to its next state. Returns undefined when the
 * task is no longer held in `working` (cancelled, or taken over after its lease
 * ran out), so a late result can't overwrite a newer one.
 */
export function settleTask(taskId: string, leaseOwner: string, outcome: TaskOutcome): TaskRecord | undefined {
  const run = db.transaction((): TaskRecord | undefined => {
    const current = getTask(taskId);
    if (!current || current.state !== "working" || current.lease_owner !== leaseOwner) {
      return undefined;
    }
    const at = nowIso();
    const terminal = isTerminal(outcome.state);
    db.prepare(
      `UPDATE agent_tasks
       SET state = ?,
           status_message = ?,
           result_json = COALESCE(?, result_json),
           error_json = ?,
           remote_task_id = COALESCE(?, remote_task_id),
           llm_calls = llm_calls + ?,
           cost_usd = cost_usd + ?,
           next_attempt_at = ?,
           lease_owner = NULL,
           lease_expires_at = NULL,
           updated_at = ?,
           finished_at = ?
       WHERE task_id = ?`,
    ).run(
      outcome.state,
      outcome.statusMessage?.slice(0, 500) ?? null,
      outcome.result ? JSON.stringify(outcome.result) : null,
      outcome.error ? JSON.stringify(outcome.error) : null,
      outcome.remoteTaskId ?? null,
      outcome.usage?.llmCalls ?? 0,
      outcome.usage?.costUsd ?? 0,
      outcome.nextAttemptAt ?? null,
      at,
      terminal ? at : null,
      taskId,
    );
    for (const artifact of outcome.artifacts ?? []) {
      db.prepare(
        `INSERT OR REPLACE INTO agent_artifacts (artifact_id, task_id, name, kind, body_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        artifact.artifactId,
        taskId,
        artifact.name,
        artifact.kind,
        JSON.stringify(artifact.kind === "text" ? { text: artifact.text ?? "" } : { data: artifact.data ?? {} }),
        at,
      );
    }
    finishAttempt(current, outcome.state === "submitted" ? "retry" : outcome.state, outcome.error ?? outcome.attemptError);
    recordEvent(taskId, "working", outcome.state, outcome.note ?? outcome.error?.code);
    return getTask(taskId);
  });
  return run();
}

/** A resumed task gets a fresh set of attempts for the turn that follows. */
const RESUME_ATTEMPTS = 3;

/** Puts a paused task back in the queue with the answer it was waiting for. */
export function resumeTask(taskId: string, note: string): TaskRecord | undefined {
  const run = db.transaction((): TaskRecord | undefined => {
    const current = getTask(taskId);
    if (!current || (current.state !== "input-required" && current.state !== "auth-required")) {
      return undefined;
    }
    const at = nowIso();
    db.prepare(
      `UPDATE agent_tasks
       SET state = 'submitted', next_attempt_at = NULL, status_message = NULL,
           max_attempts = attempts + ?, updated_at = ?
       WHERE task_id = ?`,
    ).run(RESUME_ATTEMPTS, at, taskId);
    recordEvent(taskId, current.state, "submitted", note);
    touchWorkflow(current.workflow_id, "working");
    return getTask(taskId);
  });
  return run();
}

/** Ends a task that hasn't finished, whoever holds it. */
export function forceTaskState(
  taskId: string,
  state: Extract<TaskState, "canceled" | "failed" | "rejected" | "submitted">,
  detail: { error?: TaskError; note?: string; nextAttemptAt?: string } = {},
): TaskRecord | undefined {
  const run = db.transaction((): TaskRecord | undefined => {
    const current = getTask(taskId);
    if (!current || isTerminal(current.state)) {
      return undefined;
    }
    const at = nowIso();
    db.prepare(
      `UPDATE agent_tasks
       SET state = ?, error_json = ?, lease_owner = NULL, lease_expires_at = NULL,
           next_attempt_at = ?, updated_at = ?, finished_at = ?
       WHERE task_id = ?`,
    ).run(
      state,
      detail.error ? JSON.stringify(detail.error) : null,
      detail.nextAttemptAt ?? null,
      at,
      state === "submitted" ? null : at,
      taskId,
    );
    if (current.state === "working") {
      finishAttempt(current, state === "submitted" ? "retry" : state, detail.error);
    }
    recordEvent(taskId, current.state, state, detail.note ?? detail.error?.code);
    return getTask(taskId);
  });
  return run();
}

export function extendLease(taskId: string, leaseOwner: string, leaseMs: number): boolean {
  const result = db
    .prepare(
      `UPDATE agent_tasks SET lease_expires_at = ?, updated_at = ?
       WHERE task_id = ? AND state = 'working' AND lease_owner = ?`,
    )
    .run(new Date(Date.now() + leaseMs).toISOString(), nowIso(), taskId, leaseOwner);
  return result.changes === 1;
}

export function setRemoteTaskId(taskId: string, remoteTaskId: string): void {
  db.prepare(`UPDATE agent_tasks SET remote_task_id = ?, updated_at = ? WHERE task_id = ?`).run(
    remoteTaskId,
    nowIso(),
    taskId,
  );
}

export function setTaskStatusMessage(taskId: string, message: string): void {
  db.prepare(`UPDATE agent_tasks SET status_message = ?, updated_at = ? WHERE task_id = ?`).run(
    message.slice(0, 500),
    nowIso(),
    taskId,
  );
}

/**
 * Tasks a recovery scan should look at: durable, unfinished, and not held.
 *
 * Only one copy of Aadi ever runs against a database, so a lease held under any
 * other worker id belongs to a process that is gone. Passing this process's id
 * lets a restart pick such tasks up at once instead of waiting out the lease.
 */
export function listRecoverableTasks(now = new Date(), liveOwner = ""): TaskRecord[] {
  const at = now.toISOString();
  return db
    .prepare(
      `SELECT * FROM agent_tasks
       WHERE durable = 1
         AND (
           (state = 'submitted' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
           OR (state = 'working' AND (
                 lease_expires_at IS NULL OR lease_expires_at <= ?
                 OR (? != '' AND COALESCE(lease_owner, '') != ?)))
         )
       ORDER BY created_at ASC
       LIMIT 50`,
    )
    .all(at, at, liveOwner, liveOwner) as TaskRecord[];
}

/** Tasks that were mid-flight in a process that is gone and can't be resumed. */
export function listOrphanedInlineTasks(now = new Date(), liveOwner = ""): TaskRecord[] {
  return db
    .prepare(
      `SELECT * FROM agent_tasks
       WHERE durable = 0
         AND state IN ('working', 'submitted')
         AND (lease_expires_at IS NULL OR lease_expires_at <= ?
              OR (? != '' AND COALESCE(lease_owner, '') != ?))
       LIMIT 200`,
    )
    .all(now.toISOString(), liveOwner, liveOwner) as TaskRecord[];
}

export function listPausedTasks(chatId?: number): TaskRecord[] {
  if (chatId === undefined) {
    return db
      .prepare(
        `SELECT * FROM agent_tasks WHERE state IN ('input-required', 'auth-required')
         ORDER BY updated_at DESC LIMIT 50`,
      )
      .all() as TaskRecord[];
  }
  return db
    .prepare(
      `SELECT t.* FROM agent_tasks t
       JOIN agent_workflows w ON w.workflow_id = t.workflow_id
       WHERE t.state IN ('input-required', 'auth-required') AND w.chat_id = ?
       ORDER BY t.updated_at DESC LIMIT 50`,
    )
    .all(chatId) as TaskRecord[];
}

export function listWorkflows(options: {
  origins?: WorkflowOrigin[];
  limit?: number;
} = {}): WorkflowRecord[] {
  const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 15)));
  if (options.origins && options.origins.length > 0) {
    const marks = options.origins.map(() => "?").join(", ");
    return db
      .prepare(
        `SELECT * FROM agent_workflows WHERE origin IN (${marks})
         ORDER BY CASE WHEN finished_at IS NULL THEN 0 ELSE 1 END, updated_at DESC LIMIT ?`,
      )
      .all(...options.origins, limit) as WorkflowRecord[];
  }
  return db
    .prepare(
      `SELECT * FROM agent_workflows
       ORDER BY CASE WHEN finished_at IS NULL THEN 0 ELSE 1 END, updated_at DESC LIMIT ?`,
    )
    .all(limit) as WorkflowRecord[];
}

export function setCheckpoint(taskId: string, name: string, value: unknown): void {
  db.prepare(
    `INSERT INTO agent_checkpoints (task_id, name, value_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(task_id, name) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(taskId, name, JSON.stringify(value ?? null), nowIso());
}

export function getCheckpoint<T = unknown>(taskId: string, name: string): T | undefined {
  const row = db
    .prepare(`SELECT value_json FROM agent_checkpoints WHERE task_id = ? AND name = ?`)
    .get(taskId, name) as { value_json: string } | undefined;
  if (!row) {
    return undefined;
  }
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return undefined;
  }
}

export function appendConversationMessage(
  contextId: string,
  taskId: string,
  role: "orchestrator" | "agent",
  body: Record<string, unknown>,
): void {
  const at = nowIso();
  db.prepare(
    `INSERT INTO agent_conversation_messages (context_id, task_id, role, body_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(contextId, taskId, role, JSON.stringify(body), at);
  db.prepare(`UPDATE agent_conversations SET updated_at = ? WHERE context_id = ?`).run(at, contextId);
}

export interface ConversationMessage {
  role: "orchestrator" | "agent";
  taskId: string;
  body: Record<string, unknown>;
  createdAt: string;
}

export function listConversationMessages(contextId: string): ConversationMessage[] {
  const rows = db
    .prepare(
      `SELECT role, task_id, body_json, created_at FROM agent_conversation_messages
       WHERE context_id = ? ORDER BY id ASC`,
    )
    .all(contextId) as Array<{ role: "orchestrator" | "agent"; task_id: string; body_json: string; created_at: string }>;
  return rows.map((row) => {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(row.body_json) as Record<string, unknown>;
    } catch {
      body = {};
    }
    return { role: row.role, taskId: row.task_id, body, createdAt: row.created_at };
  });
}

export function listTaskArtifacts(taskId: string): Artifact[] {
  const rows = db
    .prepare(`SELECT artifact_id, name, kind, body_json FROM agent_artifacts WHERE task_id = ? ORDER BY created_at ASC`)
    .all(taskId) as Array<{ artifact_id: string; name: string; kind: "text" | "data"; body_json: string }>;
  return rows.map((row) => {
    let body: { text?: string; data?: Record<string, unknown> } = {};
    try {
      body = JSON.parse(row.body_json) as typeof body;
    } catch {
      body = {};
    }
    return { artifactId: row.artifact_id, name: row.name, kind: row.kind, text: body.text, data: body.data };
  });
}

export interface TaskEventRecord {
  at: string;
  from_state: TaskState | null;
  to_state: TaskState;
  note: string | null;
}

export function listTaskEvents(taskId: string): TaskEventRecord[] {
  return db
    .prepare(`SELECT at, from_state, to_state, note FROM agent_task_events WHERE task_id = ? ORDER BY id ASC`)
    .all(taskId) as TaskEventRecord[];
}

export interface TaskAttemptRecord {
  attempt_no: number;
  started_at: string;
  finished_at: string | null;
  outcome: string | null;
  error_code: string | null;
  error_message: string | null;
  duration_ms: number | null;
}

export function listTaskAttempts(taskId: string): TaskAttemptRecord[] {
  return db
    .prepare(
      `SELECT attempt_no, started_at, finished_at, outcome, error_code, error_message, duration_ms
       FROM agent_task_attempts WHERE task_id = ? ORDER BY attempt_no ASC, id ASC`,
    )
    .all(taskId) as TaskAttemptRecord[];
}

export function createApproval(taskId: string, kind: string, prompt: string): number {
  const result = db
    .prepare(`INSERT INTO agent_approvals (task_id, kind, prompt, created_at) VALUES (?, ?, ?, ?)`)
    .run(taskId, kind, prompt.slice(0, 500), nowIso());
  return Number(result.lastInsertRowid);
}

export function resolveApprovals(taskId: string, state: "granted" | "denied" | "expired"): number {
  return db
    .prepare(
      `UPDATE agent_approvals SET state = ?, resolved_at = ? WHERE task_id = ? AND state = 'pending'`,
    )
    .run(state, nowIso(), taskId).changes;
}

export function pendingApprovalCount(taskId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM agent_approvals WHERE task_id = ? AND state = 'pending'`)
    .get(taskId) as { n: number };
  return row.n;
}

export function parseTaskResult(task: TaskRecord): TaskOutcome["result"] | undefined {
  if (!task.result_json) {
    return undefined;
  }
  try {
    return JSON.parse(task.result_json) as TaskOutcome["result"];
  } catch {
    return undefined;
  }
}

export function parseTaskError(task: TaskRecord): TaskError | undefined {
  if (!task.error_json) {
    return undefined;
  }
  try {
    return JSON.parse(task.error_json) as TaskError;
  } catch {
    return undefined;
  }
}

export function parseTaskInput(task: TaskRecord): Record<string, unknown> {
  try {
    const parsed = JSON.parse(task.input_json) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function parseContextRefs(task: TaskRecord): ContextRef[] {
  try {
    const parsed = JSON.parse(task.context_refs_json) as unknown;
    return Array.isArray(parsed) ? (parsed as ContextRef[]) : [];
  } catch {
    return [];
  }
}

/** One run of a specialist's goal loop: who ran it, on which model, and what it cost. */
export interface GoalRunRecord {
  task_id: string;
  workflow_id: string;
  agent_id: string;
  tier: string;
  backend: string;
  model: string;
  llm_calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  latency_ms: number;
  outcome: TaskState;
  error_code: string | null;
  /** Length of the result only; the text itself stays in the task's result. */
  result_chars: number;
  tools_json: string;
  created_at: string;
}

export function recordGoalRun(run: Omit<GoalRunRecord, "created_at">): void {
  db.prepare(
    `INSERT INTO agent_goal_runs
       (task_id, workflow_id, agent_id, tier, backend, model, llm_calls, input_tokens, output_tokens,
        cost_usd, latency_ms, outcome, error_code, result_chars, tools_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    run.task_id,
    run.workflow_id,
    run.agent_id,
    run.tier,
    run.backend,
    run.model,
    run.llm_calls,
    run.input_tokens,
    run.output_tokens,
    run.cost_usd,
    run.latency_ms,
    run.outcome,
    run.error_code,
    run.result_chars,
    run.tools_json,
    nowIso(),
  );
}

export function listGoalRuns(workflowId: string): GoalRunRecord[] {
  return db
    .prepare(`SELECT * FROM agent_goal_runs WHERE workflow_id = ? ORDER BY id`)
    .all(workflowId) as GoalRunRecord[];
}

/** What a workflow's goal loops have already used, as recorded. */
export function workflowGoalUsage(workflowId: string): { llmCalls: number; costUsd: number; createdAt?: string } {
  const used = db
    .prepare(
      `SELECT COALESCE(SUM(llm_calls), 0) AS calls, COALESCE(SUM(cost_usd), 0) AS cost
       FROM agent_goal_runs WHERE workflow_id = ?`,
    )
    .get(workflowId) as { calls: number; cost: number };
  return { llmCalls: used.calls, costUsd: used.cost, createdAt: getWorkflow(workflowId)?.created_at };
}

/** Keeps the tables small: finished workflows older than the cutoff go. */
export function pruneFinishedWorkflows(olderThanDays = 14, now = new Date()): number {
  const cutoff = new Date(now.getTime() - olderThanDays * 86_400_000).toISOString();
  const run = db.transaction((): number => {
    const old = db
      .prepare(`SELECT workflow_id FROM agent_workflows WHERE finished_at IS NOT NULL AND finished_at <= ? LIMIT 500`)
      .all(cutoff) as Array<{ workflow_id: string }>;
    for (const { workflow_id } of old) {
      const tasks = db
        .prepare(`SELECT task_id, context_id FROM agent_tasks WHERE workflow_id = ?`)
        .all(workflow_id) as Array<{ task_id: string; context_id: string }>;
      for (const task of tasks) {
        for (const table of [
          "agent_task_attempts",
          "agent_task_events",
          "agent_artifacts",
          "agent_checkpoints",
          "agent_approvals",
        ]) {
          db.prepare(`DELETE FROM ${table} WHERE task_id = ?`).run(task.task_id);
        }
        db.prepare(`DELETE FROM agent_task_deps WHERE task_id = ? OR depends_on_task_id = ?`).run(
          task.task_id,
          task.task_id,
        );
        db.prepare(`DELETE FROM agent_idempotency WHERE task_id = ?`).run(task.task_id);
      }
      db.prepare(`DELETE FROM agent_tasks WHERE workflow_id = ?`).run(workflow_id);
      db.prepare(`DELETE FROM agent_goal_runs WHERE workflow_id = ?`).run(workflow_id);
      for (const task of tasks) {
        // A conversation can outlive the workflow that opened it.
        const stillUsed = db
          .prepare(`SELECT 1 FROM agent_tasks WHERE context_id = ? LIMIT 1`)
          .get(task.context_id);
        if (!stillUsed) {
          db.prepare(`DELETE FROM agent_conversation_messages WHERE context_id = ?`).run(task.context_id);
          db.prepare(`DELETE FROM agent_conversations WHERE context_id = ?`).run(task.context_id);
        }
      }
      db.prepare(`DELETE FROM agent_workflows WHERE workflow_id = ?`).run(workflow_id);
    }
    return old.length;
  });
  return run();
}
