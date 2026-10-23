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
  | "expired"
  | "created"
  | "cancelled";

export type PendingActionType = "send_draft" | "create_event";

export type GoogleAccountId = "personal" | "work";

export interface PendingAction {
  id: number;
  type: PendingActionType;
  draft_id: string | null;
  thread_id: string | null;
  google_account: GoogleAccountId;
  status: PendingActionStatus;
  telegram_message_id: number | null;
  event_title: string | null;
  event_start: string | null;
  event_end: string | null;
  event_attendees: string | null;
  event_description: string | null;
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
  kind: "task" | "promise";
  source_thread_id: string | null;
  source_message_id: string | null;
  promise_context: string | null;
  deadline: string | null;
  recipient: string | null;
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
  related_task_id: number | null;
}

export type FollowupStatus =
  | "waiting"
  | "replied"
  | "snoozed"
  | "dismissed";

export type FollowupImportance = "high" | "medium" | "low";

export interface FollowupRecord {
  id: number;
  thread_id: string;
  recipient: string;
  subject: string;
  tag: ItemTag;
  google_account: GoogleAccountId;
  last_sent_at: string;
  status: FollowupStatus;
  nudge_count: number;
  next_check_at: string;
  reason_for_followup: string | null;
  importance: FollowupImportance;
  last_notified_at: string | null;
  created_at: string;
}

export interface FollowupInput {
  threadId: string;
  recipient: string;
  subject: string;
  tag: ItemTag;
  googleAccount: GoogleAccountId;
  lastSentAt: string;
  nextCheckAt: string;
  reasonForFollowup?: string | null;
  importance?: FollowupImportance;
}

export const DB_PATH = process.env.AADI_DB_PATH?.trim() || "./aadi.db";

const db = new Database(DB_PATH);

export async function backupDatabaseTo(destPath: string): Promise<void> {
  await db.backup(destPath);
}

function tableHasColumn(table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return rows.some((row) => row.name === column);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pending_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK (type IN ('send_draft', 'create_event')),
    draft_id TEXT,
    thread_id TEXT,
    google_account TEXT NOT NULL DEFAULT 'personal'
      CHECK (google_account IN ('personal', 'work')),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN (
        'pending', 'sent', 'discarded', 'expired',
        'created', 'cancelled'
      )),
    telegram_message_id INTEGER,
    event_title TEXT,
    event_start TEXT,
    event_end TEXT,
    event_attendees TEXT,
    event_description TEXT,
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
    thread_id TEXT NOT NULL,
    recipient TEXT NOT NULL,
    subject TEXT NOT NULL,
    tag TEXT NOT NULL CHECK (tag IN ('work', 'personal')),
    google_account TEXT NOT NULL DEFAULT 'personal'
      CHECK (google_account IN ('personal', 'work')),
    last_sent_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'waiting'
      CHECK (status IN ('waiting', 'replied', 'snoozed', 'dismissed')),
    nudge_count INTEGER NOT NULL DEFAULT 0,
    next_check_at TEXT NOT NULL,
    reason_for_followup TEXT,
    importance TEXT NOT NULL DEFAULT 'medium'
      CHECK (importance IN ('high', 'medium', 'low')),
    last_notified_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (google_account, thread_id)
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

  CREATE TABLE IF NOT EXISTS qa_bank (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    source_doc TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_qa_bank_created
    ON qa_bank (created_at);

  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    people TEXT NOT NULL,
    tag TEXT NOT NULL CHECK (tag IN ('work', 'personal')),
    content TEXT NOT NULL,
    pending_action_items TEXT,
    meeting_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_notes_created
    ON notes (created_at);

  CREATE TABLE IF NOT EXISTS attachment_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL,
    google_account TEXT NOT NULL DEFAULT 'work'
      CHECK (google_account IN ('personal', 'work')),
    attachment_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    sender TEXT NOT NULL,
    subject TEXT NOT NULL,
    guessed_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'reviewed', 'ignored')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (google_account, message_id, attachment_id)
  );

  CREATE INDEX IF NOT EXISTS idx_attachment_alerts_status
    ON attachment_alerts (status, created_at);

  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    category TEXT NOT NULL
      CHECK (category IN ('deal', 'plan', 'event', 'person', 'preference', 'other')),
    tag TEXT NOT NULL CHECK (tag IN ('work', 'personal')),
    event_date TEXT,
    source TEXT NOT NULL
      CHECK (source IN ('explicit', 'confirmed', 'auto')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_memories_updated
    ON memories (updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_memories_event_date
    ON memories (event_date);
  CREATE INDEX IF NOT EXISTS idx_memories_category
    ON memories (category);

  CREATE TABLE IF NOT EXISTS pending_memory_confirms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    category TEXT NOT NULL,
    tag TEXT NOT NULL CHECK (tag IN ('work', 'personal')),
    event_date TEXT,
    update_of_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    task TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_usage_log_timestamp
    ON usage_log (timestamp);
  CREATE INDEX IF NOT EXISTS idx_usage_log_task
    ON usage_log (task, timestamp);

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

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS builds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending_confirm'
      CHECK (status IN (
        'pending_confirm', 'running', 'waiting_checks', 'waiting_approval',
        'review', 'awaiting_followup', 'merged', 'deploying', 'deployed',
        'discarded', 'failed', 'rolled_back'
      )),
    cursor_agent_id TEXT,
    cursor_run_id TEXT,
    cursor_url TEXT,
    pr_url TEXT,
    pr_number INTEGER,
    summary TEXT,
    files_json TEXT,
    error TEXT,
    merge_sha TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_builds_status_updated
    ON builds (status, updated_at);
`);

const buildsSchema =
  (
    db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'builds'`,
      )
      .get() as { sql: string } | undefined
  )?.sql ?? "";

if (!buildsSchema.includes("waiting_checks")) {
  db.exec(`
    CREATE TABLE builds_migrate (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_confirm'
        CHECK (status IN (
          'pending_confirm', 'running', 'waiting_checks', 'waiting_approval',
          'review', 'awaiting_followup', 'merged', 'deploying', 'deployed',
          'discarded', 'failed', 'rolled_back'
        )),
      cursor_agent_id TEXT,
      cursor_run_id TEXT,
      cursor_url TEXT,
      pr_url TEXT,
      pr_number INTEGER,
      summary TEXT,
      files_json TEXT,
      error TEXT,
      merge_sha TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO builds_migrate (
      id, task, status, cursor_agent_id, cursor_run_id, cursor_url,
      pr_url, pr_number, summary, files_json, error, created_at, updated_at
    )
    SELECT id, task, status, cursor_agent_id, cursor_run_id, cursor_url,
           pr_url, pr_number, summary, files_json, error, created_at, updated_at
    FROM builds;
    DROP TABLE builds;
    ALTER TABLE builds_migrate RENAME TO builds;
    CREATE INDEX IF NOT EXISTS idx_builds_status_updated
      ON builds (status, updated_at);
  `);
} else if (!tableHasColumn("builds", "merge_sha")) {
  db.exec(`ALTER TABLE builds ADD COLUMN merge_sha TEXT`);
}

db.exec(`

  CREATE TABLE IF NOT EXISTS meeting_briefs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL,
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    title TEXT NOT NULL,
    attendees_json TEXT NOT NULL,
    briefed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    nudge_status TEXT NOT NULL DEFAULT 'briefed'
      CHECK (nudge_status IN (
        'briefed', 'nudged', 'remind_scheduled', 're_nudged',
        'skipped', 'wrapping', 'wrapped'
      )),
    nudge_at TEXT,
    thresholds_sent TEXT NOT NULL DEFAULT '[]',
    UNIQUE (event_id, start_at)
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    aliases TEXT NOT NULL DEFAULT '[]',
    email_domains TEXT NOT NULL DEFAULT '[]',
    relationship TEXT NOT NULL DEFAULT 'partner'
      CHECK (relationship IN ('partner', 'end_client')),
    via_partner_id INTEGER,
    people TEXT NOT NULL DEFAULT '[]',
    stage TEXT NOT NULL DEFAULT '',
    next_step TEXT NOT NULL DEFAULT '',
    next_step_due TEXT,
    waiting_on TEXT NOT NULL DEFAULT 'nobody'
      CHECK (waiting_on IN ('me', 'them', 'nobody')),
    last_activity_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pending_account_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    suggested_stage TEXT NOT NULL DEFAULT '',
    suggested_next_step TEXT NOT NULL DEFAULT '',
    suggested_waiting_on TEXT NOT NULL DEFAULT 'nobody',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS meeting_inbounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    google_account TEXT NOT NULL DEFAULT 'work',
    message_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    processed_as TEXT NOT NULL DEFAULT 'seen'
      CHECK (processed_as IN (
        'seen', 'skip', 'detect', 'card', 'autobook', 'ask', 'ignore'
      )),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (google_account, message_id)
  );

  CREATE TABLE IF NOT EXISTS meeting_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    sent_message_id TEXT NOT NULL,
    recipient_email TEXT NOT NULL,
    recipient_name TEXT NOT NULL,
    cc_emails TEXT NOT NULL DEFAULT '[]',
    slots TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL,
    sender_timezone TEXT,
    hold_event_ids TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'open'
      CHECK (status IN ('open', 'booked', 'expired', 'cancelled')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS meeting_pending_bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    slot_index INTEGER NOT NULL,
    send_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'sent', 'cancelled')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS meeting_draft_intents (
    draft_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    recipient_email TEXT NOT NULL,
    recipient_name TEXT NOT NULL,
    cc_emails TEXT NOT NULL DEFAULT '[]',
    slots TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL,
    sender_timezone TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_meeting_proposals_thread
    ON meeting_proposals (thread_id, status);
  CREATE INDEX IF NOT EXISTS idx_meeting_pending_send
    ON meeting_pending_bookings (status, send_at);

  CREATE TABLE IF NOT EXISTS meeting_card_state (
    inbound_id INTEGER PRIMARY KEY,
    payload TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS job_runs (
    name TEXT PRIMARY KEY,
    last_success_at TEXT,
    last_attempt_at TEXT NOT NULL,
    last_status TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meeting_threads (
    thread_id TEXT PRIMARY KEY,
    recipient_email TEXT NOT NULL,
    recipient_name TEXT NOT NULL,
    company TEXT NOT NULL DEFAULT '',
    sender_type TEXT NOT NULL,
    status TEXT NOT NULL
      CHECK (status IN ('proposed', 'clarified', 'booked', 'handed_over', 'ignored')),
    auto_emails_sent INTEGER NOT NULL DEFAULT 0,
    last_kind TEXT,
    subject TEXT NOT NULL DEFAULT '',
    proposal_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS meeting_auto_sends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('proposal', 'clarify', 'confirm')),
    message_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// Promises tracker (Part 1): extend tasks with promise-specific columns.
// All additive and nullable so existing rows stay valid.
if (!tableHasColumn("tasks", "kind")) {
  db.exec(
    `ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'task'
       CHECK (kind IN ('task', 'promise'))`,
  );
}
if (!tableHasColumn("tasks", "source_thread_id")) {
  db.exec(`ALTER TABLE tasks ADD COLUMN source_thread_id TEXT`);
}
if (!tableHasColumn("tasks", "source_message_id")) {
  db.exec(`ALTER TABLE tasks ADD COLUMN source_message_id TEXT`);
}
if (!tableHasColumn("tasks", "promise_context")) {
  db.exec(`ALTER TABLE tasks ADD COLUMN promise_context TEXT`);
}
if (!tableHasColumn("tasks", "deadline")) {
  db.exec(`ALTER TABLE tasks ADD COLUMN deadline TEXT`);
}
if (!tableHasColumn("tasks", "recipient")) {
  db.exec(`ALTER TABLE tasks ADD COLUMN recipient TEXT`);
}
db.exec(
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_source_message
     ON tasks (source_message_id)
     WHERE source_message_id IS NOT NULL`,
);

// Reminders can now carry a task link so "Done" on a promise reminder
// also closes the task and cancels sibling reminders for the same task.
if (!tableHasColumn("reminders", "related_task_id")) {
  db.exec(`ALTER TABLE reminders ADD COLUMN related_task_id INTEGER`);
}

if (!tableHasColumn("accounts", "relationship")) {
  db.exec(
    `ALTER TABLE accounts ADD COLUMN relationship TEXT NOT NULL DEFAULT 'partner'`,
  );
}
if (!tableHasColumn("accounts", "via_partner_id")) {
  db.exec(`ALTER TABLE accounts ADD COLUMN via_partner_id INTEGER`);
}
if (!tableHasColumn("accounts", "people")) {
  db.exec(`ALTER TABLE accounts ADD COLUMN people TEXT NOT NULL DEFAULT '[]'`);
}

if (!tableHasColumn("notes", "meeting_json")) {
  db.exec(`ALTER TABLE notes ADD COLUMN meeting_json TEXT`);
}
if (!tableHasColumn("meeting_pending_bookings", "skip_confirm")) {
  db.exec(
    `ALTER TABLE meeting_pending_bookings ADD COLUMN skip_confirm INTEGER NOT NULL DEFAULT 0`,
  );
}
if (!tableHasColumn("meeting_briefs", "needs_rebrief")) {
  db.exec(
    `ALTER TABLE meeting_briefs ADD COLUMN needs_rebrief INTEGER NOT NULL DEFAULT 0`,
  );
}
if (!tableHasColumn("meeting_briefs", "thresholds_sent")) {
  db.exec(
    `ALTER TABLE meeting_briefs ADD COLUMN thresholds_sent TEXT NOT NULL DEFAULT '[]'`,
  );
}

// Attachment-alert dedup: Gmail may return a different attachmentId for
// the same file across scans, so the old UNIQUE(account, message_id,
// attachment_id) lets dupe rows slip in and the scanner then pings the
// user again every 10 minutes. Enforce a stricter dedup on
// (account, message_id, file_name). Must dedupe existing rows first,
// since the UNIQUE INDEX will otherwise refuse to create.
try {
  db.exec(`
    DELETE FROM attachment_alerts
    WHERE id NOT IN (
      SELECT MIN(id) FROM attachment_alerts
      GROUP BY google_account, message_id, file_name
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_attachment_alerts_dedupe
      ON attachment_alerts (google_account, message_id, file_name);
  `);
} catch (error) {
  const errorType = error instanceof Error ? error.name : "UnknownError";
  console.error(
    `Attachment alert dedupe migration failed (${errorType}); duplicates may still slip through.`,
  );
}

let memoriesFtsReady = false;
try {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      content='memories',
      content_rowid='id',
      tokenize='porter'
    );
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content)
        VALUES('delete', old.id, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content)
        VALUES('delete', old.id, old.content);
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END;
  `);
  memoriesFtsReady = true;
} catch (error) {
  const errorType = error instanceof Error ? error.name : "UnknownError";
  console.error(`Memory FTS5 unavailable (${errorType}); search will use LIKE.`);
}

let qaBankFtsReady = false;
try {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS qa_bank_fts USING fts5(
      question,
      content='qa_bank',
      content_rowid='id',
      tokenize='porter'
    );
    CREATE TRIGGER IF NOT EXISTS qa_bank_ai AFTER INSERT ON qa_bank BEGIN
      INSERT INTO qa_bank_fts(rowid, question) VALUES (new.id, new.question);
    END;
    CREATE TRIGGER IF NOT EXISTS qa_bank_ad AFTER DELETE ON qa_bank BEGIN
      INSERT INTO qa_bank_fts(qa_bank_fts, rowid, question)
        VALUES('delete', old.id, old.question);
    END;
    CREATE TRIGGER IF NOT EXISTS qa_bank_au AFTER UPDATE OF question ON qa_bank BEGIN
      INSERT INTO qa_bank_fts(qa_bank_fts, rowid, question)
        VALUES('delete', old.id, old.question);
      INSERT INTO qa_bank_fts(rowid, question) VALUES (new.id, new.question);
    END;
  `);
  qaBankFtsReady = true;
} catch (error) {
  const errorType = error instanceof Error ? error.name : "UnknownError";
  console.error(`qa_bank FTS5 unavailable (${errorType}); search will use LIKE.`);
}

if (!tableHasColumn("pending_actions", "google_account")) {
  db.exec(
    `ALTER TABLE pending_actions ADD COLUMN google_account TEXT NOT NULL DEFAULT 'personal'`,
  );
}

// pending_actions used to be draft-only (CHECK (type = 'send_draft'),
// draft_id/thread_id NOT NULL). To support calendar event approvals
// we need a wider CHECK and new event_* columns; SQLite can't ALTER a
// CHECK, so rebuild the table and copy rows forward. Idempotent: the
// column probe skips the rebuild once the new schema is in place.
if (!tableHasColumn("pending_actions", "event_title")) {
  db.exec(`
    CREATE TABLE pending_actions_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK (type IN ('send_draft', 'create_event')),
      draft_id TEXT,
      thread_id TEXT,
      google_account TEXT NOT NULL DEFAULT 'personal'
        CHECK (google_account IN ('personal', 'work')),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN (
          'pending', 'sent', 'discarded', 'expired',
          'created', 'cancelled'
        )),
      telegram_message_id INTEGER,
      event_title TEXT,
      event_start TEXT,
      event_end TEXT,
      event_attendees TEXT,
      event_description TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO pending_actions_new
      (id, type, draft_id, thread_id, google_account, status,
       telegram_message_id, created_at)
      SELECT id, type, draft_id, thread_id, google_account, status,
             telegram_message_id, created_at
      FROM pending_actions;
    DROP TABLE pending_actions;
    ALTER TABLE pending_actions_new RENAME TO pending_actions;
    CREATE INDEX IF NOT EXISTS idx_pending_actions_draft_status
      ON pending_actions (draft_id, status);
  `);
  console.log("pending_actions migrated to support create_event rows.");
}

const followupsSchema =
  (
    db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'followups'`,
      )
      .get() as { sql: string } | undefined
  )?.sql ?? "";

if (!tableHasColumn("followups", "google_account")) {
  db.exec(
    `ALTER TABLE followups ADD COLUMN google_account TEXT NOT NULL DEFAULT 'personal'`,
  );
}

if (!tableHasColumn("followups", "reason_for_followup")) {
  db.exec(`ALTER TABLE followups ADD COLUMN reason_for_followup TEXT`);
}
if (!tableHasColumn("followups", "importance")) {
  db.exec(
    `ALTER TABLE followups ADD COLUMN importance TEXT NOT NULL DEFAULT 'medium'
       CHECK (importance IN ('high', 'medium', 'low'))`,
  );
  // Existing rows get 'medium' by default; the DEFAULT clause above already
  // backfills them, but set it explicitly for clarity and to repair any
  // legacy row that somehow holds NULL.
  db.exec(
    `UPDATE followups SET importance = 'medium' WHERE importance IS NULL OR importance = ''`,
  );
}
if (!tableHasColumn("followups", "last_notified_at")) {
  db.exec(`ALTER TABLE followups ADD COLUMN last_notified_at TEXT`);
}

if (followupsSchema.includes("thread_id TEXT NOT NULL UNIQUE")) {
  db.exec(`
    CREATE TABLE followups_migrate (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      recipient TEXT NOT NULL,
      subject TEXT NOT NULL,
      tag TEXT NOT NULL CHECK (tag IN ('work', 'personal')),
      google_account TEXT NOT NULL DEFAULT 'personal'
        CHECK (google_account IN ('personal', 'work')),
      last_sent_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting'
        CHECK (status IN ('waiting', 'replied', 'snoozed', 'dismissed')),
      nudge_count INTEGER NOT NULL DEFAULT 0,
      next_check_at TEXT NOT NULL,
      reason_for_followup TEXT,
      importance TEXT NOT NULL DEFAULT 'medium'
        CHECK (importance IN ('high', 'medium', 'low')),
      last_notified_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (google_account, thread_id)
    );
    INSERT INTO followups_migrate (
      id, thread_id, recipient, subject, tag, google_account, last_sent_at,
      status, nudge_count, next_check_at, reason_for_followup, importance,
      last_notified_at, created_at
    )
    SELECT id, thread_id, recipient, subject, tag, google_account, last_sent_at,
           status, nudge_count, next_check_at, reason_for_followup, importance,
           last_notified_at, created_at
    FROM followups;
    DROP TABLE followups;
    ALTER TABLE followups_migrate RENAME TO followups;
    CREATE INDEX IF NOT EXISTS idx_followups_status_next_check
      ON followups (status, next_check_at);
  `);
}

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

export const CONVERSATION_SUMMARY_KEY = "conversation_summary";
export const CONVERSATION_SUMMARY_UNTIL_KEY = "conversation_summary_until_id";

export function clearMessages(): void {
  db.prepare("DELETE FROM messages").run();
  db.prepare("DELETE FROM settings WHERE key IN (?, ?)").run(
    CONVERSATION_SUMMARY_KEY,
    CONVERSATION_SUMMARY_UNTIL_KEY,
  );
}

const PENDING_ACTION_COLUMNS = `id, type, draft_id, thread_id, google_account, status,
              telegram_message_id, event_title, event_start, event_end,
              event_attendees, event_description, created_at`;

export function createPendingAction(
  draftId: string,
  threadId: string,
  googleAccount: GoogleAccountId = "personal",
): PendingAction {
  const result = db
    .prepare(
      `INSERT INTO pending_actions (type, draft_id, thread_id, google_account)
       VALUES ('send_draft', ?, ?, ?)`,
    )
    .run(draftId, threadId, googleAccount);

  return getPendingAction(Number(result.lastInsertRowid))!;
}

export interface PendingEventInput {
  title: string;
  startIso: string;
  endIso: string;
  attendees: string[];
  description?: string;
  googleAccount?: GoogleAccountId;
}

export function createPendingEventAction(
  input: PendingEventInput,
): PendingAction {
  const result = db
    .prepare(
      `INSERT INTO pending_actions (
         type, google_account, event_title, event_start, event_end,
         event_attendees, event_description
       ) VALUES ('create_event', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.googleAccount ?? "work",
      input.title,
      input.startIso,
      input.endIso,
      JSON.stringify(input.attendees),
      input.description ?? null,
    );
  return getPendingAction(Number(result.lastInsertRowid))!;
}

export function getPendingAction(id: number): PendingAction | undefined {
  return db
    .prepare(
      `SELECT ${PENDING_ACTION_COLUMNS}
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
      `SELECT ${PENDING_ACTION_COLUMNS}
       FROM pending_actions
       WHERE draft_id = ? AND status = 'pending'
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get(draftId) as PendingAction | undefined;
}

export function getLatestPendingSendAction(): PendingAction | undefined {
  return db
    .prepare(
      `SELECT ${PENDING_ACTION_COLUMNS}
       FROM pending_actions
       WHERE status = 'pending'
         AND telegram_message_id IS NOT NULL
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get() as PendingAction | undefined;
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
      `SELECT ${PENDING_ACTION_COLUMNS}
       FROM pending_actions
       WHERE status = 'pending'
         AND created_at <= datetime('now', '-24 hours')`,
    )
    .all() as PendingAction[];
}

const TASK_COLUMNS = `id, text, tag, due_at, status, created_at, kind,
  source_thread_id, source_message_id, promise_context, deadline, recipient`;

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

export interface PromiseTaskInput {
  promise: string;           // short noun phrase, no "Promise:" prefix
  recipient: string;         // raw "Name <addr@host>" or just address
  threadId: string;
  messageId: string;
  deadline: string | null;   // YYYY-MM-DD or null
  dueAt: string | null;      // ISO datetime for reminder scheduling, or null
}

export function createPromiseTask(
  input: PromiseTaskInput,
): TaskRecord | undefined {
  const text = `Promise: ${input.promise}`;
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO tasks (
         text, tag, due_at, status, kind,
         source_thread_id, source_message_id, promise_context,
         deadline, recipient
       ) VALUES (?, 'work', ?, 'open', 'promise', ?, ?, ?, ?, ?)`,
    )
    .run(
      text,
      input.dueAt,
      input.threadId,
      input.messageId,
      input.promise,
      input.deadline,
      input.recipient,
    );
  if (result.changes === 0) {
    return undefined;
  }
  return getTask(Number(result.lastInsertRowid));
}

export function getPromiseByMessageId(
  messageId: string,
): TaskRecord | undefined {
  return db
    .prepare(
      `SELECT ${TASK_COLUMNS}
       FROM tasks
       WHERE source_message_id = ?`,
    )
    .get(messageId) as TaskRecord | undefined;
}

export function getTask(id: number): TaskRecord | undefined {
  return db
    .prepare(
      `SELECT ${TASK_COLUMNS}
       FROM tasks
       WHERE id = ?`,
    )
    .get(id) as TaskRecord | undefined;
}

export function getTasks(): TaskRecord[] {
  return db
    .prepare(
      `SELECT ${TASK_COLUMNS}
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

const REMINDER_COLUMNS = `id, text, tag, remind_at, recurrence, status,
  created_at, related_task_id`;

export function createReminder(
  text: string,
  tag: ItemTag,
  remindAt: string,
  recurrence: ReminderRecurrence,
  relatedTaskId: number | null = null,
): ReminderRecord {
  const result = db
    .prepare(
      `INSERT INTO reminders (text, tag, remind_at, recurrence, related_task_id)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(text, tag, remindAt, recurrence, relatedTaskId);

  return getReminder(Number(result.lastInsertRowid))!;
}

export function getReminder(id: number): ReminderRecord | undefined {
  return db
    .prepare(
      `SELECT ${REMINDER_COLUMNS}
       FROM reminders
       WHERE id = ?`,
    )
    .get(id) as ReminderRecord | undefined;
}

export function getReminders(): ReminderRecord[] {
  return db
    .prepare(
      `SELECT ${REMINDER_COLUMNS}
       FROM reminders
       ORDER BY remind_at ASC, id ASC`,
    )
    .all() as ReminderRecord[];
}

export function getDueReminders(now: string): ReminderRecord[] {
  return db
    .prepare(
      `SELECT ${REMINDER_COLUMNS}
       FROM reminders
       WHERE status = 'pending' AND remind_at <= ?
       ORDER BY remind_at ASC, id ASC`,
    )
    .all(now) as ReminderRecord[];
}

/** When a promise task is marked done, cancel its pending reminders so the
 *  user isn't pinged twice. Returns how many rows were cancelled. */
export function cancelPendingRemindersForTask(taskId: number): number {
  const result = db
    .prepare(
      `UPDATE reminders
       SET status = 'cancelled'
       WHERE related_task_id = ? AND status = 'pending'`,
    )
    .run(taskId);
  return result.changes;
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

const FOLLOWUP_COLUMNS = `id, thread_id, recipient, subject, tag, google_account,
              last_sent_at, status, nudge_count, next_check_at,
              reason_for_followup, importance, last_notified_at, created_at`;

export function getFollowup(id: number): FollowupRecord | undefined {
  return db
    .prepare(
      `SELECT ${FOLLOWUP_COLUMNS}
       FROM followups
       WHERE id = ?`,
    )
    .get(id) as FollowupRecord | undefined;
}

export function getFollowupByThread(
  threadId: string,
  googleAccount: GoogleAccountId = "personal",
): FollowupRecord | undefined {
  return db
    .prepare(
      `SELECT ${FOLLOWUP_COLUMNS}
       FROM followups
       WHERE thread_id = ? AND google_account = ?`,
    )
    .get(threadId, googleAccount) as FollowupRecord | undefined;
}

export function getFollowups(): FollowupRecord[] {
  return db
    .prepare(
      `SELECT ${FOLLOWUP_COLUMNS}
       FROM followups
       ORDER BY last_sent_at ASC, id ASC`,
    )
    .all() as FollowupRecord[];
}

export function createFollowup(input: FollowupInput): FollowupRecord {
  const result = db
    .prepare(
      `INSERT INTO followups (
         thread_id, recipient, subject, tag, google_account,
         last_sent_at, next_check_at,
         reason_for_followup, importance
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.threadId,
      input.recipient,
      input.subject,
      input.tag,
      input.googleAccount,
      input.lastSentAt,
      input.nextCheckAt,
      input.reasonForFollowup ?? null,
      input.importance ?? "medium",
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
         google_account = ?,
         last_sent_at = ?,
         status = 'waiting',
         nudge_count = 0,
         next_check_at = ?,
         reason_for_followup = ?,
         importance = ?,
         last_notified_at = NULL
     WHERE id = ?`,
  ).run(
    input.recipient,
    input.subject,
    input.tag,
    input.googleAccount,
    input.lastSentAt,
    input.nextCheckAt,
    input.reasonForFollowup ?? null,
    input.importance ?? "medium",
    id,
  );

  return getFollowup(id)!;
}

export function getDueFollowups(nowIso: string): FollowupRecord[] {
  return db
    .prepare(
      `SELECT ${FOLLOWUP_COLUMNS}
       FROM followups
       WHERE status = 'waiting' AND next_check_at <= ?
       ORDER BY importance = 'high' DESC, next_check_at ASC, id ASC`,
    )
    .all(nowIso) as FollowupRecord[];
}

export function recordFollowupNudge(
  id: number,
  lastNotifiedAt: string,
  nudgeCount: number,
  nextCheckAt: string,
): void {
  db.prepare(
    `UPDATE followups
     SET last_notified_at = ?,
         nudge_count = ?,
         next_check_at = ?
     WHERE id = ?`,
  ).run(lastNotifiedAt, nudgeCount, nextCheckAt, id);
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

export function snoozeFollowup(
  id: number,
  nextCheckAt: string,
): FollowupRecord | undefined {
  const result = db
    .prepare(
      `UPDATE followups
       SET status = 'snoozed',
           next_check_at = ?
       WHERE id = ? AND status IN ('waiting', 'snoozed')`,
    )
    .run(nextCheckAt, id);
  if (result.changes !== 1) {
    return undefined;
  }
  return getFollowup(id);
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
  meeting_json: string | null;
  created_at: string;
}

const NOTE_COLUMNS = `id, title, people, tag, content, pending_action_items, meeting_json, created_at`;

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
  meetingJson: string | null = null,
): NoteRecord {
  const result = db
    .prepare(
      `INSERT INTO notes (title, people, tag, content, pending_action_items, meeting_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      title,
      people,
      tag,
      content,
      pendingActionItems ? JSON.stringify(pendingActionItems) : null,
      meetingJson,
    );
  return getNote(Number(result.lastInsertRowid))!;
}

export function getNote(id: number): NoteRecord | undefined {
  return db
    .prepare(`SELECT ${NOTE_COLUMNS} FROM notes WHERE id = ?`)
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
        `SELECT ${NOTE_COLUMNS}
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
      `SELECT ${NOTE_COLUMNS}
       FROM notes
       WHERE title LIKE ? OR people LIKE ? OR content LIKE ?
       ORDER BY created_at DESC
       LIMIT 100`,
    )
    .all(pattern, pattern, pattern) as NoteRecord[];
}

export type AttachmentAlertStatus = "pending" | "reviewed" | "ignored";

export interface AttachmentAlertRecord {
  id: number;
  message_id: string;
  google_account: GoogleAccountId;
  attachment_id: string;
  file_name: string;
  mime_type: string;
  sender: string;
  subject: string;
  guessed_type: string;
  status: AttachmentAlertStatus;
  created_at: string;
}

const ATTACHMENT_ALERT_COLUMNS = `id, message_id, google_account, attachment_id, file_name,
  mime_type, sender, subject, guessed_type, status, created_at`;

export function createAttachmentAlert(input: {
  messageId: string;
  googleAccount: GoogleAccountId;
  attachmentId: string;
  fileName: string;
  mimeType: string;
  sender: string;
  subject: string;
  guessedType: string;
}): AttachmentAlertRecord | undefined {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO attachment_alerts (
         message_id, google_account, attachment_id, file_name, mime_type,
         sender, subject, guessed_type
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.messageId,
      input.googleAccount,
      input.attachmentId,
      input.fileName,
      input.mimeType,
      input.sender,
      input.subject,
      input.guessedType,
    );
  if (result.changes !== 1) {
    return undefined;
  }
  return getAttachmentAlert(Number(result.lastInsertRowid));
}

export function getAttachmentAlert(id: number): AttachmentAlertRecord | undefined {
  return db
    .prepare(
      `SELECT ${ATTACHMENT_ALERT_COLUMNS} FROM attachment_alerts WHERE id = ?`,
    )
    .get(id) as AttachmentAlertRecord | undefined;
}

export function getAttachmentAlertByMessage(
  googleAccount: GoogleAccountId,
  messageId: string,
  attachmentId: string,
): AttachmentAlertRecord | undefined {
  return db
    .prepare(
      `SELECT ${ATTACHMENT_ALERT_COLUMNS}
       FROM attachment_alerts
       WHERE google_account = ? AND message_id = ? AND attachment_id = ?`,
    )
    .get(googleAccount, messageId, attachmentId) as
    | AttachmentAlertRecord
    | undefined;
}

export function transitionAttachmentAlert(
  id: number,
  from: AttachmentAlertStatus,
  to: AttachmentAlertStatus,
): boolean {
  const result = db
    .prepare(
      `UPDATE attachment_alerts SET status = ? WHERE id = ? AND status = ?`,
    )
    .run(to, id, from);
  return result.changes === 1;
}

// Test-only: backdate a row's created_at by N hours. Used to exercise
// the age sweep without a 48-hour wait. Not called from production code.
export function __setAttachmentAlertAgeForTests(id: number, hoursAgo: number): void {
  db.prepare(
    `UPDATE attachment_alerts
     SET created_at = datetime('now', '-' || ? || ' hours')
     WHERE id = ?`,
  ).run(Math.max(0, Math.floor(hoursAgo)), id);
}

// Flip pending rows older than `hours` to 'ignored' so old emails don't
// clog the table and the scan loop. Returns how many rows were touched.
export function expireOldPendingAttachmentAlerts(hours: number): number {
  const safeHours = Math.max(1, Math.floor(hours));
  const result = db
    .prepare(
      `UPDATE attachment_alerts
       SET status = 'ignored'
       WHERE status = 'pending'
         AND created_at <= datetime('now', '-' || ? || ' hours')`,
    )
    .run(safeHours);
  return result.changes;
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

export interface UsageLogRow {
  timestamp: string;
  task: string;
  model: string;
  input_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export function insertUsageLog(row: UsageLogRow): void {
  db.prepare(
    `INSERT INTO usage_log (
       timestamp, task, model, input_tokens, cache_write_tokens,
       cache_read_tokens, output_tokens, cost_usd
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.timestamp,
    row.task,
    row.model,
    row.input_tokens,
    row.cache_write_tokens,
    row.cache_read_tokens,
    row.output_tokens,
    row.cost_usd,
  );
}

export function deleteUsageLogsByTimestamp(timestamp: string): void {
  db.prepare("DELETE FROM usage_log WHERE timestamp = ?").run(timestamp);
}

export function listUsageLogs(fromIso: string, toIso: string): UsageLogRow[] {
  return db
    .prepare(
      `SELECT timestamp, task, model, input_tokens, cache_write_tokens,
              cache_read_tokens, output_tokens, cost_usd
       FROM usage_log
       WHERE timestamp >= ? AND timestamp < ?
       ORDER BY timestamp ASC`,
    )
    .all(fromIso, toIso) as UsageLogRow[];
}

export const MORNING_BRIEF_SETTING = "morning_brief";

export function isMorningBriefEnabled(): boolean {
  return getSetting(MORNING_BRIEF_SETTING) === "on";
}

export function ensureMorningBriefSetting(): void {
  if (getSetting(MORNING_BRIEF_SETTING) === undefined) {
    setSetting(MORNING_BRIEF_SETTING, "off");
  }
}

export function getSetting(key: string): string | undefined {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function deleteSetting(key: string): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

export type MeetingNudgeStatus =
  | "briefed"
  | "nudged"
  | "remind_scheduled"
  | "re_nudged"
  | "skipped"
  | "wrapping"
  | "wrapped";

export interface MeetingBriefRecord {
  id: number;
  event_id: string;
  start_at: string;
  end_at: string;
  title: string;
  attendees_json: string;
  briefed_at: string;
  nudge_status: MeetingNudgeStatus;
  nudge_at: string | null;
  needs_rebrief: number;
  thresholds_sent: string;
}

const MEETING_BRIEF_COLUMNS = `id, event_id, start_at, end_at, title, attendees_json,
              briefed_at, nudge_status, nudge_at, needs_rebrief, thresholds_sent`;

export function parseThresholdsSent(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0);
  } catch {
    return [];
  }
}

export function recordMeetingBriefThreshold(
  id: number,
  minutes: number,
): boolean {
  const row = db
    .prepare(`SELECT thresholds_sent FROM meeting_briefs WHERE id = ?`)
    .get(id) as { thresholds_sent?: string } | undefined;
  if (!row) {
    return false;
  }
  const current = new Set(parseThresholdsSent(row.thresholds_sent ?? "[]"));
  if (current.has(minutes)) {
    return false;
  }
  current.add(minutes);
  const next = JSON.stringify([...current].sort((a, b) => b - a));
  const result = db
    .prepare(`UPDATE meeting_briefs SET thresholds_sent = ? WHERE id = ?`)
    .run(next, id);
  return result.changes === 1;
}

function sameInstant(left: string, right: string): boolean {
  const a = new Date(left).getTime();
  const b = new Date(right).getTime();
  return Number.isFinite(a) && a === b;
}

function isUniqueConstraint(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

export function getMeetingBrief(id: number): MeetingBriefRecord | undefined {
  return db
    .prepare(
      `SELECT ${MEETING_BRIEF_COLUMNS} FROM meeting_briefs WHERE id = ?`,
    )
    .get(id) as MeetingBriefRecord | undefined;
}

export function getMeetingBriefByEvent(
  eventId: string,
  startAt: string,
): MeetingBriefRecord | undefined {
  const rows = db
    .prepare(
      `SELECT ${MEETING_BRIEF_COLUMNS}
       FROM meeting_briefs
       WHERE event_id = ?
       ORDER BY id ASC`,
    )
    .all(eventId) as MeetingBriefRecord[];
  return rows.find((row) => sameInstant(row.start_at, startAt));
}

export function recordMeetingBrief(input: {
  eventId: string;
  startAt: string;
  endAt: string;
  title: string;
  attendeesJson: string;
  nudgeAt: string;
}): MeetingBriefRecord {
  const existing = getMeetingBriefByEvent(input.eventId, input.startAt);
  if (existing) {
    return existing;
  }
  const result = db
    .prepare(
      `INSERT INTO meeting_briefs (
         event_id, start_at, end_at, title, attendees_json, nudge_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.eventId,
      input.startAt,
      input.endAt,
      input.title,
      input.attendeesJson,
      input.nudgeAt,
    );
  return getMeetingBrief(Number(result.lastInsertRowid))!;
}

export function listMeetingBriefs(): MeetingBriefRecord[] {
  return db
    .prepare(
      `SELECT ${MEETING_BRIEF_COLUMNS}
       FROM meeting_briefs
       ORDER BY start_at ASC, id ASC`,
    )
    .all() as MeetingBriefRecord[];
}

export function rescheduleMeetingBrief(
  id: number,
  startAt: string,
  endAt: string,
  nudgeAt: string,
  needsRebrief: boolean,
): boolean {
  try {
    const result = db
      .prepare(
        `UPDATE meeting_briefs
         SET start_at = ?, end_at = ?, nudge_at = ?, needs_rebrief = ?,
             thresholds_sent = '[]'
         WHERE id = ?`,
      )
      .run(startAt, endAt, nudgeAt, needsRebrief ? 1 : 0, id);
    return result.changes === 1;
  } catch (error) {
    if (isUniqueConstraint(error)) {
      updateMeetingNudge(id, "skipped");
      return false;
    }
    throw error;
  }
}

export function clearMeetingRebrief(
  id: number,
  endAt: string,
  title: string,
  attendeesJson: string,
): void {
  db.prepare(
    `UPDATE meeting_briefs
     SET needs_rebrief = 0,
         end_at = ?,
         title = ?,
         attendees_json = ?,
         briefed_at = ?
     WHERE id = ?`,
  ).run(endAt, title, attendeesJson, new Date().toISOString(), id);
}

export function updateMeetingNudge(
  id: number,
  status: MeetingNudgeStatus,
  nudgeAt?: string | null,
): boolean {
  const result = db
    .prepare(
      `UPDATE meeting_briefs
       SET nudge_status = ?,
           nudge_at = CASE WHEN ? = 1 THEN ? ELSE nudge_at END
       WHERE id = ?`,
    )
    .run(status, nudgeAt === undefined ? 0 : 1, nudgeAt ?? null, id);
  return result.changes === 1;
}

export type WaitingOn = "me" | "them" | "nobody";
export type AccountRelationship = "partner" | "end_client";

export interface AccountRecord {
  id: number;
  name: string;
  aliases: string;
  email_domains: string;
  relationship: AccountRelationship;
  via_partner_id: number | null;
  people: string;
  stage: string;
  next_step: string;
  next_step_due: string | null;
  waiting_on: WaitingOn;
  last_activity_at: string | null;
  created_at: string;
}

const ACCOUNT_COLUMNS = `id, name, aliases, email_domains, relationship, via_partner_id,
              people, stage, next_step, next_step_due, waiting_on, last_activity_at, created_at`;

export function createAccount(input: {
  name: string;
  aliases?: string;
  emailDomains?: string;
  relationship?: AccountRelationship;
  viaPartnerId?: number | null;
  people?: string;
  stage?: string;
  nextStep?: string;
  nextStepDue?: string | null;
  waitingOn?: WaitingOn;
}): AccountRecord {
  const result = db
    .prepare(
      `INSERT INTO accounts (
         name, aliases, email_domains, relationship, via_partner_id, people,
         stage, next_step, next_step_due, waiting_on
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.name,
      input.aliases ?? "[]",
      input.emailDomains ?? "[]",
      input.relationship ?? "partner",
      input.viaPartnerId ?? null,
      input.people ?? "[]",
      input.stage ?? "",
      input.nextStep ?? "",
      input.nextStepDue ?? null,
      input.waitingOn ?? "nobody",
    );
  return getAccount(Number(result.lastInsertRowid))!;
}

export function getAccount(id: number): AccountRecord | undefined {
  return db
    .prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ?`)
    .get(id) as AccountRecord | undefined;
}

export function getAccounts(): AccountRecord[] {
  return db
    .prepare(
      `SELECT ${ACCOUNT_COLUMNS}
       FROM accounts
       ORDER BY last_activity_at IS NULL DESC, last_activity_at ASC, name ASC`,
    )
    .all() as AccountRecord[];
}

export function updateAccount(
  id: number,
  patch: {
    name?: string;
    aliases?: string;
    emailDomains?: string;
    relationship?: AccountRelationship;
    viaPartnerId?: number | null;
    people?: string;
    stage?: string;
    nextStep?: string;
    nextStepDue?: string | null;
    waitingOn?: WaitingOn;
  },
): AccountRecord | undefined {
  const current = getAccount(id);
  if (!current) {
    return undefined;
  }
  db.prepare(
    `UPDATE accounts
     SET name = ?,
         aliases = ?,
         email_domains = ?,
         relationship = ?,
         via_partner_id = ?,
         people = ?,
         stage = ?,
         next_step = ?,
         next_step_due = ?,
         waiting_on = ?
     WHERE id = ?`,
  ).run(
    patch.name ?? current.name,
    patch.aliases ?? current.aliases,
    patch.emailDomains ?? current.email_domains,
    patch.relationship ?? current.relationship,
    patch.viaPartnerId === undefined
      ? current.via_partner_id
      : patch.viaPartnerId,
    patch.people ?? current.people,
    patch.stage ?? current.stage,
    patch.nextStep ?? current.next_step,
    patch.nextStepDue === undefined ? current.next_step_due : patch.nextStepDue,
    patch.waitingOn ?? current.waiting_on,
    id,
  );
  return getAccount(id);
}

export function updateAccountActivity(
  id: number,
  lastActivityAt: string,
): void {
  const current = getAccount(id);
  if (!current) {
    return;
  }
  if (
    current.last_activity_at &&
    new Date(current.last_activity_at).getTime() >=
      new Date(lastActivityAt).getTime()
  ) {
    return;
  }
  db.prepare(`UPDATE accounts SET last_activity_at = ? WHERE id = ?`).run(
    lastActivityAt,
    id,
  );
}

export function removeAccount(id: number): boolean {
  const result = db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
  return result.changes === 1;
}

export interface PendingAccountUpdate {
  id: number;
  account_id: number;
  suggested_stage: string;
  suggested_next_step: string;
  suggested_waiting_on: WaitingOn;
  created_at: string;
}

export function createPendingAccountUpdate(input: {
  accountId: number;
  suggestedStage: string;
  suggestedNextStep: string;
  suggestedWaitingOn: WaitingOn;
}): PendingAccountUpdate {
  const result = db
    .prepare(
      `INSERT INTO pending_account_updates (
         account_id, suggested_stage, suggested_next_step, suggested_waiting_on
       ) VALUES (?, ?, ?, ?)`,
    )
    .run(
      input.accountId,
      input.suggestedStage,
      input.suggestedNextStep,
      input.suggestedWaitingOn,
    );
  return getPendingAccountUpdate(Number(result.lastInsertRowid))!;
}

export function getPendingAccountUpdate(
  id: number,
): PendingAccountUpdate | undefined {
  return db
    .prepare(
      `SELECT id, account_id, suggested_stage, suggested_next_step,
              suggested_waiting_on, created_at
       FROM pending_account_updates WHERE id = ?`,
    )
    .get(id) as PendingAccountUpdate | undefined;
}

export function deletePendingAccountUpdate(id: number): void {
  db.prepare(`DELETE FROM pending_account_updates WHERE id = ?`).run(id);
}

export type MemoryCategory =
  | "deal"
  | "plan"
  | "event"
  | "person"
  | "preference"
  | "other";
export type MemorySource = "explicit" | "confirmed" | "auto";

export interface MemoryRecord {
  id: number;
  content: string;
  category: MemoryCategory;
  tag: ItemTag;
  event_date: string | null;
  source: MemorySource;
  created_at: string;
  updated_at: string;
}

export interface MemoryInput {
  content: string;
  category: MemoryCategory;
  tag: ItemTag;
  eventDate?: string | null;
  source: MemorySource;
}

export interface PendingMemoryConfirm {
  id: number;
  content: string;
  category: MemoryCategory;
  tag: ItemTag;
  event_date: string | null;
  update_of_id: number | null;
  created_at: string;
}

const MEMORY_COLUMNS = `id, content, category, tag, event_date, source, created_at, updated_at`;
const MEMORY_COLUMNS_M = `m.id, m.content, m.category, m.tag, m.event_date, m.source, m.created_at, m.updated_at`;

function ftsMatchQuery(raw: string): string | null {
  const tokens = raw.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];
  const unique = [...new Set(tokens)].slice(0, 12);
  if (unique.length === 0) {
    return null;
  }
  return unique.map((token) => `"${token.replace(/"/g, "")}"`).join(" OR ");
}

export function isMemoriesFtsReady(): boolean {
  return memoriesFtsReady;
}

export function createMemory(input: MemoryInput): MemoryRecord {
  const result = db
    .prepare(
      `INSERT INTO memories (content, category, tag, event_date, source)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      input.content,
      input.category,
      input.tag,
      input.eventDate ?? null,
      input.source,
    );
  console.log(
    `Memory ${Number(result.lastInsertRowid)}: created category=${input.category} tag=${input.tag} source=${input.source}`,
  );
  return getMemory(Number(result.lastInsertRowid))!;
}

export function getMemory(id: number): MemoryRecord | undefined {
  return db
    .prepare(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE id = ?`)
    .get(id) as MemoryRecord | undefined;
}

export function listMemories(): MemoryRecord[] {
  return db
    .prepare(
      `SELECT ${MEMORY_COLUMNS} FROM memories
       ORDER BY category ASC, updated_at DESC, id DESC`,
    )
    .all() as MemoryRecord[];
}

export function countMemories(): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM memories`).get() as {
    n: number;
  };
  return row.n;
}

export function updateMemory(
  id: number,
  update: {
    content?: string;
    category?: MemoryCategory;
    tag?: ItemTag;
    eventDate?: string | null;
    source?: MemorySource;
  },
): MemoryRecord | undefined {
  const current = getMemory(id);
  if (!current) {
    return undefined;
  }
  db.prepare(
    `UPDATE memories
     SET content = ?,
         category = ?,
         tag = ?,
         event_date = ?,
         source = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).run(
    update.content ?? current.content,
    update.category ?? current.category,
    update.tag ?? current.tag,
    update.eventDate === undefined ? current.event_date : update.eventDate,
    update.source ?? current.source,
    id,
  );
  console.log(`Memory ${id}: updated`);
  return getMemory(id);
}

export function deleteMemory(id: number): boolean {
  const result = db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
  if (result.changes === 1) {
    console.log(`Memory ${id}: deleted`);
  }
  return result.changes === 1;
}

export function deleteAllMemories(): number {
  const result = db.prepare(`DELETE FROM memories`).run();
  console.log(`Memories: deleted count=${result.changes}`);
  return result.changes;
}

export function searchMemories(query: string, limit = 15): MemoryRecord[] {
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  const trimmed = query.trim();
  if (!trimmed) {
    return db
      .prepare(
        `SELECT ${MEMORY_COLUMNS} FROM memories
         ORDER BY updated_at DESC, id DESC
         LIMIT ?`,
      )
      .all(safeLimit) as MemoryRecord[];
  }

  const match = ftsMatchQuery(trimmed);
  if (memoriesFtsReady && match) {
    try {
      const rows = db
        .prepare(
          `SELECT ${MEMORY_COLUMNS_M}
           FROM memories m
           JOIN memories_fts f ON f.rowid = m.id
           WHERE memories_fts MATCH ?
           ORDER BY bm25(memories_fts), m.updated_at DESC, m.id DESC
           LIMIT ?`,
        )
        .all(match, safeLimit) as MemoryRecord[];
      if (rows.length > 0) {
        return rows;
      }
    } catch {
      // fall through to LIKE
    }
  }

  const pattern = `%${trimmed.replace(/[%_]/g, " ").trim()}%`;
  return db
    .prepare(
      `SELECT ${MEMORY_COLUMNS} FROM memories
       WHERE content LIKE ?
       ORDER BY updated_at DESC, id DESC
       LIMIT ?`,
    )
    .all(pattern, safeLimit) as MemoryRecord[];
}

export interface QaBankRecord {
  id: number;
  question: string;
  answer: string;
  source_doc: string | null;
  created_at: string;
}

const QA_BANK_COLUMNS = `id, question, answer, source_doc, created_at`;

export function isQaBankFtsReady(): boolean {
  return qaBankFtsReady;
}

export function createQaBankEntry(input: {
  question: string;
  answer: string;
  sourceDoc?: string | null;
}): QaBankRecord {
  const result = db
    .prepare(
      `INSERT INTO qa_bank (question, answer, source_doc)
       VALUES (?, ?, ?)`,
    )
    .run(input.question, input.answer, input.sourceDoc ?? null);
  return getQaBankEntry(Number(result.lastInsertRowid))!;
}

export function getQaBankEntry(id: number): QaBankRecord | undefined {
  return db
    .prepare(`SELECT ${QA_BANK_COLUMNS} FROM qa_bank WHERE id = ?`)
    .get(id) as QaBankRecord | undefined;
}

export function countQaBankEntries(): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM qa_bank`)
    .get() as { n: number };
  return row.n;
}

export function searchQaBank(query: string, limit = 3): QaBankRecord[] {
  const safeLimit = Math.max(1, Math.min(20, Math.floor(limit)));
  const trimmed = query.trim();
  if (!trimmed) {
    return db
      .prepare(
        `SELECT ${QA_BANK_COLUMNS} FROM qa_bank
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(safeLimit) as QaBankRecord[];
  }
  const match = ftsMatchQuery(trimmed);
  if (qaBankFtsReady && match) {
    try {
      const rows = db
        .prepare(
          `SELECT ${QA_BANK_COLUMNS.split(", ").map((c) => `q.${c}`).join(", ")}
           FROM qa_bank q
           JOIN qa_bank_fts f ON f.rowid = q.id
           WHERE qa_bank_fts MATCH ?
           ORDER BY bm25(qa_bank_fts), q.created_at DESC, q.id DESC
           LIMIT ?`,
        )
        .all(match, safeLimit) as QaBankRecord[];
      if (rows.length > 0) {
        return rows;
      }
    } catch {
      // fall through to LIKE
    }
  }
  const pattern = `%${trimmed.replace(/[%_]/g, " ").trim()}%`;
  return db
    .prepare(
      `SELECT ${QA_BANK_COLUMNS} FROM qa_bank
       WHERE question LIKE ? OR answer LIKE ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(pattern, pattern, safeLimit) as QaBankRecord[];
}

export function memoriesWithEventDateBetween(
  startYmd: string,
  endYmd: string,
): MemoryRecord[] {
  return db
    .prepare(
      `SELECT ${MEMORY_COLUMNS} FROM memories
       WHERE event_date IS NOT NULL
         AND event_date >= ?
         AND event_date <= ?
       ORDER BY event_date ASC, id ASC`,
    )
    .all(startYmd, endYmd) as MemoryRecord[];
}

export function createPendingMemoryConfirm(input: {
  content: string;
  category: MemoryCategory;
  tag: ItemTag;
  eventDate?: string | null;
  updateOfId?: number | null;
}): PendingMemoryConfirm {
  const result = db
    .prepare(
      `INSERT INTO pending_memory_confirms (
         content, category, tag, event_date, update_of_id
       ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      input.content,
      input.category,
      input.tag,
      input.eventDate ?? null,
      input.updateOfId ?? null,
    );
  return getPendingMemoryConfirm(Number(result.lastInsertRowid))!;
}

export function getPendingMemoryConfirm(
  id: number,
): PendingMemoryConfirm | undefined {
  return db
    .prepare(
      `SELECT id, content, category, tag, event_date, update_of_id, created_at
       FROM pending_memory_confirms WHERE id = ?`,
    )
    .get(id) as PendingMemoryConfirm | undefined;
}

export function deletePendingMemoryConfirm(id: number): void {
  db.prepare(`DELETE FROM pending_memory_confirms WHERE id = ?`).run(id);
}

export type BuildStatus =
  | "pending_confirm"
  | "running"
  | "waiting_checks"
  | "waiting_approval"
  | "review"
  | "awaiting_followup"
  | "merged"
  | "deploying"
  | "deployed"
  | "discarded"
  | "failed"
  | "rolled_back";

export interface BuildRecord {
  id: number;
  task: string;
  status: BuildStatus;
  cursor_agent_id: string | null;
  cursor_run_id: string | null;
  cursor_url: string | null;
  pr_url: string | null;
  pr_number: number | null;
  summary: string | null;
  files_json: string | null;
  error: string | null;
  merge_sha: string | null;
  created_at: string;
  updated_at: string;
}

const BUILD_COLUMNS = `id, task, status, cursor_agent_id, cursor_run_id, cursor_url,
              pr_url, pr_number, summary, files_json, error, merge_sha, created_at, updated_at`;

export function createBuild(task: string): BuildRecord {
  const result = db
    .prepare(`INSERT INTO builds (task) VALUES (?)`)
    .run(task);
  return getBuild(Number(result.lastInsertRowid))!;
}

export function getBuild(id: number): BuildRecord | undefined {
  return db
    .prepare(`SELECT ${BUILD_COLUMNS} FROM builds WHERE id = ?`)
    .get(id) as BuildRecord | undefined;
}

export function listBuilds(limit = 10): BuildRecord[] {
  return db
    .prepare(
      `SELECT ${BUILD_COLUMNS} FROM builds ORDER BY id DESC LIMIT ?`,
    )
    .all(limit) as BuildRecord[];
}

export function listBuildsByStatus(status: BuildStatus): BuildRecord[] {
  return db
    .prepare(
      `SELECT ${BUILD_COLUMNS} FROM builds WHERE status = ? ORDER BY id ASC`,
    )
    .all(status) as BuildRecord[];
}

export function listBuildsByStatuses(statuses: BuildStatus[]): BuildRecord[] {
  if (statuses.length === 0) {
    return [];
  }
  const placeholders = statuses.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT ${BUILD_COLUMNS} FROM builds WHERE status IN (${placeholders}) ORDER BY id ASC`,
    )
    .all(...statuses) as BuildRecord[];
}

export function updateBuild(
  id: number,
  fields: Partial<
    Pick<
      BuildRecord,
      | "status"
      | "cursor_agent_id"
      | "cursor_run_id"
      | "cursor_url"
      | "pr_url"
      | "pr_number"
      | "summary"
      | "files_json"
      | "error"
      | "merge_sha"
    >
  >,
): BuildRecord | undefined {
  const assignments: string[] = ["updated_at = CURRENT_TIMESTAMP"];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(fields)) {
    assignments.push(`${key} = ?`);
    values.push(value);
  }
  if (values.length === 0) {
    return getBuild(id);
  }
  db.prepare(`UPDATE builds SET ${assignments.join(", ")} WHERE id = ?`).run(
    ...values,
    id,
  );
  return getBuild(id);
}

export type MeetingInboundProcessedAs =
  | "seen"
  | "skip"
  | "detect"
  | "card"
  | "autobook"
  | "ask"
  | "ignore";

export interface MeetingInboundRecord {
  id: number;
  google_account: GoogleAccountId;
  message_id: string;
  thread_id: string;
  processed_as: MeetingInboundProcessedAs;
  created_at: string;
}

export type MeetingProposalStatus = "open" | "booked" | "expired" | "cancelled";

export interface MeetingProposalRecord {
  id: number;
  thread_id: string;
  sent_message_id: string;
  recipient_email: string;
  recipient_name: string;
  cc_emails: string;
  slots: string;
  duration_minutes: number;
  sender_timezone: string | null;
  hold_event_ids: string;
  status: MeetingProposalStatus;
  created_at: string;
}

export interface MeetingProposalInput {
  threadId: string;
  sentMessageId: string;
  recipientEmail: string;
  recipientName: string;
  ccEmails: string[];
  slots: Array<{ start: string; end: string }>;
  durationMinutes: number;
  senderTimezone: string | null;
  holdEventIds?: string[];
}

export type MeetingPendingBookingStatus = "pending" | "sent" | "cancelled";

export interface MeetingPendingBookingRecord {
  id: number;
  proposal_id: number;
  event_id: string;
  slot_index: number;
  send_at: string;
  status: MeetingPendingBookingStatus;
  skip_confirm: number;
  created_at: string;
}

export type MeetingThreadStatus =
  | "proposed"
  | "clarified"
  | "booked"
  | "handed_over"
  | "ignored";

export interface MeetingThreadRecord {
  thread_id: string;
  recipient_email: string;
  recipient_name: string;
  company: string;
  sender_type: string;
  status: MeetingThreadStatus;
  auto_emails_sent: number;
  last_kind: string | null;
  subject: string;
  proposal_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface MeetingDraftIntentRecord {
  draft_id: string;
  thread_id: string;
  recipient_email: string;
  recipient_name: string;
  cc_emails: string;
  slots: string;
  duration_minutes: number;
  sender_timezone: string | null;
  created_at: string;
}

const MEETING_INBOUND_COLUMNS = `id, google_account, message_id, thread_id, processed_as, created_at`;
const MEETING_PROPOSAL_COLUMNS = `id, thread_id, sent_message_id, recipient_email, recipient_name,
  cc_emails, slots, duration_minutes, sender_timezone, hold_event_ids, status, created_at`;
const MEETING_PENDING_COLUMNS = `id, proposal_id, event_id, slot_index, send_at, status, skip_confirm, created_at`;
const MEETING_INTENT_COLUMNS = `draft_id, thread_id, recipient_email, recipient_name, cc_emails,
  slots, duration_minutes, sender_timezone, created_at`;

export function insertMeetingInbound(input: {
  googleAccount?: GoogleAccountId;
  messageId: string;
  threadId: string;
  processedAs?: MeetingInboundProcessedAs;
}): MeetingInboundRecord | undefined {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO meeting_inbounds (
         google_account, message_id, thread_id, processed_as
       ) VALUES (?, ?, ?, ?)`,
    )
    .run(
      input.googleAccount ?? "work",
      input.messageId,
      input.threadId,
      input.processedAs ?? "seen",
    );
  if (result.changes !== 1) {
    return undefined;
  }
  return getMeetingInbound(Number(result.lastInsertRowid));
}

export function getMeetingInbound(id: number): MeetingInboundRecord | undefined {
  return db
    .prepare(
      `SELECT ${MEETING_INBOUND_COLUMNS} FROM meeting_inbounds WHERE id = ?`,
    )
    .get(id) as MeetingInboundRecord | undefined;
}

export function getMeetingInboundByMessage(
  googleAccount: GoogleAccountId,
  messageId: string,
): MeetingInboundRecord | undefined {
  return db
    .prepare(
      `SELECT ${MEETING_INBOUND_COLUMNS}
       FROM meeting_inbounds
       WHERE google_account = ? AND message_id = ?`,
    )
    .get(googleAccount, messageId) as MeetingInboundRecord | undefined;
}

export function setMeetingInboundProcessedAs(
  id: number,
  processedAs: MeetingInboundProcessedAs,
): void {
  db.prepare(`UPDATE meeting_inbounds SET processed_as = ? WHERE id = ?`).run(
    processedAs,
    id,
  );
}

export function createMeetingProposal(
  input: MeetingProposalInput,
): MeetingProposalRecord {
  const result = db
    .prepare(
      `INSERT INTO meeting_proposals (
         thread_id, sent_message_id, recipient_email, recipient_name, cc_emails,
         slots, duration_minutes, sender_timezone, hold_event_ids
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.threadId,
      input.sentMessageId,
      input.recipientEmail.toLowerCase(),
      input.recipientName,
      JSON.stringify(input.ccEmails.map((email) => email.toLowerCase())),
      JSON.stringify(input.slots),
      input.durationMinutes,
      input.senderTimezone,
      JSON.stringify(input.holdEventIds ?? []),
    );
  return getMeetingProposal(Number(result.lastInsertRowid))!;
}

export function getMeetingProposal(id: number): MeetingProposalRecord | undefined {
  return db
    .prepare(
      `SELECT ${MEETING_PROPOSAL_COLUMNS} FROM meeting_proposals WHERE id = ?`,
    )
    .get(id) as MeetingProposalRecord | undefined;
}

export function getLatestMeetingProposalByThread(
  threadId: string,
): MeetingProposalRecord | undefined {
  return db
    .prepare(
      `SELECT ${MEETING_PROPOSAL_COLUMNS}
       FROM meeting_proposals
       WHERE thread_id = ?
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get(threadId) as MeetingProposalRecord | undefined;
}

export function getOpenMeetingProposalByThread(
  threadId: string,
): MeetingProposalRecord | undefined {
  return db
    .prepare(
      `SELECT ${MEETING_PROPOSAL_COLUMNS}
       FROM meeting_proposals
       WHERE thread_id = ? AND status = 'open'
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get(threadId) as MeetingProposalRecord | undefined;
}

export function listOpenMeetingProposals(): MeetingProposalRecord[] {
  return db
    .prepare(
      `SELECT ${MEETING_PROPOSAL_COLUMNS}
       FROM meeting_proposals
       WHERE status = 'open'
       ORDER BY id ASC`,
    )
    .all() as MeetingProposalRecord[];
}

export function setMeetingProposalStatus(
  id: number,
  status: MeetingProposalStatus,
): void {
  db.prepare(`UPDATE meeting_proposals SET status = ? WHERE id = ?`).run(
    status,
    id,
  );
}

export function setMeetingProposalHolds(id: number, holdEventIds: string[]): void {
  db.prepare(`UPDATE meeting_proposals SET hold_event_ids = ? WHERE id = ?`).run(
    JSON.stringify(holdEventIds),
    id,
  );
}

export function setMeetingProposalSlots(
  id: number,
  slots: Array<{ start: string; end: string }>,
): void {
  db.prepare(`UPDATE meeting_proposals SET slots = ? WHERE id = ?`).run(
    JSON.stringify(slots),
    id,
  );
}

export function createMeetingPendingBooking(input: {
  proposalId: number;
  eventId: string;
  slotIndex: number;
  sendAt: string;
  skipConfirm?: boolean;
}): MeetingPendingBookingRecord {
  const result = db
    .prepare(
      `INSERT INTO meeting_pending_bookings (
         proposal_id, event_id, slot_index, send_at, skip_confirm
       ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      input.proposalId,
      input.eventId,
      input.slotIndex,
      input.sendAt,
      input.skipConfirm ? 1 : 0,
    );
  return getMeetingPendingBooking(Number(result.lastInsertRowid))!;
}

export function getMeetingPendingBooking(
  id: number,
): MeetingPendingBookingRecord | undefined {
  return db
    .prepare(
      `SELECT ${MEETING_PENDING_COLUMNS} FROM meeting_pending_bookings WHERE id = ?`,
    )
    .get(id) as MeetingPendingBookingRecord | undefined;
}

export function getPendingBookingForProposal(
  proposalId: number,
): MeetingPendingBookingRecord | undefined {
  return db
    .prepare(
      `SELECT ${MEETING_PENDING_COLUMNS}
       FROM meeting_pending_bookings
       WHERE proposal_id = ? AND status = 'pending'
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get(proposalId) as MeetingPendingBookingRecord | undefined;
}

export function listDueMeetingPendingBookings(
  nowIso: string,
): MeetingPendingBookingRecord[] {
  return db
    .prepare(
      `SELECT ${MEETING_PENDING_COLUMNS}
       FROM meeting_pending_bookings
       WHERE status = 'pending' AND send_at <= ?
       ORDER BY send_at ASC`,
    )
    .all(nowIso) as MeetingPendingBookingRecord[];
}

export function listMeetingPendingBookings(): MeetingPendingBookingRecord[] {
  return db
    .prepare(
      `SELECT ${MEETING_PENDING_COLUMNS}
       FROM meeting_pending_bookings
       ORDER BY id ASC`,
    )
    .all() as MeetingPendingBookingRecord[];
}

export function transitionMeetingPendingBooking(
  id: number,
  from: MeetingPendingBookingStatus,
  to: MeetingPendingBookingStatus,
): boolean {
  const result = db
    .prepare(
      `UPDATE meeting_pending_bookings SET status = ? WHERE id = ? AND status = ?`,
    )
    .run(to, id, from);
  return result.changes === 1;
}

export function upsertMeetingDraftIntent(input: {
  draftId: string;
  threadId: string;
  recipientEmail: string;
  recipientName: string;
  ccEmails: string[];
  slots: Array<{ start: string; end: string }>;
  durationMinutes: number;
  senderTimezone: string | null;
}): void {
  db.prepare(
    `INSERT INTO meeting_draft_intents (
       draft_id, thread_id, recipient_email, recipient_name, cc_emails,
       slots, duration_minutes, sender_timezone
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(draft_id) DO UPDATE SET
       thread_id = excluded.thread_id,
       recipient_email = excluded.recipient_email,
       recipient_name = excluded.recipient_name,
       cc_emails = excluded.cc_emails,
       slots = excluded.slots,
       duration_minutes = excluded.duration_minutes,
       sender_timezone = excluded.sender_timezone`,
  ).run(
    input.draftId,
    input.threadId,
    input.recipientEmail.toLowerCase(),
    input.recipientName,
    JSON.stringify(input.ccEmails.map((email) => email.toLowerCase())),
    JSON.stringify(input.slots),
    input.durationMinutes,
    input.senderTimezone,
  );
}

export function getMeetingDraftIntent(
  draftId: string,
): MeetingDraftIntentRecord | undefined {
  return db
    .prepare(
      `SELECT ${MEETING_INTENT_COLUMNS} FROM meeting_draft_intents WHERE draft_id = ?`,
    )
    .get(draftId) as MeetingDraftIntentRecord | undefined;
}

export function deleteMeetingDraftIntent(draftId: string): void {
  db.prepare(`DELETE FROM meeting_draft_intents WHERE draft_id = ?`).run(draftId);
}

export function setMeetingCardState(inboundId: number, payload: string): void {
  db.prepare(
    `INSERT INTO meeting_card_state (inbound_id, payload) VALUES (?, ?)
     ON CONFLICT(inbound_id) DO UPDATE SET payload = excluded.payload`,
  ).run(inboundId, payload);
}

export function getMeetingCardState(inboundId: number): string | undefined {
  const row = db
    .prepare(`SELECT payload FROM meeting_card_state WHERE inbound_id = ?`)
    .get(inboundId) as { payload: string } | undefined;
  return row?.payload;
}

export function deleteMeetingCardState(inboundId: number): void {
  db.prepare(`DELETE FROM meeting_card_state WHERE inbound_id = ?`).run(inboundId);
}

export interface JobRunRecord {
  name: string;
  last_success_at: string | null;
  last_attempt_at: string;
  last_status: string;
}

export function recordJobRun(
  name: string,
  status: "ok" | "error" | "soft_error" | "overlap" | "deferred",
  at = new Date(),
): void {
  const iso = at.toISOString();
  const existing = getJobRun(name);
  const successAt =
    status === "ok" ? iso : (existing?.last_success_at ?? null);
  db.prepare(
    `INSERT INTO job_runs (name, last_success_at, last_attempt_at, last_status)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       last_success_at = excluded.last_success_at,
       last_attempt_at = excluded.last_attempt_at,
       last_status = excluded.last_status`,
  ).run(name, successAt, iso, status);
}

export function getJobRun(name: string): JobRunRecord | undefined {
  return db
    .prepare(
      `SELECT name, last_success_at, last_attempt_at, last_status
       FROM job_runs WHERE name = ?`,
    )
    .get(name) as JobRunRecord | undefined;
}

export function listJobRuns(): JobRunRecord[] {
  return db
    .prepare(
      `SELECT name, last_success_at, last_attempt_at, last_status
       FROM job_runs ORDER BY name ASC`,
    )
    .all() as JobRunRecord[];
}

const MEETING_THREAD_COLUMNS = `thread_id, recipient_email, recipient_name, company, sender_type,
  status, auto_emails_sent, last_kind, subject, proposal_id, created_at, updated_at`;

export function upsertMeetingThread(input: {
  threadId: string;
  recipientEmail: string;
  recipientName: string;
  company: string;
  senderType: string;
  status: MeetingThreadStatus;
  autoEmailsSent?: number;
  lastKind?: string | null;
  subject: string;
  proposalId?: number | null;
}): MeetingThreadRecord {
  db.prepare(
    `INSERT INTO meeting_threads (
       thread_id, recipient_email, recipient_name, company, sender_type,
       status, auto_emails_sent, last_kind, subject, proposal_id, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(thread_id) DO UPDATE SET
       recipient_email = excluded.recipient_email,
       recipient_name = excluded.recipient_name,
       company = excluded.company,
       sender_type = excluded.sender_type,
       status = excluded.status,
       auto_emails_sent = excluded.auto_emails_sent,
       last_kind = excluded.last_kind,
       subject = excluded.subject,
       proposal_id = excluded.proposal_id,
       updated_at = CURRENT_TIMESTAMP`,
  ).run(
    input.threadId,
    input.recipientEmail.toLowerCase(),
    input.recipientName,
    input.company,
    input.senderType,
    input.status,
    input.autoEmailsSent ?? 0,
    input.lastKind ?? null,
    input.subject,
    input.proposalId ?? null,
  );
  return getMeetingThread(input.threadId)!;
}

export function getMeetingThread(threadId: string): MeetingThreadRecord | undefined {
  return db
    .prepare(
      `SELECT ${MEETING_THREAD_COLUMNS} FROM meeting_threads WHERE thread_id = ?`,
    )
    .get(threadId) as MeetingThreadRecord | undefined;
}

export function listMeetingThreads(): MeetingThreadRecord[] {
  return db
    .prepare(
      `SELECT ${MEETING_THREAD_COLUMNS}
       FROM meeting_threads
       ORDER BY updated_at DESC, created_at DESC`,
    )
    .all() as MeetingThreadRecord[];
}

export function recordMeetingAutoSend(input: {
  threadId: string;
  kind: "proposal" | "clarify" | "confirm";
  messageId: string;
}): void {
  db.prepare(
    `INSERT INTO meeting_auto_sends (thread_id, kind, message_id) VALUES (?, ?, ?)`,
  ).run(input.threadId, input.kind, input.messageId);
}

export function countMeetingAutoSendsToday(
  now: Date,
  timeZone = "Asia/Kolkata",
): number {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const rows = db
    .prepare(`SELECT created_at FROM meeting_auto_sends`)
    .all() as Array<{ created_at: string }>;
  return rows.filter((row) => {
    const created = new Date(
      row.created_at.includes("T") ? row.created_at : `${row.created_at}Z`,
    );
    const day = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(created);
    return day === today;
  }).length;
}

export function listMeetingAutoSendIds(threadId: string): string[] {
  return (
    db
      .prepare(`SELECT message_id FROM meeting_auto_sends WHERE thread_id = ?`)
      .all(threadId) as Array<{ message_id: string }>
  ).map((row) => row.message_id);
}
