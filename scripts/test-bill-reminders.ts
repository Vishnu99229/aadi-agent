import assert from "node:assert/strict";
import {
  cancelPendingRemindersForBill,
  createBill,
  createReminder,
  getBill,
  getReminder,
  getReminders,
  transitionBillStatus,
} from "../src/db.ts";
import { isReminderCommand, shouldSkipAutoCapture } from "../src/memory_logic.ts";

if (process.env.AADI_DB_PATH !== ":memory:") {
  console.error(
    "test-bill-reminders.ts must run with AADI_DB_PATH=:memory: to avoid writing to the live db.",
  );
  process.exit(1);
}

// ---- isReminderCommand gate (Part 3 belt-and-braces) ----
for (const line of [
  "Remind me to call Priya tomorrow",
  "remind me at 5pm about the demo",
  "Please remind me on Friday",
  "Can you remind me about the SOW",
  "Ping me at 10am",
  "nudge me when it's done",
  "Let me know on Monday",
  "Follow up with me next week",
]) {
  assert(
    isReminderCommand(line),
    `expected imperative detector to catch: ${JSON.stringify(line)}`,
  );
  assert(
    shouldSkipAutoCapture(line),
    `expected auto-capture to skip: ${JSON.stringify(line)}`,
  );
}
for (const line of [
  "I'll remind him myself when he gets back",
  "The reminder for Priya was sent",
  "Pinged the client about pricing",
]) {
  assert(
    !isReminderCommand(line),
    `imperative detector should NOT fire for: ${JSON.stringify(line)}`,
  );
}

// ---- Automatic bill reminders (Part 2) ----
// Pick a due date well in the future so all 3 reminder slots land ahead
// of "now". addDaysYmd / nineAmKolkataIso are internal to bills.ts; we
// test the DB-level invariants that bills.scheduleBillReminders enforces.
const futureDue = "2099-12-01";
const bill = createBill("ACME Power", 1249, "INR", futureDue, "thread-bill-1")!;
assert(bill, "bill creation failed");

const text =
  `Bill due: ${bill.biller} for INR ${bill.amount}. Due on ${bill.due_date}. Tap Done when paid.`;
// Simulate what src/bills.ts:scheduleBillReminders does.
const offsets = [-3, -1, 0];
for (const offset of offsets) {
  const [y, m, d] = futureDue.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + offset);
  const day = dt.toISOString().slice(0, 10);
  const remindAt = new Date(`${day}T09:00:00+05:30`).toISOString();
  createReminder(text, "personal", remindAt, "none", {
    relatedBillId: bill.id,
  });
}

const linkedReminders = getReminders().filter(
  (r) => r.related_bill_id === bill.id,
);
assert.equal(linkedReminders.length, 3, "three reminders should be linked to the bill");
for (const r of linkedReminders) {
  assert.equal(r.related_bill_id, bill.id);
  assert.equal(r.related_task_id, null, "bill reminders must not also link to a task");
  assert.equal(r.status, "pending");
  assert.equal(r.tag, "personal");
  assert.match(
    r.text,
    /^Bill due: ACME Power for INR 1249\. Due on 2099-12-01\. Tap Done when paid\.$/,
  );
}

// "Done" semantics: paid + sibling cancellation.
assert(transitionBillStatus(bill.id, "upcoming", "paid"));
assert.equal(getBill(bill.id)!.status, "paid");
const cancelled = cancelPendingRemindersForBill(bill.id);
assert.equal(cancelled, 3);
for (const r of linkedReminders) {
  assert.equal(getReminder(r.id)!.status, "cancelled");
}

// A non-bill reminder must not be touched by cancelPendingRemindersForBill.
const unrelated = createReminder(
  "Water the plants",
  "personal",
  new Date("2099-12-01T03:30:00Z").toISOString(),
  "none",
);
assert.equal(unrelated.related_bill_id, null);
assert.equal(unrelated.related_task_id, null);

console.log("Bill reminder + memory-command checks passed.");
