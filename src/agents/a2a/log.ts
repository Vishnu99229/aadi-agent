import { db } from "../../db.js";

/**
 * One row per A2A task, in either direction: who the other agent is, which
 * task and conversation, which skill, how it travelled, when it started and
 * finished, how many bytes moved, how it ended, how often a stream dropped and
 * how often the task's status was read back instead of re-sending it.
 * Ids, counts and states only; no message content.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS a2a_task_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    peer_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    context_id TEXT,
    skill TEXT,
    transport TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    completed_at TEXT,
    bytes_in INTEGER NOT NULL DEFAULT 0,
    bytes_out INTEGER NOT NULL DEFAULT 0,
    state TEXT,
    success INTEGER,
    stream_disconnects INTEGER NOT NULL DEFAULT 0,
    reconciliation_attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    UNIQUE (direction, peer_id, task_id)
  );
  CREATE INDEX IF NOT EXISTS idx_a2a_task_log_requested ON a2a_task_log (requested_at);
`);

export type A2aDirection = "inbound" | "outbound";

function swallow(action: () => void): void {
  try {
    action();
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(`a2a log: write failed (${errorType}).`);
  }
}

export function logTaskStart(entry: {
  direction: A2aDirection;
  peerId: string;
  taskId: string;
  contextId?: string;
  skill?: string;
  transport: string;
}): void {
  swallow(() => {
    db.prepare(
      `INSERT INTO a2a_task_log (direction, peer_id, task_id, context_id, skill, transport, requested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(direction, peer_id, task_id) DO UPDATE SET
         context_id = COALESCE(excluded.context_id, a2a_task_log.context_id),
         skill = COALESCE(excluded.skill, a2a_task_log.skill)`,
    ).run(entry.direction, entry.peerId, entry.taskId, entry.contextId ?? null, entry.skill ?? null, entry.transport, new Date().toISOString());
  });
}

export function logTaskEnd(entry: {
  direction: A2aDirection;
  peerId: string;
  taskId: string;
  state: string;
  success: boolean;
  error?: string;
}): void {
  swallow(() => {
    db.prepare(
      `UPDATE a2a_task_log SET completed_at = ?, state = ?, success = ?, error = ?
       WHERE direction = ? AND peer_id = ? AND task_id = ?`,
    ).run(new Date().toISOString(), entry.state, entry.success ? 1 : 0, entry.error?.slice(0, 200) ?? null, entry.direction, entry.peerId, entry.taskId);
  });
}

export function logTaskTraffic(entry: {
  direction: A2aDirection;
  peerId: string;
  taskId: string;
  bytesIn?: number;
  bytesOut?: number;
  disconnect?: boolean;
  reconcile?: boolean;
}): void {
  swallow(() => {
    db.prepare(
      `UPDATE a2a_task_log SET bytes_in = bytes_in + ?, bytes_out = bytes_out + ?,
         stream_disconnects = stream_disconnects + ?, reconciliation_attempts = reconciliation_attempts + ?
       WHERE direction = ? AND peer_id = ? AND task_id = ?`,
    ).run(
      Math.max(0, Math.round(entry.bytesIn ?? 0)),
      Math.max(0, Math.round(entry.bytesOut ?? 0)),
      entry.disconnect ? 1 : 0,
      entry.reconcile ? 1 : 0,
      entry.direction,
      entry.peerId,
      entry.taskId,
    );
  });
}

export interface A2aLogRow {
  direction: string;
  peer_id: string;
  task_id: string;
  context_id: string | null;
  skill: string | null;
  transport: string;
  requested_at: string;
  completed_at: string | null;
  bytes_in: number;
  bytes_out: number;
  state: string | null;
  success: number | null;
  stream_disconnects: number;
  reconciliation_attempts: number;
}

export function listA2aLog(limit = 50): A2aLogRow[] {
  return db.prepare(`SELECT * FROM a2a_task_log ORDER BY id DESC LIMIT ?`).all(limit) as A2aLogRow[];
}

export function a2aLogFor(direction: A2aDirection, peerId: string, taskId: string): A2aLogRow | undefined {
  return db
    .prepare(`SELECT * FROM a2a_task_log WHERE direction = ? AND peer_id = ? AND task_id = ?`)
    .get(direction, peerId, taskId) as A2aLogRow | undefined;
}
