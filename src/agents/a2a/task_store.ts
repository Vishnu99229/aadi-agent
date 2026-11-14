import { Task } from "@a2a-js/sdk";
import type { ServerCallContext, TaskStore } from "@a2a-js/sdk/server";
import { db } from "../../db.js";

/**
 * Aadi's A2A server keeps the tasks other agents gave it in SQLite, so a caller
 * that lost its connection, or comes back after Aadi restarted, can read the
 * task by its id instead of sending the request again. Each task belongs to the
 * client that created it: another client's id is "not found".
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS a2a_server_tasks (
    task_id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    context_id TEXT NOT NULL,
    state TEXT NOT NULL,
    task_json TEXT NOT NULL,
    local_task_id TEXT,
    skill TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_a2a_server_tasks_owner ON a2a_server_tasks (owner, updated_at);

  -- A message id seen once from a client is never executed a second time.
  CREATE TABLE IF NOT EXISTS a2a_server_messages (
    owner TEXT NOT NULL,
    message_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (owner, message_id)
  );
`);

const MAX_HISTORY = 20;
const KEEP_DAYS = 14;

export function ownerOf(context: ServerCallContext | undefined): string {
  return context?.user?.userName || "anonymous";
}

/** Saves one snapshot. The executor calls this on every event, listener or not. */
export function saveTaskSnapshot(task: Task, owner: string): void {
  const trimmed: Task = { ...task, history: (task.history ?? []).slice(-MAX_HISTORY) };
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO a2a_server_tasks (task_id, owner, context_id, state, task_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(task_id) DO UPDATE SET
       context_id = excluded.context_id, state = excluded.state,
       task_json = excluded.task_json, updated_at = excluded.updated_at
     WHERE a2a_server_tasks.owner = excluded.owner`,
  ).run(task.id, owner, task.contextId, String(task.status?.state ?? 0), JSON.stringify(Task.toJSON(trimmed)), now, now);
}

export function loadTaskSnapshot(taskId: string, owner: string): Task | undefined {
  const row = db
    .prepare(`SELECT task_json FROM a2a_server_tasks WHERE task_id = ? AND owner = ?`)
    .get(taskId, owner) as { task_json: string } | undefined;
  if (!row) {
    return undefined;
  }
  try {
    return Task.fromJSON(JSON.parse(row.task_json));
  } catch {
    return undefined;
  }
}

/** Aadi's own task behind an A2A task, so a follow-up continues the same work after a restart. */
export function setLocalTask(taskId: string, owner: string, localTaskId: string, skill: string): void {
  db.prepare(`UPDATE a2a_server_tasks SET local_task_id = ?, skill = ? WHERE task_id = ? AND owner = ?`).run(localTaskId, skill, taskId, owner);
}

export function localTaskFor(taskId: string, owner: string): { localTaskId?: string; skill?: string } {
  const row = db
    .prepare(`SELECT local_task_id, skill FROM a2a_server_tasks WHERE task_id = ? AND owner = ?`)
    .get(taskId, owner) as { local_task_id: string | null; skill: string | null } | undefined;
  return { localTaskId: row?.local_task_id ?? undefined, skill: row?.skill ?? undefined };
}

/**
 * Claims a client's message id for a task. Returns the task that already holds
 * it when the same message arrives again (a retry after a lost connection).
 */
export function claimMessage(owner: string, messageId: string, taskId: string): string | undefined {
  if (!messageId) {
    return undefined;
  }
  const inserted = db
    .prepare(`INSERT OR IGNORE INTO a2a_server_messages (owner, message_id, task_id, created_at) VALUES (?, ?, ?, ?)`)
    .run(owner, messageId, taskId, new Date().toISOString());
  if (inserted.changes === 1) {
    return undefined;
  }
  const row = db
    .prepare(`SELECT task_id FROM a2a_server_messages WHERE owner = ? AND message_id = ?`)
    .get(owner, messageId) as { task_id: string } | undefined;
  return row && row.task_id !== taskId ? row.task_id : undefined;
}

export function sweepServerTasks(now = Date.now()): number {
  const cutoff = new Date(now - KEEP_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`DELETE FROM a2a_server_messages WHERE created_at < ?`).run(cutoff);
  return db.prepare(`DELETE FROM a2a_server_tasks WHERE updated_at < ?`).run(cutoff).changes;
}

export class SqliteTaskStore implements TaskStore {
  async save(task: Task, context: ServerCallContext): Promise<void> {
    saveTaskSnapshot(task, ownerOf(context));
  }

  async load(taskId: string, context: ServerCallContext): Promise<Task | undefined> {
    return loadTaskSnapshot(taskId, ownerOf(context));
  }

  async list(params: { pageSize?: number; pageToken?: string; contextId?: string }, context: ServerCallContext) {
    const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));
    const offset = Math.max(0, Number(params.pageToken || 0) || 0);
    const owner = ownerOf(context);
    const filter = params.contextId ? `AND context_id = ?` : "";
    const args = params.contextId ? [owner, params.contextId] : [owner];
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM a2a_server_tasks WHERE owner = ? ${filter}`).get(...args) as { n: number }).n;
    const rows = db
      .prepare(`SELECT task_json FROM a2a_server_tasks WHERE owner = ? ${filter} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all(...args, pageSize, offset) as Array<{ task_json: string }>;
    return {
      tasks: rows.map((row) => Task.fromJSON(JSON.parse(row.task_json))),
      nextPageToken: offset + rows.length < total ? String(offset + rows.length) : "",
      pageSize,
      totalSize: total,
    };
  }
}
