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

export type ItemTag = "work" | "personal";
export type TaskStatus = "open" | "done";

export interface TaskRecord {
  id: number;
  text: string;
  tag: ItemTag;
  due_at: string | null;
  status: TaskStatus;
  created_at: string;
}

export type ReminderRecurrence = "none" | "daily" | "weekly" | "weekdays";
export type ReminderStatus = "pending" | "sent" | "cancelled";

export interface ReminderRecord {
  id: number;
  text: string;
  tag: ItemTag;
  remind_at: string;
  recurrence: ReminderRecurrence;
  status: ReminderStatus;
  created_at: string;
}

export type FollowupStatus =
  | "waiting"
  | "replied"
  | "snoozed"
  | "dismissed";

export interface FollowupRecord {
  id: number;
  thread_id: string;
  recipient: string;
  subject: string;
  tag: ItemTag;
  last_sent_at: string;
  status: FollowupStatus;
  nudge_count: number;
  next_check_at: string;
  created_at: string;
}

export interface FollowupInput {
  threadId: string;
  recipient: string;
  subject: string;
  tag: ItemTag;
  lastSentAt: string;
  nextCheckAt: string;
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

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    tag TEXT NOT NULL CHECK (tag IN ('work', 'personal')),
    due_at TEXT,
    status TEXT NOT NULL DEFAULT 'open'
      CHECK (status IN ('open', 'done')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_status_tag_due
    ON tasks (status, tag, due_at);

  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    tag TEXT NOT NULL CHECK (tag IN ('work', 'personal')),
    remind_at TEXT NOT NULL,
    recurrence TEXT NOT NULL DEFAULT 'none'
      CHECK (recurrence IN ('none', 'daily', 'weekly', 'weekdays')),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'sent', 'cancelled')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_reminders_status_time
    ON reminders (status, remind_at);

  CREATE TABLE IF NOT EXISTS followups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL UNIQUE,
    recipient TEXT NOT NULL,
    subject TEXT NOT NULL,
    tag TEXT NOT NULL CHECK (tag IN ('work', 'personal')),
    last_sent_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'waiting'
      CHECK (status IN ('waiting', 'replied', 'snoozed', 'dismissed')),
    nudge_count INTEGER NOT NULL DEFAULT 0,
    next_check_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_followups_status_next_check
    ON followups (status, next_check_at);
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

export function createTask(
  text: string,
  tag: ItemTag,
  dueAt: string | null,
): TaskRecord {
  const result = db
    .prepare(
      `INSERT INTO tasks (text, tag, due_at)
       VALUES (?, ?, ?)`,
    )
    .run(text, tag, dueAt);

  return getTask(Number(result.lastInsertRowid))!;
}

export function getTask(id: number): TaskRecord | undefined {
  return db
    .prepare(
      `SELECT id, text, tag, due_at, status, created_at
       FROM tasks
       WHERE id = ?`,
    )
    .get(id) as TaskRecord | undefined;
}

export function getTasks(): TaskRecord[] {
  return db
    .prepare(
      `SELECT id, text, tag, due_at, status, created_at
       FROM tasks
       ORDER BY
         CASE WHEN due_at IS NULL THEN 1 ELSE 0 END,
         due_at ASC,
         id ASC`,
    )
    .all() as TaskRecord[];
}

export function markTaskDone(id: number): boolean {
  const result = db
    .prepare(
      `UPDATE tasks
       SET status = 'done'
       WHERE id = ? AND status = 'open'`,
    )
    .run(id);

  return result.changes === 1;
}

export function createReminder(
  text: string,
  tag: ItemTag,
  remindAt: string,
  recurrence: ReminderRecurrence,
): ReminderRecord {
  const result = db
    .prepare(
      `INSERT INTO reminders (text, tag, remind_at, recurrence)
       VALUES (?, ?, ?, ?)`,
    )
    .run(text, tag, remindAt, recurrence);

  return getReminder(Number(result.lastInsertRowid))!;
}

export function getReminder(id: number): ReminderRecord | undefined {
  return db
    .prepare(
      `SELECT id, text, tag, remind_at, recurrence, status, created_at
       FROM reminders
       WHERE id = ?`,
    )
    .get(id) as ReminderRecord | undefined;
}

export function getReminders(): ReminderRecord[] {
  return db
    .prepare(
      `SELECT id, text, tag, remind_at, recurrence, status, created_at
       FROM reminders
       ORDER BY remind_at ASC, id ASC`,
    )
    .all() as ReminderRecord[];
}

export function getDueReminders(now: string): ReminderRecord[] {
  return db
    .prepare(
      `SELECT id, text, tag, remind_at, recurrence, status, created_at
       FROM reminders
       WHERE status = 'pending' AND remind_at <= ?
       ORDER BY remind_at ASC, id ASC`,
    )
    .all(now) as ReminderRecord[];
}

export function transitionReminderStatus(
  id: number,
  from: ReminderStatus,
  to: ReminderStatus,
): boolean {
  const result = db
    .prepare(
      `UPDATE reminders
       SET status = ?
       WHERE id = ? AND status = ?`,
    )
    .run(to, id, from);

  return result.changes === 1;
}

export function getFollowup(id: number): FollowupRecord | undefined {
  return db
    .prepare(
      `SELECT id, thread_id, recipient, subject, tag, last_sent_at,
              status, nudge_count, next_check_at, created_at
       FROM followups
       WHERE id = ?`,
    )
    .get(id) as FollowupRecord | undefined;
}

export function getFollowupByThread(
  threadId: string,
): FollowupRecord | undefined {
  return db
    .prepare(
      `SELECT id, thread_id, recipient, subject, tag, last_sent_at,
              status, nudge_count, next_check_at, created_at
       FROM followups
       WHERE thread_id = ?`,
    )
    .get(threadId) as FollowupRecord | undefined;
}

export function getFollowups(): FollowupRecord[] {
  return db
    .prepare(
      `SELECT id, thread_id, recipient, subject, tag, last_sent_at,
              status, nudge_count, next_check_at, created_at
       FROM followups
       ORDER BY last_sent_at ASC, id ASC`,
    )
    .all() as FollowupRecord[];
}

export function createFollowup(input: FollowupInput): FollowupRecord {
  const result = db
    .prepare(
      `INSERT INTO followups (
         thread_id, recipient, subject, tag, last_sent_at, next_check_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.threadId,
      input.recipient,
      input.subject,
      input.tag,
      input.lastSentAt,
      input.nextCheckAt,
    );

  return getFollowup(Number(result.lastInsertRowid))!;
}

export function restartFollowup(
  id: number,
  input: FollowupInput,
): FollowupRecord {
  db.prepare(
    `UPDATE followups
     SET recipient = ?,
         subject = ?,
         tag = ?,
         last_sent_at = ?,
         status = 'waiting',
         nudge_count = 0,
         next_check_at = ?
     WHERE id = ?`,
  ).run(
    input.recipient,
    input.subject,
    input.tag,
    input.lastSentAt,
    input.nextCheckAt,
    id,
  );

  return getFollowup(id)!;
}

export function refreshFollowupSentMessage(
  id: number,
  recipient: string,
  subject: string,
  lastSentAt: string,
  nextCheckAt: string,
): FollowupRecord {
  db.prepare(
    `UPDATE followups
     SET recipient = ?,
         subject = ?,
         last_sent_at = ?,
         status = 'waiting',
         nudge_count = 0,
         next_check_at = ?
     WHERE id = ? AND status IN ('waiting', 'snoozed')`,
  ).run(recipient, subject, lastSentAt, nextCheckAt, id);

  return getFollowup(id)!;
}

export function transitionFollowupStatus(
  id: number,
  from: FollowupStatus | FollowupStatus[],
  to: FollowupStatus,
): boolean {
  const statuses = Array.isArray(from) ? from : [from];
  if (statuses.length === 0) {
    return false;
  }
  const placeholders = statuses.map(() => "?").join(", ");
  const result = db
    .prepare(
      `UPDATE followups
       SET status = ?
       WHERE id = ? AND status IN (${placeholders})`,
    )
    .run(to, id, ...statuses);

  return result.changes === 1;
}
