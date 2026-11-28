import assert from "node:assert/strict";
import { newRunReport, runAgent, setToolInterceptorForTests } from "../src/agent.ts";
import { toolOwnership } from "../src/agents/registry.ts";
import { createScheduledSend, db, recordScheduledSendSent, saveMessage } from "../src/db.ts";
import { setCompleteForTests, type CompleteParams } from "../src/llm.ts";
import { newTurnMeter, recordTurn } from "../src/metrics.ts";
import { askedOnlyToLook, receiptRetryPrompt, unreceiptedClaims } from "../src/receipt.ts";
import { recordedReceipt } from "../src/receipt_records.ts";
import { modelReply } from "./fakes.ts";

assert.equal(process.env.AADI_DB_PATH, ":memory:");
assert.equal(process.env.DOTENV_CONFIG_PATH, "scripts/fixtures/test.env");

const READ_RETRY = "Don't take any new action. Check the record with a read tool, then say what actually happened and when, or say you aren't sure.";
const ADDRESS = "mukesh@example.test";
const QUESTION = "thanks how many follow up does this email thread has?";
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

type Step = Parameters<typeof modelReply>[0];
async function replay(ownerText: string, steps: Step[], options: { confirmation?: boolean } = {}) {
  const calls: CompleteParams[] = [];
  const ran: string[] = [];
  const report = newRunReport();
  setToolInterceptorForTests((call) => {
    ran.push(call.name);
    if (call.name === "search_emails") return JSON.stringify([{ id: "sent43", to: ADDRESS, account: "work" }]);
    if (call.name === "start_sequence") return "Sequence offer posted.";
    return "Sent.";
  });
  setCompleteForTests(async (params) => {
    calls.push({ ...params, messages: [...params.messages], tools: [...params.tools] });
    assert(steps.length > 0, "unexpected additional model call");
    return modelReply(steps.shift()!);
  });
  const reply = await runAgent(ownerText, {
    backend: "claude", report, guardText: ownerText,
    saveUserMessage: false, saveAssistantMessage: false,
    metaTools: [{
      definition: { type: "function", name: "delegate_tasks", description: "Test delegation", inputSchema: { type: "object" } },
      handler: () => {
        ran.push("delegate_tasks");
        return { content: "Delegated." };
      },
    }],
    ...(options.confirmation === false ? {} : { sendConfirmation: { chatId: 1, messageId: 1953 } }),
  });
  return { reply, calls, ran, report };
}

async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  reset();
  try { await run(); count++; originalLog(`PASS ${name}`); }
  catch (error) { failures.push(name); originalLog(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`); }
  finally { setCompleteForTests(undefined); setToolInterceptorForTests(undefined); }
}

await test("state questions containing action words are lookups", () => {
  for (const text of [QUESTION, "how many follow ups are there", "Any email sent", "Did you send it", "Has the email been sent", "Is the follow up sent", "What happened to the send", "The email was sent?"]) {
    assert(askedOnlyToLook(text, "sent"), text);
  }
  assert(!askedOnlyToLook("Did Hardik reply? If not, send him a nudge", "sent"));
});

await test("retry instructions follow current command intent", () => {
  assert.equal(receiptRetryPrompt(["sent"], QUESTION), READ_RETRY);
  assert.equal(receiptRetryPrompt(["sent"], "Start a sequence for Mukesh"), READ_RETRY);
  assert.equal(receiptRetryPrompt(["sent"], "Draft an email to Mukesh"), READ_RETRY);
  assert.equal(receiptRetryPrompt(["sent", "deleted"], "Send Mukesh an email"), READ_RETRY);
  assert.equal(receiptRetryPrompt(["deleted"], "Book a meeting to delete an event"), READ_RETRY);
  assert.equal(receiptRetryPrompt(["sent"], `Can you check whether to send the email to ${ADDRESS}?`), READ_RETRY);
});

await test("incident question accepts the earlier send without touching pending draft 42", async () => {
  incident();
  const result = await replay(QUESTION, [
    { tools: [{ name: "search_emails", input: { query: `to:${ADDRESS}` } }] },
    { text: `I sent the email to ${ADDRESS} earlier. There are no follow-ups.` },
  ]);
  assert.deepEqual(result.ran, ["search_emails"]);
  assert.equal(result.calls.length, 2);
  assert.doesNotMatch(result.reply, /didn't happen|couldn't do that/);
  assert.equal((db.prepare("SELECT status FROM pending_actions WHERE id=42").get() as {status:string}).status, "pending");
});

await test("sequence instruction can mention a receipted earlier send", async () => {
  incident();
  const result = await replay(`Start a sequence for ${ADDRESS}`, [
    { tools: [{ name: "start_sequence", input: { prospect: ADDRESS } }] },
    { text: `I sent the email to ${ADDRESS} earlier (sent43). Sequence offer posted.` },
  ]);
  assert.deepEqual(result.ran, ["start_sequence"]);
  assert.equal(result.calls.length, 2);
});

await test("unknown historical claim restricts offered and executed tools including delegation", async () => {
  const result = await replay(`What happened to the email to ${ADDRESS}?`, [
    { text: `I sent the email to ${ADDRESS}.` },
    { tools: ["confirm_send_pending_draft", "draft_new_email", "book_meeting", "delete_task", "start_sequence", "delegate_tasks"].map(name => ({ name, input: { draft_id: "draft42" } })) },
    { tools: [{ name: "search_notes", input: { query: "send record" } }] },
    { text: "I am not sure whether it was sent." },
  ]);
  assert.deepEqual(result.ran, ["search_notes"]);
  for (const call of result.calls.slice(1)) {
    assert(call.tools.length > 0);
    assert(call.tools.every(tool => tool.type === "function" && toolOwnership(tool.name)?.effect === "read"));
  }
  assert.match(result.reply, /not sure/);
  const metric = recordTurn({ chatId: 1, route: "test", path: "aadi", agentId: "aadi", report: result.report, meter: newTurnMeter(), success: true });
  const row = db.prepare("SELECT receipt_retries_json FROM metric_turns WHERE id=?").get(metric) as { receipt_retries_json: string };
  assert.deepEqual(JSON.parse(row.receipt_retries_json), [{ actions: ["sent"], lookup: true, toolsRestricted: true }]);
});

await test("retry denial is replaced by the completed record", async () => {
  incident();
  const result = await replay(QUESTION, [
    { text: `I sent the email to ${ADDRESS} (sent43). I deleted the draft.` },
    { text: "It didn't happen. No send tool confirmed anything. Say send it." },
  ]);
  assert(result.reply.startsWith(`Sent to ${ADDRESS} at `));
  assert.match(result.reply, /00:15:29/);
  assert.doesNotMatch(result.reply, /didn't happen|Say send it/);
  assert.deepEqual(result.ran, []);
});

await test("an unrelated sent recipient cannot ground a false claim", async () => {
  incident();
  const result = await replay("What happened to the email to other@example.com?", [
    { text: "I sent the email to other@example.com." }, { text: "I am not sure whether it went out." },
  ]);
  assert.equal(result.calls.length, 2);
  assert.equal(result.calls[1]!.messages.at(-1)?.role, "user");
  assert.match(result.reply, /not sure/);
});

await test("card, draft, thread and Gmail IDs distinguish sent and pending mail", () => {
  incident();
  for (const subject of ["card #1949", "draft #43", "draft43", "thread43", "sent43"]) {
    const record = recordedReceipt({ ownerText: `Was ${subject} sent?`, reply: "I sent it.", turnStartedAt: Date.now() });
    assert.deepEqual(record?.actions, ["sent"], subject);
  }
  assert.equal(recordedReceipt({ ownerText: "Was card #1946 sent?", reply: `I sent the email to ${ADDRESS}.`, turnStartedAt: Date.now() }), undefined);
  assert.equal(recordedReceipt({ ownerText: `Was the invoice email to ${ADDRESS} sent?`, reply: "It didn't happen.", turnStartedAt: Date.now() }), undefined);
});

await test("a schedule becomes a delivery receipt only after it is marked sent", () => {
  const schedule = createScheduledSend({
    key: "msg:1:8:other@example.com:future", sendAt: "2030-01-01T09:00:00Z", itemText: "Email",
    tag: "work", request: JSON.stringify({ account: "work", draftId: "schedule-draft", to: [{ mailbox: { email: "other@example.com" } }] }),
    confirmChat: 1, confirmMessage: 8,
  })!;
  const context = { ownerText: "What happened to schedule-draft?", turnStartedAt: Date.now() };
  assert.deepEqual(recordedReceipt({ ...context, reply: "I scheduled it." })?.actions, ["scheduled"]);
  assert.equal(recordedReceipt({ ...context, reply: "I sent it." }), undefined);
  assert.deepEqual(unreceiptedClaims("Sent.", [{ name: "send_email", success: true, content: "Scheduled: Tomorrow" }]), ["sent"]);
  assert.deepEqual(unreceiptedClaims("Sent.", [{ name: "draft_reply", success: true, content: "Draft ready for approval." }]), ["sent"]);
  recordScheduledSendSent(schedule.id, "delivered-schedule");
  assert.deepEqual(recordedReceipt({ ...context, turnStartedAt: Date.now(), reply: "I sent it." })?.actions, ["sent"]);
});

console.log = originalLog;
originalLog(`Receipt checks: ${count} passed, ${failures.length} failed.`);
if (failures.length) process.exitCode = 1;
