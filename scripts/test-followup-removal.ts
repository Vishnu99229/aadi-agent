/**
 * The old follow-up tracker is gone: its table and job record are dropped at
 * startup, nothing still offers it, and the reply keyboard is refreshed once.
 * Runs on a throwaway database file that still has the old table, the way the
 * phone's did.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import Database from "better-sqlite3";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const dir = mkdtempSync(join(tmpdir(), "aadi-followup-removal-"));
const file = join(dir, "aadi.db");
{
  const old = new Database(file);
  old.exec(`
    CREATE TABLE followups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      recipient TEXT NOT NULL,
      subject TEXT NOT NULL,
      tag TEXT NOT NULL,
      google_account TEXT NOT NULL DEFAULT 'personal',
      last_sent_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting',
      nudge_count INTEGER NOT NULL DEFAULT 0,
      next_check_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (google_account, thread_id)
    );
    CREATE INDEX idx_followups_status_next_check ON followups (status, next_check_at);
    CREATE TABLE job_runs (
      name TEXT PRIMARY KEY,
      last_success_at TEXT,
      last_attempt_at TEXT NOT NULL,
      last_status TEXT NOT NULL
    );
    INSERT INTO job_runs (name, last_success_at, last_attempt_at, last_status)
      VALUES ('followup-scan', '2026-11-06T04:30:00Z', '2026-11-06T04:30:00Z', 'ok'),
             ('morning-brief', '2026-11-08T02:30:00Z', '2026-11-08T02:30:00Z', 'ok');
  `);
  const insert = old.prepare(
    `INSERT INTO followups (thread_id, recipient, subject, tag, google_account, last_sent_at, status, next_check_at)
     VALUES (?, 'x@example.com', 's', 'work', 'work', '2026-11-01T00:00:00Z', 'waiting', '2026-11-09T00:00:00Z')`,
  );
  for (let index = 0; index < 15; index += 1) {
    insert.run(`thread-${index}`);
  }
  old.close();
}

process.env.AADI_DB_PATH = file;
const { getJobRun, getSetting, setSetting } = await import("../src/db.ts");
{
  const check = new Database(file, { readonly: true });
  const table = check.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'followup%' OR name LIKE 'idx_followups%'").all();
  assert(table.length === 0, `the followups table and its index are gone, found ${JSON.stringify(table)}`);
  check.close();
}
assert(getJobRun("followup-scan") === undefined, "the followup-scan job record is gone, so /health has no row for it");
assert(getJobRun("morning-brief") !== undefined, "other job records stay");

// A second start is a no-op.
{
  const again = new Database(file);
  again.exec("DROP TABLE IF EXISTS followups; DELETE FROM job_runs WHERE name = 'followup-scan';");
  again.close();
}

// Nothing offers the tracker any more.
const { TOOL_ORDER, FORWARDED_TOOLS } = await import("../src/tools/index.ts");
for (const name of ["track_thread", "stop_tracking", "list_waiting"]) {
  assert(!(TOOL_ORDER as readonly string[]).includes(name), `${name} is no longer a tool`);
  assert(!(FORWARDED_TOOLS as readonly string[]).includes(name), `${name} is not offered to forwarded messages`);
}
const { HEALTH_JOBS } = await import("../src/scheduler.ts");
assert(!(HEALTH_JOBS as readonly string[]).includes("followup-scan"), "/health no longer lists followup-scan");
const indexSrc = await readFile("src/index.ts", "utf8");
assert(!indexSrc.includes('command: "followups"'), "/followups is gone from the Telegram menu");
const botSrc = await readFile("src/bot.ts", "utf8");
assert(!/bot\.command\("followups"/.test(botSrc), "/followups no longer answers");
assert(!botSrc.includes("Waiting on\")") && !botSrc.includes("menu:waiting"), "Waiting on is gone from the keyboard and menu");
assert(botSrc.includes('.text("Sequences", "menu:sequences")') && botSrc.includes('.text("Sequences")'), "Sequences takes its place");
for (const removed of ["src/followups.ts", "src/followup_panel.ts", "src/followup_logic.ts"]) {
  let present = true;
  try {
    await readFile(removed, "utf8");
  } catch {
    present = false;
  }
  assert(!present, `${removed} is deleted`);
}

// The reply keyboard is sent again once, and only when it's switched on.
const { refreshReplyKeyboardOnce } = await import("../src/bot.ts");
const sent: Array<{ text: string; markup: unknown }> = [];
const api = {
  sendMessage: async (_chat: number, text: string, extra: { reply_markup?: unknown }) => {
    sent.push({ text, markup: extra.reply_markup });
    return { message_id: sent.length };
  },
} as never;
setSetting("reply_keyboard", "off");
assert((await refreshReplyKeyboardOnce(api)) === false && sent.length === 0, "a hidden keyboard isn't sent");
setSetting("reply_keyboard", "on");
assert((await refreshReplyKeyboardOnce(api)) === true && sent.length === 1, "a shown keyboard is sent once");
const buttons = JSON.stringify(sent[0]!.markup);
assert(buttons.includes("Sequences") && !buttons.includes("Waiting on"), `the new keyboard has Sequences: ${buttons}`);
assert((await refreshReplyKeyboardOnce(api)) === false && sent.length === 1, "and never again");
assert(getSetting("reply_keyboard_layout") === "sequences-v1", "the layout is remembered");

rmSync(dir, { recursive: true, force: true });
console.log("test-followup-removal: ok");
process.exit(0);
