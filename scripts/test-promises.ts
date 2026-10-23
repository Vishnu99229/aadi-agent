import "dotenv/config";
import assert from "node:assert/strict";
import {
  cancelPendingRemindersForTask,
  createPromiseTask,
  createReminder,
  getPromiseByMessageId,
  getReminder,
  getTask,
  markTaskDone,
} from "../src/db.ts";
import {
  PROMISE_PATTERNS,
  containsPromiseKeyword,
  parseExtraction,
} from "../src/promises.ts";

if (process.env.AADI_DB_PATH !== ":memory:") {
  console.error(
    "test-promises.ts must run with AADI_DB_PATH=:memory: to avoid writing to the live db.",
  );
  process.exit(1);
}

// ---- keyword gatekeeper ----
const positives: string[] = [
  "I'll send the pricing deck tomorrow.",
  "I will share the API credentials by Friday.",
  "Let me revert on the SOW by Monday.",
  "Will do, circling back next week.",
  "I'm on it — getting back to you shortly.",
  "Will send over the MSA by EOD.",
  "I'll share the deck by EOW.",
  "Let me check with the team and get back to you.",
  "Next steps: I will send the proposal tomorrow.",
  "Will follow up with you by 25th Nov.",
  "Will do.",
];
for (const line of positives) {
  assert(
    containsPromiseKeyword(line),
    `expected keyword hit for: ${JSON.stringify(line)}`,
  );
}

// Negative cases for the ALGORITHMIC gatekeeper only. Anything with a
// deadline anchor like "by Friday" is intentionally let through so the
// LLM can distinguish "I will send by Friday" from "please send by Friday".
const negatives: string[] = [
  "Thanks for the note, received the deck.",
  "Noted, appreciate the update.",
  "Looking forward to seeing you.",
  "Attached is the signed NDA for your records.",
  "The quarterly numbers were strong.",
];
for (const line of negatives) {
  assert(
    !containsPromiseKeyword(line),
    `expected no keyword hit for: ${JSON.stringify(line)}`,
  );
}
assert(PROMISE_PATTERNS.length > 15, "keyword list should not shrink silently");

// ---- extraction parser ----
const good = parseExtraction(
  '{"has_promise": true, "promise": "Send the pricing deck", "deadline": "2026-10-24", "confidence": "high"}',
);
assert.equal(good.has_promise, true);
assert.equal(good.promise, "Send the pricing deck");
assert.equal(good.deadline, "2026-10-24");
assert.equal(good.confidence, "high");

const malformed = parseExtraction(
  'Here you go: {"has_promise": false, "promise": "", "deadline": "not-a-date", "confidence": "medium"} trailing',
);
assert.equal(malformed.has_promise, false);
assert.equal(malformed.deadline, null, "non-ISO date should fall back to null");

assert.throws(() => parseExtraction("no json here"), /did not return a JSON/);
assert.throws(
  () =>
    parseExtraction(
      '{"has_promise": "yes", "promise": "x", "confidence": "high"}',
    ),
  /invalid fields/,
);

// ---- promise task creation + dedup ----
const task = createPromiseTask({
  promise: "Send the pricing deck",
  recipient: "Priya <priya@acme.co>",
  threadId: "thread-abc",
  messageId: "msg-123",
  deadline: "2099-12-01",
  dueAt: new Date("2099-12-01T03:30:00Z").toISOString(),
});
assert(task, "promise task should be created");
assert.equal(task!.text, "Promise: Send the pricing deck");
assert.equal(task!.kind, "promise");
assert.equal(task!.tag, "work");
assert.equal(task!.status, "open");
assert.equal(task!.deadline, "2099-12-01");
assert.equal(task!.source_message_id, "msg-123");
assert.equal(task!.recipient, "Priya <priya@acme.co>");

// Second insert on the same message_id should dedup (OR IGNORE).
const dup = createPromiseTask({
  promise: "Send the pricing deck",
  recipient: "Priya <priya@acme.co>",
  threadId: "thread-abc",
  messageId: "msg-123",
  deadline: "2099-12-01",
  dueAt: new Date("2099-12-01T03:30:00Z").toISOString(),
});
assert.equal(dup, undefined, "dup insert on same source_message_id must no-op");

const found = getPromiseByMessageId("msg-123");
assert(found && found.id === task!.id, "lookup by message id should work");

// ---- reminder <-> task linking ----
const r1 = createReminder(
  "You promised to Send the pricing deck to Priya by 2099-12-01. Have you done it yet?",
  "work",
  new Date("2099-11-30T03:30:00Z").toISOString(),
  "none",
  task!.id,
);
const r2 = createReminder(
  "You promised to Send the pricing deck to Priya by 2099-12-01. Have you done it yet?",
  "work",
  new Date("2099-12-01T03:30:00Z").toISOString(),
  "none",
  task!.id,
);
assert.equal(r1.related_task_id, task!.id);
assert.equal(r2.related_task_id, task!.id);

// Marking the task done should let the sibling-cancel helper close both.
assert(markTaskDone(task!.id));
assert.equal(getTask(task!.id)!.status, "done");
const cancelled = cancelPendingRemindersForTask(task!.id);
assert.equal(cancelled, 2, "both pending reminders should be cancelled");
assert.equal(getReminder(r1.id)!.status, "cancelled");
assert.equal(getReminder(r2.id)!.status, "cancelled");

// Non-promise reminders still default related_task_id to null.
const plain = createReminder(
  "Water the plants",
  "personal",
  new Date("2099-12-01T03:30:00Z").toISOString(),
  "none",
);
assert.equal(plain.related_task_id, null);

console.log("Promise tracker checks passed.");
