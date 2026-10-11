import Database from "better-sqlite3";

export type MessageRole = "user" | "assistant";

export interface StoredMessage {
  id: number;
  role: MessageRole;
  content: string;
  created_at: string;
}

export type PendingActionStatus =
  | "pending"
  | "sent"
  | "discarded"
  | "expired";

export interface PendingAction {
  id: number;
  type: "send_draft";
  draft_id: string;
  thread_id: string;
  status: PendingActionStatus;
  telegram_message_id: number | null;
  created_at: string;
}

const db = new Database("./aadi.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pending_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK (type = 'send_draft'),
    draft_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'sent', 'discarded', 'expired')),
    telegram_message_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_pending_actions_draft_status
    ON pending_actions (draft_id, status);
`);

const insertMessage = db.prepare(
  "INSERT INTO messages (role, content) VALUES (?, ?)",
);

export function saveMessage(role: MessageRole, content: string): void {
  insertMessage.run(role, content);
}

export function getRecentMessages(limit = 10): StoredMessage[] {
  const safeLimit = Math.max(0, Math.floor(limit));
  const rows = db
    .prepare(
      `SELECT id, role, content, created_at
       FROM messages
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(safeLimit) as StoredMessage[];

  return rows.reverse();
}

export function clearMessages(): void {
  db.prepare("DELETE FROM messages").run();
}

export function createPendingAction(
  draftId: string,
  threadId: string,
): PendingAction {
  const result = db
    .prepare(
      `INSERT INTO pending_actions (type, draft_id, thread_id)
       VALUES ('send_draft', ?, ?)`,
    )
    .run(draftId, threadId);

  return getPendingAction(Number(result.lastInsertRowid))!;
}

export function getPendingAction(id: number): PendingAction | undefined {
  return db
    .prepare(
      `SELECT id, type, draft_id, thread_id, status,
              telegram_message_id, created_at
       FROM pending_actions
       WHERE id = ?`,
    )
    .get(id) as PendingAction | undefined;
}

export function getPendingActionForDraft(
  draftId: string,
): PendingAction | undefined {
  return db
    .prepare(
      `SELECT id, type, draft_id, thread_id, status,
              telegram_message_id, created_at
       FROM pending_actions
       WHERE draft_id = ? AND status = 'pending'
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get(draftId) as PendingAction | undefined;
}

export function setPendingActionTelegramMessage(
  id: number,
  telegramMessageId: number,
): void {
  db.prepare(
    `UPDATE pending_actions
     SET telegram_message_id = ?
     WHERE id = ?`,
  ).run(telegramMessageId, id);
}

export function transitionPendingAction(
  id: number,
  from: PendingActionStatus,
  to: PendingActionStatus,
): boolean {
  const result = db
    .prepare(
      `UPDATE pending_actions
       SET status = ?
       WHERE id = ? AND status = ?`,
    )
    .run(to, id, from);

  return result.changes === 1;
}

export function getExpiredPendingActions(): PendingAction[] {
  return db
    .prepare(
      `SELECT id, type, draft_id, thread_id, status,
              telegram_message_id, created_at
       FROM pending_actions
       WHERE status = 'pending'
         AND created_at <= datetime('now', '-24 hours')`,
    )
    .all() as PendingAction[];
}
