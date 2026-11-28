import Database from "better-sqlite3";
import { addOneMonthYmd } from "./bill_cycle.js";
import { sameConversation } from "./subject_logic.js";
import { assertTestSeam } from "./test_seam.js";
import { parseAddressList } from "./address_list.js";

export type MessageRole = "user" | "assistant" | "tool";

export interface StoredMessage {
  id: number;
  role: MessageRole;
  content: string;
  created_at: string;
  tool_name: string | null;
}

export type PendingActionStatus =
  | "pending"
  | "sent"
  | "discarded"
  | "expired"
  | "created"
  | "cancelled"
  | "superseded";

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
  auto_send_at: string | null;
  updated_at: string | null;
  to_header: string | null;
  live_to_header?: string | null;
  sent_at?: string | null;
  sent_message_id?: string | null;
  sent_thread_id?: string | null;
  cc_header: string | null;
  subject: string | null;
  /** The send command this card stands for, when a command became a card. */
  command_key: string | null;
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
  suspected_duplicate_of: number | null;
}

export type ReminderRecurrence = "none" | "daily" | "weekly" | "weekdays";
export type ReminderStatus = "pending" | "sent" | "cancelled";
/** Why a reminder left `pending`. `ignore` is the only reason restore may undo. */
export type ReminderStatusReason = "user" | "completion" | "ignore" | "other";

export interface ReminderRecord {
  id: number;
  text: string;
  tag: ItemTag;
  remind_at: string;
  recurrence: ReminderRecurrence;
  status: ReminderStatus;
  created_at: string;
  related_task_id: number | null;
  related_bill_id: number | null;
  /** Stable id shared by every occurrence of one recurring schedule. */
  series_id: number | null;
  status_reason: ReminderStatusReason | null;
}

/** Sales sequence tables. The startup rebuild creates the same tables, so an old
 *  database ends up exactly like a new one. Up to 9 steps: 3 he sent himself and 6
 *  from Aadi. */
const SALES_SEQUENCES_BODY = `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    account TEXT NOT NULL DEFAULT 'work' CHECK (account = 'work'),
    prospect_email TEXT NOT NULL,
    prospect_domain TEXT NOT NULL,
    prospect_key TEXT NOT NULL,
    prospect_name TEXT NOT NULL DEFAULT '',
    prospect_company TEXT NOT NULL DEFAULT '',
    prospect_timezone TEXT,
    subject TEXT NOT NULL DEFAULT '',
    original_message_id TEXT NOT NULL,
    original_sent_at TEXT NOT NULL,
    status TEXT NOT NULL
      CHECK (status IN ('proposed', 'active', 'stopped', 'completed')),
    stop_reason TEXT,
    current_step INTEGER NOT NULL DEFAULT 1 CHECK (current_step BETWEEN 1 AND 9),
    steps_sent INTEGER NOT NULL DEFAULT 0 CHECK (steps_sent BETWEEN 0 AND 9),
    manual_followups INTEGER NOT NULL DEFAULT 0 CHECK (manual_followups BETWEEN 0 AND 3),
    original_ask TEXT CHECK (original_ask IN ('demo', 'partnership_call', 'meeting')),
    next_step_at TEXT,
    enrolled_at TEXT,
    classifier_confidence REAL,
    classifier_reason TEXT,
    card_message_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    prospect_timezone_source TEXT,
    total_steps INTEGER NOT NULL DEFAULT 4 CHECK (total_steps BETWEEN 1 AND 9),
    step_days INTEGER CHECK (step_days BETWEEN 1 AND 14),
    cc_first_only INTEGER NOT NULL DEFAULT 1 CHECK (cc_first_only IN (0, 1)),
    cta TEXT,
    command_key TEXT,
    UNIQUE (account, thread_id)
`;

const SALES_SEQUENCE_STEPS_BODY = `
    sequence_id INTEGER NOT NULL REFERENCES sales_sequences (id),
    step_no INTEGER NOT NULL CHECK (step_no BETWEEN 1 AND 9),
    scheduled_at TEXT,
    draft_text TEXT,
    check_result TEXT,
    status TEXT NOT NULL DEFAULT 'planned'
      CHECK (status IN ('planned', 'sending', 'sent', 'blocked', 'skipped')),
    sent_message_id TEXT,
    sent_at TEXT,
    reason TEXT,
    draft_id TEXT,
    claimed_at TEXT,
    blocked_at TEXT,
    waiting_ping_at TEXT,
    slot_lines TEXT,
    cc TEXT,
    PRIMARY KEY (sequence_id, step_no)
`;

export const DB_PATH = process.env.AADI_DB_PATH?.trim() || "./aadi.db";

export const db = new Database(DB_PATH);

export async function backupDatabaseTo(destPath: string): Promise<void> {
  await db.backup(destPath);
}

function tableHasColumn(table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return rows.some((row) => row.name === column);
}

/** Record rules are unique by entity id. Source and category rules stay unique
 *  by normalized key. Safe to run on every open: it only drops the old index. */
function migrateIgnoreRuleIndexes(): void {
  const table = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ignore_rules'`,
    )
    .get() as { name: string } | undefined;
  if (!table) {
    return;
  }
  const duplicates = db
    .prepare(
      `SELECT entity_type, entity_id, tag, MIN(id) AS keep_id
         FROM ignore_rules
        WHERE status = 'active'
          AND match_scope = 'record'
          AND entity_id IS NOT NULL
        GROUP BY entity_type, entity_id, tag
       HAVING COUNT(*) > 1`,
    )
    .all() as Array<{
    entity_type: string;
    entity_id: string;
    tag: string;
    keep_id: number;
  }>;
  const retiredAt = new Date().toISOString();
  for (const row of duplicates) {
    db.prepare(
      `UPDATE ignore_rules
          SET status = 'resumed', resumed_at = ?
        WHERE status = 'active'
          AND match_scope = 'record'
          AND entity_type = ?
          AND entity_id = ?
          AND tag = ?
          AND id != ?`,
    ).run(retiredAt, row.entity_type, row.entity_id, row.tag, row.keep_id);
  }
  db.exec(`
    DROP INDEX IF EXISTS idx_ignore_rules_active_key;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ignore_rules_active_record
      ON ignore_rules (entity_type, entity_id, match_scope, tag)
      WHERE status = 'active' AND match_scope = 'record' AND entity_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ignore_rules_active_record_key
      ON ignore_rules (entity_type, match_key, match_scope, tag)
      WHERE status = 'active' AND match_scope = 'record' AND entity_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ignore_rules_active_source
      ON ignore_rules (entity_type, match_key, match_scope, tag)
      WHERE status = 'active' AND match_scope IN ('source', 'category');
  `);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    tool_name TEXT
  );

  CREATE TABLE IF NOT EXISTS calendar_event_refs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    account_id TEXT NOT NULL CHECK (account_id IN ('work', 'personal')),
    title TEXT NOT NULL,
    start_iso TEXT NOT NULL,
    attendees_json TEXT NOT NULL DEFAULT '[]',
    focused INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    UNIQUE (chat_id, account_id, event_id)
  );

  CREATE INDEX IF NOT EXISTS idx_calendar_event_refs_chat
    ON calendar_event_refs (chat_id, focused DESC, updated_at DESC);

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
        'created', 'cancelled', 'superseded'
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

  -- An OCR/photo result and the Telegram messages that point to it.  The chat
  -- scope prevents a reply in one chat from selecting another chat's document.
  CREATE TABLE IF NOT EXISTS telegram_document_refs (
    chat_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    document_id INTEGER NOT NULL REFERENCES documents(id),
    created_ms INTEGER NOT NULL,
    PRIMARY KEY (chat_id, message_id)
  );

  CREATE INDEX IF NOT EXISTS idx_telegram_document_refs_recent
    ON telegram_document_refs (chat_id, created_ms DESC);

  CREATE TABLE IF NOT EXISTS jobs (
    job_id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running'
      CHECK (status IN ('running', 'done', 'failed', 'cancelled', 'paused')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    cost_usd REAL NOT NULL DEFAULT 0,
    budget_usd REAL NOT NULL DEFAULT 0.5,
    owner_text TEXT NOT NULL,
    telegram_chat_id INTEGER,
    telegram_message_id INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_status_updated
    ON jobs (status, updated_at);

  CREATE TABLE IF NOT EXISTS job_steps (
    job_id INTEGER NOT NULL,
    step_id TEXT NOT NULL,
    step_order INTEGER NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'running', 'done', 'failed', 'skipped')),
    attempts INTEGER NOT NULL DEFAULT 0,
    depends_on TEXT NOT NULL DEFAULT '[]',
    input_ref TEXT NOT NULL DEFAULT '{}',
    done_condition TEXT NOT NULL,
    result_ref TEXT,
    done_check_passed INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    started_at TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (job_id, step_id)
  );

  CREATE INDEX IF NOT EXISTS idx_job_steps_job_order
    ON job_steps (job_id, step_order);

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

  CREATE TABLE IF NOT EXISTS llm_backend_flags (
    backend TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    flagged_at TEXT NOT NULL
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

  CREATE TABLE IF NOT EXISTS ignore_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id TEXT NOT NULL DEFAULT 'owner',
    tag TEXT NOT NULL CHECK (tag IN ('work', 'personal', 'both')),
    entity_type TEXT NOT NULL CHECK (entity_type IN (
      'bill', 'task', 'reminder', 'date', 'email_source',
      'account', 'notification', 'build', 'calendar_event'
    )),
    entity_id TEXT,
    match_key TEXT NOT NULL,
    match_scope TEXT NOT NULL CHECK (match_scope IN ('record', 'source', 'category')),
    duration TEXT NOT NULL CHECK (duration IN ('permanent', 'temporary')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT,
    instruction TEXT NOT NULL,
    auth_ref TEXT NOT NULL,
    reason TEXT,
    resumed_at TEXT,
    status TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'resumed', 'expired'))
  );

  CREATE INDEX IF NOT EXISTS idx_ignore_rules_lookup
    ON ignore_rules (status, entity_type, match_key);
  CREATE INDEX IF NOT EXISTS idx_ignore_rules_expiry
    ON ignore_rules (status, expires_at);

  CREATE TABLE IF NOT EXISTS ignore_rule_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id INTEGER NOT NULL,
    action TEXT NOT NULL CHECK (action IN (
      'created', 'resumed', 'expired', 'duplicate'
    )),
    at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    auth_ref TEXT NOT NULL,
    instruction TEXT,
    detail TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_ignore_rule_events_rule
    ON ignore_rule_events (rule_id, at);

  CREATE TABLE IF NOT EXISTS pending_action_contexts (
    chat_id INTEGER PRIMARY KEY,
    action TEXT NOT NULL,
    state_json TEXT NOT NULL,
    owner_words TEXT NOT NULL,
    confirm_chat INTEGER NOT NULL,
    confirm_message INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS closed_email_contexts (
    chat_id INTEGER PRIMARY KEY,
    detail TEXT NOT NULL,
    closed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS presented_referents (
    chat_id INTEGER PRIMARY KEY,
    entities_json TEXT NOT NULL,
    pending_kind TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS canonical_contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name_key TEXT NOT NULL,
    display_name TEXT NOT NULL,
    emails_json TEXT NOT NULL,
    company TEXT,
    aliases_json TEXT NOT NULL DEFAULT '[]',
    sources_json TEXT NOT NULL DEFAULT '[]',
    confirmed INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_canonical_contacts_name
    ON canonical_contacts (name_key);
`);

migrateIgnoreRuleIndexes();

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

  CREATE TABLE IF NOT EXISTS message_embeddings (
    message_id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL,
    model TEXT NOT NULL,
    scheme TEXT NOT NULL,
    dims INTEGER NOT NULL,
    vector BLOB,
    skip_reason TEXT
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

  CREATE TABLE IF NOT EXISTS sales_sequences (${SALES_SEQUENCES_BODY});

  CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_sequences_open_prospect
    ON sales_sequences (prospect_key)
    WHERE status IN ('proposed', 'active');

  CREATE TABLE IF NOT EXISTS sales_sequence_steps (${SALES_SEQUENCE_STEPS_BODY});

  CREATE INDEX IF NOT EXISTS idx_sales_sequence_steps_sent_message
    ON sales_sequence_steps (sent_message_id);

  CREATE TABLE IF NOT EXISTS command_sends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idem_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'unconfirmed')),
    account TEXT NOT NULL,
    thread_id TEXT,
    sent_message_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sent_at TEXT
  );

  CREATE TABLE IF NOT EXISTS command_send_choices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'used', 'cancelled')),
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS contact_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    request TEXT NOT NULL,
    query TEXT NOT NULL,
    options TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'dropped')),
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS contact_choices (
    name_key TEXT PRIMARY KEY,
    contact TEXT NOT NULL,
    chosen_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS scheduled_sends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idem_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'scheduled'
      CHECK (status IN ('scheduled', 'held', 'sending', 'sent', 'cancelled', 'failed')),
    send_at TEXT NOT NULL,
    retry_at TEXT,
    task_id INTEGER NOT NULL REFERENCES tasks (id),
    item_text TEXT NOT NULL,
    request TEXT NOT NULL,
    confirm_chat INTEGER NOT NULL,
    confirm_message INTEGER NOT NULL,
    write_failures INTEGER NOT NULL DEFAULT 0,
    claimed_at TEXT,
    sent_message_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_scheduled_sends_status_time
    ON scheduled_sends (status, send_at);

  CREATE TABLE IF NOT EXISTS sales_do_not_contact (
    email TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sales_pitch_scans (
    message_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    is_sales_pitch INTEGER NOT NULL,
    confidence REAL NOT NULL,
    reason TEXT NOT NULL,
    scanned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS processed_messages (
    chat_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (chat_id, message_id)
  );

  CREATE INDEX IF NOT EXISTS idx_processed_messages_at
    ON processed_messages (processed_at);

  CREATE TABLE IF NOT EXISTS chat_turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ended_at TEXT,
    duration_ms INTEGER,
    outcome TEXT NOT NULL DEFAULT 'running'
      CHECK (outcome IN ('running', 'ok', 'failed', 'timeout', 'empty')),
    error TEXT,
    retry_text TEXT,
    forwarded INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_chat_turns_started
    ON chat_turns (started_at, outcome);

  CREATE TABLE IF NOT EXISTS local_model_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    until_id INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ok', 'error')),
    duration_ms INTEGER,
    local_model TEXT NOT NULL,
    cloud_backend TEXT NOT NULL,
    cloud_model TEXT NOT NULL,
    cloud_summary TEXT NOT NULL,
    local_summary TEXT,
    error TEXT,
    input_chars INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_local_model_runs_created
    ON local_model_runs (created_at DESC);
`);

if (!tableHasColumn("chat_turns", "forwarded")) {
  db.exec(
    `ALTER TABLE chat_turns ADD COLUMN forwarded INTEGER NOT NULL DEFAULT 0`,
  );
}

{
  const schema = db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'`,
    )
    .get() as { sql: string } | undefined;
  const allowsTool = schema?.sql?.includes("'tool'") === true;
  if (!allowsTool) {
    const toolNameSelect = tableHasColumn("messages", "tool_name")
      ? "tool_name"
      : "NULL";
    db.exec(`
      CREATE TABLE messages_role_migrate (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        tool_name TEXT
      );
      INSERT INTO messages_role_migrate (id, role, content, created_at, tool_name)
        SELECT id, role, content, created_at, ${toolNameSelect} FROM messages;
      DROP TABLE messages;
      ALTER TABLE messages_role_migrate RENAME TO messages;
    `);
  } else if (!tableHasColumn("messages", "tool_name")) {
    db.exec(`ALTER TABLE messages ADD COLUMN tool_name TEXT`);
  }
}

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

// Shadow mode was removed. Its tables and job record go with it.
db.exec(`
  DROP TABLE IF EXISTS shadow_replies;
  DROP TABLE IF EXISTS shadow_skip_counts;
  DELETE FROM job_runs WHERE name = 'shadow-evening';
`);
// The old follow-up tracker was removed. Its table (and with it its index) and its
// job record go too. Sales sequences never read it.
db.exec(`
  DROP TABLE IF EXISTS followups;
  DELETE FROM job_runs WHERE name = 'followup-scan';
`);
if (!tableHasColumn("sales_sequences", "prospect_timezone_source")) {
  db.exec(`ALTER TABLE sales_sequences ADD COLUMN prospect_timezone_source TEXT`);
}
// Each planned step stores its allowed copies from the original pitch.
if (!tableHasColumn("sales_sequence_steps", "cc")) {
  db.exec(`ALTER TABLE sales_sequence_steps ADD COLUMN cc TEXT`);
}
// His own count, gap and call-to-action, from a typed or spoken command. A row
// without them is a Start-tap sequence: 4 steps, SEQUENCE_STEP_DAYS, inferred ask.
for (const [column, type] of [
  ["total_steps", "INTEGER NOT NULL DEFAULT 4"],
  ["step_days", "INTEGER"],
  ["cc_first_only", "INTEGER NOT NULL DEFAULT 1 CHECK (cc_first_only IN (0, 1))"],
  ["cta", "TEXT"],
  ["command_key", "TEXT"],
] as const) {
  if (!tableHasColumn("sales_sequences", column)) {
    db.exec(`ALTER TABLE sales_sequences ADD COLUMN ${column} ${type}`);
  }
}
// Which sent email an Aadi message was about, so "put this email in a follow-up
// sequence" in reply to it can find the thread. (pending_actions gets its column
// after its own rebuild below.)
if (!tableHasColumn("command_sends", "telegram_message_id")) {
  db.exec(`ALTER TABLE command_sends ADD COLUMN telegram_message_id INTEGER`);
}

const WIDE_SEQUENCES = "current_step BETWEEN 1 AND 9";
const WIDE_STEPS = "step_no BETWEEN 1 AND 9";

function tableSqlOf(handle: Database.Database, name: string): string {
  return (
    handle
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name) as { sql: string } | undefined
  )?.sql ?? "";
}

function columnsOf(handle: Database.Database, table: string): string[] {
  return (handle.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

/**
 * SQLite can't widen a CHECK, so an old database gets both sequence tables rebuilt
 * once, from the same definitions a new database uses. It runs in one transaction
 * and checks counts and foreign keys before it commits. On any failure it rolls
 * back, logs one line and leaves the old tables, which cap a sequence at 4 steps.
 * Startup never stops on it.
 */
export function migrateSalesSequenceLimits(
  handle: Database.Database = db,
): "skipped" | "rebuilt" | "failed" {
  const sequencesSql = tableSqlOf(handle, "sales_sequences");
  const stepsSql = tableSqlOf(handle, "sales_sequence_steps");
  if (!sequencesSql || !stepsSql || (sequencesSql.includes(WIDE_SEQUENCES) && stepsSql.includes(WIDE_STEPS))) {
    return "skipped";
  }
  const foreignKeys = handle.pragma("foreign_keys", { simple: true }) as number;
  handle.pragma("foreign_keys = OFF");
  try {
    handle.transaction(() => {
      const copy = (from: string, to: string): void => {
        const oldColumns = columnsOf(handle, from);
        const newColumns = new Set(columnsOf(handle, to));
        const unknown = oldColumns.filter((column) => !newColumns.has(column));
        if (unknown.length > 0) {
          throw new Error(`${from} has columns the new table lacks: ${unknown.join(", ")}`);
        }
        const list = oldColumns.join(", ");
        handle.exec(`INSERT INTO ${to} (${list}) SELECT ${list} FROM ${from}`);
        const count = (table: string): number =>
          (handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
        if (count(from) !== count(to)) {
          throw new Error(`${from} row count changed while copying`);
        }
      };
      handle.exec(`CREATE TABLE sales_sequences_rebuild (${SALES_SEQUENCES_BODY})`);
      copy("sales_sequences", "sales_sequences_rebuild");
      handle.exec(
        `CREATE TABLE sales_sequence_steps_rebuild (${SALES_SEQUENCE_STEPS_BODY})`,
      );
      copy("sales_sequence_steps", "sales_sequence_steps_rebuild");
      handle.exec(`
        DROP TABLE sales_sequence_steps;
        DROP TABLE sales_sequences;
        ALTER TABLE sales_sequences_rebuild RENAME TO sales_sequences;
        ALTER TABLE sales_sequence_steps_rebuild RENAME TO sales_sequence_steps;
        CREATE UNIQUE INDEX idx_sales_sequences_open_prospect
          ON sales_sequences (prospect_key)
          WHERE status IN ('proposed', 'active');
        CREATE INDEX idx_sales_sequence_steps_sent_message
          ON sales_sequence_steps (sent_message_id);
      `);
      const broken = handle.pragma("foreign_key_check") as unknown[];
      if (broken.length > 0) {
        throw new Error(`${broken.length} rows fail the foreign key check`);
      }
    })();
    console.log("Sales sequences: tables rebuilt; up to 6 follow-ups allowed.");
    return "rebuilt";
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    const detail = error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 160) : "";
    console.error(
      `Sales sequence rebuild failed (${errorType}: ${detail}); rolled back, running on the old tables with follow-ups capped at 4.`,
    );
    return "failed";
  } finally {
    handle.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  }
}

migrateSalesSequenceLimits();

let stepCapForTests: number | undefined;

export function setSalesSequenceStepCapForTests(cap: number | undefined): void {
  assertTestSeam("setSalesSequenceStepCapForTests");
  stepCapForTests = cap;
}

/** How many step rows one sequence may have here: 9 once the tables are rebuilt,
 *  4 while the old tables are still in place. */
export function salesSequenceStepCap(): number {
  if (stepCapForTests !== undefined) {
    return stepCapForTests;
  }
  return tableSqlOf(db, "sales_sequence_steps").includes(WIDE_STEPS) ? 9 : 4;
}
// One open sequence per person, not per company: the key is the address itself.
if (tableHasColumn("sales_sequences", "prospect_key")) {
  db.exec(`
    UPDATE sales_sequences SET prospect_key = lower(trim(prospect_email))
    WHERE prospect_key <> lower(trim(prospect_email));
  `);
}
db.exec(`
  CREATE TABLE IF NOT EXISTS sales_facts_added (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section TEXT,
    fact TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);
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
// Same pattern for bills: a bill reminder's "Done" button marks the
// bill paid and cancels its sibling reminders.
if (!tableHasColumn("reminders", "related_bill_id")) {
  db.exec(`ALTER TABLE reminders ADD COLUMN related_bill_id INTEGER`);
}
if (!tableHasColumn("reminders", "series_id")) {
  db.exec(`ALTER TABLE reminders ADD COLUMN series_id INTEGER`);
}
if (!tableHasColumn("reminders", "status_reason")) {
  db.exec(`ALTER TABLE reminders ADD COLUMN status_reason TEXT`);
}
// Each existing recurring row is its own series. Never merge on text.
db.exec(
  `UPDATE reminders
      SET series_id = id
    WHERE series_id IS NULL
      AND recurrence != 'none'`,
);

// Autonomy / rules engine: when a draft passes auto_send_approved, the
// pending action's auto_send_at carries the scheduled send instant.
// The scheduler fires sends whose row has auto_send_at <= now.
if (!tableHasColumn("pending_actions", "auto_send_at")) {
  db.exec(`ALTER TABLE pending_actions ADD COLUMN auto_send_at TEXT`);
}

if (!tableHasColumn("pending_actions", "updated_at")) {
  db.exec(`ALTER TABLE pending_actions ADD COLUMN updated_at TEXT`);
  db.exec(
    `UPDATE pending_actions SET updated_at = created_at WHERE updated_at IS NULL`,
  );
}
if (!tableHasColumn("pending_actions", "to_header")) {
  db.exec(`ALTER TABLE pending_actions ADD COLUMN to_header TEXT`);
}
if (!tableHasColumn("pending_actions", "cc_header")) {
  db.exec(`ALTER TABLE pending_actions ADD COLUMN cc_header TEXT`);
}
// The send command a Send card stands for: one command, at most one email.
if (!tableHasColumn("pending_actions", "command_key")) {
  db.exec(`ALTER TABLE pending_actions ADD COLUMN command_key TEXT`);
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_actions_command_key ON pending_actions (command_key)`);
if (!tableHasColumn("pending_actions", "subject")) {
  db.exec(`ALTER TABLE pending_actions ADD COLUMN subject TEXT`);
}

// Dedupe metadata: when MinHash flags a near-duplicate we store the
// MATCHED record's id here instead of silently dropping the new row.
if (!tableHasColumn("tasks", "suspected_duplicate_of")) {
  db.exec(`ALTER TABLE tasks ADD COLUMN suspected_duplicate_of INTEGER`);
}
if (!tableHasColumn("bills", "suspected_duplicate_of")) {
  db.exec(`ALTER TABLE bills ADD COLUMN suspected_duplicate_of INTEGER`);
}
// Bills need the raw snippet to dedupe against; previous rows won't have
// it, which is fine - dedupe only runs on the trailing 7 days.
if (!tableHasColumn("bills", "source_text")) {
  db.exec(`ALTER TABLE bills ADD COLUMN source_text TEXT`);
}
// Why a bill left `upcoming`. Resuming an ignore may only undo `ignore`.
// The backfill runs once, in the same transaction that adds the column.
if (!tableHasColumn("bills", "status_reason")) {
  db.transaction(() => {
    db.exec(`ALTER TABLE bills ADD COLUMN status_reason TEXT`);
    backfillLegacyBillIgnoreProvenance();
  })();
}

/**
 * Before this column, three paths set a bill to `ignored`: the bill-card
 * Ignore button, duplicate removal and skip-this-cycle. The card only acted
 * on `upcoming` bills. Duplicate removal always leaves `suspected_duplicate_of`
 * set. A cycle skip always leaves a row for the same biller on the next
 * cycle's due date (it creates one, or one already existed). So an ignored
 * row with neither, whose first record rule is the active rule its own card
 * created, was changed by that card. Anything else stays NULL and Resume
 * never resets it.
 */
export function backfillLegacyBillIgnoreProvenance(): number {
  const candidates = db
    .prepare(
      `SELECT b.id, b.biller, b.due_date, b.thread_id
         FROM bills b
         JOIN ignore_rules r
           ON r.entity_type = 'bill'
          AND r.match_scope = 'record'
          AND r.entity_id = CAST(b.id AS TEXT)
          AND r.status = 'active'
          AND r.instruction = 'telegram:bill-ignore'
          AND r.auth_ref = 'telegram:callback:' || b.id
        WHERE b.status = 'ignored'
          AND b.status_reason IS NULL
          AND b.suspected_duplicate_of IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM ignore_rules earlier
             WHERE earlier.entity_type = 'bill'
               AND earlier.match_scope = 'record'
               AND earlier.entity_id = r.entity_id
               AND earlier.id < r.id
          )`,
    )
    .all() as Array<{ id: number; biller: string; due_date: string; thread_id: string }>;
  const nextCycle = db.prepare(
    `SELECT 1 FROM bills
      WHERE id != ?
        AND due_date = ?
        AND (LOWER(biller) = LOWER(?) OR thread_id = ?)
      LIMIT 1`,
  );
  const mark = db.prepare(
    `UPDATE bills SET status_reason = 'ignore'
      WHERE id = ? AND status = 'ignored' AND status_reason IS NULL`,
  );
  let marked = 0;
  for (const bill of candidates) {
    let nextDue: string;
    try {
      nextDue = addOneMonthYmd(bill.due_date);
    } catch {
      continue;
    }
    if (nextCycle.get(bill.id, nextDue, bill.biller, bill.thread_id)) {
      continue;
    }
    marked += mark.run(bill.id).changes;
  }
  return marked;
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

let messagesFtsReady = false;
try {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      content='messages',
      content_rowid='id',
      tokenize='porter'
    );
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content)
        VALUES('delete', old.id, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF content ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content)
        VALUES('delete', old.id, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
  `);
  messagesFtsReady = true;
  const rebuilt = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get("messages_fts_rebuilt_v1") as { value: string } | undefined;
  if (rebuilt?.value !== "1") {
    db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild');`);
    db.prepare(
      `INSERT INTO settings (key, value) VALUES ('messages_fts_rebuilt_v1', '1')
       ON CONFLICT(key) DO UPDATE SET value = '1'`,
    ).run();
    console.log("messages FTS index rebuilt");
  }
} catch (error) {
  messagesFtsReady = false;
  const errorType = error instanceof Error ? error.name : "UnknownError";
  console.error(`Message FTS5 unavailable (${errorType}); search will scan a bounded slice.`);
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
// The Gmail message a sent draft card became, for "put this email in a follow-up sequence".
if (!tableHasColumn("pending_actions", "sent_message_id")) {
  db.exec(`ALTER TABLE pending_actions ADD COLUMN sent_message_id TEXT`);
}
for (const table of ["pending_actions", "scheduled_sends"]) {
  if (!tableHasColumn(table, "sent_at")) db.exec(`ALTER TABLE ${table} ADD COLUMN sent_at TEXT`);
}
if (!tableHasColumn("pending_actions", "sent_thread_id")) {
  db.exec("ALTER TABLE pending_actions ADD COLUMN sent_thread_id TEXT");
}
db.exec(`CREATE TABLE IF NOT EXISTS unconfirmed_draft_deliveries (
  account TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  attempted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account, draft_id)
)`);
// A "send then follow-ups" request rides on the card of an email that needs his tap.
if (!tableHasColumn("pending_actions", "followup_words")) {
  db.exec(`ALTER TABLE pending_actions ADD COLUMN followup_words TEXT`);
}
if (!tableHasColumn("pending_actions", "followup_key")) {
  db.exec(`ALTER TABLE pending_actions ADD COLUMN followup_key TEXT`);
}
if (!tableHasColumn("pending_actions", "live_to_header")) {
  // Keep the live recipient separate from the header Telegram has confirmed it showed.
  // Rebuild older tables to widen their status CHECK and preserve every approval field.
  db.transaction(() => {
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'pending_actions'").get() as { sql: string };
    if (!schema.sql.includes("'superseded'")) {
      db.exec(`
        ${schema.sql.replace(/^CREATE TABLE\s+["`]?pending_actions["`]?/i, "CREATE TABLE pending_actions_replacement").replace("'cancelled'", "'cancelled', 'superseded'")};
        INSERT INTO pending_actions_replacement SELECT * FROM pending_actions;
        DROP TABLE pending_actions;
        ALTER TABLE pending_actions_replacement RENAME TO pending_actions;
        CREATE INDEX idx_pending_actions_draft_status ON pending_actions (draft_id, status);
        CREATE INDEX idx_pending_actions_command_key ON pending_actions (command_key);
      `);
    }
    db.exec("ALTER TABLE pending_actions ADD COLUMN live_to_header TEXT");
  }).immediate();
}
db.exec(`
  -- Addresses he has sent to (Gmail Sent, either account) or Aadi sent to on his
  -- confirmation. Only "known" is ever stored; "new" is never cached.
  CREATE TABLE IF NOT EXISTS known_recipients (
    email TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    checked_at TEXT NOT NULL
  );
  -- Each address a draft's card has shown him, and the newest of his messages that had
  -- arrived by then. Shown before message M means that watermark is below M.
  -- Who each posted card message shows, written only once Telegram confirmed the
  -- post or edit. shown_watermark: his newest message when it was shown.
  CREATE TABLE IF NOT EXISTS card_message_recipients (
    message_id INTEGER NOT NULL,
    draft_id TEXT NOT NULL,
    email TEXT NOT NULL,
    shown_watermark INTEGER NOT NULL,
    shown_at TEXT NOT NULL,
    PRIMARY KEY (message_id, draft_id, email)
  );
  CREATE INDEX IF NOT EXISTS idx_card_message_recipients_draft ON card_message_recipients (draft_id);
`);

db.exec(`
  -- People a read tool showed on his own chat turn: the From/To/Cc headers of an email
  -- or draft it read, a calendar event's attendees, a contact lookup's one match. Headers
  -- and attendee lists only, never body text. Short-lived: they are who a name in this
  -- chat can mean.
  CREATE TABLE IF NOT EXISTS conversation_participants (
    chat_id INTEGER NOT NULL,
    email TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL,
    source_ref TEXT NOT NULL DEFAULT '',
    seen_at TEXT NOT NULL,
    PRIMARY KEY (chat_id, email, source, source_ref)
  );
  CREATE INDEX IF NOT EXISTS idx_conversation_participants_chat ON conversation_participants (chat_id, seen_at);
  -- The people an Aadi message was about (a meeting brief's attendees, from Calendar),
  -- so his Telegram reply to that message can mean one of them.
  CREATE TABLE IF NOT EXISTS telegram_message_participants (
    message_id INTEGER NOT NULL,
    source TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    participants_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (message_id, source, source_ref)
  );
  -- A card that told him "You emailed X at T. Send another?", written only by the card
  -- builder once Telegram confirmed it. His tap on that card, or his own message after
  -- it, confirms another email to X for sends up to sent_at.
  -- An address his own turn pointed at in a photo's text or a quoted message: usable as
  -- that email's recipient (always through the new-address card), never as a fact about
  -- who a name means, an invite or an attendee, unless he types it himself.
  CREATE TABLE IF NOT EXISTS external_addresses (
    chat_id INTEGER NOT NULL,
    email TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (chat_id, email)
  );
  CREATE TABLE IF NOT EXISTS card_recent_send_warnings (
    message_id INTEGER NOT NULL,
    card_key TEXT NOT NULL,
    email TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    shown_watermark INTEGER NOT NULL,
    shown_at TEXT NOT NULL,
    PRIMARY KEY (message_id, card_key, email)
  );
`);
// Who a direct command send went to, so a second email to them can be checked.
if (!tableHasColumn("command_sends", "to_header")) {
  db.exec("ALTER TABLE command_sends ADD COLUMN to_header TEXT");
}

/**
 * Pre-fix NiCE HQ caches stored Asia/Jerusalem on sales_sequences.prospect_timezone,
 * which stops the sequence runner from calling chooseProspectZone. There is no
 * company_name column; the company is prospect_company. NULL on both cache
 * columns is the signal to resolve again on the next tick. A global company
 * with no person-level place resolves to US Pacific.
 *
 * Idempotent: rows that are not that zone, or not a NiCE company, are left
 * alone, and a second run changes nothing. An owner correction stays: the
 * runner never looks that source up again. The settings row makes it one-shot
 * so a later correct Asia/Jerusalem is not wiped on every process start.
 */
export const STALE_NICE_JERUSALEM_TZ_KEY = "sales_sequences_cleared_stale_jerusalem";

export function clearStaleNiceJerusalemTimezones(): number {
  return db
    .prepare(
      `UPDATE sales_sequences
       SET prospect_timezone = NULL,
           prospect_timezone_source = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE prospect_timezone = 'Asia/Jerusalem'
         AND prospect_company LIKE '%NiCE%'
         AND COALESCE(prospect_timezone_source, '') <> 'owner'`,
    )
    .run().changes;
}

export function migrateStaleNiceJerusalemTimezones(): number {
  const done = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(STALE_NICE_JERUSALEM_TZ_KEY) as { value: string } | undefined;
  if (done?.value === "1") {
    return 0;
  }
  const changes = db.transaction(() => {
    const cleared = clearStaleNiceJerusalemTimezones();
    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, '1')
       ON CONFLICT(key) DO UPDATE SET value = '1'`,
    ).run(STALE_NICE_JERUSALEM_TZ_KEY);
    return cleared;
  })();
  if (changes > 0) {
    console.log(
      `Cleared ${changes} stale NiCE Asia/Jerusalem sequence timezone${changes === 1 ? "" : "s"}.`,
    );
  }
  return changes;
}

migrateStaleNiceJerusalemTimezones();

const insertMessage = db.prepare(
  "INSERT INTO messages (role, content, tool_name) VALUES (?, ?, ?)",
);

export function saveMessage(
  role: MessageRole,
  content: string,
  toolName?: string | null,
): void {
  insertMessage.run(role, content, role === "tool" ? toolName ?? "tool" : null);
}

export function getRecentMessages(limit = 10): StoredMessage[] {
  const safeLimit = Math.max(0, Math.floor(limit));
  const rows = db
    .prepare(
      `SELECT id, role, content, created_at, tool_name
       FROM messages
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(safeLimit) as StoredMessage[];

  return rows.reverse();
}

export interface MessageHit {
  id: number;
  content: string;
  created_at: string;
}

function messageSearchForms(tokens: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const token of tokens) {
    const word = token.toLowerCase();
    if (word.length < 3) {
      continue;
    }
    forms.add(word);
    if (word.length >= 6 && forms.size < 12) {
      for (let index = 0; index < word.length && forms.size < 12; index += 1) {
        if (word[index] === "h" || word[index] === "i") {
          const variant = `${word.slice(0, index)}${word[index] === "i" ? "y" : ""}${word.slice(index + 1)}`;
          if (variant.length >= 3) {
            forms.add(variant);
          }
        }
      }
    }
  }
  return [...forms].slice(0, 12);
}

/**
 * Candidate chat lines for one lookup. FTS5 supplies a small set; the caller ranks it.
 * Without FTS, only the latest 200 non-tool rows are read, then whole words are kept.
 */
export function searchRelevantMessages(tokens: readonly string[], limit = 24): MessageHit[] {
  const safeLimit = Math.max(1, Math.min(24, Math.floor(limit)));
  const forms = messageSearchForms(tokens);
  if (forms.length === 0) {
    return [];
  }
  if (messagesFtsReady) {
    const match = forms.map((form) => `"${form.replace(/"/g, "")}"`).join(" OR ");
    try {
      return db
        .prepare(
          `SELECT m.id, m.content, m.created_at
           FROM messages m
           JOIN messages_fts f ON f.rowid = m.id
           WHERE messages_fts MATCH ? AND m.role != 'tool'
           ORDER BY bm25(messages_fts), m.id DESC
           LIMIT ?`,
        )
        .all(match, safeLimit) as MessageHit[];
    } catch (error) {
      const errorType = error instanceof Error ? error.name : "UnknownError";
      console.error(`Message FTS query failed (${errorType}); scanning a bounded slice.`);
    }
  }
  const rows = db
    .prepare(
      `SELECT id, content, created_at
       FROM messages
       WHERE role != 'tool'
       ORDER BY id DESC
       LIMIT 200`,
    )
    .all() as MessageHit[];
  return rows
    .filter((row) =>
      forms.some((form) => new RegExp(`(?<![\\p{L}\\p{N}])${form}(?![\\p{L}\\p{N}])`, "iu").test(row.content)),
    )
    .slice(0, safeLimit);
}

export interface CalendarEventRefRecord {
  chatId: number;
  eventId: string;
  accountId: "work" | "personal";
  title: string;
  startIso: string;
  attendees: Array<{ name: string; email: string }>;
  focused: boolean;
  updatedAt: string;
}

const CALENDAR_REF_LIMIT = 20;

export function upsertCalendarEventRef(input: {
  chatId: number;
  eventId: string;
  accountId: "work" | "personal";
  title: string;
  startIso: string;
  attendees: Array<{ name: string; email: string }>;
  focused?: boolean;
  updatedAt: string;
}): void {
  const attendees = input.attendees.slice(0, 30);
  const focused = input.focused ? 1 : 0;
  db.transaction(() => {
    if (focused) {
      db.prepare(`UPDATE calendar_event_refs SET focused = 0 WHERE chat_id = ?`).run(input.chatId);
    }
    db.prepare(
      `INSERT INTO calendar_event_refs
        (chat_id, event_id, account_id, title, start_iso, attendees_json, focused, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chat_id, account_id, event_id) DO UPDATE SET
         title = excluded.title,
         start_iso = excluded.start_iso,
         attendees_json = excluded.attendees_json,
         focused = CASE WHEN excluded.focused = 1 THEN 1 ELSE calendar_event_refs.focused END,
         updated_at = excluded.updated_at`,
    ).run(
      input.chatId,
      input.eventId,
      input.accountId,
      input.title,
      input.startIso,
      JSON.stringify(attendees),
      focused,
      input.updatedAt,
    );
    db.prepare(
      `DELETE FROM calendar_event_refs
       WHERE chat_id = ?
         AND id NOT IN (
           SELECT id FROM calendar_event_refs
           WHERE chat_id = ?
           ORDER BY focused DESC, updated_at DESC
           LIMIT ?
         )`,
    ).run(input.chatId, input.chatId, CALENDAR_REF_LIMIT);
  })();
}

export function listCalendarEventRefs(chatId: number): CalendarEventRefRecord[] {
  const rows = db
    .prepare(
      `SELECT event_id, account_id, title, start_iso, attendees_json, focused, updated_at
       FROM calendar_event_refs
       WHERE chat_id = ?
       ORDER BY focused DESC, updated_at DESC
       LIMIT ?`,
    )
    .all(chatId, CALENDAR_REF_LIMIT) as Array<{
    event_id: string;
    account_id: "work" | "personal";
    title: string;
    start_iso: string;
    attendees_json: string;
    focused: number;
    updated_at: string;
  }>;
  return rows.map((row) => {
    let attendees: Array<{ name: string; email: string }> = [];
    try {
      const parsed = JSON.parse(row.attendees_json) as Array<{ name?: string; email?: string }>;
      attendees = parsed
        .map((person) => ({
          name: person.name ?? "",
          email: (person.email ?? "").toLowerCase(),
        }))
        .filter((person) => person.email);
    } catch {
      attendees = [];
    }
    return {
      chatId,
      eventId: row.event_id,
      accountId: row.account_id,
      title: row.title,
      startIso: row.start_iso,
      attendees,
      focused: row.focused === 1,
      updatedAt: row.updated_at,
    };
  });
}

export const CONVERSATION_SUMMARY_KEY = "conversation_summary";
export const CONVERSATION_SUMMARY_UNTIL_KEY = "conversation_summary_until_id";

export function clearMessages(): void {
  db.prepare("DELETE FROM messages").run();
  db.prepare("DELETE FROM message_embeddings").run();
  db.prepare("DELETE FROM settings WHERE key IN (?, ?)").run(
    CONVERSATION_SUMMARY_KEY,
    CONVERSATION_SUMMARY_UNTIL_KEY,
  );
}

export interface AwaitingEmbedMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

export function listMessagesAwaitingEmbedding(limit: number): AwaitingEmbedMessage[] {
  const safeLimit = Math.max(0, Math.floor(limit));
  return db
    .prepare(
      `SELECT m.id, m.role, m.content, m.created_at
       FROM messages m
       LEFT JOIN message_embeddings e ON e.message_id = m.id
       WHERE e.message_id IS NULL
         AND m.role IN ('user', 'assistant')
       ORDER BY m.id ASC
       LIMIT ?`,
    )
    .all(safeLimit) as AwaitingEmbedMessage[];
}

export interface SearchableEmbedding {
  message_id: number;
  role: string;
  content: string;
  created_at: string;
  vector: Buffer;
}

export function listSearchableEmbeddings(
  model: string,
  scheme: string,
  excludeNewest: number,
): SearchableEmbedding[] {
  const skip = Math.max(0, Math.floor(excludeNewest));
  return db
    .prepare(
      `SELECT e.message_id, m.role, m.content, m.created_at, e.vector
       FROM message_embeddings e
       JOIN messages m ON m.id = e.message_id
       WHERE e.model = ?
         AND e.scheme = ?
         AND e.vector IS NOT NULL
         AND e.message_id NOT IN (
           SELECT id FROM messages ORDER BY id DESC LIMIT ?
         )`,
    )
    .all(model, scheme, skip) as SearchableEmbedding[];
}

export function insertMessageEmbedding(row: {
  messageId: number;
  createdAt: string;
  model: string;
  scheme: string;
  dims: number;
  vector: Buffer | null;
  skipReason: string | null;
}): void {
  db.prepare(
    `INSERT INTO message_embeddings (
       message_id, created_at, model, scheme, dims, vector, skip_reason
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.messageId,
    row.createdAt,
    row.model,
    row.scheme,
    row.dims,
    row.vector,
    row.skipReason,
  );
}

const PENDING_ACTION_COLUMNS = `id, type, draft_id, thread_id, google_account, status,
              telegram_message_id, event_title, event_start, event_end,
              event_attendees, event_description, created_at, auto_send_at,
              updated_at, to_header, cc_header, subject, command_key, live_to_header, sent_at, sent_message_id, sent_thread_id`;

export function createPendingAction(
  draftId: string,
  threadId: string | null,
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

/** The card's draft is now a reply in this thread, or (null) a new conversation. */
export function setPendingActionThread(id: number, threadId: string | null): void {
  db.prepare(`UPDATE pending_actions SET thread_id = ? WHERE id = ?`).run(threadId, id);
}

/** A send command became this card: its key lives with the card from now on. */
export function setPendingActionCommandKey(id: number, key: string): void {
  db.prepare(`UPDATE pending_actions SET command_key = ? WHERE id = ?`).run(key, id);
}

/** The card a send command became, whatever has happened to it since. */
export function pendingActionForCommandKey(key: string): PendingAction | undefined {
  return db
    .prepare(
      `SELECT ${PENDING_ACTION_COLUMNS}
       FROM pending_actions
       WHERE command_key = ?
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get(key) as PendingAction | undefined;
}

export function getPendingActionForDraft(
  draftId: string,
  account?: GoogleAccountId,
): PendingAction | undefined {
  return db
    .prepare(
      `SELECT ${PENDING_ACTION_COLUMNS}
       FROM pending_actions
       WHERE draft_id = ? AND status = 'pending' AND (? IS NULL OR google_account = ?)
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get(draftId, account ?? null, account ?? null) as PendingAction | undefined;
}

export function latestDraftAction(draftId: string, account?: GoogleAccountId): PendingAction | undefined {
  return db.prepare(`SELECT ${PENDING_ACTION_COLUMNS} FROM pending_actions
    WHERE draft_id = ? AND (? IS NULL OR google_account = ?) ORDER BY id DESC LIMIT 1`)
    .get(draftId, account ?? null, account ?? null) as PendingAction | undefined;
}

export function pendingDraftActionForMessage(messageId: number): PendingAction | undefined {
  return db.prepare(`SELECT ${PENDING_ACTION_COLUMNS} FROM pending_actions
    WHERE type = 'send_draft' AND (telegram_message_id = ? OR EXISTS (
      SELECT 1 FROM card_message_recipients AS shown
      WHERE shown.message_id = ? AND shown.draft_id = pending_actions.draft_id
    )) ORDER BY (telegram_message_id = ?) DESC, id DESC LIMIT 1`).get(messageId, messageId, messageId) as PendingAction | undefined;
}

export function draftCardMessageIds(action: PendingAction): number[] {
  const rows = db.prepare("SELECT DISTINCT message_id FROM card_message_recipients WHERE draft_id = ?")
    .all(action.draft_id) as Array<{ message_id: number }>;
  return [...new Set([action.telegram_message_id, ...rows.map((row) => row.message_id)])]
    .filter((messageId): messageId is number => messageId !== null);
}

function pendingDrafts(account?: GoogleAccountId): PendingAction[] {
  return db.prepare(`SELECT ${PENDING_ACTION_COLUMNS} FROM pending_actions
    WHERE type = 'send_draft' AND status = 'pending' AND (? IS NULL OR google_account = ?)
    ORDER BY id DESC`).all(account ?? null, account ?? null) as PendingAction[];
}

function draftToAddresses(action: PendingAction): string[] {
  return parseAddressList(action.live_to_header ?? action.to_header ?? "").map(({ email }) => email);
}

function supersedeDraft(action: PendingAction): boolean {
  if (!transitionPendingAction(action.id, "pending", "superseded")) return false;
  if (action.draft_id) cancelOpenDraftSchedules(action.draft_id, action.google_account);
  return true;
}

function supersedeOverlappingDrafts(account: GoogleAccountId, to: string, exceptId?: number): PendingAction[] {
  const addresses = new Set(parseAddressList(to).map(({ email }) => email));
  return pendingDrafts(account).filter((other) =>
    other.id !== exceptId && draftToAddresses(other).some((email) => addresses.has(email)) && supersedeDraft(other),
  );
}

function olderDuplicateDrafts(): PendingAction[] {
  const seen = new Set<string>();
  return pendingDrafts().filter((action) => {
    const keys = draftToAddresses(action).map((email) => `${action.google_account}:${email}`);
    const duplicate = keys.some((key) => seen.has(key));
    keys.forEach((key) => seen.add(key));
    return duplicate;
  });
}

/** Persist the winner for cards created before recipient uniqueness was enforced. */
export function reconcilePendingDrafts(): PendingAction[] {
  return db.transaction(() => olderDuplicateDrafts().filter(supersedeDraft)).immediate();
}

export function supersedeDraftIfReplaced(action: PendingAction, liveTo: string): PendingAction[] {
  const addresses = new Set(parseAddressList(liveTo).map(({ email }) => email));
  return db.transaction(() => {
    const replaced = pendingDrafts(action.google_account).some((other) =>
      other.id > action.id && draftToAddresses(other).some((email) => addresses.has(email)),
    );
    return replaced && supersedeDraft(action) ? [action] : [];
  }).immediate();
}

export function registerPendingDraft(input: {
  draftId: string; threadId: string | null; account: GoogleAccountId; to: string; commandKey?: string;
}): { action?: PendingAction; replaced: PendingAction[] } {
  return db.transaction(() => {
    const existing = latestDraftAction(input.draftId, input.account);
    if (existing && isClosedEmailStatus(existing.status) && existing.status !== "expired") return { replaced: [] };
    if (existing?.status === "pending" && olderDuplicateDrafts().some((row) => row.id === existing.id)) {
      return { replaced: supersedeDraft(existing) ? [existing] : [] };
    }
    const action = existing?.status === "pending" ? existing : createPendingAction(input.draftId, input.threadId, input.account);
    if (existing?.status === "expired") {
      db.prepare(`DELETE FROM closed_email_contexts
        WHERE json_extract(detail, '$.status') = 'expired'
          AND json_extract(detail, '$.draftId') = ?
          AND json_extract(detail, '$.account') = ?`).run(input.draftId, input.account);
    }
    db.prepare("UPDATE pending_actions SET live_to_header = ? WHERE id = ?").run(input.to, action.id);
    if (input.commandKey) setPendingActionCommandKey(action.id, input.commandKey);
    return { action, replaced: supersedeOverlappingDrafts(input.account, input.to, action.id) };
  }).immediate();
}

/** Record delivery and retire any overlapping drafts in the same transaction. */
export function settleDraftDelivery(input: {
  account: GoogleAccountId; to: string; actionId?: number; draftId?: string;
  commandKey?: string | null; sentMessageId?: string;
  sentThreadId?: string;
  schedule?: { id: number; taskId: number };
}): PendingAction[] {
  return db.transaction(() => {
    const action = input.actionId === undefined
      ? input.draftId ? getPendingActionForDraft(input.draftId, input.account) : undefined
      : getPendingAction(input.actionId);
    const delivery = { messageId: input.sentMessageId, threadId: input.sentThreadId, background: input.commandKey?.startsWith("sched:") === true };
    const delivered = action && (transitionPendingAction(action.id, "pending", "sent", delivery) ||
      // A new card may have replaced this one while Gmail was already delivering it.
      transitionPendingAction(action.id, "superseded", "sent", delivery));
    const deliveredDraft = input.draftId ?? action?.draft_id;
    if (deliveredDraft) clearUnconfirmedDraftDelivery(deliveredDraft, input.account);
    if (input.commandKey) recordCommandSendSent(input.commandKey, input.sentMessageId ?? "unknown");
    const command = input.commandKey ? db.prepare(
      "SELECT status, thread_id, sent_at FROM command_sends WHERE idem_key = ? AND account = ?",
    ).get(input.commandKey, input.account) as { status: string; thread_id: string | null; sent_at: string | null } | undefined : undefined;
    const origin = /^msg:(-?\d+):(\d+)(?::|$)/.exec(input.commandKey ?? "");
    if (!delivered && (input.draftId || (origin && command?.status === "sent"))) {
      closeEmailContext({
        account: input.account, draftId: input.draftId, status: "sent", to: input.to,
        threadId: input.sentThreadId ?? command?.thread_id ?? undefined, sentAt: command?.sent_at ?? recordedNow(),
        sentMessageId: input.sentMessageId,
      }, origin ? { chatId: Number(origin[1]), messageId: Number(origin[2]) } : undefined);
    }
    if (input.schedule) {
      recordScheduledSendSent(input.schedule.id, input.sentMessageId ?? null);
      markTaskDone(input.schedule.taskId);
    }
    return supersedeOverlappingDrafts(input.account, input.to, action?.id);
  }).immediate();
}

/** Pending email drafts whose approval card was posted before `messageId`.
 *  Telegram message ids in a chat only grow, so a lower card id means Vishnu
 *  saw the card before he sent that message. Newest card first. */
export function listDraftsShownBefore(messageId: number): PendingAction[] {
  const replaced = new Set(olderDuplicateDrafts().map((action) => action.id));
  return db
    .prepare(
      `SELECT ${PENDING_ACTION_COLUMNS}
       FROM pending_actions
       WHERE status = 'pending'
         AND type = 'send_draft'
         AND draft_id IS NOT NULL
         AND telegram_message_id IS NOT NULL
         AND telegram_message_id < ?
       ORDER BY telegram_message_id DESC`,
    )
    .all(messageId).map((row) => row as PendingAction).filter((action) => !replaced.has(action.id));
}

/** Vishnu's own message ids in `chatId` that came before `messageId`, newest
 *  first (from the dedupe log, kept for 24 hours). */
export function ownerMessageIdsBefore(
  chatId: number,
  messageId: number,
  limit: number,
): number[] {
  return (
    db
      .prepare(
        `SELECT message_id FROM processed_messages
         WHERE chat_id = ? AND message_id < ?
         ORDER BY message_id DESC
         LIMIT ?`,
      )
      .all(chatId, messageId, limit) as Array<{ message_id: number }>
  ).map((row) => row.message_id);
}

export function getLatestPendingSendAction(): PendingAction | undefined {
  return db
    .prepare(
      `SELECT ${PENDING_ACTION_COLUMNS}
       FROM pending_actions
       WHERE status = 'pending'
         AND type = 'send_draft'
         AND telegram_message_id IS NOT NULL
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get() as PendingAction | undefined;
}

export function setPendingActionAutoSendAt(
  id: number,
  autoSendAtIso: string | null,
): void {
  db.prepare(
    `UPDATE pending_actions SET auto_send_at = ? WHERE id = ?`,
  ).run(autoSendAtIso, id);
}

export function getDueAutoSendActions(nowIso: string): PendingAction[] {
  return db
    .prepare(
      `SELECT ${PENDING_ACTION_COLUMNS}
       FROM pending_actions
       WHERE status = 'pending'
         AND type = 'send_draft'
         AND auto_send_at IS NOT NULL
         AND auto_send_at <= ?
       ORDER BY auto_send_at ASC, id ASC`,
    )
    .all(nowIso) as PendingAction[];
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

/** The Gmail message a draft card's send became. Recorded only; nothing reads it
 *  to decide a send. */
export function setPendingActionSentMessage(id: number, sentMessageId: string): void {
  db.prepare(`UPDATE pending_actions SET sent_message_id = ?, sent_at = COALESCE(sent_at, CURRENT_TIMESTAMP) WHERE id = ?`).run(sentMessageId, id);
}

export function draftCardForTelegramMessage(telegramMessageId: number):
  | { status: string; draft_id: string | null; google_account: GoogleAccountId; sent_message_id: string | null }
  | undefined {
  return db
    .prepare(
      `SELECT status, draft_id, google_account, sent_message_id FROM pending_actions
       WHERE type = 'send_draft' AND telegram_message_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(telegramMessageId) as
    | { status: string; draft_id: string | null; google_account: GoogleAccountId; sent_message_id: string | null }
    | undefined;
}

export function sentMessageForDraft(
  draftId: string,
): { google_account: GoogleAccountId; sent_message_id: string | null; to_header: string | null } | undefined {
  return db
    .prepare(
      `SELECT google_account, sent_message_id, COALESCE(live_to_header, to_header) AS to_header FROM pending_actions
       WHERE type = 'send_draft' AND draft_id = ? AND status = 'sent'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(draftId) as { google_account: GoogleAccountId; sent_message_id: string | null; to_header: string | null } | undefined;
}

export function transitionPendingAction(
  id: number,
  from: PendingActionStatus,
  to: PendingActionStatus,
  delivery?: { messageId?: string; threadId?: string; background?: boolean },
): boolean {
  return db.transaction(() => {
    const changed = db.prepare(
      "UPDATE pending_actions SET status = ? WHERE id = ? AND status = ?",
    ).run(to, id, from).changes === 1;
    if (changed && isClosedEmailStatus(to)) {
      if (to === "sent" && delivery) db.prepare(
        "UPDATE pending_actions SET sent_at = COALESCE(sent_at, CURRENT_TIMESTAMP), sent_message_id = COALESCE(?, sent_message_id), sent_thread_id = COALESCE(?, sent_thread_id) WHERE id = ?",
      ).run(delivery.messageId ?? null, delivery.threadId ?? null, id);
      const action = getPendingAction(id);
      if (action?.draft_id) closeEmailContext(emailReferenceForAction(action, to), undefined, delivery?.background);
    }
    return changed;
  }).immediate();
}

/** Puts a finished approval back to pending. Tests use it to prove a stale Send
 *  button still cannot deliver an email that already went out. */
export function reopenPendingActionForTests(id: number): void {
  assertTestSeam("reopenPendingActionForTests");
  db.prepare("UPDATE pending_actions SET status = 'pending' WHERE id = ?").run(id);
}

export function setPendingActionDraftMeta(
  id: number,
  meta: { toHeader: string; ccHeader: string; subject: string },
): void {
  db.prepare(
    `UPDATE pending_actions
     SET to_header = ?, cc_header = ?, subject = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(meta.toHeader, meta.ccHeader, meta.subject, id);
  // Who the posted card shows is recorded by the card builder (confirm_cards.ts), for
  // the message Telegram confirmed: the only writer of card_message_recipients.
}

/** Telegram confirmed this card message shows these people (posted, or edited to show
 *  them): it now confirms exactly them. Called only by the card builder. The key is the
 *  card's Gmail draft id, or schedule:<id> / choice:<id> for those cards. Someone still on it keeps the time they were
 *  first shown; someone taken off it no longer counts for this message. */
export const recordCardRecipients = db.transaction((messageId: number, draftId: string, header: string): void => {
  const people = parseAddressList(header).map(({ email }) => email);
  const current = db
    .prepare(`SELECT email FROM card_message_recipients WHERE message_id = ? AND draft_id = ?`)
    .all(messageId, draftId) as Array<{ email: string }>;
  const remove = db.prepare(`DELETE FROM card_message_recipients WHERE message_id = ? AND draft_id = ? AND email = ?`);
  for (const { email } of current) {
    if (!people.includes(email)) {
      remove.run(messageId, draftId, email);
    }
  }
  const insert = db.prepare(
    `INSERT OR IGNORE INTO card_message_recipients (message_id, draft_id, email, shown_watermark, shown_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const watermark = latestProcessedMessageId();
  for (const email of people) {
    insert.run(messageId, draftId, email, watermark, new Date().toISOString());
  }
});

/** Who this one card message showed: what a tap on it confirms. */
export function cardRecipientsForMessage(draftId: string, messageId: number): Set<string> {
  const rows = db
    .prepare(`SELECT email FROM card_message_recipients WHERE draft_id = ? AND message_id = ?`)
    .all(draftId, messageId) as Array<{ email: string }>;
  return new Set(rows.map((row) => row.email));
}

/** False for a card posted before recipients were recorded per card message. */
export function draftHasCardRecords(draftId: string): boolean {
  return db.prepare(`SELECT 1 FROM card_message_recipients WHERE draft_id = ? LIMIT 1`).get(draftId) !== undefined;
}

/** The newest of his messages already taken for processing. */
export function latestProcessedMessageId(): number {
  return (db.prepare(`SELECT MAX(message_id) AS id FROM processed_messages`).get() as { id: number | null }).id ?? 0;
}

/** Addresses on a card for this draft that was posted before his message `messageId`. */
export function draftRecipientsShownBefore(draftId: string, messageId: number): Set<string> {
  const rows = db
    .prepare(`SELECT DISTINCT email FROM card_message_recipients WHERE draft_id = ? AND shown_watermark < ?`)
    .all(draftId, messageId) as Array<{ email: string }>;
  return new Set(rows.map((row) => row.email));
}

/** SQLite's CURRENT_TIMESTAMP and ISO strings, both as an ISO string in UTC. */
export function recordedIso(value: string): string {
  const parsed = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : value;
}

function normalizedEmail(value: string): string {
  return value.trim().toLowerCase();
}

export interface ConversationParticipant {
  email: string;
  name: string;
  source: string;
  sourceRef: string;
  seenAt: string;
}

const PARTICIPANT_RETENTION_MS = 24 * 60 * 60 * 1000;

/** People a read tool showed on his own turn (headers or attendees only). */
export function recordConversationParticipants(
  chatId: number,
  people: ReadonlyArray<{ email: string; name?: string }>,
  source: string,
  sourceRef: string,
  now = new Date(),
): void {
  const upsert = db.prepare(
    `INSERT INTO conversation_participants (chat_id, email, name, source, source_ref, seen_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_id, email, source, source_ref) DO UPDATE SET
       name = CASE WHEN length(excluded.name) > length(conversation_participants.name)
         THEN excluded.name ELSE conversation_participants.name END,
       seen_at = excluded.seen_at`,
  );
  db.transaction(() => {
    for (const person of people) {
      const email = normalizedEmail(person.email);
      if (!email.includes("@")) continue;
      upsert.run(chatId, email, (person.name ?? "").trim(), source, sourceRef, now.toISOString());
    }
    db.prepare("DELETE FROM conversation_participants WHERE chat_id = ? AND source <> 'owner_text' AND seen_at < ?")
      .run(chatId, new Date(now.getTime() - PARTICIPANT_RETENTION_MS).toISOString());
  })();
}

export function conversationParticipants(chatId: number, sinceIso: string): ConversationParticipant[] {
  const rows = db.prepare(
    `SELECT email, name, source, source_ref, seen_at FROM conversation_participants
     WHERE chat_id = ? AND (source = 'owner_text' OR seen_at >= ?) ORDER BY seen_at DESC`,
  ).all(chatId, sinceIso) as Array<{ email: string; name: string; source: string; source_ref: string; seen_at: string }>;
  return rows.map((row) => ({ email: row.email, name: row.name, source: row.source, sourceRef: row.source_ref, seenAt: row.seen_at }));
}

/** His own turn pointed at this address in a photo or a quoted message. */
export function recordExternalAddress(chatId: number, email: string, source: string, now = new Date()): void {
  const address = normalizedEmail(email);
  if (!address.includes("@")) return;
  db.prepare(
    `INSERT INTO external_addresses (chat_id, email, source, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(chat_id, email) DO UPDATE SET source = excluded.source, created_at = excluded.created_at`,
  ).run(chatId, address, source, now.toISOString());
}

/** Addresses this chat only ever got from a photo or a quoted message. */
export function externalAddresses(chatId: number): Set<string> {
  return new Set((db.prepare("SELECT email FROM external_addresses WHERE chat_id = ?").all(chatId) as Array<{ email: string }>)
    .map((row) => row.email));
}

/** The people an Aadi message was about, recorded when it was posted. */
export function linkTelegramMessageParticipants(
  messageId: number,
  source: string,
  sourceRef: string,
  people: ReadonlyArray<{ email: string; name?: string }>,
  now = new Date(),
): void {
  const list = people
    .map((person) => ({ email: normalizedEmail(person.email), name: (person.name ?? "").trim() }))
    .filter((person) => person.email.includes("@"));
  db.prepare(
    `INSERT OR REPLACE INTO telegram_message_participants (message_id, source, source_ref, participants_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(messageId, source, sourceRef, JSON.stringify(list), now.toISOString());
}

export function telegramMessageParticipants(messageId: number): ConversationParticipant[] {
  const rows = db.prepare(
    "SELECT source, source_ref, participants_json, created_at FROM telegram_message_participants WHERE message_id = ?",
  ).all(messageId) as Array<{ source: string; source_ref: string; participants_json: string; created_at: string }>;
  return rows.flatMap((row) => {
    let people: Array<{ email?: string; name?: string }> = [];
    try {
      people = JSON.parse(row.participants_json) as Array<{ email?: string; name?: string }>;
    } catch {
      return [];
    }
    return people.flatMap((person) => person.email
      ? [{ email: normalizedEmail(person.email), name: person.name ?? "", source: row.source, sourceRef: row.source_ref, seenAt: row.created_at }]
      : []);
  });
}

export interface RecentSendRecord {
  email: string;
  name: string;
  /** ISO, UTC. */
  sentAt: string;
}

/**
 * Aadi's own sends since `sinceIso` whose To included one of these addresses: draft
 * cards, direct command sends, scheduled sends and follow-up steps. The newest per
 * address. Records only.
 */
export function recentSendsTo(addresses: readonly string[], sinceIso: string): RecentSendRecord[] {
  const wanted = new Set(addresses.map(normalizedEmail).filter(Boolean));
  if (wanted.size === 0) return [];
  const newest = new Map<string, RecentSendRecord>();
  const note = (email: string, name: string, sentAt: string): void => {
    const address = normalizedEmail(email);
    if (!wanted.has(address)) return;
    const iso = recordedIso(sentAt);
    const previous = newest.get(address);
    if (!previous || previous.sentAt < iso) newest.set(address, { email: address, name: name.trim() || previous?.name || "", sentAt: iso });
  };
  const fromHeader = (header: string | null, sentAt: string): void => {
    for (const mailbox of parseAddressList(header ?? "")) note(mailbox.email, mailbox.name, sentAt);
  };
  for (const row of db.prepare(
    `SELECT COALESCE(live_to_header, to_header) AS to_header, sent_at FROM pending_actions
     WHERE type = 'send_draft' AND status = 'sent' AND sent_at IS NOT NULL AND julianday(sent_at) >= julianday(?)`,
  ).all(sinceIso) as Array<{ to_header: string | null; sent_at: string }>) {
    fromHeader(row.to_header, row.sent_at);
  }
  for (const row of db.prepare(
    `SELECT to_header, sent_at FROM command_sends
     WHERE status = 'sent' AND sent_at IS NOT NULL AND to_header IS NOT NULL AND julianday(sent_at) >= julianday(?)`,
  ).all(sinceIso) as Array<{ to_header: string | null; sent_at: string }>) {
    fromHeader(row.to_header, row.sent_at);
  }
  for (const row of db.prepare(
    `SELECT request, sent_at FROM scheduled_sends
     WHERE status = 'sent' AND sent_at IS NOT NULL AND julianday(sent_at) >= julianday(?)`,
  ).all(sinceIso) as Array<{ request: string; sent_at: string }>) {
    try {
      const request = JSON.parse(row.request) as { to?: Array<{ mailbox?: { email?: string; name?: string } }> };
      for (const slot of request.to ?? []) {
        if (slot.mailbox?.email) note(slot.mailbox.email, slot.mailbox.name ?? "", row.sent_at);
      }
    } catch {
      continue;
    }
  }
  for (const row of db.prepare(
    `SELECT s.prospect_email AS email, s.prospect_name AS name, st.sent_at AS sent_at
     FROM sales_sequence_steps st JOIN sales_sequences s ON s.id = st.sequence_id
     WHERE st.status = 'sent' AND st.sent_at IS NOT NULL AND julianday(st.sent_at) >= julianday(?)`,
  ).all(sinceIso) as Array<{ email: string; name: string; sent_at: string }>) {
    note(row.email, row.name, row.sent_at);
  }
  return [...newest.values()];
}

/** Aadi's newest delivered email whose To included this address, from its own records
 *  (a draft card's send or a direct command send). */
export function latestRecordedSendTo(address: string): { sentMessageId: string; account: GoogleAccountId; sentAt: string } | undefined {
  const email = normalizedEmail(address);
  let best: { sentMessageId: string; account: GoogleAccountId; sentAt: string } | undefined;
  const consider = (header: string | null, id: string | null, account: string, sentAt: string | null): void => {
    if (!id || !sentAt || (account !== "work" && account !== "personal")) return;
    if (!parseAddressList(header ?? "").some((mailbox) => mailbox.email === email)) return;
    const iso = recordedIso(sentAt);
    if (!best || best.sentAt < iso) best = { sentMessageId: id, account, sentAt: iso };
  };
  for (const row of db.prepare(
    `SELECT COALESCE(live_to_header, to_header) AS to_header, sent_message_id, google_account, sent_at FROM pending_actions
     WHERE type = 'send_draft' AND status = 'sent' AND sent_message_id IS NOT NULL ORDER BY id DESC LIMIT 200`,
  ).all() as Array<{ to_header: string | null; sent_message_id: string | null; google_account: string; sent_at: string | null }>) {
    consider(row.to_header, row.sent_message_id, row.google_account, row.sent_at);
  }
  for (const row of db.prepare(
    `SELECT to_header, sent_message_id, account, sent_at FROM command_sends
     WHERE status = 'sent' AND sent_message_id IS NOT NULL AND to_header IS NOT NULL ORDER BY id DESC LIMIT 200`,
  ).all() as Array<{ to_header: string | null; sent_message_id: string | null; account: string; sent_at: string | null }>) {
    consider(row.to_header, row.sent_message_id, row.account, row.sent_at);
  }
  return best;
}

/** The card builder's record of a "You emailed X at T" warning on a posted card. It
 *  replaces whatever that message showed before. */
export const recordCardRecentSendWarnings = db.transaction((
  messageId: number,
  cardKey: string,
  warnings: ReadonlyArray<{ email: string; sentAt: string }>,
): void => {
  db.prepare("DELETE FROM card_recent_send_warnings WHERE message_id = ? AND card_key = ?").run(messageId, cardKey);
  const insert = db.prepare(
    `INSERT OR REPLACE INTO card_recent_send_warnings (message_id, card_key, email, sent_at, shown_watermark, shown_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const watermark = latestProcessedMessageId();
  for (const warning of warnings) {
    insert.run(messageId, cardKey, normalizedEmail(warning.email), recordedIso(warning.sentAt), watermark, new Date().toISOString());
  }
});

function warningMap(rows: Array<{ email: string; sent_at: string }>): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    const previous = map.get(row.email);
    if (!previous || previous < row.sent_at) map.set(row.email, row.sent_at);
  }
  return map;
}

/** What this card message warned about: email to the newest send it showed. */
export function recentSendWarningsForMessage(cardKey: string, messageId: number): Map<string, string> {
  return warningMap(db.prepare(
    "SELECT email, sent_at FROM card_recent_send_warnings WHERE card_key = ? AND message_id = ?",
  ).all(cardKey, messageId) as Array<{ email: string; sent_at: string }>);
}

/** Warnings this card key showed before his message `messageId`. */
export function recentSendWarningsShownBefore(cardKey: string, messageId: number): Map<string, string> {
  return warningMap(db.prepare(
    "SELECT email, sent_at FROM card_recent_send_warnings WHERE card_key = ? AND shown_watermark < ?",
  ).all(cardKey, messageId) as Array<{ email: string; sent_at: string }>);
}

export function isKnownRecipientCached(email: string): boolean {
  return db.prepare(`SELECT 1 FROM known_recipients WHERE email = ?`).get(email.trim().toLowerCase()) !== undefined;
}

export function recordKnownRecipient(email: string, source: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO known_recipients (email, source, checked_at) VALUES (?, ?, ?)`,
  ).run(email.trim().toLowerCase(), source, new Date().toISOString());
}

/** Every address already recorded as one he has sent to. */
export function listKnownRecipientEmails(): string[] {
  return (db.prepare(`SELECT email FROM known_recipients`).all() as Array<{ email: string }>).map((row) => row.email);
}

/** Who a posted card message showed, whatever it was a card for. */
export function cardRecipientsOnMessage(messageId: number): string[] {
  return (db.prepare(`SELECT DISTINCT email FROM card_message_recipients WHERE message_id = ?`)
    .all(messageId) as Array<{ email: string }>).map((row) => row.email);
}

/** A "send then follow-ups" request waiting on this card's Send tap. */
export function setPendingActionFollowups(id: number, settings: string, key: string): boolean {
  return db.prepare(`UPDATE pending_actions SET followup_words = ?, followup_key = ? WHERE id = ? AND status = 'pending'`)
    .run(settings, key, id).changes > 0;
}

export function pendingActionFollowups(id: number): { settings: string; key: string } | undefined {
  const row = db
    .prepare(`SELECT followup_words, followup_key FROM pending_actions WHERE id = ?`)
    .get(id) as { followup_words: string | null; followup_key: string | null } | undefined;
  return row?.followup_words && row.followup_key ? { settings: row.followup_words, key: row.followup_key } : undefined;
}

/** Tests only: pin created/updated so recency and 3-hour expiry are deterministic. */
export function setPendingActionTimestampsForTests(
  id: number,
  timestamps: { createdAt?: string; updatedAt?: string },
): void {
  assertTestSeam("setPendingActionTimestampsForTests");
  if (timestamps.createdAt) {
    db.prepare(`UPDATE pending_actions SET created_at = ? WHERE id = ?`).run(
      timestamps.createdAt,
      id,
    );
  }
  if (timestamps.updatedAt) {
    db.prepare(`UPDATE pending_actions SET updated_at = ? WHERE id = ?`).run(
      timestamps.updatedAt,
      id,
    );
  }
}

export function getExpiredPendingActions(): PendingAction[] {
  return db
    .prepare(
      `SELECT ${PENDING_ACTION_COLUMNS}
       FROM pending_actions
       WHERE status = 'pending'
         AND (
           (type = 'send_draft'
            AND datetime(COALESCE(updated_at, created_at)) <= datetime('now', '-3 hours'))
           OR
           (type = 'create_event'
            AND created_at <= datetime('now', '-24 hours'))
         )`,
    )
    .all() as PendingAction[];
}

const TASK_COLUMNS = `id, text, tag, due_at, status, created_at, kind,
  source_thread_id, source_message_id, promise_context, deadline, recipient,
  suspected_duplicate_of`;

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
  created_at, related_task_id, related_bill_id, series_id, status_reason`;

export interface ReminderLinks {
  relatedTaskId?: number | null;
  relatedBillId?: number | null;
  seriesId?: number | null;
}

export function createReminder(
  text: string,
  tag: ItemTag,
  remindAt: string,
  recurrence: ReminderRecurrence,
  links: number | null | ReminderLinks = null,
): ReminderRecord {
  // Back-compat: callers that passed a number used to mean task id.
  const taskId =
    typeof links === "number"
      ? links
      : links && typeof links === "object"
        ? (links.relatedTaskId ?? null)
        : null;
  const billId =
    links && typeof links === "object" ? (links.relatedBillId ?? null) : null;
  const seriesId =
    links && typeof links === "object" ? (links.seriesId ?? null) : null;
  const result = db
    .prepare(
      `INSERT INTO reminders (
         text, tag, remind_at, recurrence, related_task_id, related_bill_id, series_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(text, tag, remindAt, recurrence, taskId, billId, seriesId);
  const id = Number(result.lastInsertRowid);
  if (recurrence !== "none" && seriesId == null) {
    db.prepare(
      `UPDATE reminders SET series_id = id WHERE id = ? AND series_id IS NULL`,
    ).run(id);
  }
  return getReminder(id)!;
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
       SET status = 'cancelled', status_reason = 'completion'
       WHERE related_task_id = ? AND status = 'pending'`,
    )
    .run(taskId);
  return result.changes;
}

/** Mirror helper for bills: cancels every pending reminder linked to the
 *  bill, used when the bill is marked paid or ignored. */
export function cancelPendingRemindersForBill(billId: number): number {
  const result = db
    .prepare(
      `UPDATE reminders
       SET status = 'cancelled', status_reason = 'completion'
       WHERE related_bill_id = ? AND status = 'pending'`,
    )
    .run(billId);
  return result.changes;
}

export function transitionReminderStatus(
  id: number,
  from: ReminderStatus,
  to: ReminderStatus,
  reason?: ReminderStatusReason | null,
): boolean {
  if (to === "pending" && from === "cancelled") {
    const current = db
      .prepare(`SELECT status_reason FROM reminders WHERE id = ?`)
      .get(id) as { status_reason: string | null } | undefined;
    if (current?.status_reason !== "ignore") {
      return false;
    }
  }
  const result =
    to === "cancelled"
      ? db
          .prepare(
            `UPDATE reminders
                SET status = ?, status_reason = ?
              WHERE id = ? AND status = ?`,
          )
          .run(to, reason ?? "other", id, from)
      : to === "pending"
        ? db
            .prepare(
              `UPDATE reminders
                  SET status = ?, status_reason = NULL
                WHERE id = ? AND status = ?`,
            )
            .run(to, id, from)
        : db
            .prepare(
              `UPDATE reminders
                  SET status = ?
                WHERE id = ? AND status = ?`,
            )
            .run(to, id, from);

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

export function rememberTelegramDocumentRef(
  chatId: number,
  messageId: number,
  documentId: number,
  now = Date.now(),
): void {
  db.prepare(
    `INSERT INTO telegram_document_refs (chat_id, message_id, document_id, created_ms)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(chat_id, message_id) DO UPDATE SET
       document_id = excluded.document_id, created_ms = excluded.created_ms`,
  ).run(chatId, messageId, documentId, now);
}

export function documentRefForTelegramMessage(
  chatId: number,
  messageId: number,
  sinceMs: number,
): number | undefined {
  const row = db.prepare(
    `SELECT document_id FROM telegram_document_refs
     WHERE chat_id = ? AND message_id = ? AND created_ms >= ?`,
  ).get(chatId, messageId, sinceMs) as { document_id: number } | undefined;
  return row?.document_id;
}

/** Non-expired documents (same 7-day rule as deleteExpiredDocuments), newest first. */
export function listDocuments(limit = 10): DocumentRecord[] {
  const safe = Math.max(1, Math.min(25, Math.floor(limit)));
  return db
    .prepare(
      `SELECT id, file_name, tag, extracted_text, pending_action_items, created_at
       FROM documents
       WHERE created_at > datetime('now', '-7 days')
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(safe) as DocumentRecord[];
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
  return db.transaction(() => {
    db.prepare(
      `DELETE FROM telegram_document_refs
       WHERE document_id IN (
         SELECT id FROM documents WHERE created_at <= datetime('now', '-7 days')
       )`,
    ).run();
    const result = db
      .prepare(
        `DELETE FROM documents
         WHERE created_at <= datetime('now', '-7 days')`,
      )
      .run();
    return result.changes;
  })();
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
/** Why a bill left `upcoming`. Only `ignore` (legacy card Ignore) is undone by Resume. */
export type BillStatusReason = "ignore" | "skip_cycle" | "duplicate" | "paid" | "other";

export interface BillRecord {
  id: number;
  biller: string;
  amount: number | null;
  currency: string;
  due_date: string;
  thread_id: string;
  status: BillStatus;
  created_at: string;
  suspected_duplicate_of: number | null;
  source_text: string | null;
  status_reason: BillStatusReason | null;
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

const BILL_COLUMNS = `id, biller, amount, currency, due_date, thread_id,
  status, created_at, suspected_duplicate_of, source_text, status_reason`;

export function createBill(
  biller: string,
  amount: number | null,
  currency: string,
  dueDate: string,
  threadId: string,
  sourceText: string | null = null,
  suspectedDuplicateOf: number | null = null,
): BillRecord | undefined {
  try {
    const result = db
      .prepare(
        `INSERT INTO bills (
           biller, amount, currency, due_date, thread_id,
           source_text, suspected_duplicate_of
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        biller,
        amount,
        currency,
        dueDate,
        threadId,
        sourceText,
        suspectedDuplicateOf,
      );
    return getBill(Number(result.lastInsertRowid))!;
  } catch {
    return undefined;
  }
}

export function getBill(id: number): BillRecord | undefined {
  return db
    .prepare(`SELECT ${BILL_COLUMNS} FROM bills WHERE id = ?`)
    .get(id) as BillRecord | undefined;
}

export function getBills(): BillRecord[] {
  return db
    .prepare(
      `SELECT ${BILL_COLUMNS}
       FROM bills ORDER BY due_date ASC, id ASC`,
    )
    .all() as BillRecord[];
}

export function getRecentBills(sinceIso: string): BillRecord[] {
  return db
    .prepare(
      `SELECT ${BILL_COLUMNS}
       FROM bills
       WHERE created_at >= ?
       ORDER BY created_at DESC`,
    )
    .all(sinceIso) as BillRecord[];
}

export function markBillSuspectedDuplicate(
  id: number,
  of: number | null,
): void {
  db.prepare(
    `UPDATE bills SET suspected_duplicate_of = ? WHERE id = ?`,
  ).run(of, id);
}

/** Fill in amount/source on an amount-unknown bill (merge path). */
export function updateBillDetails(
  id: number,
  update: {
    biller?: string;
    amount?: number | null;
    currency?: string;
    threadId?: string;
    sourceText?: string | null;
  },
): BillRecord | undefined {
  const current = getBill(id);
  if (!current) {
    return undefined;
  }
  db.prepare(
    `UPDATE bills
     SET biller = ?, amount = ?, currency = ?, thread_id = ?, source_text = ?
     WHERE id = ?`,
  ).run(
    update.biller ?? current.biller,
    update.amount !== undefined ? update.amount : current.amount,
    update.currency ?? current.currency,
    update.threadId ?? current.thread_id,
    update.sourceText !== undefined ? update.sourceText : current.source_text,
    id,
  );
  return getBill(id);
}

export function getRecentPromiseTasks(sinceIso: string): TaskRecord[] {
  return db
    .prepare(
      `SELECT ${TASK_COLUMNS}
       FROM tasks
       WHERE kind = 'promise' AND created_at >= ?
       ORDER BY created_at DESC`,
    )
    .all(sinceIso) as TaskRecord[];
}

export function markTaskSuspectedDuplicate(
  id: number,
  of: number | null,
): void {
  db.prepare(
    `UPDATE tasks SET suspected_duplicate_of = ? WHERE id = ?`,
  ).run(of, id);
}

export function searchUpcomingBills(query: string): BillRecord[] {
  const needle = `%${query.trim().toLowerCase()}%`;
  return db
    .prepare(
      `SELECT ${BILL_COLUMNS}
         FROM bills
        WHERE status = 'upcoming'
          AND LOWER(biller) LIKE ?
        ORDER BY due_date ASC, id ASC`,
    )
    .all(needle) as BillRecord[];
}

export function transitionBillStatus(
  id: number,
  from: BillStatus | BillStatus[],
  to: BillStatus,
  reason?: BillStatusReason,
): boolean {
  const statuses = Array.isArray(from) ? from : [from];
  const placeholders = statuses.map(() => "?").join(", ");
  const nextReason =
    to === "upcoming" ? null : (reason ?? (to === "paid" ? "paid" : "other"));
  const result = db
    .prepare(
      `UPDATE bills SET status = ?, status_reason = ?
        WHERE id = ? AND status IN (${placeholders})`,
    )
    .run(to, nextReason, id, ...statuses);
  return result.changes === 1;
}

/** Undo only a status change the Ignore feature itself made. A later skip,
 *  duplicate removal or payment carries its own reason and is left alone. */
export function restoreIgnoreOwnedBill(id: number): boolean {
  const result = db
    .prepare(
      `UPDATE bills SET status = 'upcoming', status_reason = NULL
        WHERE id = ? AND status = 'ignored' AND status_reason = 'ignore'`,
    )
    .run(id);
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

export interface LlmBackendFlagRow {
  backend: string;
  reason: string;
  flagged_at: string;
}

export function upsertLlmBackendFlag(
  backend: string,
  reason: string,
  flaggedAt: string,
): void {
  db.prepare(
    `INSERT INTO llm_backend_flags (backend, reason, flagged_at)
     VALUES (?, ?, ?)
     ON CONFLICT(backend) DO UPDATE SET
       reason = excluded.reason,
       flagged_at = excluded.flagged_at`,
  ).run(backend, reason, flaggedAt);
}

export function getLlmBackendFlag(backend: string): LlmBackendFlagRow | undefined {
  return db
    .prepare(
      `SELECT backend, reason, flagged_at FROM llm_backend_flags WHERE backend = ?`,
    )
    .get(backend) as LlmBackendFlagRow | undefined;
}

export function listLlmBackendFlags(): LlmBackendFlagRow[] {
  return db
    .prepare(
      `SELECT backend, reason, flagged_at FROM llm_backend_flags ORDER BY backend`,
    )
    .all() as LlmBackendFlagRow[];
}

export function deleteLlmBackendFlag(backend: string): void {
  db.prepare(`DELETE FROM llm_backend_flags WHERE backend = ?`).run(backend);
}

export function deleteAllLlmBackendFlags(): void {
  db.prepare(`DELETE FROM llm_backend_flags`).run();
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

export function listPendingMemoryConfirms(): PendingMemoryConfirm[] {
  return db
    .prepare(
      `SELECT id, content, category, tag, event_date, update_of_id, created_at
       FROM pending_memory_confirms
       ORDER BY id ASC`,
    )
    .all() as PendingMemoryConfirm[];
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

export type LocalModelRunStatus = "ok" | "error";

export type LocalModelRunRow = {
  id: number;
  created_at: string;
  until_id: number;
  status: LocalModelRunStatus;
  duration_ms: number | null;
  local_model: string;
  cloud_backend: string;
  cloud_model: string;
  cloud_summary: string;
  local_summary: string | null;
  error: string | null;
  input_chars: number;
};

export function insertLocalModelRun(input: {
  untilId: number;
  status: LocalModelRunStatus;
  durationMs: number | null;
  localModel: string;
  cloudBackend: string;
  cloudModel: string;
  cloudSummary: string;
  localSummary: string | null;
  error: string | null;
  inputChars: number;
}): number {
  const result = db
    .prepare(
      `INSERT INTO local_model_runs (
         until_id, status, duration_ms, local_model, cloud_backend, cloud_model,
         cloud_summary, local_summary, error, input_chars
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.untilId,
      input.status,
      input.durationMs,
      input.localModel,
      input.cloudBackend,
      input.cloudModel,
      input.cloudSummary,
      input.localSummary,
      input.error,
      input.inputChars,
    );
  return Number(result.lastInsertRowid);
}

export function listLocalModelRuns(limit = 20): LocalModelRunRow[] {
  const capped = Math.max(1, Math.min(200, Math.floor(limit)));
  return db
    .prepare(
      `SELECT id, created_at, until_id, status, duration_ms, local_model,
              cloud_backend, cloud_model, cloud_summary, local_summary, error,
              input_chars
       FROM local_model_runs
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(capped) as LocalModelRunRow[];
}

export function latestLocalModelRun(): LocalModelRunRow | undefined {
  return db
    .prepare(
      `SELECT id, created_at, until_id, status, duration_ms, local_model,
              cloud_backend, cloud_model, cloud_summary, local_summary, error,
              input_chars
       FROM local_model_runs
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get() as LocalModelRunRow | undefined;
}

export function clearLocalModelRunsForTests(): void {
  assertTestSeam("clearLocalModelRunsForTests");
  db.exec(`DELETE FROM local_model_runs`);
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

const claimTelegramMessageTxn = db.transaction(
  (chatId: number, messageId: number): boolean => {
    const existing = db
      .prepare(
        `SELECT 1 FROM processed_messages
         WHERE chat_id = ? AND message_id = ?
           AND processed_at > datetime('now', '-5 minutes')`,
      )
      .get(chatId, messageId);
    if (existing) return false;
    db.prepare(
      `INSERT OR REPLACE INTO processed_messages (chat_id, message_id)
       VALUES (?, ?)`,
    ).run(chatId, messageId);
    return true;
  },
);

/** Atomically claims a Telegram message for processing. Returns true if this
 *  is the first time we've seen (chat_id, message_id) in the last 5 minutes,
 *  false if the message was already handled (e.g. re-delivered after a
 *  restart). */
export function claimTelegramMessage(
  chatId: number,
  messageId: number,
): boolean {
  return claimTelegramMessageTxn(chatId, messageId);
}

/** Keep 24 hours of ids (the draft-approval lifetime): send confirmation uses
 *  them to tell which drafts came from Vishnu's last couple of turns. */
export function pruneProcessedMessages(): number {
  return db
    .prepare(
      `DELETE FROM processed_messages WHERE processed_at < datetime('now', '-24 hours')`,
    )
    .run().changes;
}

export type ChatTurnOutcome = "running" | "ok" | "failed" | "timeout" | "empty";

export function beginChatTurn(): number {
  const info = db
    .prepare(
      `INSERT INTO chat_turns (started_at, outcome) VALUES (?, 'running')`,
    )
    .run(new Date().toISOString());
  return Number(info.lastInsertRowid);
}

export function setChatTurnRetryText(id: number, text: string): void {
  db.prepare(`UPDATE chat_turns SET retry_text = ? WHERE id = ?`).run(text, id);
}

export function getChatTurnRetryText(id: number): string | undefined {
  const row = db
    .prepare(`SELECT retry_text FROM chat_turns WHERE id = ?`)
    .get(id) as { retry_text: string | null } | undefined;
  return row?.retry_text ?? undefined;
}

export function setChatTurnForwarded(id: number, forwarded: boolean): void {
  db.prepare(`UPDATE chat_turns SET forwarded = ? WHERE id = ?`).run(
    forwarded ? 1 : 0,
    id,
  );
}

export function getChatTurnForwarded(id: number): boolean {
  const row = db
    .prepare(`SELECT forwarded FROM chat_turns WHERE id = ?`)
    .get(id) as { forwarded: number | null } | undefined;
  return row?.forwarded === 1;
}

export function finishChatTurn(
  id: number,
  input: { outcome: ChatTurnOutcome; durationMs: number; error?: string },
): void {
  db.prepare(
    `UPDATE chat_turns
     SET ended_at = ?, duration_ms = ?, outcome = ?, error = ?
     WHERE id = ?`,
  ).run(
    new Date().toISOString(),
    input.durationMs,
    input.outcome,
    input.error ?? null,
    id,
  );
}

function istDayBounds(now: Date): { startIso: string; endIso: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  const start = new Date(`${year}-${month}-${day}T00:00:00+05:30`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

export function countChatTurnsToday(now = new Date()): {
  failed: number;
  timeout: number;
} {
  const { startIso, endIso } = istDayBounds(now);
  const rows = db
    .prepare(
      `SELECT outcome, COUNT(*) AS n
       FROM chat_turns
       WHERE started_at >= ? AND started_at < ?
         AND outcome IN ('failed', 'empty', 'timeout')
       GROUP BY outcome`,
    )
    .all(startIso, endIso) as Array<{ outcome: string; n: number }>;
  let failed = 0;
  let timeout = 0;
  for (const row of rows) {
    if (row.outcome === "timeout") {
      timeout += row.n;
    } else {
      failed += row.n;
    }
  }
  return { failed, timeout };
}

export type JobStatus =
  | "running"
  | "done"
  | "failed"
  | "cancelled"
  | "paused";

export type JobStepStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "skipped";

export interface JobRecord {
  job_id: number;
  title: string;
  status: JobStatus;
  created_at: string;
  updated_at: string;
  cost_usd: number;
  budget_usd: number;
  owner_text: string;
  telegram_chat_id: number | null;
  telegram_message_id: number | null;
}

export interface JobStepRecord {
  job_id: number;
  step_id: string;
  step_order: number;
  type: string;
  status: JobStepStatus;
  attempts: number;
  depends_on: string;
  input_ref: string;
  done_condition: string;
  result_ref: string | null;
  done_check_passed: number;
  error: string | null;
  started_at: string | null;
  updated_at: string;
}

const JOB_COLUMNS = `job_id, title, status, created_at, updated_at, cost_usd,
  budget_usd, owner_text, telegram_chat_id, telegram_message_id`;

const JOB_STEP_COLUMNS = `job_id, step_id, step_order, type, status, attempts,
  depends_on, input_ref, done_condition, result_ref, done_check_passed, error,
  started_at, updated_at`;

export function createJob(input: {
  title: string;
  ownerText: string;
  budgetUsd?: number;
  telegramChatId?: number | null;
  telegramMessageId?: number | null;
}): JobRecord {
  const result = db
    .prepare(
      `INSERT INTO jobs (title, owner_text, budget_usd, telegram_chat_id, telegram_message_id)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      input.title,
      input.ownerText,
      input.budgetUsd ?? 0.5,
      input.telegramChatId ?? null,
      input.telegramMessageId ?? null,
    );
  return getJob(Number(result.lastInsertRowid))!;
}

export function getJob(jobId: number): JobRecord | undefined {
  return db
    .prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE job_id = ?`)
    .get(jobId) as JobRecord | undefined;
}

export function listJobs(limit = 20): JobRecord[] {
  const safe = Math.max(1, Math.min(50, Math.floor(limit)));
  return db
    .prepare(
      `SELECT ${JOB_COLUMNS} FROM jobs
       ORDER BY CASE status
         WHEN 'running' THEN 0
         WHEN 'paused' THEN 1
         ELSE 2
       END, updated_at DESC
       LIMIT ?`,
    )
    .all(safe) as JobRecord[];
}

export function listActiveJobs(): JobRecord[] {
  return db
    .prepare(
      `SELECT ${JOB_COLUMNS} FROM jobs
       WHERE status IN ('running', 'paused')
       ORDER BY created_at ASC`,
    )
    .all() as JobRecord[];
}

export function updateJob(
  jobId: number,
  update: {
    status?: JobStatus;
    telegramMessageId?: number | null;
    telegramChatId?: number | null;
    budgetUsd?: number;
  },
): void {
  const current = getJob(jobId);
  if (!current) {
    return;
  }
  db.prepare(
    `UPDATE jobs
     SET status = ?,
         telegram_message_id = ?,
         telegram_chat_id = ?,
         budget_usd = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE job_id = ?`,
  ).run(
    update.status ?? current.status,
    update.telegramMessageId === undefined
      ? current.telegram_message_id
      : update.telegramMessageId,
    update.telegramChatId === undefined
      ? current.telegram_chat_id
      : update.telegramChatId,
    update.budgetUsd ?? current.budget_usd,
    jobId,
  );
}

export function addJobCost(jobId: number, usd: number): number {
  const add = Number.isFinite(usd) ? Math.max(0, usd) : 0;
  db.prepare(
    `UPDATE jobs
     SET cost_usd = cost_usd + ?, updated_at = CURRENT_TIMESTAMP
     WHERE job_id = ?`,
  ).run(add, jobId);
  return getJob(jobId)?.cost_usd ?? 0;
}

export function insertJobStep(input: {
  jobId: number;
  stepId: string;
  order: number;
  type: string;
  dependsOn: string[];
  inputRef: unknown;
  doneCondition: unknown;
}): JobStepRecord {
  db.prepare(
    `INSERT INTO job_steps (
       job_id, step_id, step_order, type, depends_on, input_ref, done_condition
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.jobId,
    input.stepId,
    input.order,
    input.type,
    JSON.stringify(input.dependsOn),
    JSON.stringify(input.inputRef ?? {}),
    JSON.stringify(input.doneCondition),
  );
  return getJobStep(input.jobId, input.stepId)!;
}

export function getJobStep(
  jobId: number,
  stepId: string,
): JobStepRecord | undefined {
  return db
    .prepare(
      `SELECT ${JOB_STEP_COLUMNS} FROM job_steps
       WHERE job_id = ? AND step_id = ?`,
    )
    .get(jobId, stepId) as JobStepRecord | undefined;
}

export function listJobSteps(jobId: number): JobStepRecord[] {
  return db
    .prepare(
      `SELECT ${JOB_STEP_COLUMNS} FROM job_steps
       WHERE job_id = ?
       ORDER BY step_order ASC`,
    )
    .all(jobId) as JobStepRecord[];
}

export function updateJobStep(
  jobId: number,
  stepId: string,
  update: {
    status?: JobStepStatus;
    attempts?: number;
    resultRef?: unknown;
    doneCheckPassed?: boolean;
    error?: string | null;
    startedAt?: string | null;
  },
): void {
  const current = getJobStep(jobId, stepId);
  if (!current) {
    return;
  }
  db.prepare(
    `UPDATE job_steps
     SET status = ?,
         attempts = ?,
         result_ref = ?,
         done_check_passed = ?,
         error = ?,
         started_at = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE job_id = ? AND step_id = ?`,
  ).run(
    update.status ?? current.status,
    update.attempts ?? current.attempts,
    update.resultRef === undefined
      ? current.result_ref
      : JSON.stringify(update.resultRef),
    update.doneCheckPassed === undefined
      ? current.done_check_passed
      : update.doneCheckPassed
        ? 1
        : 0,
    update.error === undefined ? current.error : update.error,
    update.startedAt === undefined ? current.started_at : update.startedAt,
    jobId,
    stepId,
  );
}

export function recoverStuckJobSteps(olderThanMs: number, now = Date.now()): number {
  const cutoff = new Date(now - olderThanMs).toISOString();
  const result = db
    .prepare(
      `UPDATE job_steps
       SET status = 'pending',
           error = 'resumed after stuck running',
           updated_at = CURRENT_TIMESTAMP
       WHERE status = 'running'
         AND started_at IS NOT NULL
         AND started_at <= ?`,
    )
    .run(cutoff);
  return result.changes;
}

export type SalesSequenceStatus = "proposed" | "active" | "stopped" | "completed";
export type SalesSequenceStepStatus =
  | "planned"
  | "sending"
  | "sent"
  | "blocked"
  | "skipped";

export type SalesOriginalAsk = "demo" | "partnership_call" | "meeting";

export interface SalesSequenceRecord {
  id: number;
  thread_id: string;
  account: "work";
  prospect_email: string;
  prospect_domain: string;
  prospect_key: string;
  prospect_name: string;
  prospect_company: string;
  prospect_timezone: string | null;
  /** How the zone was found: email, signature, thread, company, owner or default. */
  prospect_timezone_source: string | null;
  subject: string;
  original_message_id: string;
  original_sent_at: string;
  status: SalesSequenceStatus;
  stop_reason: string | null;
  current_step: number;
  steps_sent: number;
  manual_followups: number;
  original_ask: SalesOriginalAsk | null;
  next_step_at: string | null;
  enrolled_at: string | null;
  classifier_confidence: number | null;
  classifier_reason: string | null;
  card_message_id: number | null;
  created_at: string;
  updated_at: string;
  /** Every step row, manual ones included: 4 for a Start tap, his own count plus
   *  the ones he sent himself for a command. */
  total_steps: number;
  /** Days between follow-ups. Null means SEQUENCE_STEP_DAYS. */
  step_days: number | null;
  cc_first_only: number;
  /** His own call-to-action. Null means the ask in his email. */
  cta: string | null;
  /** The owner message that enrolled it by command, so a second run of the same
   *  command reports it instead of enrolling again. */
  command_key: string | null;
}

export interface SalesSequenceStepRecord {
  sequence_id: number;
  step_no: number;
  scheduled_at: string | null;
  draft_text: string | null;
  check_result: string | null;
  status: SalesSequenceStepStatus;
  sent_message_id: string | null;
  sent_at: string | null;
  reason: string | null;
  draft_id: string | null;
  claimed_at: string | null;
  blocked_at: string | null;
  waiting_ping_at: string | null;
  slot_lines: string | null;
  /** Own-team Cc set at Start, on step 1 only. */
  cc: string | null;
}

export interface SalesPitchScanRecord {
  message_id: string;
  thread_id: string;
  is_sales_pitch: number;
  confidence: number;
  reason: string;
  scanned_at: string;
}

export const SALES_SEQUENCE_STEP_COUNT = 4;
export const SALES_SEQUENCE_DECLINED = "declined";

export function getSalesSequence(id: number): SalesSequenceRecord | undefined {
  return db
    .prepare(`SELECT * FROM sales_sequences WHERE id = ?`)
    .get(id) as SalesSequenceRecord | undefined;
}

export function getSalesSequenceByCommandKey(
  key: string,
): SalesSequenceRecord | undefined {
  return db
    .prepare(`SELECT * FROM sales_sequences WHERE command_key = ? ORDER BY id DESC LIMIT 1`)
    .get(key) as SalesSequenceRecord | undefined;
}

export function getSalesSequenceByThread(
  threadId: string,
): SalesSequenceRecord | undefined {
  return db
    .prepare(`SELECT * FROM sales_sequences WHERE account = 'work' AND thread_id = ?`)
    .get(threadId) as SalesSequenceRecord | undefined;
}

/** The key is the prospect's own address: one open sequence per person. */
export function getOpenSalesSequenceForKey(
  prospectKey: string,
): SalesSequenceRecord | undefined {
  return db
    .prepare(
      `SELECT * FROM sales_sequences
       WHERE prospect_key = ? AND status IN ('proposed', 'active')`,
    )
    .get(prospectKey.trim().toLowerCase()) as SalesSequenceRecord | undefined;
}

export function listSalesSequenceSteps(
  sequenceId: number,
): SalesSequenceStepRecord[] {
  return db
    .prepare(
      `SELECT * FROM sales_sequence_steps WHERE sequence_id = ? ORDER BY step_no`,
    )
    .all(sequenceId) as SalesSequenceStepRecord[];
}

/** The partial unique index makes a second open row for a person, or any second
 *  row for a thread, a no-op: the caller gets undefined and sends no card. */
export function createProposedSalesSequence(input: {
  threadId: string;
  prospectEmail: string;
  prospectDomain: string;
  prospectKey: string;
  prospectName: string;
  prospectCompany: string;
  subject: string;
  originalMessageId: string;
  originalSentAt: string;
  manualFollowups: number;
  classifierConfidence: number | null;
  classifierReason: string | null;
}): SalesSequenceRecord | undefined {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO sales_sequences (
         thread_id, prospect_email, prospect_domain, prospect_key, prospect_name,
         prospect_company, subject, original_message_id, original_sent_at,
         manual_followups, status, classifier_confidence, classifier_reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)`,
    )
    .run(
      input.threadId,
      input.prospectEmail.trim().toLowerCase(),
      input.prospectDomain.trim().toLowerCase(),
      input.prospectKey.trim().toLowerCase(),
      input.prospectName,
      input.prospectCompany,
      input.subject,
      input.originalMessageId,
      input.originalSentAt,
      input.manualFollowups,
      input.classifierConfidence,
      input.classifierReason,
    );
  return result.changes > 0
    ? getSalesSequence(Number(result.lastInsertRowid))
    : undefined;
}

export function setSalesSequenceCardMessage(id: number, messageId: number): void {
  db.prepare(
    `UPDATE sales_sequences
     SET card_message_id = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).run(messageId, id);
}

export function deleteProposedSalesSequence(id: number): void {
  db.prepare(
    `DELETE FROM sales_sequences WHERE id = ? AND status = 'proposed'`,
  ).run(id);
}

/** Back to proposed so an explicit owner request can show a new Start card.
 *  It never activates anything. */
export function reproposeDeclinedSalesSequence(
  id: number,
): SalesSequenceRecord | undefined {
  const updated = db
    .prepare(
      `UPDATE sales_sequences
       SET status = 'proposed', stop_reason = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'stopped' AND steps_sent = 0 AND stop_reason = ?`,
    )
    .run(id, SALES_SEQUENCE_DECLINED);
  return updated.changes > 0 ? getSalesSequence(id) : undefined;
}

/** The only way a sequence becomes active, and only ever from a proposed row
 *  when Vishnu taps Start. */
export function activateSalesSequence(
  id: number,
  input: {
    nextStepAt: string;
    enrolledAt: string;
    manualFollowups: number;
    /** His own team from the pitch's Cc. Kept on step 1 only when step 1 is a
     *  sequence send; every later step has no Cc. */
    stepOneCc?: readonly string[];
    ccFirstOnly?: boolean;
    /** Follow-ups Aadi sends, on top of the ones he sent himself. Omitted for a
     *  Start tap, which keeps 4 steps in all. */
    followups?: number;
    /** Days between follow-ups. Null or omitted means SEQUENCE_STEP_DAYS. */
    stepDays?: number | null;
    /** His own call-to-action. Null or omitted means the ask in his email. */
    cta?: string | null;
    commandKey?: string | null;
  },
): boolean {
  const total =
    input.followups === undefined
      ? SALES_SEQUENCE_STEP_COUNT
      : input.manualFollowups + input.followups;
  if (!Number.isInteger(total) || total < 1 || total > salesSequenceStepCap()) {
    throw new Error(`A sequence can't have ${total} steps here.`);
  }
  return db.transaction(() => {
    const updated = db
      .prepare(
        `UPDATE sales_sequences
         SET status = 'active', stop_reason = NULL, enrolled_at = ?,
             next_step_at = ?, current_step = ?, manual_followups = ?,
             total_steps = ?, step_days = ?, cc_first_only = ?, cta = ?, command_key = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'proposed'`,
      )
      .run(
        input.enrolledAt,
        input.nextStepAt,
        input.manualFollowups + 1,
        input.manualFollowups,
        total,
        input.stepDays ?? null,
        input.ccFirstOnly === false ? 0 : 1,
        input.cta ?? null,
        input.commandKey ?? null,
        id,
      );
    if (updated.changes === 0) {
      return false;
    }
    const insertStep = db.prepare(
      `INSERT INTO sales_sequence_steps (sequence_id, step_no, scheduled_at, status, reason, cc)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const stepOneCc = (input.stepOneCc ?? []).join(", ");
    for (let step = 1; step <= total; step += 1) {
      const manual = step <= input.manualFollowups;
      insertStep.run(
        id,
        step,
        step === input.manualFollowups + 1 ? input.nextStepAt : null,
        manual ? "skipped" : "planned",
        manual ? "manual_followup" : null,
        !manual && (step === 1 || input.ccFirstOnly === false) && stepOneCc ? stepOneCc : null,
      );
    }
    return true;
  })();
}

/** A command's Start card holds exactly what was understood, so Start enrols exactly that. */
export function setProposedSalesSequenceSettings(
  id: number,
  input: {
    totalSteps: number;
    stepDays: number | null;
    cta: string | null;
    ccFirstOnly?: boolean;
    commandKey: string | null;
    /** The follow-ups he has sent himself as of this card, so total minus this is
     *  exactly the number the card offered. Omitted: leave as stored. */
    manualFollowups?: number;
  },
): boolean {
  return (
    db
      .prepare(
        `UPDATE sales_sequences
         SET total_steps = ?, step_days = ?, cc_first_only = ?, cta = ?, command_key = ?,
             manual_followups = COALESCE(?, manual_followups), updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'proposed'`,
      )
      .run(input.totalSteps, input.stepDays, input.ccFirstOnly === false ? 0 : 1, input.cta, input.commandKey, input.manualFollowups ?? null, id).changes > 0
  );
}

export function stopProposedSalesSequence(id: number, reason: string): boolean {
  return (
    db
      .prepare(
        `UPDATE sales_sequences
         SET status = 'stopped', stop_reason = ?, next_step_at = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'proposed'`,
      )
      .run(reason, id).changes > 0
  );
}

export function addSalesDoNotContact(email: string, reason: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO sales_do_not_contact (email, reason) VALUES (?, ?)`,
  ).run(email.trim().toLowerCase(), reason);
}

export function isSalesDoNotContact(email: string): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM sales_do_not_contact WHERE email = ?`)
      .get(email.trim().toLowerCase()) !== undefined
  );
}

export function getSalesPitchScan(
  messageId: string,
): SalesPitchScanRecord | undefined {
  return db
    .prepare(`SELECT * FROM sales_pitch_scans WHERE message_id = ?`)
    .get(messageId) as SalesPitchScanRecord | undefined;
}

export function recordSalesPitchScan(input: {
  messageId: string;
  threadId: string;
  isSalesPitch: boolean;
  confidence: number;
  reason: string;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO sales_pitch_scans (
       message_id, thread_id, is_sales_pitch, confidence, reason
     ) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    input.messageId,
    input.threadId,
    input.isSalesPitch ? 1 : 0,
    input.confidence,
    input.reason,
  );
}

export function getSalesSequenceStep(
  sequenceId: number,
  stepNo: number,
): SalesSequenceStepRecord | undefined {
  return db
    .prepare(
      `SELECT * FROM sales_sequence_steps WHERE sequence_id = ? AND step_no = ?`,
    )
    .get(sequenceId, stepNo) as SalesSequenceStepRecord | undefined;
}

export function setSalesSequenceOriginalAsk(
  id: number,
  ask: SalesOriginalAsk,
): void {
  db.prepare(
    `UPDATE sales_sequences
     SET original_ask = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).run(ask, id);
}

/** The written follow-up. The step stays planned until it is sent. */
export function setSalesStepPrepared(
  sequenceId: number,
  stepNo: number,
  draftText: string,
): void {
  db.prepare(
    `UPDATE sales_sequence_steps
     SET draft_text = ?, reason = NULL
     WHERE sequence_id = ? AND step_no = ? AND status = 'planned'`,
  ).run(draftText, sequenceId, stepNo);
}

function advanceSalesSequenceAfterSend(
  sequenceId: number,
  sentAt: string,
  stepDays: number,
): void {
  db.prepare(
    `UPDATE sales_sequences
     SET steps_sent = steps_sent + 1, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).run(sequenceId);
  const sequence = getSalesSequence(sequenceId);
  if (sequence?.status !== "active") {
    return;
  }
  // His own gap, when he set one by command.
  const gapDays = sequence.step_days ?? stepDays;
  const next = db
    .prepare(
      `SELECT step_no FROM sales_sequence_steps
       WHERE sequence_id = ? AND status = 'planned'
       ORDER BY step_no LIMIT 1`,
    )
    .get(sequenceId) as { step_no: number } | undefined;
  if (!next) {
    db.prepare(
      `UPDATE sales_sequences
       SET status = 'completed', next_step_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(sequenceId);
    return;
  }
  const nextAt = new Date(
    new Date(sentAt).getTime() + gapDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  db.prepare(
    `UPDATE sales_sequence_steps SET scheduled_at = ?
     WHERE sequence_id = ? AND step_no = ?`,
  ).run(nextAt, sequenceId, next.step_no);
  db.prepare(
    `UPDATE sales_sequences
     SET current_step = ?, next_step_at = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).run(next.step_no, nextAt, sequenceId);
}

/** Records one sent step and moves the sequence on. */
export function recordSalesStepSent(input: {
  sequenceId: number;
  stepNo: number;
  sentMessageId: string;
  sentAt: string;
  stepDays: number;
}): void {
  db.transaction(() => {
    db.prepare(
      `UPDATE sales_sequence_steps
       SET status = 'sent', sent_message_id = ?, sent_at = ?
       WHERE sequence_id = ? AND step_no = ?`,
    ).run(input.sentMessageId, input.sentAt, input.sequenceId, input.stepNo);
    advanceSalesSequenceAfterSend(input.sequenceId, input.sentAt, input.stepDays);
  })();
}

export function listActiveSalesSequences(): SalesSequenceRecord[] {
  return db
    .prepare(
      `SELECT * FROM sales_sequences WHERE status = 'active'
       ORDER BY next_step_at IS NULL, next_step_at, id`,
    )
    .all() as SalesSequenceRecord[];
}

export function setSalesSequenceTimezone(id: number, timezone: string, source: string): void {
  db.prepare(
    `UPDATE sales_sequences
     SET prospect_timezone = ?, prospect_timezone_source = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).run(timezone, source, id);
}

export function clearSalesSequenceTimezone(id: number): void {
  db.prepare(
    `UPDATE sales_sequences
     SET prospect_timezone = NULL, prospect_timezone_source = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).run(id);
}

export interface AddedSalesFact {
  id: number;
  section: string | null;
  fact: string;
  created_at: string;
}

/** Facts Vishnu adds by chat. They sit beside docs/sales_facts.md, never in it. */
export function addSalesFact(fact: string, section: string | null): AddedSalesFact {
  const result = db
    .prepare(`INSERT INTO sales_facts_added (section, fact) VALUES (?, ?)`)
    .run(section, fact);
  return db
    .prepare(`SELECT * FROM sales_facts_added WHERE id = ?`)
    .get(Number(result.lastInsertRowid)) as AddedSalesFact;
}

export function listAddedSalesFacts(): AddedSalesFact[] {
  return db
    .prepare(`SELECT * FROM sales_facts_added ORDER BY id`)
    .all() as AddedSalesFact[];
}

export function deleteAddedSalesFact(id: number): boolean {
  return db.prepare(`DELETE FROM sales_facts_added WHERE id = ?`).run(id).changes > 0;
}

/** Claimed before the send call, so a crash can never lead to a second send: a
 *  step stuck in sending is never picked up again. */
export function claimSalesStepSending(
  sequenceId: number,
  stepNo: number,
  claimedAt: string,
): boolean {
  return (
    db
      .prepare(
        `UPDATE sales_sequence_steps
         SET status = 'sending', claimed_at = ?
         WHERE sequence_id = ? AND step_no = ? AND status = 'planned'
           AND sent_message_id IS NULL
           AND EXISTS (
             SELECT 1 FROM sales_sequences
             WHERE id = ? AND status = 'active' AND current_step = ?
           )`,
      )
      .run(claimedAt, sequenceId, stepNo, sequenceId, stepNo).changes > 0
  );
}

/** Only for a send Gmail definitely refused. */
export function releaseSalesStepClaim(sequenceId: number, stepNo: number): void {
  db.prepare(
    `UPDATE sales_sequence_steps
     SET status = 'planned', claimed_at = NULL
     WHERE sequence_id = ? AND step_no = ? AND status = 'sending'`,
  ).run(sequenceId, stepNo);
}

export function stopActiveSalesSequence(id: number, reason: string): boolean {
  return (
    db
      .prepare(
        `UPDATE sales_sequences
         SET status = 'stopped', stop_reason = ?, next_step_at = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'active'`,
      )
      .run(reason, id).changes > 0
  );
}

/** A crashed send that later showed up in Gmail: record it so nothing else takes
 *  it for his own email, and stop rather than carry on from an unknown state. */
export function recoverSalesStepSent(input: {
  sequenceId: number;
  stepNo: number;
  sentMessageId: string;
  sentAt: string;
  reason: string;
}): void {
  db.transaction(() => {
    db.prepare(
      `UPDATE sales_sequence_steps
       SET status = 'sent', sent_message_id = ?, sent_at = ?
       WHERE sequence_id = ? AND step_no = ? AND status = 'sending'`,
    ).run(input.sentMessageId, input.sentAt, input.sequenceId, input.stepNo);
    db.prepare(
      `UPDATE sales_sequences
       SET steps_sent = steps_sent + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(input.sequenceId);
    stopActiveSalesSequence(input.sequenceId, input.reason);
  })();
}

/** Moves the next step later, never earlier. A paused sequence stays paused. */
export function postponeSalesSequence(id: number, nextAt: string): boolean {
  return db.transaction(() => {
    const moved =
      db
        .prepare(
          `UPDATE sales_sequences
           SET next_step_at = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND status = 'active' AND next_step_at IS NOT NULL
             AND next_step_at < ?`,
        )
        .run(nextAt, id, nextAt).changes > 0;
    if (moved) {
      db.prepare(
        `UPDATE sales_sequence_steps SET scheduled_at = ?
         WHERE sequence_id = ? AND step_no = (
           SELECT current_step FROM sales_sequences WHERE id = ?
         )`,
      ).run(nextAt, id, id);
    }
    return moved;
  })();
}

export function isSalesSequenceSentMessage(messageId: string): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM sales_sequence_steps WHERE sent_message_id = ?`)
      .get(messageId) !== undefined
  );
}

/** Sends and in-flight claims since the given time, for the daily cap. */
export function countSalesSendsSince(sinceIso: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM sales_sequence_steps
       WHERE (status = 'sent' AND sent_at >= ?)
          OR (status = 'sending' AND claimed_at >= ?)`,
    )
    .get(sinceIso, sinceIso) as { count: number };
  return row.count;
}

export function lastSalesSendAt(): string | undefined {
  const row = db
    .prepare(
      `SELECT MAX(COALESCE(sent_at, claimed_at)) AS last FROM sales_sequence_steps
       WHERE status IN ('sent', 'sending')`,
    )
    .get() as { last: string | null };
  return row.last ?? undefined;
}

/** A meeting already in motion with this address: an open offer, a booking about
 *  to confirm, or an event card waiting for his tap. */
export function hasPendingMeetingWithEmail(email: string): boolean {
  const address = email.trim().toLowerCase();
  const proposal = db
    .prepare(
      `SELECT 1 FROM meeting_proposals
       WHERE status = 'open' AND lower(recipient_email) = ?`,
    )
    .get(address);
  if (proposal) {
    return true;
  }
  const booking = db
    .prepare(
      `SELECT 1 FROM meeting_pending_bookings AS booking
       JOIN meeting_proposals AS proposal ON proposal.id = booking.proposal_id
       WHERE booking.status = 'pending' AND lower(proposal.recipient_email) = ?`,
    )
    .get(address);
  if (booking) {
    return true;
  }
  return (
    db
      .prepare(
        `SELECT 1 FROM pending_actions
         WHERE type = 'create_event' AND status = 'pending'
           AND instr(lower(COALESCE(event_attendees, '')), ?) > 0`,
      )
      .get(`"${address}"`) !== undefined
  );
}

// ---- Emails sent on Vishnu's command (send_email) ----

export interface CommandChoiceRecord {
  id: number;
  request: string;
  status: "open" | "used" | "cancelled";
  created_at: string;
}

/** Claimed before the Gmail call. The unique key is what stops a second send. */
export function claimCommandSend(input: {
  key: string;
  account: string;
  threadId: string | null;
  /** The To header it goes to. Recorded for the recent-send check. */
  to?: string;
}): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO command_sends (idem_key, status, account, thread_id, to_header)
       VALUES (?, 'sending', ?, ?, ?)`,
    )
    .run(input.key, input.account, input.threadId, input.to ?? null);
  return result.changes === 1;
}

/** A draft Aadi sent at once with no card (sendCreatedDraftNow): no pending_actions row
 *  exists for it, so it is recorded like a direct command send, where recentSendsTo and
 *  the receipts read it. */
export function recordImmediateDraftSend(input: {
  key: string;
  account: string;
  threadId: string | null;
  to: string;
  sentMessageId: string;
}): void {
  db.prepare(
    `INSERT OR IGNORE INTO command_sends (idem_key, status, account, thread_id, to_header, sent_message_id, sent_at)
     VALUES (?, 'sent', ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
  ).run(input.key, input.account, input.threadId, input.to, input.sentMessageId);
}

export function getCommandSendByKey(
  key: string,
): { status: string; sent_message_id: string | null } | undefined {
  return db
    .prepare("SELECT status, sent_message_id FROM command_sends WHERE idem_key = ?")
    .get(key) as { status: string; sent_message_id: string | null } | undefined;
}

export function recordCommandSendSent(key: string, sentMessageId: string): void {
  db.prepare(
    `UPDATE command_sends SET status = 'sent', sent_message_id = ?, sent_at = CURRENT_TIMESTAMP
     WHERE idem_key = ? AND status = 'sending'`,
  ).run(sentMessageId, key);
}

/** The Telegram message that told him this email went out. */
export function setCommandSendTelegramMessage(key: string, telegramMessageId: number): void {
  db.prepare("UPDATE command_sends SET telegram_message_id = ? WHERE idem_key = ?").run(
    telegramMessageId,
    key,
  );
}

export function commandSendForTelegramMessage(
  telegramMessageId: number,
): { account: string; status: string; sent_message_id: string | null } | undefined {
  return db
    .prepare(
      `SELECT account, status, sent_message_id FROM command_sends
       WHERE telegram_message_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(telegramMessageId) as
    | { account: string; status: string; sent_message_id: string | null }
    | undefined;
}

export function markCommandSendUnconfirmed(key: string): void {
  db.prepare(
    "UPDATE command_sends SET status = 'unconfirmed' WHERE idem_key = ? AND status = 'sending'",
  ).run(key);
}

/** Gmail refused it, so the same command may try again. */
export function releaseCommandSend(key: string): void {
  db.prepare("DELETE FROM command_sends WHERE idem_key = ? AND status = 'sending'").run(key);
}

export function createCommandChoice(request: string, createdAt: string): number {
  const result = db
    .prepare("INSERT INTO command_send_choices (request, created_at) VALUES (?, ?)")
    .run(request, createdAt);
  return Number(result.lastInsertRowid);
}

export function getCommandChoice(id: number): CommandChoiceRecord | undefined {
  return db.prepare("SELECT * FROM command_send_choices WHERE id = ?").get(id) as
    | CommandChoiceRecord
    | undefined;
}

export function listOpenCommandChoices(sinceIso: string): CommandChoiceRecord[] {
  return db
    .prepare("SELECT * FROM command_send_choices WHERE status = 'open' AND created_at >= ?")
    .all(sinceIso) as CommandChoiceRecord[];
}

/** One tap wins: the choice closes here, so a double tap can't act twice. */
export function closeCommandChoice(id: number, status: "used" | "cancelled"): boolean {
  return (
    db
      .prepare("UPDATE command_send_choices SET status = ? WHERE id = ? AND status = 'open'")
      .run(status, id).changes === 1
  );
}

// ---- "Which Hardik?": a name that fits several people, or nobody ----

export interface ContactQuestionRecord {
  id: number;
  chat_id: number;
  /** Vishnu's own message that needed the person, re-run once he answers. */
  request: string;
  /** The name as it was asked for. */
  query: string;
  /** JSON list of the people to choose from. Empty when nobody matched. */
  options: string;
  status: "open" | "answered" | "dropped";
  created_at: string;
}

/** One question per chat: asking a new one drops the one before it. */
export function openContactQuestion(input: {
  chatId: number;
  request: string;
  query: string;
  options: string;
  createdAt: string;
}): number {
  db.prepare("UPDATE contact_questions SET status = 'dropped' WHERE chat_id = ? AND status = 'open'").run(
    input.chatId,
  );
  const result = db
    .prepare(
      "INSERT INTO contact_questions (chat_id, request, query, options, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(input.chatId, input.request, input.query, input.options, input.createdAt);
  return Number(result.lastInsertRowid);
}

export function getContactQuestion(id: number): ContactQuestionRecord | undefined {
  return db.prepare("SELECT * FROM contact_questions WHERE id = ?").get(id) as
    | ContactQuestionRecord
    | undefined;
}

export function getOpenContactQuestion(
  chatId: number,
  sinceIso: string,
): ContactQuestionRecord | undefined {
  return db
    .prepare(
      "SELECT * FROM contact_questions WHERE chat_id = ? AND status = 'open' AND created_at >= ? ORDER BY id DESC LIMIT 1",
    )
    .get(chatId, sinceIso) as ContactQuestionRecord | undefined;
}

/** The newest question id for this chat, so a turn can tell whether it asked one. */
export function latestContactQuestionId(chatId: number): number {
  const row = db
    .prepare("SELECT MAX(id) AS id FROM contact_questions WHERE chat_id = ?")
    .get(chatId) as { id: number | null };
  return row.id ?? 0;
}

/** One answer wins: the question closes here, so a double tap can't act twice. */
export function closeContactQuestion(id: number, status: "answered" | "dropped"): boolean {
  return (
    db
      .prepare("UPDATE contact_questions SET status = ? WHERE id = ? AND status = 'open'")
      .run(status, id).changes === 1
  );
}

/** Who Vishnu said he meant by a name. Only his own answer or tap writes this. */
export function saveContactChoice(nameKey: string, contact: string, chosenAt: string): void {
  db.prepare(
    `INSERT INTO contact_choices (name_key, contact, chosen_at) VALUES (?, ?, ?)
     ON CONFLICT(name_key) DO UPDATE SET contact = excluded.contact, chosen_at = excluded.chosen_at`,
  ).run(nameKey, contact, chosenAt);
}

export function getContactChoice(nameKey: string, sinceIso: string): string | undefined {
  const row = db
    .prepare("SELECT contact FROM contact_choices WHERE name_key = ? AND chosen_at >= ?")
    .get(nameKey, sinceIso) as { contact: string } | undefined;
  return row?.contact;
}

export interface PendingActionRow {
  chat_id: number;
  action: string;
  state_json: string;
  owner_words: string;
  confirm_chat: number;
  confirm_message: number;
  updated_at: string;
}

export function upsertPendingActionContext(input: {
  chatId: number;
  action: string;
  stateJson: string;
  ownerWords: string;
  confirmChat: number;
  confirmMessage: number;
  updatedAt: string;
}): void {
  db.transaction(() => {
    const proposed = JSON.parse(input.stateJson) as { email?: EmailLink; status?: string };
    if (proposed?.email && (proposed.status === "open" || proposed.status === undefined)) {
      const last = getClosedEmailContext(input.chatId);
      const matchedCommand = input.action === "send_email" && !proposed.email.draftId && !proposed.email.scheduledSendId &&
        db.prepare("SELECT 1 FROM command_sends WHERE account = ? AND idem_key GLOB ? AND status = 'sent' LIMIT 1")
          .get(proposed.email.account, `msg:${input.chatId}:${input.confirmMessage}:*`);
      if (matchedCommand || recordedClosedEmail(proposed.email) || (last && sameEmailLink(proposed.email, last))) return;
    }
    db.prepare(
      `INSERT INTO pending_action_contexts (
       chat_id, action, state_json, owner_words, confirm_chat, confirm_message, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       action = excluded.action,
       state_json = excluded.state_json,
       owner_words = excluded.owner_words,
       confirm_chat = excluded.confirm_chat,
       confirm_message = excluded.confirm_message,
       updated_at = excluded.updated_at`,
    ).run(
      input.chatId,
      input.action,
      input.stateJson,
      input.ownerWords,
      input.confirmChat,
      input.confirmMessage,
      input.updatedAt,
    );
  }).immediate();
}

export function getPendingActionContext(chatId: number): PendingActionRow | undefined {
  return db
    .prepare("SELECT * FROM pending_action_contexts WHERE chat_id = ?")
    .get(chatId) as PendingActionRow | undefined;
}

type ClosedEmailStatus = "sent" | "superseded" | "discarded" | "cancelled" | "expired" | "unknown";

export interface ClosedEmailContext {
  account: GoogleAccountId;
  draftId?: string;
  scheduleId?: number;
  threadId?: string;
  to?: string;
  status: ClosedEmailStatus;
  sentAt?: string;
  sentMessageId?: string;
  focusMessageId?: number;
}

function isClosedEmailStatus(status: PendingActionStatus): status is ClosedEmailStatus & PendingActionStatus {
  return status === "sent" || status === "superseded" || status === "discarded" ||
    status === "cancelled" || status === "expired";
}

function recordedNow(): string {
  return new Date().toISOString();
}

type EmailLink = {
  account: GoogleAccountId;
  draftId?: string;
  scheduledSendId?: number;
  to?: Array<{ name?: string; email?: string }>;
};

function linkedRecipient(email: EmailLink): string | undefined {
  return email.to?.flatMap(({ name, email }) => email ? [name ? `${name} <${email}>` : email] : []).join(", ") || undefined;
}

function emailReferenceForAction(action: PendingAction, status: ClosedEmailStatus): ClosedEmailContext {
  const sentSchedule = status === "sent" && action.draft_id
    ? listScheduledSendsForDraft(action.draft_id, action.google_account).find(row => row.status === "sent")
    : undefined;
  return {
    account: action.google_account, draftId: action.draft_id ?? undefined, status,
    threadId: action.sent_thread_id ?? action.thread_id ?? undefined, to: action.live_to_header ?? action.to_header ?? undefined,
    sentAt: action.sent_at ?? sentSchedule?.sent_at ?? undefined,
    sentMessageId: action.sent_message_id ?? sentSchedule?.sent_message_id ?? undefined,
  };
}

function scheduleEmailReference(row: ScheduledSendRecord, status: "sent" | "cancelled"): ClosedEmailContext | undefined {
  try {
    const request = JSON.parse(row.request) as {
      account?: GoogleAccountId; draftId?: string; threadId?: string;
      to?: Array<{ mailbox?: { name?: string; email?: string } }>;
    };
    if (request.account !== "work" && request.account !== "personal") return undefined;
    return {
      account: request.account, scheduleId: row.id, draftId: request.draftId,
      threadId: request.threadId ?? undefined, status,
      to: linkedRecipient({ account: request.account, to: request.to?.flatMap(slot => slot.mailbox ? [slot.mailbox] : []) }),
      sentAt: status === "sent" ? row.sent_at ?? undefined : undefined,
      sentMessageId: status === "sent" ? row.sent_message_id ?? undefined : undefined,
    };
  } catch {
    return undefined;
  }
}

export function getClosedEmailContext(chatId: number): (ClosedEmailContext & { closedAt: string }) | undefined {
  const row = db.prepare("SELECT detail, closed_at FROM closed_email_contexts WHERE chat_id = ?").get(chatId) as
    { detail: string; closed_at: string } | undefined;
  return row ? { ...JSON.parse(row.detail) as ClosedEmailContext, closedAt: row.closed_at } : undefined;
}

function sameEmailLink(email: EmailLink, ref: ClosedEmailContext): boolean {
  return email.account === ref.account && (ref.status === "cancelled" && ref.scheduleId
    ? email.scheduledSendId === ref.scheduleId
    : Boolean((ref.draftId && email.draftId === ref.draftId) ||
      (ref.scheduleId && email.scheduledSendId === ref.scheduleId)));
}

/** Called in the transition transaction. Only the email itself and its authority are closed. */
function closeEmailContext(
  ref: ClosedEmailContext,
  origin?: { chatId: number; messageId: number },
  useLinkedMessage = false,
): void {
  const rows = db.prepare("SELECT * FROM pending_action_contexts").all() as PendingActionRow[];
  const store = db.prepare(`INSERT INTO closed_email_contexts (chat_id, detail)
    VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET detail = excluded.detail, closed_at = CURRENT_TIMESTAMP`);
  for (const row of rows) {
    type State = {
      email?: EmailLink; status?: string; action?: string; authorizedAt?: string; ownerWords?: string;
      meeting?: unknown;
    };
    let state: State;
    try { state = JSON.parse(row.state_json) as State; } catch { continue; }
    if (!state) continue;
    const email = state.email;
    if (!email || email.account !== ref.account) continue;
    const matchesCommand = !ref.draftId && !ref.scheduleId && !email.draftId && !email.scheduledSendId &&
      row.chat_id === origin?.chatId && row.confirm_message === origin?.messageId && row.action === "send_email";
    if (!sameEmailLink(email, ref) && !matchesCommand) continue;
    const focusMessageId = origin?.messageId ??
      (ref.scheduleId || useLinkedMessage || ref.status === "expired"
        ? row.confirm_message
        : ownerMessageIdsBefore(row.chat_id, Number.MAX_SAFE_INTEGER, 1)[0] ?? 0);
    store.run(row.chat_id, JSON.stringify({ ...ref, focusMessageId, to: ref.to ?? linkedRecipient(email) }));
    delete state.email;
    if (row.action === "draft_email" || row.action === "send_email") {
      delete state.authorizedAt;
      state.ownerWords = "";
      if (state.meeting) {
        state.action = "create_meeting";
        state.status = "open";
      } else if (state.status !== "cancelled") {
        state.action = "note";
        state.status = "done";
      }
    }
    db.prepare("UPDATE pending_action_contexts SET state_json = ?, action = ?, owner_words = ? WHERE chat_id = ?")
      .run(JSON.stringify(state), state.action ?? row.action, state.ownerWords ?? row.owner_words, row.chat_id);
  }
  // A delivery already in progress can settle after its approval was superseded.
  // Update its last reference in place without disturbing any newer open email.
  if (ref.status === "sent" && ref.draftId) {
    const previous = db.prepare("SELECT chat_id, detail FROM closed_email_contexts WHERE json_extract(detail, '$.draftId') = ? AND json_extract(detail, '$.account') = ?").all(ref.draftId, ref.account) as
      Array<{ chat_id: number; detail: string }>;
    for (const row of previous) {
      const old = JSON.parse(row.detail) as ClosedEmailContext;
      store.run(row.chat_id, JSON.stringify({
        ...ref, to: ref.to ?? old.to, threadId: ref.threadId ?? old.threadId, focusMessageId: old.focusMessageId,
      }));
    }
  }
}

/** Resolve legacy links from records before a stale draft can be edited again. */
export function recordedClosedEmail(email: EmailLink): ClosedEmailContext | undefined {
  const action = email.draftId ? latestDraftAction(email.draftId, email.account) : undefined;
  const bound = email.scheduledSendId ? getScheduledSend(email.scheduledSendId) : undefined;
  const delivered = email.draftId
    ? listScheduledSendsForDraft(email.draftId, email.account).find(row => row.status === "sent")
    : undefined;
  const schedule = delivered ?? bound;
  if (schedule?.status === "sent" || schedule?.status === "cancelled") {
    const ref = scheduleEmailReference(schedule, schedule.status);
    if (ref && sameEmailLink(email, ref) && schedule.status === "sent") return ref;
  }
  if (action && isClosedEmailStatus(action.status)) return emailReferenceForAction(action, action.status);
  if (action?.command_key) {
    const command = db.prepare(
      "SELECT sent_at, sent_message_id, thread_id FROM command_sends WHERE idem_key = ? AND account = ? AND status = 'sent'",
    ).get(action.command_key, email.account) as
      { sent_at: string | null; sent_message_id: string | null; thread_id: string | null } | undefined;
    if (command) return {
      ...emailReferenceForAction(action, "sent"),
      sentAt: command.sent_at ?? undefined, sentMessageId: command.sent_message_id ?? undefined,
      threadId: command.thread_id ?? action.thread_id ?? undefined,
    };
  }
  if (bound?.status === "cancelled") {
    const ref = scheduleEmailReference(bound, "cancelled");
    if (ref && sameEmailLink(email, ref)) return ref;
  }
  return undefined;
}

export function emailDeliveryUnsettled(email: EmailLink): boolean {
  if (email.draftId && unconfirmedDraftDelivery(email.draftId, email.account)) return true;
  const schedules = email.draftId ? draftDeliveryRows(email.draftId, email.account) : [];
  const directSchedule = email.scheduledSendId ? getScheduledSend(email.scheduledSendId) : undefined;
  if (directSchedule && scheduleEmailReference(directSchedule, "sent")?.account === email.account) schedules.push(directSchedule);
  if (schedules.some(row => row.status === "sending" || (row.status === "failed" && row.claimed_at))) return true;
  const key = email.draftId ? latestDraftAction(email.draftId, email.account)?.command_key : undefined;
  const command = key ? getCommandSendByKey(key) : undefined;
  // A pending command card also has a claim. Only an unconfirmed command here
  // is evidence of an unresolved external attempt.
  return command?.status === "unconfirmed";
}

export function reconcileClosedEmail(chatId: number, email: EmailLink, gmailMissing = false): ClosedEmailContext | undefined {
  return db.transaction(() => {
    const known = recordedClosedEmail(email);
    if (!known && !gmailMissing) return undefined;
    const action = email.draftId ? latestDraftAction(email.draftId, email.account) : undefined;
    const ref: ClosedEmailContext = known ?? {
      account: email.account, draftId: email.draftId, scheduleId: email.scheduledSendId,
      threadId: action?.thread_id ?? undefined, to: linkedRecipient(email), status: "unknown",
    };
    closeEmailContext(ref, undefined, true);
    const last = getClosedEmailContext(chatId);
    return last && sameEmailLink(email, last) ? last : ref;
  }).immediate();
}

export function deletePendingActionContext(chatId: number): void {
  db.prepare("DELETE FROM pending_action_contexts WHERE chat_id = ?").run(chatId);
}

export interface PresentedReferentRow {
  chat_id: number;
  entities_json: string;
  pending_kind: string | null;
  updated_at: string;
}

export function upsertPresentedReferents(input: {
  chatId: number;
  entitiesJson: string;
  pendingKind?: string | null;
  updatedAt: string;
}): void {
  db.prepare(
    `INSERT INTO presented_referents (chat_id, entities_json, pending_kind, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       entities_json = excluded.entities_json,
       pending_kind = excluded.pending_kind,
       updated_at = excluded.updated_at`,
  ).run(input.chatId, input.entitiesJson, input.pendingKind ?? null, input.updatedAt);
}

export function getPresentedReferents(chatId: number): PresentedReferentRow | undefined {
  return db
    .prepare("SELECT * FROM presented_referents WHERE chat_id = ?")
    .get(chatId) as PresentedReferentRow | undefined;
}

export interface CanonicalContactRow {
  id: number;
  name_key: string;
  display_name: string;
  emails_json: string;
  company: string | null;
  aliases_json: string;
  sources_json: string;
  confirmed: number;
  updated_at: string;
}

export function listCanonicalContacts(): CanonicalContactRow[] {
  return db
    .prepare("SELECT * FROM canonical_contacts ORDER BY confirmed DESC, updated_at DESC")
    .all() as CanonicalContactRow[];
}

export function upsertCanonicalContact(input: {
  nameKey: string;
  displayName: string;
  emailsJson: string;
  company?: string | null;
  aliasesJson: string;
  sourcesJson: string;
  confirmed: boolean;
  updatedAt: string;
}): void {
  const existing = db
    .prepare("SELECT id, confirmed, aliases_json FROM canonical_contacts WHERE name_key = ?")
    .get(input.nameKey) as { id: number; confirmed: number; aliases_json: string } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE canonical_contacts
       SET display_name = ?, emails_json = ?, company = COALESCE(?, company),
           aliases_json = ?, sources_json = ?, confirmed = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      input.displayName,
      input.emailsJson,
      input.company ?? null,
      input.aliasesJson,
      input.sourcesJson,
      input.confirmed || existing.confirmed ? 1 : 0,
      input.updatedAt,
      existing.id,
    );
    return;
  }
  db.prepare(
    `INSERT INTO canonical_contacts (
       name_key, display_name, emails_json, company, aliases_json, sources_json, confirmed, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.nameKey,
    input.displayName,
    input.emailsJson,
    input.company ?? null,
    input.aliasesJson,
    input.sourcesJson,
    input.confirmed ? 1 : 0,
    input.updatedAt,
  );
}

/** Everyone a follow-up sequence was proposed or run for: name, address and company. */
export function listSequenceProspects(): Array<{ name: string; email: string; company: string; seen_at: string }> {
  return db
    .prepare(
      `SELECT prospect_name AS name, prospect_email AS email, prospect_company AS company,
              MAX(updated_at) AS seen_at
       FROM sales_sequences
       GROUP BY prospect_email`,
    )
    .all() as Array<{ name: string; email: string; company: string; seen_at: string }>;
}

// ---- Emails to send later on Vishnu's command ----

export type ScheduledSendStatus = "scheduled" | "held" | "sending" | "sent" | "cancelled" | "failed";

export interface ScheduledSendRecord {
  id: number;
  idem_key: string;
  status: ScheduledSendStatus;
  send_at: string;
  retry_at: string | null;
  task_id: number;
  item_text: string;
  /** The CommandRequest, including who it goes to and what he asked it to say. */
  request: string;
  confirm_chat: number;
  confirm_message: number;
  write_failures: number;
  claimed_at: string | null;
  sent_message_id: string | null;
  sent_at?: string | null;
  created_at: string;
}

/** The row and its visible task, together. Undefined when this command already made one. */
export function createScheduledSend(input: {
  key: string;
  sendAt: string;
  itemText: string;
  tag: ItemTag;
  request: string;
  confirmChat: number;
  confirmMessage: number;
  /** Held: waiting on his Confirm tap (a new address). */
  held?: boolean;
}): ScheduledSendRecord | undefined {
  return db.transaction(() => {
    if (db.prepare("SELECT 1 FROM scheduled_sends WHERE idem_key = ?").get(input.key)) {
      return undefined;
    }
    const task = createTask(input.itemText, input.tag, input.sendAt);
    const result = db
      .prepare(
        `INSERT INTO scheduled_sends
           (idem_key, send_at, task_id, item_text, request, confirm_chat, confirm_message, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.key,
        input.sendAt,
        task.id,
        input.itemText,
        input.request,
        input.confirmChat,
        input.confirmMessage,
        input.held ? "held" : "scheduled",
      );
    return getScheduledSend(Number(result.lastInsertRowid));
  })();
}

function editableScheduledStatus(status: ScheduledSendStatus): boolean {
  return status === "scheduled" || status === "held";
}

/** A person the scheduled email goes to. The address is the choice he made, so it is
 *  also what the send-time check looks up. */
export interface ScheduledPerson {
  name: string;
  email: string;
}

function scheduledSlots(people: readonly ScheduledPerson[]): Array<Record<string, unknown>> {
  return people.map((person) => {
    const email = person.email.toLowerCase();
    return { query: email, mailbox: { email, name: person.name || email } };
  });
}

function slotAddresses(slots: unknown): string {
  if (!Array.isArray(slots)) {
    return "";
  }
  return slots
    .map((slot) => {
      const mailbox = (slot as { mailbox?: { email?: unknown } } | null)?.mailbox;
      return typeof mailbox?.email === "string" ? mailbox.email.toLowerCase() : "";
    })
    .sort()
    .join(",");
}

function sameAddressSet(slots: unknown, people: readonly ScheduledPerson[]): boolean {
  return slotAddresses(slots) === people.map((person) => person.email.toLowerCase()).sort().join(",");
}

/** Everything the scheduled worker reads from an approved draft edit. Which draft a row
 *  belongs to is fixed when it is scheduled and is never changed here. */
export interface ScheduledCopyChange {
  to?: readonly ScheduledPerson[];
  cc?: readonly ScheduledPerson[];
  subject?: string;
  /** The finished body. It is sent as it is, with no rewrite at send time. */
  body?: string;
}

export type ScheduledCopyResult =
  | { ok: true; changed: boolean }
  | { ok: false; status: ScheduledSendStatus | "missing" | "unreadable" };

/**
 * One write for every field the worker reads: recipients, subject, and the finalized
 * subject and body. Either all of it lands or none of it does, and
 * only while the row can still change. The worker's claim compares the request text, so
 * any change here makes a copy it already prepared stale.
 */
export function writeScheduledCopy(id: number, change: ScheduledCopyChange): ScheduledCopyResult {
  return db.transaction((): ScheduledCopyResult => {
    const row = getScheduledSend(id);
    if (!row) {
      return { ok: false, status: "missing" };
    }
    if (!editableScheduledStatus(row.status)) {
      return { ok: false, status: row.status };
    }
    let request: Record<string, unknown>;
    try {
      request = JSON.parse(row.request) as Record<string, unknown>;
    } catch {
      return { ok: false, status: "unreadable" };
    }
    // The same people keep the names and choices already stored for them.
    if (change.to && change.to.length > 0 && !sameAddressSet(request.to, change.to)) {
      request.to = scheduledSlots(change.to);
    }
    if (change.cc && !sameAddressSet(request.cc, change.cc)) {
      request.cc = scheduledSlots(change.cc);
    }
    const subject = change.subject?.trim();
    const before = typeof request.subject === "string" ? request.subject : "";
    if (subject) {
      // A subject he changed, not one copied over unchanged, decides at send time whether a
      // reply can stay in its thread.
      if (before && !sameConversation(subject, before)) {
        request.subjectEdited = true;
      }
      request.subject = subject;
      request.finalSubject = subject;
    }
    if (typeof change.body === "string" && change.body.trim()) {
      request.finalBody = change.body;
      request.instruction = change.body;
      if (typeof request.finalSubject !== "string" && typeof request.subject === "string") {
        request.finalSubject = request.subject;
      }
    }
    let next = JSON.stringify(request);
    if (next === row.request) {
      return { ok: true, changed: false };
    }
    if (subject || change.body) {
      const version = typeof request.finalVersion === "number" ? request.finalVersion : 0;
      request.finalVersion = version + 1;
      next = JSON.stringify(request);
    }
    const written = db
      .prepare(
        `UPDATE scheduled_sends SET request = ?
         WHERE id = ? AND status IN ('scheduled', 'held') AND request = ?`,
      )
      .run(next, id, row.request).changes === 1;
    if (written && subject && subject !== before) {
      // The task list and /scheduledsends show the subject that will go out.
      const parts = row.item_text.split(" — ");
      if (parts.length >= 3) {
        parts[1] = subject;
        const itemText = parts.join(" — ");
        db.prepare("UPDATE scheduled_sends SET item_text = ? WHERE id = ?").run(itemText, id);
        db.prepare("UPDATE tasks SET text = ? WHERE id = ? AND text = ?").run(itemText, row.task_id, row.item_text);
      }
    }
    return written ? { ok: true, changed: true } : { ok: false, status: getScheduledSend(id)?.status ?? "missing" };
  })();
}

/** Every scheduled email bound, when it was scheduled, to this Gmail draft in this mailbox,
 *  and that has not ended without sending. A draft id alone never links two mailboxes. */
export function listScheduledSendsForDraft(draftId: string, account: string): ScheduledSendRecord[] {
  return db
    .prepare(
      `SELECT * FROM scheduled_sends
       WHERE status IN ('scheduled', 'held', 'sending', 'sent')
         AND json_valid(request)
         AND json_extract(request, '$.draftId') = ?
         AND json_extract(request, '$.account') = ?
       ORDER BY id DESC`,
    )
    .all(draftId, account) as ScheduledSendRecord[];
}

export type DraftDeliveryClaim =
  | { state: "none" }
  | { state: "superseded" }
  | { state: "claimed"; id: number; taskId: number }
  | { state: "already_sent"; id: number; itemText: string }
  | { state: "in_progress"; id: number; itemText: string }
  | { state: "unconfirmed"; id: number; itemText: string };

/** Scheduled rows for this draft in this mailbox, including attempts that already left the queue. */
function draftDeliveryRows(draftId: string, account: string): ScheduledSendRecord[] {
  return db
    .prepare(
      `SELECT * FROM scheduled_sends
       WHERE json_valid(request)
         AND json_extract(request, '$.draftId') = ?
         AND json_extract(request, '$.account') = ?
         AND status IN ('scheduled', 'held', 'sending', 'sent', 'failed')
       ORDER BY id DESC`,
    )
    .all(draftId, account) as ScheduledSendRecord[];
}

export function recordUnconfirmedDraftDelivery(draftId: string, account: string): boolean {
  return db.prepare("INSERT OR IGNORE INTO unconfirmed_draft_deliveries (account, draft_id) VALUES (?, ?)").run(account, draftId).changes === 1;
}

export function clearUnconfirmedDraftDelivery(draftId: string, account: string): void {
  db.prepare("DELETE FROM unconfirmed_draft_deliveries WHERE account = ? AND draft_id = ?").run(account, draftId);
}

export function unconfirmedDraftDelivery(draftId: string, account: string): { attempted_at: string } | undefined {
  return db.prepare("SELECT attempted_at FROM unconfirmed_draft_deliveries WHERE account = ? AND draft_id = ?")
    .get(account, draftId) as { attempted_at: string } | undefined;
}

/**
 * One claim for every way this draft can go out. The manual Send button and the
 * scheduled worker both take it before Gmail, so only one of them proceeds.
 * A sent, in-flight, or unconfirmed attempt blocks another try.
 */
export function claimDraftDelivery(
  draftId: string,
  account: string,
  nowIso: string,
  only?: { scheduleId: number; request: string },
): DraftDeliveryClaim {
  const classify = (depth: number): DraftDeliveryClaim => {
    if (depth > 3) {
      return { state: "in_progress", id: 0, itemText: "That email is already being sent." };
    }
    const rows = draftDeliveryRows(draftId, account);
    const sending = rows.find((row) => row.status === "sending");
    if (sending) {
      return { state: "in_progress", id: sending.id, itemText: sending.item_text };
    }
    const openRows = rows.filter((row) => row.status === "scheduled" || row.status === "held");
    const open = only
      ? openRows.find((row) => row.id === only.scheduleId && row.request === only.request)
      : openRows[0];
    if (open) {
      const claimed =
        db
          .prepare(
            `UPDATE scheduled_sends SET status = 'sending', claimed_at = ?
             WHERE id = ? AND status IN ('scheduled', 'held')
               AND EXISTS (
                 SELECT 1 FROM tasks
                 WHERE tasks.id = scheduled_sends.task_id AND tasks.status = 'open'
               )`,
          )
          .run(nowIso, open.id).changes === 1;
      if (claimed) {
        for (const other of openRows) {
          if (other.id === open.id) continue;
          if (transitionScheduledSend(other.id, ["scheduled", "held"], "cancelled")) {
            markTaskDone(other.task_id);
          }
        }
        return { state: "claimed", id: open.id, taskId: open.task_id };
      }
      const current = getScheduledSend(open.id);
      if (current && (current.status === "scheduled" || current.status === "held")) {
        return { state: "none" };
      }
      return classify(depth + 1);
    }
    const sent = rows.find((row) => row.status === "sent");
    if (sent) {
      return { state: "already_sent", id: sent.id, itemText: sent.item_text };
    }
    const failed = rows.find((row) => row.status === "failed" && row.claimed_at);
    if (failed) {
      return { state: "unconfirmed", id: failed.id, itemText: failed.item_text };
    }
    return { state: "none" };
  };
  return db.transaction((): DraftDeliveryClaim => {
    const action = (account === "work" || account === "personal") ? latestDraftAction(draftId, account) : undefined;
    if (action?.status === "superseded" || (action?.status === "pending" && olderDuplicateDrafts().some((row) => row.id === action.id))) {
      return { state: "superseded" };
    }
    if (unconfirmedDraftDelivery(draftId, account)) {
      return { state: "unconfirmed", id: 0, itemText: "Gmail has not confirmed the draft delivery." };
    }
    return classify(0);
  }).immediate();
}

/** Drops queued deliveries for this draft. An attempt already underway is left alone. */
export function cancelOpenDraftSchedules(draftId: string, account: string): number {
  let cancelled = 0;
  for (const row of draftDeliveryRows(draftId, account)) {
    if (row.status !== "scheduled" && row.status !== "held") {
      continue;
    }
    if (transitionScheduledSend(row.id, ["scheduled", "held"], "cancelled")) {
      markTaskDone(row.task_id);
      cancelled += 1;
    }
  }
  return cancelled;
}

export function draftDeliveryBlocksDiscard(draftId: string, account: string): "in_progress" | "already_sent" | undefined {
  const rows = draftDeliveryRows(draftId, account);
  if (rows.some((row) => row.status === "sending")) {
    return "in_progress";
  }
  if (rows.some((row) => row.status === "sent")) {
    return "already_sent";
  }
  return undefined;
}

/** The mailbox a draft was scheduled from, including after that send has finished. */
export function accountBoundToDraft(draftId: string): "work" | "personal" | undefined {
  const row = db
    .prepare(
      `SELECT json_extract(request, '$.account') AS account
       FROM scheduled_sends
       WHERE json_valid(request)
         AND json_extract(request, '$.draftId') = ?
         AND status IN ('scheduled', 'held', 'sending', 'sent', 'failed')
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get(draftId) as { account: unknown } | undefined;
  return row?.account === "work" || row?.account === "personal" ? row.account : undefined;
}

export function getScheduledSend(id: number): ScheduledSendRecord | undefined {
  return db.prepare("SELECT * FROM scheduled_sends WHERE id = ?").get(id) as
    | ScheduledSendRecord
    | undefined;
}

export function listOpenScheduledSends(): ScheduledSendRecord[] {
  return db
    .prepare(
      "SELECT * FROM scheduled_sends WHERE status IN ('scheduled', 'held') ORDER BY send_at ASC, id ASC",
    )
    .all() as ScheduledSendRecord[];
}

export function listDueScheduledSends(nowIso: string, limit: number): ScheduledSendRecord[] {
  return db
    .prepare(
      `SELECT * FROM scheduled_sends
       WHERE status = 'scheduled' AND send_at <= ? AND (retry_at IS NULL OR retry_at <= ?)
       ORDER BY send_at ASC, id ASC
       LIMIT ?`,
    )
    .all(nowIso, nowIso, limit) as ScheduledSendRecord[];
}

/** Closing the task is one of the ways to cancel. */
export function listScheduledSendsWithClosedTask(): ScheduledSendRecord[] {
  return db
    .prepare(
      `SELECT scheduled_sends.* FROM scheduled_sends
       JOIN tasks ON tasks.id = scheduled_sends.task_id
       WHERE scheduled_sends.status IN ('scheduled', 'held') AND tasks.status = 'done'`,
    )
    .all() as ScheduledSendRecord[];
}

export function listStaleScheduledSends(cutoffIso: string): ScheduledSendRecord[] {
  return db
    .prepare("SELECT * FROM scheduled_sends WHERE status = 'sending' AND claimed_at < ?")
    .all(cutoffIso) as ScheduledSendRecord[];
}

/** The last check before Gmail, in one statement. Fails if he cancelled, by any route, or
 *  if the saved request is no longer the exact one this copy was prepared from. After it
 *  succeeds the row is 'sending' and no correction can change it. */
export function claimScheduledSend(id: number, nowIso: string, preparedRequest: string): boolean {
  return (
    db
      .prepare(
        `UPDATE scheduled_sends SET status = 'sending', claimed_at = ?
         WHERE id = ? AND status = 'scheduled' AND request = ?
           AND EXISTS (SELECT 1 FROM tasks WHERE tasks.id = scheduled_sends.task_id AND tasks.status = 'open')`,
      )
      .run(nowIso, id, preparedRequest).changes === 1
  );
}

export function transitionScheduledSend(
  id: number,
  from: readonly ScheduledSendStatus[],
  to: ScheduledSendStatus,
): boolean {
  const places = from.map(() => "?").join(", ");
  return db.transaction(() => {
    const changed = db.prepare(`UPDATE scheduled_sends SET status = ? WHERE id = ? AND status IN (${places})`)
      .run(to, id, ...from).changes === 1;
    if (changed && to === "cancelled") {
      const row = getScheduledSend(id);
      const ref = row && scheduleEmailReference(row, "cancelled");
      if (ref) closeEmailContext(ref);
    }
    return changed;
  }).immediate();
}

/** Holds only the version the worker checked, so a correction saved meanwhile is kept. */
export function holdScheduledSend(id: number, request: string, checkedRequest: string): boolean {
  return (
    db
      .prepare(
        "UPDATE scheduled_sends SET status = 'held', request = ? WHERE id = ? AND status = 'scheduled' AND request = ?",
      )
      .run(request, id, checkedRequest).changes === 1
  );
}

/** A scheduled email whose recipients now include a new address waits on his Confirm. */
export function holdScheduledSendForConfirm(id: number): boolean {
  return (
    db.prepare("UPDATE scheduled_sends SET status = 'held' WHERE id = ? AND status = 'scheduled'").run(id).changes === 1
  );
}

/** The schedule a command made, by its key. */
export function scheduledSendByKey(key: string): ScheduledSendRecord | undefined {
  const row = db.prepare("SELECT id FROM scheduled_sends WHERE idem_key = ?").get(key) as { id: number } | undefined;
  return row ? getScheduledSend(row.id) : undefined;
}

export function releaseHeldScheduledSend(id: number, request: string, expectedRequest?: string): boolean {
  if (expectedRequest !== undefined) {
    // Only the version he was shown: an edit since then wins and nothing is released.
    return (
      db
        .prepare(
          "UPDATE scheduled_sends SET status = 'scheduled', request = ?, retry_at = NULL WHERE id = ? AND status = 'held' AND request = ?",
        )
        .run(request, id, expectedRequest).changes === 1
    );
  }
  return (
    db
      .prepare(
        "UPDATE scheduled_sends SET status = 'scheduled', request = ?, retry_at = NULL WHERE id = ? AND status = 'held'",
      )
      .run(request, id).changes === 1
  );
}

export function recordScheduledSendSent(id: number, sentMessageId: string | null): void {
  db.transaction(() => {
    const changed = db.prepare("UPDATE scheduled_sends SET status = 'sent', sent_message_id = ?, sent_at = COALESCE(sent_at, CURRENT_TIMESTAMP) WHERE id = ?").run(
      sentMessageId, id,
    ).changes === 1;
    if (!changed) return;
    const row = getScheduledSend(id);
    const ref = row && scheduleEmailReference(row, "sent");
    if (ref) closeEmailContext(ref);
  }).immediate();
}

/** Retries a send that is still scheduled. A cancel that landed meanwhile stays cancelled. */
export function retryScheduledSend(id: number, retryAt: string): number {
  const changed = db.prepare(
    "UPDATE scheduled_sends SET retry_at = ?, write_failures = write_failures + 1 WHERE id = ? AND status = 'scheduled'",
  ).run(retryAt, id).changes;
  return changed === 1 ? getScheduledSend(id)?.write_failures ?? 0 : 0;
}

export type IgnoreEntityType =
  | "bill"
  | "task"
  | "reminder"
  | "date"
  | "email_source"
  | "account"
  | "notification"
  | "build"
  | "calendar_event";

export type IgnoreMatchScope = "record" | "source" | "category";
export type IgnoreDuration = "permanent" | "temporary";
export type IgnoreRuleStatus = "active" | "resumed" | "expired";
export type IgnoreTag = ItemTag | "both";

export interface IgnoreRuleRecord {
  id: number;
  owner_id: string;
  tag: IgnoreTag;
  entity_type: IgnoreEntityType;
  entity_id: string | null;
  match_key: string;
  match_scope: IgnoreMatchScope;
  duration: IgnoreDuration;
  created_at: string;
  expires_at: string | null;
  instruction: string;
  auth_ref: string;
  reason: string | null;
  resumed_at: string | null;
  status: IgnoreRuleStatus;
}

export interface IgnoreRuleEventRecord {
  id: number;
  rule_id: number;
  action: "created" | "resumed" | "expired" | "duplicate";
  at: string;
  auth_ref: string;
  instruction: string | null;
  detail: string | null;
}

const IGNORE_RULE_COLUMNS = `id, owner_id, tag, entity_type, entity_id, match_key,
  match_scope, duration, created_at, expires_at, instruction, auth_ref, reason,
  resumed_at, status`;

export interface CreateIgnoreRuleInput {
  ownerId?: string;
  tag: IgnoreTag;
  entityType: IgnoreEntityType;
  entityId?: string | null;
  matchKey: string;
  matchScope: IgnoreMatchScope;
  duration: IgnoreDuration;
  expiresAt?: string | null;
  instruction: string;
  authRef: string;
  reason?: string | null;
}

export function insertIgnoreRule(
  input: CreateIgnoreRuleInput,
): IgnoreRuleRecord | undefined {
  try {
    const result = db
      .prepare(
        `INSERT INTO ignore_rules (
           owner_id, tag, entity_type, entity_id, match_key, match_scope,
           duration, expires_at, instruction, auth_ref, reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.ownerId ?? "owner",
        input.tag,
        input.entityType,
        input.entityId ?? null,
        input.matchKey,
        input.matchScope,
        input.duration,
        input.expiresAt ?? null,
        input.instruction,
        input.authRef,
        input.reason ?? null,
      );
    return getIgnoreRule(Number(result.lastInsertRowid));
  } catch {
    return undefined;
  }
}

export function getIgnoreRule(id: number): IgnoreRuleRecord | undefined {
  return db
    .prepare(`SELECT ${IGNORE_RULE_COLUMNS} FROM ignore_rules WHERE id = ?`)
    .get(id) as IgnoreRuleRecord | undefined;
}

export function getActiveIgnoreRuleByKey(
  entityType: IgnoreEntityType,
  matchKey: string,
  matchScope: IgnoreMatchScope,
  tag: IgnoreTag,
): IgnoreRuleRecord | undefined {
  return db
    .prepare(
      `SELECT ${IGNORE_RULE_COLUMNS}
         FROM ignore_rules
        WHERE status = 'active'
          AND entity_type = ?
          AND match_key = ?
          AND match_scope = ?
          AND tag = ?`,
    )
    .get(entityType, matchKey, matchScope, tag) as IgnoreRuleRecord | undefined;
}

export function getActiveIgnoreRuleByRecord(
  entityType: IgnoreEntityType,
  entityId: string,
  matchScope: IgnoreMatchScope,
  tag: IgnoreTag,
): IgnoreRuleRecord | undefined {
  return db
    .prepare(
      `SELECT ${IGNORE_RULE_COLUMNS}
         FROM ignore_rules
        WHERE status = 'active'
          AND entity_type = ?
          AND entity_id = ?
          AND match_scope = ?
          AND tag = ?`,
    )
    .get(entityType, entityId, matchScope, tag) as IgnoreRuleRecord | undefined;
}

export function listActiveIgnoreRules(): IgnoreRuleRecord[] {
  return db
    .prepare(
      `SELECT ${IGNORE_RULE_COLUMNS}
         FROM ignore_rules
        WHERE status = 'active'
        ORDER BY created_at ASC, id ASC`,
    )
    .all() as IgnoreRuleRecord[];
}

export function listIgnoreRulesByStatus(
  status: IgnoreRuleStatus,
): IgnoreRuleRecord[] {
  return db
    .prepare(
      `SELECT ${IGNORE_RULE_COLUMNS}
         FROM ignore_rules
        WHERE status = ?
        ORDER BY created_at ASC, id ASC`,
    )
    .all(status) as IgnoreRuleRecord[];
}

export function recordIgnoreRuleEvent(
  ruleId: number,
  action: IgnoreRuleEventRecord["action"],
  authRef: string,
  instruction?: string | null,
  detail?: string | null,
): void {
  db.prepare(
    `INSERT INTO ignore_rule_events (rule_id, action, auth_ref, instruction, detail)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(ruleId, action, authRef, instruction ?? null, detail ?? null);
}

export function listIgnoreRuleEvents(ruleId: number): IgnoreRuleEventRecord[] {
  return db
    .prepare(
      `SELECT id, rule_id, action, at, auth_ref, instruction, detail
         FROM ignore_rule_events
        WHERE rule_id = ?
        ORDER BY at ASC, id ASC`,
    )
    .all(ruleId) as IgnoreRuleEventRecord[];
}

export function markIgnoreRuleResumed(
  id: number,
  resumedAt: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE ignore_rules
          SET status = 'resumed', resumed_at = ?
        WHERE id = ? AND status = 'active'`,
    )
    .run(resumedAt, id);
  return result.changes === 1;
}

export function markIgnoreRuleExpired(
  id: number,
  expiredAt: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE ignore_rules
          SET status = 'expired', resumed_at = ?
        WHERE id = ? AND status = 'active'`,
    )
    .run(expiredAt, id);
  return result.changes === 1;
}

export function expireDueIgnoreRules(nowIso: string): IgnoreRuleRecord[] {
  const due = db
    .prepare(
      `SELECT id FROM ignore_rules
        WHERE status = 'active'
          AND duration = 'temporary'
          AND expires_at IS NOT NULL
          AND expires_at <= ?`,
    )
    .all(nowIso) as Array<{ id: number }>;
  const expired: IgnoreRuleRecord[] = [];
  for (const row of due) {
    if (markIgnoreRuleExpired(row.id, nowIso)) {
      recordIgnoreRuleEvent(row.id, "expired", "scheduler", null, nowIso);
      const rule = getIgnoreRule(row.id);
      if (rule) {
        expired.push(rule);
      }
    }
  }
  return expired;
}
