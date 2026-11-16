/**
 * Ignore suppresses delivery. It does not cancel future schedules, and
 * record rules for two invoices of the same biller stay distinct.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "grammy";
import { handleBillCallback } from "../src/bills.ts";
import {
  createBill,
  createReminder,
  createTask,
  getBill,
  getReminder,
  getReminders,
  listActiveIgnoreRules,
  listIgnoreRuleEvents,
  transitionBillStatus,
  transitionReminderStatus,
} from "../src/db.ts";
import {
  applyIgnore,
  billIsIgnored,
  reminderIsIgnored,
  resumeIgnore,
} from "../src/ignore.ts";
import { handler as ignoreBill } from "../src/tools/ignore_bill.ts";
import { handler as ignoreItem } from "../src/tools/ignore_item.ts";
import { handler as listBills } from "../src/tools/list_bills.ts";

if (process.env.AADI_DB_PATH !== ":memory:") {
  throw new Error("test-ignore-lifecycle.ts must run with AADI_DB_PATH=:memory:");
}

const owner = (text: string) => ({
  iteration: 1,
  calledTools: [] as string[],
  confirmation: { chatId: 1, messageId: 7 },
  userText: text,
});

function slot(day: string): string {
  return new Date(`${day}T09:00:00+05:30`).toISOString();
}

function pendingFor(billId: number): Array<{ id: number; remind_at: string; status: string }> {
  return getReminders()
    .filter((reminder) => reminder.related_bill_id === billId)
    .map((reminder) => ({
      id: reminder.id,
      remind_at: reminder.remind_at,
      status: reminder.status,
    }));
}

function billReminders(billId: number, due: string): void {
  for (const day of [addDays(due, -3), addDays(due, -1), due]) {
    createReminder(
      `Bill due: lifecycle. Due on ${due}.`,
      "personal",
      slot(day),
      "none",
      { relatedBillId: billId },
    );
  }
}

function addDays(ymd: string, days: number): string {
  const date = new Date(`${ymd}T12:00:00+05:30`);
  date.setDate(date.getDate() + days);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

// A. Temporary bill ignore keeps later reminders and drops only the missed one.
{
  const bill = createBill("Lifecycle Power", 100, "INR", "2026-11-25", "life-a")!;
  billReminders(bill.id, "2026-11-25");
  const created = applyIgnore({
    entityType: "bill",
    matchKey: "lifecycle power",
    matchScope: "record",
    tag: "personal",
    entityId: String(bill.id),
    duration: "temporary",
    expiresAt: "2026-11-23T00:00:00.000Z",
    instruction: "Ignore Lifecycle Power until 23 Nov",
    authRef: "owner_chat:test",
  });
  assert.equal(created.kind, "created");
  const during = new Date("2026-11-22T04:00:00.000Z");
  assert.equal(billIsIgnored(getBill(bill.id)!, during), true);
  assert.equal(
    pendingFor(bill.id).filter((row) => row.status === "pending").length,
    3,
    "ignore does not cancel the schedule",
  );
  assert.equal(
    getReminders()
      .filter((row) => row.related_bill_id === bill.id)
      .every((row) => row.status !== "sent"),
    true,
  );
  const after = new Date("2026-11-23T01:00:00.000Z");
  assert.equal(billIsIgnored(getBill(bill.id)!, after), false, "expiry lifts the rule");
  const rows = pendingFor(bill.id);
  const missed = rows.find((row) => row.remind_at === slot("2026-11-22"));
  const later = rows.filter((row) => row.remind_at !== slot("2026-11-22"));
  assert.equal(missed?.status, "cancelled", "the missed 22 Nov ping is not delivered");
  assert.ok(later.every((row) => row.status === "pending"), JSON.stringify(rows));
  assert.equal(later.length, 2);
  assert.ok(rows.every((row) => row.status !== "sent"));
}

// B. Explicit resume restores future slots that the old cancel path destroyed.
{
  const bill = createBill("Lifecycle Water", 80, "INR", "2026-12-01", "life-b")!;
  billReminders(bill.id, "2026-12-01");
  createReminder("old past ping", "personal", slot("2026-11-10"), "none", {
    relatedBillId: bill.id,
  });
  const rule = applyIgnore({
    entityType: "bill",
    matchKey: "lifecycle water",
    matchScope: "record",
    tag: "personal",
    entityId: String(bill.id),
    instruction: "Ignore Lifecycle Water",
    authRef: "owner_chat:test",
  }).rule;
  for (const reminder of getReminders()) {
    if (reminder.related_bill_id === bill.id && reminder.status === "pending") {
      if (new Date(reminder.remind_at).getTime() > Date.parse("2026-11-16T12:00:00.000Z")) {
        transitionReminderStatus(reminder.id, "pending", "cancelled");
      }
    }
  }
  const now = new Date("2026-11-16T12:00:00.000Z");
  const resumed = resumeIgnore(rule.id, "owner_chat:test", "resume water", now);
  assert.equal(resumed?.status, "resumed");
  const rows = pendingFor(bill.id);
  const future = rows.filter((row) => new Date(row.remind_at).getTime() > now.getTime());
  const past = rows.filter((row) => new Date(row.remind_at).getTime() <= now.getTime());
  assert.equal(future.filter((row) => row.status === "pending").length, 3, JSON.stringify(rows));
  assert.ok(past.every((row) => row.status === "cancelled"), JSON.stringify(rows));
  assert.ok(rows.every((row) => row.status !== "sent"));
  assert.equal(resumeIgnore(rule.id, "owner_chat:test", "again", now), undefined);
  assert.equal(
    pendingFor(bill.id).filter((row) => row.status === "pending").length,
    3,
    "a second resume does not duplicate reminders",
  );
}

// C. A daily reminder skips missed days and keeps one future occurrence.
{
  const firstAt = "2026-11-13T03:30:00.000Z";
  const reminder = createReminder("Take vitamin D", "personal", firstAt, "daily");
  const rule = applyIgnore({
    entityType: "reminder",
    matchKey: "take vitamin d",
    matchScope: "record",
    tag: "personal",
    entityId: String(reminder.id),
    duration: "temporary",
    expiresAt: "2026-11-19T00:00:00.000Z",
    instruction: "Ignore vitamin D for three days",
    authRef: "owner_chat:test",
  }).rule;
  const during = new Date("2026-11-16T08:00:00.000Z");
  assert.equal(reminderIsIgnored(getReminder(reminder.id)!, during), true);
  assert.equal(getReminder(reminder.id)!.status, "pending");
  const now = new Date("2026-11-16T14:00:00.000Z");
  resumeIgnore(rule.id, "owner_chat:test", "resume vitamin", now);
  assert.equal(getReminder(reminder.id)!.status, "cancelled");
  const series = getReminders().filter((row) => row.text === "Take vitamin D");
  const future = series.filter(
    (row) => row.status === "pending" && new Date(row.remind_at).getTime() > now.getTime(),
  );
  assert.equal(future.length, 1, JSON.stringify(series));
  assert.ok(series.every((row) => row.status !== "sent"));

  const expiredSeed = createReminder(
    "Take vitamin C",
    "personal",
    "2026-11-13T03:30:00.000Z",
    "daily",
  );
  applyIgnore({
    entityType: "reminder",
    matchKey: "take vitamin c",
    matchScope: "record",
    tag: "personal",
    entityId: String(expiredSeed.id),
    duration: "temporary",
    expiresAt: "2026-11-16T12:00:00.000Z",
    instruction: "Ignore vitamin C until it expires",
    authRef: "owner_chat:test",
  });
  const expiredAt = new Date("2026-11-16T13:00:00.000Z");
  assert.equal(reminderIsIgnored(getReminder(expiredSeed.id)!, expiredAt), false);
  const vitaminC = getReminders().filter((row) => row.text === "Take vitamin C");
  assert.equal(
    vitaminC.filter(
      (row) => row.status === "pending" && new Date(row.remind_at).getTime() > expiredAt.getTime(),
    ).length,
    1,
    JSON.stringify(vitaminC),
  );

  const broken = createReminder("Stretch", "personal", "2026-11-13T03:30:00.000Z", "daily");
  transitionReminderStatus(broken.id, "pending", "cancelled");
  const brokenRule = applyIgnore({
    entityType: "reminder",
    matchKey: "stretch",
    matchScope: "record",
    tag: "personal",
    entityId: String(broken.id),
    instruction: "Ignore stretch",
    authRef: "owner_chat:test",
  }).rule;
  resumeIgnore(brokenRule.id, "owner_chat:test", "resume stretch", now);
  const stretch = getReminders().filter((row) => row.text === "Stretch" && row.status === "pending");
  assert.equal(stretch.length, 1, "a cancelled recurrence chain is rebuilt once");
  assert.ok(new Date(stretch[0]!.remind_at).getTime() > now.getTime());
}

// D. The bill-card Ignore button is registry-only.
{
  const bill = createBill("Lifecycle Card", 50, "INR", "2026-12-20", "life-d")!;
  createReminder("card future", "personal", slot("2026-12-17"), "none", {
    relatedBillId: bill.id,
  });
  const ctx = {
    answerCallbackQuery: async () => undefined,
    reply: async () => undefined,
    editMessageReplyMarkup: async () => undefined,
  } as unknown as Context;
  await handleBillCallback(ctx, "ignore", bill.id);
  assert.equal(getBill(bill.id)!.status, "upcoming");
  assert.equal(billIsIgnored(getBill(bill.id)!), true);
  assert.equal(
    getReminders().find((row) => row.related_bill_id === bill.id)?.status,
    "pending",
  );
  assert.doesNotMatch(listBills({ filter: "upcoming" }), /Lifecycle Card/);
  const rule = listActiveIgnoreRules().find((row) => row.entity_id === String(bill.id));
  assert.ok(rule);
  assert.equal(rule!.match_scope, "record");
  resumeIgnore(rule!.id, "telegram:resume", "resume card");
  assert.equal(getBill(bill.id)!.status, "upcoming");
  assert.equal(billIsIgnored(getBill(bill.id)!), false);
  assert.match(listBills({ filter: "upcoming" }), /Lifecycle Card/);
  assert.equal(
    getReminders().find((row) => row.related_bill_id === bill.id)?.status,
    "pending",
  );
}

// E. A historical cycle skip is not turned into a source rule.
{
  const before = listActiveIgnoreRules().length;
  const historical = createBill("Old Cycle Skip", 10, "INR", "2026-10-01", "life-e")!;
  assert.equal(transitionBillStatus(historical.id, "upcoming", "ignored"), true);
  assert.equal(listActiveIgnoreRules().length, before);
  assert.equal(getBill(historical.id)!.status, "ignored");
  const skipped = createBill("Cycle Phone", 20, "INR", "2026-11-18", "life-e2")!;
  const text = ignoreBill(
    { query: "Cycle Phone", skip_cycle: true },
    owner("Skip this cycle"),
  );
  assert.match(text, /Skipped Cycle Phone for this month/);
  assert.equal(getBill(skipped.id)!.status, "ignored");
  assert.equal(
    listActiveIgnoreRules().some((rule) => rule.match_key.includes("cycle phone")),
    false,
  );
}

// F / G. Two invoices from one biller are two record rules. Repeating one is a duplicate.
{
  const first = createBill("LinkedIn", 2400, "INR", "2026-12-01", "life-f1")!;
  const second = createBill("LinkedIn", 2400, "INR", "2026-12-15", "life-f2")!;
  const left = applyIgnore({
    entityType: "bill",
    matchKey: "linkedin",
    matchScope: "record",
    tag: "personal",
    entityId: String(first.id),
    instruction: "Ignore LinkedIn invoice 1",
    authRef: "owner_chat:test",
  });
  const right = applyIgnore({
    entityType: "bill",
    matchKey: "linkedin",
    matchScope: "record",
    tag: "personal",
    entityId: String(second.id),
    instruction: "Ignore LinkedIn invoice 2",
    authRef: "owner_chat:test",
  });
  assert.equal(left.kind, "created");
  assert.equal(right.kind, "created");
  assert.notEqual(left.rule.id, right.rule.id);
  assert.equal(left.rule.entity_id, String(first.id));
  assert.equal(right.rule.entity_id, String(second.id));
  const again = applyIgnore({
    entityType: "bill",
    matchKey: "linkedin",
    matchScope: "record",
    tag: "personal",
    entityId: String(first.id),
    instruction: "Ignore LinkedIn invoice 1 again",
    authRef: "owner_chat:test",
  });
  assert.equal(again.kind, "duplicate");
  assert.equal(again.rule.id, left.rule.id);
  assert.ok(
    listIgnoreRuleEvents(left.rule.id).some((event) => event.action === "duplicate"),
  );
  assert.equal(
    listActiveIgnoreRules().filter(
      (rule) => rule.match_scope === "record" && rule.entity_id === String(first.id),
    ).length,
    1,
  );
  resumeIgnore(left.rule.id, "owner_chat:test", "resume first linkedin");
  assert.equal(billIsIgnored(getBill(first.id)!), false);
  assert.equal(billIsIgnored(getBill(second.id)!), true);
}

// H. Source-level ignore still collapses to one rule.
{
  const once = applyIgnore({
    entityType: "bill",
    matchKey: "spotify",
    matchScope: "source",
    tag: "personal",
    instruction: "Ignore Spotify bills",
    authRef: "owner_chat:test",
  });
  const twice = applyIgnore({
    entityType: "bill",
    matchKey: "spotify",
    matchScope: "source",
    tag: "personal",
    instruction: "Ignore Spotify bills",
    authRef: "owner_chat:test",
  });
  assert.equal(once.kind, "created");
  assert.equal(twice.duplicate, true);
  assert.equal(twice.rule.id, once.rule.id);
  assert.equal(
    listActiveIgnoreRules().filter((rule) => rule.match_key === "spotify").length,
    1,
  );
  const later = createBill("Spotify", 119, "INR", "2026-12-28", "life-h")!;
  assert.equal(billIsIgnored(later), true);
}

// I. Resume does not send reminders whose time passed while ignored.
{
  const bill = createBill("Lifecycle Gas", 40, "INR", "2026-11-20", "life-i")!;
  const past = createReminder("gas past", "personal", slot("2026-11-14"), "none", {
    relatedBillId: bill.id,
  });
  const future = createReminder("gas future", "personal", slot("2026-11-19"), "none", {
    relatedBillId: bill.id,
  });
  const rule = applyIgnore({
    entityType: "bill",
    matchKey: "lifecycle gas",
    matchScope: "record",
    tag: "personal",
    entityId: String(bill.id),
    instruction: "Ignore gas until resume",
    authRef: "owner_chat:test",
  }).rule;
  const now = new Date("2026-11-16T12:00:00.000Z");
  resumeIgnore(rule.id, "owner_chat:test", "resume gas", now);
  assert.equal(getReminder(past.id)!.status, "cancelled");
  assert.equal(getReminder(future.id)!.status, "pending");
  assert.ok(
    getReminders()
      .filter((row) => row.related_bill_id === bill.id)
      .every((row) => row.status !== "sent"),
  );
}

// Task-linked future reminders survive; a passed one does not burst.
{
  const task = createTask("File the tax papers", "personal", "2026-12-01T09:00:00.000Z");
  const past = createReminder("tax past", "personal", slot("2026-11-01"), "none", {
    relatedTaskId: task.id,
  });
  const future = createReminder("tax future", "personal", slot("2026-11-30"), "none", {
    relatedTaskId: task.id,
  });
  transitionReminderStatus(future.id, "pending", "cancelled");
  const rule = applyIgnore({
    entityType: "task",
    matchKey: "file the tax papers",
    matchScope: "record",
    tag: "personal",
    entityId: String(task.id),
    instruction: "Ignore the tax task",
    authRef: "owner_chat:test",
  }).rule;
  resumeIgnore(rule.id, "owner_chat:test", "resume tax", new Date("2026-11-16T12:00:00.000Z"));
  assert.equal(getReminder(past.id)!.status, "cancelled");
  assert.equal(getReminder(future.id)!.status, "pending");
}

{
  const refused = ignoreItem(
    { query: "Lifecycle Gas" },
    { iteration: 1, calledTools: [] },
  );
  assert.match(refused, /own chat or voice/i);
}

{
  const dir = mkdtempSync(join(tmpdir(), "aadi-ignore-migrate-"));
  const path = join(dir, "old.db");
  const env = { ...process.env, AADI_DB_PATH: path };
  const seed = spawnSync(
    "npx",
    ["tsx", "scripts/ignore-migration-check.ts", "seed"],
    { env, encoding: "utf8" },
  );
  assert.equal(seed.status, 0, seed.stderr || seed.stdout);
  assert.match(seed.stdout, /SEEDED/);
  const check = spawnSync(
    "npx",
    ["tsx", "scripts/ignore-migration-check.ts", "check"],
    { env, encoding: "utf8" },
  );
  assert.equal(check.status, 0, check.stderr || check.stdout);
  assert.match(check.stdout, /MIGRATION_OK/);
}

console.log("ignore lifecycle checks passed.");
