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
import {
  extractDeadline,
  parseNaturalDate,
} from "../src/promise_dates.ts";

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

// ---- extraction parser (LLM no longer outputs a deadline) ----
const good = parseExtraction(
  '{"has_promise": true, "promise": "Send the pricing deck", "confidence": "high"}',
);
assert.equal(good.has_promise, true);
assert.equal(good.promise, "Send the pricing deck");
assert.equal(good.confidence, "high");

// Date fields in the LLM response (if the model ignores the instruction)
// must be silently ignored - the schema has no deadline field any more.
const extraneous = parseExtraction(
  '{"has_promise": false, "promise": "", "deadline": "2026-10-24", "confidence": "medium"}',
);
assert.equal(extraneous.has_promise, false);
assert.equal(
  (extraneous as unknown as Record<string, unknown>).deadline,
  undefined,
  "parser must not pass through a deadline field",
);

assert.throws(() => parseExtraction("no json here"), /did not return a JSON/);
assert.throws(
  () =>
    parseExtraction(
      '{"has_promise": "yes", "promise": "x", "confidence": "high"}',
    ),
  /invalid fields/,
);

// ---- parseNaturalDate wrapper ----
const monday = new Date("2026-10-19T10:00:00+05:30"); // Mon 19 Oct 2026, Asia/Kolkata
assert.equal(
  parseNaturalDate("Catch up Friday morning", monday),
  "2026-10-23",
  "Friday after Monday 19 Oct 2026 should be 23 Oct",
);
assert.equal(
  parseNaturalDate("Let's talk tomorrow", monday),
  "2026-10-20",
);
assert.equal(
  parseNaturalDate("Meeting on 25 Nov", monday),
  "2026-11-25",
  "future-of-same-year date resolves as-is",
);
// Past date with no explicit year must shift to next year.
const dec = new Date("2026-12-05T10:00:00+05:30");
assert.equal(
  parseNaturalDate("Meeting on 10 Jan", dec),
  "2027-01-10",
  "no-year past date rolls to next year",
);
// Explicit past year must NOT be rolled forward.
assert.equal(
  parseNaturalDate("The receipt is dated 25 Nov 2024", monday),
  null,
  "explicit past year stays rejected (year pinned by writer)",
);
assert.equal(
  parseNaturalDate("No dates here, just a chat.", monday),
  null,
);

// ---- extractDeadline (explicit anchors + chrono fallback) ----
const sentMon = "2026-10-19T10:00:00+05:30";
assert.equal(
  extractDeadline("I'll send it by Friday.", sentMon),
  "2026-10-23",
  "chrono resolves 'Friday' against sent date",
);
assert.equal(
  extractDeadline("Will revert by EOD today.", sentMon),
  "2026-10-19",
  "EOD = same day as sent",
);
assert.equal(
  extractDeadline("Share by EOW.", sentMon),
  "2026-10-23",
  "EOW = the coming Friday",
);
assert.equal(
  extractDeadline("Let's catch up next week.", sentMon),
  "2026-10-26",
  "'next week' with no day = next Monday",
);
assert.equal(
  extractDeadline("No dates in here, friend.", sentMon),
  null,
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
