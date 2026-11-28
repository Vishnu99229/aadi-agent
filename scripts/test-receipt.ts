/**
 * Delivery grounding from records: the data the reply checker is given. What a
 * reply's words claim is the checker's call (test-reply-checker.ts), never a
 * pattern here.
 */
import assert from "node:assert/strict";
import { setToolInterceptorForTests } from "../src/agent.ts";
import { createScheduledSend, db, recordScheduledSendSent, saveMessage } from "../src/db.ts";
import { setCompleteForTests } from "../src/llm.ts";
import { isDeliveryTool, isSuccessfulToolResult } from "../src/receipt.ts";
import { confirmedSentReads, deliveryReadsFromTool, recordedReceipt } from "../src/receipt_records.ts";

assert.equal(process.env.AADI_DB_PATH, ":memory:");
assert.equal(process.env.DOTENV_CONFIG_PATH, "scripts/fixtures/test.env");

const ADDRESS = "alice@example.test";
const SENT = "2026-11-25 18:45:29";
const originalLog = console.log;
console.log = () => undefined;
const failures: string[] = [];
let count = 0;

function reset(): void {
  db.exec("DELETE FROM messages; DELETE FROM pending_actions; DELETE FROM command_sends; DELETE FROM scheduled_sends;");
}

function incident(): void {
  db.prepare(`INSERT INTO pending_actions
    (id,type,draft_id,status,to_header,cc_header,telegram_message_id,command_key,google_account,sent_message_id,created_at,updated_at)
    VALUES (42,'send_draft','draft42','pending',?,'',1946,?,'work',NULL,?,?),
           (43,'send_draft','draft43','sent',?,'ashwini@example.test',1949,?,'work','sent43',?,?)`)
    .run(ADDRESS, `msg:1:1945:${ADDRESS}`, SENT, SENT, ADDRESS, `msg:1:1948:${ADDRESS}`, SENT, SENT);
  db.prepare(`INSERT INTO command_sends (idem_key,status,account,thread_id,sent_message_id,created_at,sent_at)
    VALUES (?,'sent','work','thread43','sent43',?,?)`).run(`msg:1:1948:${ADDRESS}`, SENT, SENT);
  saveMessage("assistant", `Sent to ${ADDRESS} with Ashwini in Cc.`);
}

async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  reset();
  try { await run(); count++; originalLog(`PASS ${name}`); }
  catch (error) { failures.push(name); originalLog(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`); }
  finally { setCompleteForTests(undefined); setToolInterceptorForTests(undefined); }
}

await test("delivery receipts require an exact sent message in its mailbox", () => {
  incident();
  const check = (content: object) => recordedReceipt({
    outcomeIds: [],
    reads: deliveryReadsFromTool("search_emails", JSON.stringify([content])),
    deliveryAttempted: false, writeFailed: false,
  });
  assert.equal(check({ account: "work", id: "sent43" }), true);
  assert.equal(check({ account: "personal", id: "sent43" }), false);
  assert.equal(check({ account: "work", id: "draft42", threadId: "thread43" }), false);
  assert.equal(check({ account: "work", id: "gmail-only", sent: true }), true);
});

await test("a schedule provides current delivery evidence only after it is marked sent", () => {
  const schedule = createScheduledSend({
    key: "msg:1:8:other@example.com:future", sendAt: "2030-01-01T09:00:00Z", itemText: "Email",
    tag: "work", request: JSON.stringify({ account: "work", draftId: "schedule-draft", to: [{ mailbox: { email: "other@example.com" } }] }),
    confirmChat: 1, confirmMessage: 8,
  })!;
  const context = { outcomeIds: ["send:work:delivered-schedule"], reads: [], deliveryAttempted: true, writeFailed: false };
  assert.equal(recordedReceipt(context), false);
  recordScheduledSendSent(schedule.id, "delivered-schedule");
  assert.equal(recordedReceipt(context), true);
});

await test("a lookup's sent messages reach the checker only when the records confirm them", () => {
  incident();
  const reads = deliveryReadsFromTool("search_emails", JSON.stringify([
    { account: "work", id: "sent43" },
    { account: "work", id: "sent43" },
    { account: "work", id: "draft42" },
    { account: "personal", id: "gmail-sent", sent: true },
  ]));
  assert.deepEqual(confirmedSentReads(reads), [{ account: "work", id: "sent43" }, { account: "personal", id: "gmail-sent" }]);
  assert.deepEqual(deliveryReadsFromTool("search_emails", "Found 2 emails: Alice wrote ..."), [], "prose carries no record");
});

await test("tool results and delivery tools are read from records, not wording", () => {
  assert.equal(isSuccessfulToolResult("Not sent: missing draft_id."), false);
  assert.equal(isSuccessfulToolResult("Sent to alice@example.test."), true);
  assert.equal(isSuccessfulToolResult("Sent.", true), false);
  assert.equal(isDeliveryTool("send_email") && isDeliveryTool("confirm_send_pending_draft"), true);
  assert.equal(isDeliveryTool("search_emails"), false);
});

console.log = originalLog;
originalLog(`Receipt checks: ${count} passed, ${failures.length} failed.`);
if (failures.length) process.exitCode = 1;
