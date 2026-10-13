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

  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_name TEXT NOT NULL,
    tag TEXT NOT NULL CHECK (tag IN ('work', 'personal')),
    extracted_text TEXT NOT NULL,
    pending_action_items TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_documents_created
    ON documents (created_at);

  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    people TEXT NOT NULL,
    tag TEXT NOT NULL CHECK (tag IN ('work', 'personal')),
    content TEXT NOT NULL,
    pending_action_items TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_notes_created
    ON notes (created_at);

  CREATE TABLE IF NOT EXISTS bills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    biller TEXT NOT NULL,
    amount REAL,
    currency TEXT NOT NULL DEFAULT 'INR',
    due_date TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'upcoming'
      CHECK (status IN ('upcoming', 'paid', 'ignored')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_bills_dedupe
    ON bills (biller, due_date, amount, currency);

  CREATE TABLE IF NOT EXISTS important_dates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person TEXT NOT NULL,
    relation TEXT NOT NULL DEFAULT '',
    month_day TEXT NOT NULL,
    year INTEGER,
    type TEXT NOT NULL CHECK (type IN ('birthday', 'anniversary', 'other')),
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_important_dates_month_day
    ON important_dates (month_day);
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

export interface DocumentActionItem {
  text: string;
  tag: ItemTag;
  due_at: string | null;
}

export interface DocumentRecord {
  id: number;
  file_name: string;
  tag: ItemTag;
  extracted_text: string;
  pending_action_items: string | null;
  created_at: string;
}

export interface NoteActionItem {
  text: string;
  owner: "vishnu" | "other";
  owner_email: string | null;
  tag: ItemTag;
  due_at: string | null;
}

export interface NoteRecord {
  id: number;
  title: string;
  people: string;
  tag: ItemTag;
  content: string;
  pending_action_items: string | null;
  created_at: string;
}

export function createDocument(
  fileName: string,
  tag: ItemTag,
  extractedText: string,
  pendingActionItems: DocumentActionItem[] | null,
): DocumentRecord {
  const result = db
    .prepare(
      `INSERT INTO documents (file_name, tag, extracted_text, pending_action_items)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      fileName,
      tag,
      extractedText,
      pendingActionItems ? JSON.stringify(pendingActionItems) : null,
    );
  return getDocument(Number(result.lastInsertRowid))!;
}

export function getDocument(id: number): DocumentRecord | undefined {
  return db
    .prepare(
      `SELECT id, file_name, tag, extracted_text, pending_action_items, created_at
       FROM documents WHERE id = ?`,
    )
    .get(id) as DocumentRecord | undefined;
}

export function updateDocument(
  id: number,
  update: {
    tag: ItemTag;
    extractedText: string;
    pendingActionItems: DocumentActionItem[] | null;
  },
): void {
  db.prepare(
    `UPDATE documents
     SET tag = ?, extracted_text = ?, pending_action_items = ?
     WHERE id = ?`,
  ).run(
    update.tag,
    update.extractedText,
    update.pendingActionItems
      ? JSON.stringify(update.pendingActionItems)
      : null,
    id,
  );
}

export function clearDocumentPendingTasks(id: number): void {
  db.prepare(
    `UPDATE documents SET pending_action_items = NULL WHERE id = ?`,
  ).run(id);
}

export function deleteExpiredDocuments(): number {
  const result = db
    .prepare(
      `DELETE FROM documents
       WHERE created_at <= datetime('now', '-7 days')`,
    )
    .run();
  return result.changes;
}

export function createNote(
  title: string,
  people: string,
  tag: ItemTag,
  content: string,
  pendingActionItems: NoteActionItem[] | null,
): NoteRecord {
  const result = db
    .prepare(
      `INSERT INTO notes (title, people, tag, content, pending_action_items)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      title,
      people,
      tag,
      content,
      pendingActionItems ? JSON.stringify(pendingActionItems) : null,
    );
  return getNote(Number(result.lastInsertRowid))!;
}

export function getNote(id: number): NoteRecord | undefined {
  return db
    .prepare(
      `SELECT id, title, people, tag, content, pending_action_items, created_at
       FROM notes WHERE id = ?`,
    )
    .get(id) as NoteRecord | undefined;
}

export function clearNotePendingTasks(id: number): void {
  db.prepare(`UPDATE notes SET pending_action_items = NULL WHERE id = ?`).run(
    id,
  );
}

export function searchNotes(
  query: string,
  sinceIso?: string,
): NoteRecord[] {
  const safe = query.replace(/[%_]/g, " ").trim();
  const pattern = safe ? `%${safe}%` : "%";
  if (sinceIso) {
    return db
      .prepare(
        `SELECT id, title, people, tag, content, pending_action_items, created_at
         FROM notes
         WHERE created_at >= ?
           AND (title LIKE ? OR people LIKE ? OR content LIKE ?)
         ORDER BY created_at DESC
         LIMIT 100`,
      )
      .all(sinceIso, pattern, pattern, pattern) as NoteRecord[];
  }
  return db
    .prepare(
      `SELECT id, title, people, tag, content, pending_action_items, created_at
       FROM notes
       WHERE title LIKE ? OR people LIKE ? OR content LIKE ?
       ORDER BY created_at DESC
       LIMIT 100`,
    )
    .all(pattern, pattern, pattern) as NoteRecord[];
}

export type BillStatus = "upcoming" | "paid" | "ignored";

export interface BillRecord {
  id: number;
  biller: string;
  amount: number | null;
  currency: string;
  due_date: string;
  thread_id: string;
  status: BillStatus;
  created_at: string;
}

export type ImportantDateType = "birthday" | "anniversary" | "other";

export interface ImportantDateRecord {
  id: number;
  person: string;
  relation: string;
  month_day: string;
  year: number | null;
  type: ImportantDateType;
  note: string;
  created_at: string;
}

export function createBill(
  biller: string,
  amount: number | null,
  currency: string,
  dueDate: string,
  threadId: string,
): BillRecord | undefined {
  try {
    const result = db
      .prepare(
        `INSERT INTO bills (biller, amount, currency, due_date, thread_id)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(biller, amount, currency, dueDate, threadId);
    return getBill(Number(result.lastInsertRowid))!;
  } catch {
    return undefined;
  }
}

export function getBill(id: number): BillRecord | undefined {
  return db
    .prepare(
      `SELECT id, biller, amount, currency, due_date, thread_id, status, created_at
       FROM bills WHERE id = ?`,
    )
    .get(id) as BillRecord | undefined;
}

export function getBills(): BillRecord[] {
  return db
    .prepare(
      `SELECT id, biller, amount, currency, due_date, thread_id, status, created_at
       FROM bills ORDER BY due_date ASC, id ASC`,
    )
    .all() as BillRecord[];
}

export function transitionBillStatus(
  id: number,
  from: BillStatus | BillStatus[],
  to: BillStatus,
): boolean {
  const statuses = Array.isArray(from) ? from : [from];
  const placeholders = statuses.map(() => "?").join(", ");
  const result = db
    .prepare(
      `UPDATE bills SET status = ? WHERE id = ? AND status IN (${placeholders})`,
    )
    .run(to, id, ...statuses);
  return result.changes === 1;
}

export function createImportantDate(
  person: string,
  relation: string,
  monthDay: string,
  year: number | null,
  type: ImportantDateType,
  note: string,
): ImportantDateRecord {
  const result = db
    .prepare(
      `INSERT INTO important_dates (person, relation, month_day, year, type, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(person, relation, monthDay, year, type, note);
  return getImportantDate(Number(result.lastInsertRowid))!;
}

export function getImportantDate(id: number): ImportantDateRecord | undefined {
  return db
    .prepare(
      `SELECT id, person, relation, month_day, year, type, note, created_at
       FROM important_dates WHERE id = ?`,
    )
    .get(id) as ImportantDateRecord | undefined;
}

export function getImportantDates(): ImportantDateRecord[] {
  return db
    .prepare(
      `SELECT id, person, relation, month_day, year, type, note, created_at
       FROM important_dates ORDER BY month_day ASC, id ASC`,
    )
    .all() as ImportantDateRecord[];
}

export function removeImportantDate(id: number): boolean {
  const result = db.prepare(`DELETE FROM important_dates WHERE id = ?`).run(id);
  return result.changes === 1;
}
