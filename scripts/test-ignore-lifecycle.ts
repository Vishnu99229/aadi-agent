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
import type { Api } from "grammy";
import { handleBillCallback, handleBillDuplicateCallback } from "../src/bills.ts";
import {
  backfillLegacyBillIgnoreProvenance,
  cancelPendingRemindersForBill,
  cancelPendingRemindersForTask,
  createBill,
  createReminder,
  createTask,
  db,
  getBill,
  getBills,
  getDueReminders,
  getReminder,
  getReminders,
  insertIgnoreRule,
  listActiveIgnoreRules,
  listIgnoreRuleEvents,
  markTaskDone,
  transitionBillStatus,
  transitionReminderStatus,
} from "../src/db.ts";
import {
  applyIgnore,
  billIsIgnored,
  matchingIgnoreRule,
  reminderIsIgnored,
  resumeIgnore,
} from "../src/ignore.ts";
import { registerReminderScheduler } from "../src/reminders.ts";
import { handler as cancelReminder } from "../src/tools/cancel_reminder.ts";
import { handler as ignoreBill } from "../src/tools/ignore_bill.ts";
import { handler as ignoreItem } from "../src/tools/ignore_item.ts";
import { handler as listBills } from "../src/tools/list_bills.ts";
import { handler as listReminders } from "../src/tools/list_reminders.ts";

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
  assert.equal(
    getReminders().filter((row) => row.text === "Stretch" && row.status === "pending").length,
    0,
    "a cancellation without ignore provenance is not revived",
  );
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
  transitionReminderStatus(future.id, "pending", "cancelled", "user");
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
  assert.equal(getReminder(future.id)!.status, "cancelled");
  assert.equal(getReminder(future.id)!.status_reason, "user");
}

{
  const refused = ignoreItem(
    { query: "Lifecycle Gas" },
    { iteration: 1, calledTools: [] },
  );
  assert.match(refused, /own chat or voice/i);
}

// Two daily schedules with the same words stay separate series.
{
  const now = new Date("2026-11-16T16:00:00.000Z");
  const morning = createReminder(
    "Take medication",
    "personal",
    "2026-11-13T03:30:00.000Z",
    "daily",
  );
  const evening = createReminder(
    "Take medication",
    "personal",
    "2026-11-13T14:30:00.000Z",
    "daily",
  );
  assert.ok(morning.series_id && evening.series_id);
  assert.notEqual(morning.series_id, evening.series_id);
  const rule = applyIgnore({
    entityType: "reminder",
    matchKey: "take medication",
    matchScope: "record",
    tag: "personal",
    entityId: String(morning.id),
    instruction: "Ignore the morning medication",
    authRef: "owner_chat:test",
  }).rule;
  resumeIgnore(rule.id, "owner_chat:test", "resume morning medication", now);
  const morningRows = getReminders().filter((row) => row.series_id === morning.series_id);
  const eveningRows = getReminders().filter((row) => row.series_id === evening.series_id);
  assert.equal(
    morningRows.filter((row) => row.status === "pending").length,
    1,
  );
  assert.equal(eveningRows.length, 1);
  assert.equal(eveningRows[0]!.id, evening.id);
  assert.equal(eveningRows[0]!.status, "pending");
  assert.equal(eveningRows[0]!.remind_at, evening.remind_at);
  const morningNext = morningRows.find((row) => row.status === "pending")!;
  assert.equal(morningNext.series_id, morning.series_id);
  assert.ok(new Date(morningNext.remind_at).getTime() > now.getTime());
  assert.notEqual(morningNext.remind_at, evening.remind_at);
}

// An explicit cancel survives both resume and expiry.
{
  const now = new Date("2026-11-20T04:00:00.000Z");
  const kept = createReminder("Water the plants", "personal", "2026-11-25T03:30:00.000Z", "daily");
  const rule = applyIgnore({
    entityType: "reminder",
    matchKey: "water the plants",
    matchScope: "record",
    tag: "personal",
    entityId: String(kept.id),
    instruction: "Ignore watering",
    authRef: "owner_chat:test",
  }).rule;
  assert.equal(JSON.parse(cancelReminder({ id: kept.id })).status, "cancelled");
  resumeIgnore(rule.id, "owner_chat:test", "resume watering", now);
  assert.equal(getReminder(kept.id)!.status, "cancelled");
  assert.equal(getReminder(kept.id)!.status_reason, "user");
  assert.equal(
    getReminders().filter((row) => row.series_id === kept.series_id && row.status === "pending").length,
    0,
  );

  const expiring = createReminder(
    "Water the herbs",
    "personal",
    "2026-11-25T03:30:00.000Z",
    "daily",
  );
  applyIgnore({
    entityType: "reminder",
    matchKey: "water the herbs",
    matchScope: "record",
    tag: "personal",
    entityId: String(expiring.id),
    duration: "temporary",
    expiresAt: "2026-11-18T00:00:00.000Z",
    instruction: "Ignore herbs for a few days",
    authRef: "owner_chat:test",
  });
  cancelReminder({ id: expiring.id });
  assert.equal(
    reminderIsIgnored(getReminder(expiring.id)!, new Date("2026-11-19T00:00:00.000Z")),
    false,
  );
  assert.equal(getReminder(expiring.id)!.status, "cancelled");
  assert.equal(getReminder(expiring.id)!.status_reason, "user");
  assert.equal(
    getReminders().some((row) => row.series_id === expiring.series_id && row.status === "pending"),
    false,
  );
}

// A user-cancelled bill slot stays cancelled. Paying the bill blocks a rebuild.
{
  const bill = createBill("Lifecycle Rent", 1000, "INR", "2026-12-10", "life-rent")!;
  billReminders(bill.id, "2026-12-10");
  const slots = getReminders().filter((row) => row.related_bill_id === bill.id);
  const dropped = slots[0]!;
  const rule = applyIgnore({
    entityType: "bill",
    matchKey: "lifecycle rent",
    matchScope: "record",
    tag: "personal",
    entityId: String(bill.id),
    instruction: "Ignore rent",
    authRef: "owner_chat:test",
  }).rule;
  cancelReminder({ id: dropped.id });
  const now = new Date("2026-11-16T12:00:00.000Z");
  resumeIgnore(rule.id, "owner_chat:test", "resume rent", now);
  assert.equal(getReminder(dropped.id)!.status, "cancelled");
  assert.equal(getReminder(dropped.id)!.status_reason, "user");
  const pendingSlots = getReminders().filter(
    (row) => row.related_bill_id === bill.id && row.status === "pending",
  );
  assert.equal(pendingSlots.length, 2);
  assert.ok(pendingSlots.every((row) => row.remind_at !== dropped.remind_at));

  const paid = createBill("Lifecycle Paid", 10, "INR", "2026-12-12", "life-paid")!;
  billReminders(paid.id, "2026-12-12");
  const paidRule = applyIgnore({
    entityType: "bill",
    matchKey: "lifecycle paid",
    matchScope: "record",
    tag: "personal",
    entityId: String(paid.id),
    instruction: "Ignore paid bill",
    authRef: "owner_chat:test",
  }).rule;
  assert.equal(transitionBillStatus(paid.id, "upcoming", "paid"), true);
  cancelPendingRemindersForBill(paid.id);
  resumeIgnore(paidRule.id, "owner_chat:test", "resume paid bill", now);
  assert.ok(
    getReminders()
      .filter((row) => row.related_bill_id === paid.id)
      .every((row) => row.status === "cancelled" && row.status_reason === "completion"),
  );
}

// Completing a task while it is ignored does not bring its reminders back.
{
  const task = createTask("Send the receipt", "personal", "2026-12-01T09:00:00.000Z");
  const reminder = createReminder("Send the receipt", "personal", slot("2026-11-30"), "none", {
    relatedTaskId: task.id,
  });
  const rule = applyIgnore({
    entityType: "task",
    matchKey: "send the receipt",
    matchScope: "record",
    tag: "personal",
    entityId: String(task.id),
    instruction: "Ignore the receipt task",
    authRef: "owner_chat:test",
  }).rule;
  assert.equal(markTaskDone(task.id), true);
  cancelPendingRemindersForTask(task.id);
  resumeIgnore(rule.id, "owner_chat:test", "resume receipt", new Date("2026-11-16T12:00:00.000Z"));
  assert.equal(getReminder(reminder.id)!.status, "cancelled");
  assert.equal(getReminder(reminder.id)!.status_reason, "completion");
}

// A reminder-source rule also settles linked reminders that its text suppressed.
{
  const now = new Date("2026-11-16T16:00:00.000Z");
  const task = createTask("Walk the dog", "personal", null);
  const linked = createReminder(
    "Walk the dog",
    "personal",
    "2026-11-14T03:30:00.000Z",
    "daily",
    { relatedTaskId: task.id },
  );
  const rule = applyIgnore({
    entityType: "reminder",
    matchKey: "walk the dog",
    matchScope: "source",
    tag: "personal",
    instruction: "Ignore walk the dog reminders",
    authRef: "owner_chat:test",
  }).rule;
  assert.equal(reminderIsIgnored(getReminder(linked.id)!, new Date("2026-11-15T04:00:00.000Z")), true);
  resumeIgnore(rule.id, "owner_chat:test", "resume the dog walk", now);
  assert.equal(getReminder(linked.id)!.status, "cancelled");
  assert.equal(getReminder(linked.id)!.status_reason, "ignore");
  const next = getReminders().filter(
    (row) => row.series_id === linked.series_id && row.status === "pending",
  );
  assert.equal(next.length, 1);
  assert.equal(next[0]!.related_task_id, task.id);
  assert.ok(new Date(next[0]!.remind_at).getTime() > now.getTime());

  const bill = createBill("Lifecycle Milk", 60, "INR", "2026-12-05", "life-milk")!;
  const billReminder = createReminder(
    "Milk delivery",
    "personal",
    "2026-11-14T03:30:00.000Z",
    "none",
    { relatedBillId: bill.id },
  );
  const milkRule = applyIgnore({
    entityType: "reminder",
    matchKey: "milk delivery",
    matchScope: "source",
    tag: "personal",
    duration: "temporary",
    expiresAt: "2026-11-16T12:00:00.000Z",
    instruction: "Ignore milk delivery reminders",
    authRef: "owner_chat:test",
  }).rule;
  assert.equal(milkRule.duration, "temporary");
  assert.equal(reminderIsIgnored(getReminder(billReminder.id)!, now), false);
  assert.equal(getReminder(billReminder.id)!.status, "cancelled");
  assert.notEqual(getReminder(billReminder.id)!.status, "pending");
}

// Unknown historical cancellations are not treated as ignore-owned.
{
  const historical = createReminder(
    "Call the clinic",
    "personal",
    "2026-11-13T03:30:00.000Z",
    "daily",
  );
  db.prepare(
    `UPDATE reminders SET status = 'cancelled', status_reason = NULL WHERE id = ?`,
  ).run(historical.id);
  const rule = applyIgnore({
    entityType: "reminder",
    matchKey: "call the clinic",
    matchScope: "record",
    tag: "personal",
    entityId: String(historical.id),
    instruction: "Ignore the clinic call",
    authRef: "owner_chat:test",
  }).rule;
  resumeIgnore(rule.id, "owner_chat:test", "resume clinic", new Date("2026-11-16T16:00:00.000Z"));
  assert.equal(
    getReminders().filter((row) => row.series_id === historical.series_id && row.status === "pending")
      .length,
    0,
  );
}

const cardCtx = {
  answerCallbackQuery: async () => undefined,
  reply: async () => undefined,
  editMessageReplyMarkup: async () => undefined,
} as unknown as Context;

function cardRuleFor(billId: number) {
  const rule = listActiveIgnoreRules().find(
    (row) => row.entity_type === "bill" && row.entity_id === String(billId),
  );
  assert.ok(rule, `card rule for bill ${billId}`);
  return rule!;
}

function remindersOf(billId: number): number {
  return getReminders().filter((row) => row.related_bill_id === billId).length;
}

// Codex 1A. A cycle skip after a card Ignore survives Resume.
{
  const bill = createBill("Skipcheck Fibre", 999, "INR", "2026-12-12", "p2-1a")!;
  await handleBillCallback(cardCtx, "ignore", bill.id);
  const rule = cardRuleFor(bill.id);
  assert.equal(getBill(bill.id)!.status, "upcoming", "card Ignore is registry-only");
  assert.match(
    ignoreBill({ query: "Skipcheck Fibre", skip_cycle: true }, owner("Skip this cycle")),
    /Skipped Skipcheck Fibre for this month/,
  );
  assert.equal(getBill(bill.id)!.status, "ignored");
  assert.equal(getBill(bill.id)!.status_reason, "skip_cycle");
  const before = remindersOf(bill.id);
  resumeIgnore(rule.id, "telegram:resume", "resume fibre", new Date("2026-12-01T00:00:00.000Z"));
  assert.equal(getBill(bill.id)!.status, "ignored", "Resume does not undo the skip");
  assert.equal(getBill(bill.id)!.status_reason, "skip_cycle");
  assert.equal(remindersOf(bill.id), before, "no reminders rebuilt for a skipped cycle");
  const listed = JSON.parse(listBills({ filter: "all" })) as Array<{ id: number; status: string }>;
  assert.equal(listed.find((row) => row.id === bill.id)?.status, "ignored", "reports keep the skip");
  const next = getBills().find(
    (row) => row.biller === "Skipcheck Fibre" && row.due_date === "2027-01-12",
  );
  assert.equal(next?.status, "upcoming", "the next cycle is untouched");
  assert.equal(billIsIgnored(next!), false, "the record rule never covered the next cycle");
}

// Codex 1B. Duplicate removal and payment after a card Ignore survive Resume.
{
  const original = createBill("Dupecheck Cloud", 300, "INR", "2026-12-14", "p2-1b")!;
  const dupe = createBill(
    "Dupecheck Cloud",
    300,
    "INR",
    "2026-12-15",
    "p2-1b-2",
    null,
    original.id,
  )!;
  await handleBillCallback(cardCtx, "ignore", dupe.id);
  const rule = cardRuleFor(dupe.id);
  await handleBillDuplicateCallback(cardCtx, "remove", dupe.id);
  assert.equal(getBill(dupe.id)!.status, "ignored");
  assert.equal(getBill(dupe.id)!.status_reason, "duplicate");
  resumeIgnore(rule.id, "telegram:resume", "resume dupe");
  assert.equal(getBill(dupe.id)!.status, "ignored", "Resume does not undo duplicate removal");
  assert.equal(getBill(dupe.id)!.status_reason, "duplicate");
  assert.equal(getBill(original.id)!.status, "upcoming");

  const paid = createBill("Paidcheck Hosting", 120, "INR", "2026-12-16", "p2-1b-3")!;
  await handleBillCallback(cardCtx, "ignore", paid.id);
  const paidRule = cardRuleFor(paid.id);
  assert.equal(transitionBillStatus(paid.id, "upcoming", "paid"), true);
  assert.equal(getBill(paid.id)!.status_reason, "paid");
  resumeIgnore(paidRule.id, "telegram:resume", "resume paid");
  assert.equal(getBill(paid.id)!.status, "paid", "Resume does not unpay a bill");
}

// Codex 1C. Historical rows: restore only what the old card Ignore provably did.
{
  const legacyIgnore = (billId: number) => {
    // What the old card did after creating its rule: flip the status, no reason column.
    db.prepare(`UPDATE bills SET status = 'ignored', status_reason = NULL WHERE id = ?`).run(
      billId,
    );
  };
  const now = new Date("2026-12-01T00:00:00.000Z");

  // Attributable: card rule is the only record rule; no duplicate flag; no next cycle row.
  const owned = createBill("Legacycard Broadband", 700, "INR", "2026-12-20", "p2-1c-1")!;
  billReminders(owned.id, "2026-12-20");
  await handleBillCallback(cardCtx, "ignore", owned.id);
  legacyIgnore(owned.id);
  db.prepare(
    `UPDATE reminders SET status = 'cancelled', status_reason = NULL WHERE related_bill_id = ?`,
  ).run(owned.id);
  const ownedRule = cardRuleFor(owned.id);

  // Ambiguous: the bill was skipped (next cycle row exists) and its reason was never recorded.
  const skipped = createBill("Legacyskip Mobile", 499, "INR", "2026-11-28", "p2-1c-2")!;
  await handleBillCallback(cardCtx, "ignore", skipped.id);
  ignoreBill({ query: "Legacyskip Mobile", skip_cycle: true }, owner("Skip this cycle"));
  db.prepare(`UPDATE bills SET status_reason = NULL WHERE id = ?`).run(skipped.id);
  const skippedRule = cardRuleFor(skipped.id);

  // Ambiguous: removed as a duplicate, reason never recorded.
  const keep = createBill("Legacydupe Storage", 50, "INR", "2026-12-21", "p2-1c-3")!;
  const removed = createBill(
    "Legacydupe Storage",
    50,
    "INR",
    "2026-12-22",
    "p2-1c-4",
    null,
    keep.id,
  )!;
  await handleBillCallback(cardCtx, "ignore", removed.id);
  legacyIgnore(removed.id);
  const removedRule = cardRuleFor(removed.id);

  // Ambiguous: an earlier record rule on the same bill came first.
  const twice = createBill("Legacytwice Gym", 1500, "INR", "2026-12-23", "p2-1c-5")!;
  const earlier = insertIgnoreRule({
    tag: "personal",
    entityType: "bill",
    entityId: String(twice.id),
    matchKey: "legacytwice gym",
    matchScope: "record",
    duration: "permanent",
    instruction: "Ignore that gym invoice",
    authRef: "owner_chat:test",
  })!;
  db.prepare(`UPDATE ignore_rules SET status = 'resumed' WHERE id = ?`).run(earlier.id);
  await handleBillCallback(cardCtx, "ignore", twice.id);
  legacyIgnore(twice.id);
  const twiceRule = cardRuleFor(twice.id);

  // Ambiguous: ignored with a record rule that the card did not create.
  const chat = createBill("Legacychat Insurance", 2000, "INR", "2026-12-24", "p2-1c-6")!;
  const chatRule = applyIgnore({
    entityType: "bill",
    matchKey: "legacychat insurance",
    matchScope: "record",
    tag: "personal",
    entityId: String(chat.id),
    instruction: "Ignore that insurance invoice",
    authRef: "owner_chat:test",
  }).rule;
  legacyIgnore(chat.id);

  assert.equal(backfillLegacyBillIgnoreProvenance(), 1, "only the provable row is marked");
  assert.equal(backfillLegacyBillIgnoreProvenance(), 0, "backfill is idempotent");
  assert.equal(getBill(owned.id)!.status_reason, "ignore");
  for (const bill of [skipped, removed, twice, chat]) {
    assert.equal(getBill(bill.id)!.status_reason, null, `bill ${bill.id} stays ambiguous`);
  }

  resumeIgnore(ownedRule.id, "telegram:resume", "resume broadband", now);
  assert.equal(getBill(owned.id)!.status, "upcoming", "provable legacy Ignore is undone");
  assert.equal(getBill(owned.id)!.status_reason, null);
  assert.equal(
    getReminders().filter(
      (row) =>
        row.related_bill_id === owned.id &&
        row.status === "pending" &&
        new Date(row.remind_at).getTime() > now.getTime(),
    ).length,
    3,
    "future slots come back once",
  );

  for (const [bill, rule] of [
    [skipped, skippedRule],
    [removed, removedRule],
    [twice, twiceRule],
    [chat, chatRule],
  ] as const) {
    const before = remindersOf(bill.id);
    resumeIgnore(rule.id, "telegram:resume", "resume ambiguous", now);
    assert.equal(getBill(bill.id)!.status, "ignored", `bill ${bill.id} is not restored`);
    assert.equal(remindersOf(bill.id), before);
  }
}

// Codex 2A/2B. A record Ignore follows the series when another rule's Resume advances it.
{
  const DAY = 24 * 60 * 60 * 1000;
  const real = Date.now();
  const firstAt = new Date(real - 3 * DAY - 60 * 60 * 1000);
  const resumeTaskAt = new Date(real - 2 * 60 * 60 * 1000);
  const task = createTask("Water the balcony plants", "personal", null);
  const seed = createReminder(
    "Water the balcony plants",
    "personal",
    firstAt.toISOString(),
    "daily",
    { relatedTaskId: task.id },
  );
  assert.ok(seed.series_id);
  const recordRule = applyIgnore({
    entityType: "reminder",
    matchKey: "water the balcony plants",
    matchScope: "record",
    tag: "personal",
    entityId: String(seed.id),
    instruction: "Ignore the balcony plants reminder",
    authRef: "owner_chat:test",
  }).rule;
  const taskRule = applyIgnore({
    entityType: "task",
    matchKey: "water the balcony plants",
    matchScope: "source",
    tag: "personal",
    entityId: String(task.id),
    instruction: "Ignore the balcony plants task",
    authRef: "owner_chat:test",
  }).rule;
  assert.equal(getReminder(seed.id)!.status, "pending", "stale while both rules are active");

  resumeIgnore(taskRule.id, "owner_chat:test", "resume the task only", resumeTaskAt);
  const afterTask = getReminders().filter((row) => row.series_id === seed.series_id);
  const pending = afterTask.filter((row) => row.status === "pending");
  assert.equal(getReminder(seed.id)!.status, "cancelled");
  assert.equal(getReminder(seed.id)!.status_reason, "ignore");
  assert.equal(pending.length, 1, JSON.stringify(afterTask));
  const next = pending[0]!;
  assert.notEqual(next.id, seed.id, "the next occurrence is a new row");
  assert.equal(next.series_id, seed.series_id);
  assert.ok(new Date(next.remind_at).getTime() > resumeTaskAt.getTime());
  assert.ok(new Date(next.remind_at).getTime() <= real, "and it is already due");
  assert.equal(matchingIgnoreRule(
    { entityType: "reminder", entityId: next.id, matchKey: next.text, tag: next.tag, seriesId: next.series_id },
  )?.id, recordRule.id);
  assert.equal(reminderIsIgnored(next), true, "the remaining record rule still suppresses it");
  assert.equal(
    getDueReminders(new Date().toISOString())
      .filter((row) => !reminderIsIgnored(row))
      .some((row) => row.series_id === seed.series_id),
    false,
  );

  const sent: string[] = [];
  const api = {
    sendMessage: async (_chat: number, text: string) => {
      sent.push(text);
      return {};
    },
  } as unknown as Api;
  const interval = await registerReminderScheduler(api);
  clearInterval(interval);
  assert.equal(
    sent.filter((text) => text.includes("Water the balcony plants")).length,
    0,
    "no notification while the record rule is active",
  );
  assert.equal(getReminder(next.id)!.status, "pending");

  // 2B. Resume the record rule: exactly one valid future occurrence, deliverable.
  const resumeRecordAt = new Date();
  resumeIgnore(recordRule.id, "owner_chat:test", "resume the reminder", resumeRecordAt);
  const series = getReminders().filter((row) => row.series_id === seed.series_id);
  const live = series.filter((row) => row.status === "pending");
  assert.equal(live.length, 1, JSON.stringify(series));
  assert.ok(new Date(live[0]!.remind_at).getTime() > resumeRecordAt.getTime());
  assert.equal(getReminder(next.id)!.status, "cancelled", "the missed occurrence does not burst");
  assert.ok(series.every((row) => row.status !== "sent"));
  assert.equal(reminderIsIgnored(live[0]!), false, "normal delivery eligibility is back");
  const dueAt = new Date(new Date(live[0]!.remind_at).getTime() + 1000).toISOString();
  assert.equal(
    getDueReminders(dueAt).filter(
      (row) => row.series_id === seed.series_id && !reminderIsIgnored(row),
    ).length,
    1,
  );
}

// Codex 2C. Same text, different series: a record Ignore covers only its own series.
{
  const now = new Date("2026-11-16T16:00:00.000Z");
  const a = createReminder("Check the inverter", "personal", "2026-11-17T03:30:00.000Z", "daily");
  const b = createReminder("Check the inverter", "personal", "2026-11-17T14:30:00.000Z", "daily");
  assert.notEqual(a.series_id, b.series_id);
  const rule = applyIgnore({
    entityType: "reminder",
    matchKey: "check the inverter",
    matchScope: "record",
    tag: "personal",
    entityId: String(a.id),
    instruction: "Ignore the morning inverter check",
    authRef: "owner_chat:test",
  }).rule;
  assert.equal(reminderIsIgnored(a, now), true);
  assert.equal(reminderIsIgnored(b, now), false);
  // Each series moves on the way deliverReminder moves it: sent, then a new row.
  const advance = (row: typeof a, at: string) => {
    assert.equal(transitionReminderStatus(row.id, "pending", "sent"), true);
    return createReminder(row.text, row.tag, at, row.recurrence, { seriesId: row.series_id });
  };
  const aNext = advance(a, "2026-11-18T03:30:00.000Z");
  const bNext = advance(b, "2026-11-18T14:30:00.000Z");
  assert.notEqual(aNext.id, a.id);
  assert.equal(reminderIsIgnored(aNext, now), true, "the rule follows series A");
  assert.equal(reminderIsIgnored(bNext, now), false, "series B is untouched");
  const again = applyIgnore({
    entityType: "reminder",
    matchKey: "check the inverter",
    matchScope: "record",
    tag: "personal",
    entityId: String(aNext.id),
    instruction: "Ignore the inverter check",
    authRef: "owner_chat:test",
  });
  assert.equal(again.kind, "duplicate", "a later occurrence of series A is the same rule");
  assert.equal(again.rule.id, rule.id);
  const bRows = () =>
    getReminders()
      .filter((row) => row.series_id === b.series_id)
      .map((row) => `${row.id}:${row.status}:${row.remind_at}`);
  const bBefore = bRows();
  resumeIgnore(rule.id, "owner_chat:test", "resume morning", now);
  assert.deepEqual(bRows(), bBefore, "resuming A does not touch B's rows");
  assert.equal(getReminder(aNext.id)!.status, "pending");
  assert.equal(reminderIsIgnored(aNext, now), false);
}

// Codex 2D. A one-time reminder record Ignore stays on that exact id.
{
  const now = new Date("2026-11-16T16:00:00.000Z");
  const first = createReminder("Collect the courier", "personal", "2026-11-20T05:00:00.000Z", "none");
  const second = createReminder("Collect the courier", "personal", "2026-11-21T05:00:00.000Z", "none");
  assert.equal(first.series_id, null);
  assert.equal(second.series_id, null);
  applyIgnore({
    entityType: "reminder",
    matchKey: "collect the courier",
    matchScope: "record",
    tag: "personal",
    entityId: String(first.id),
    instruction: "Ignore the courier reminder",
    authRef: "owner_chat:test",
  });
  assert.equal(reminderIsIgnored(first, now), true);
  assert.equal(reminderIsIgnored(second, now), false, "exact id, not text");
}

// Codex 3. list_reminders expires rules before it reads rows, not halfway through.
{
  const DAY = 24 * 60 * 60 * 1000;
  const real = Date.now();
  const seed = createReminder(
    "Feed the fish",
    "personal",
    new Date(real - 3 * DAY - 60 * 60 * 1000).toISOString(),
    "daily",
  );
  const rule = applyIgnore({
    entityType: "reminder",
    matchKey: "feed the fish",
    matchScope: "record",
    tag: "personal",
    entityId: String(seed.id),
    duration: "temporary",
    expiresAt: new Date(real - 60 * 1000).toISOString(),
    instruction: "Ignore feeding the fish for a bit",
    authRef: "owner_chat:test",
  }).rule;
  // Expired by the clock, not yet processed: no scheduler tick has run since.
  assert.equal(rule.status, "active");
  const listed = listReminders({ status: "pending" })
    .split("\n")
    .filter((line) => line.includes("Feed the fish"));
  assert.equal(getReminder(seed.id)!.status, "cancelled", "the missed occurrence was settled");
  const live = getReminders().filter(
    (row) => row.series_id === seed.series_id && row.status === "pending",
  );
  assert.equal(live.length, 1);
  assert.deepEqual(
    listed.map((line) => /^#(\d+) \[pending\]/.exec(line)?.[1]),
    [String(live[0]!.id)],
    `list shows the new occurrence, not the cancelled one: ${JSON.stringify(listed)}`,
  );
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
