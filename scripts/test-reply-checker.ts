/**
 * The reply checker and the raw-data guard. The chat model, the checker model,
 * Gmail lookups and Telegram are all scripted; nothing reaches a provider.
 *
 * What happened is read from records only. Whether the reply is true to them is
 * the checker's verdict, never a pattern over the words.
 */
import assert from "node:assert/strict";
import { Api } from "grammy";
import { newRunReport, runAgent, setToolInterceptorForTests } from "../src/agent.ts";
import { summaryForOwner } from "../src/agents/orchestrator.ts";
import { getAgent } from "../src/agents/registry.ts";
import { toolOwnership } from "../src/agents/registry.ts";
import { config } from "../src/config.ts";
import { db, recordImmediateDraftSend, saveMessage } from "../src/db.ts";
import { recordEmailOutcome } from "../src/email_outcomes.ts";
import { LlmChainError, setCompleteForTests, type CompleteParams } from "../src/llm.ts";
import { newTurnMeter, recordTurn } from "../src/metrics.ts";
import { FORMAT_PROBLEM_TEXT, isRawPayload, RawTextBlockedError } from "../src/raw_text_guard.ts";
import {
  CHECKER_TIMEOUT_MS,
  NOT_CHECKED_LABEL,
  NOTHING_CHANGED_TEXT,
  UNCONFIRMED_TEXT,
  parseVerdict,
  setReplyCheckerForTests,
  type CheckInput,
} from "../src/reply_checker.ts";
import { installOutgoingTextGuard } from "../src/telegram_io.ts";
import { formatTurnFailure, settleChatWork } from "../src/turns.ts";
import { modelReply } from "./fakes.ts";

assert.equal(process.env.AADI_DB_PATH, ":memory:");

const ADDRESS = "alice@example.test";
const SENT = "2026-11-25 18:45:29";
const originalLog = console.log;
console.log = () => undefined;
console.warn = () => undefined;
const failures: string[] = [];
let count = 0;

function reset(): void {
  db.exec("DELETE FROM messages; DELETE FROM pending_actions; DELETE FROM command_sends; DELETE FROM scheduled_sends;");
}

/** An earlier, recorded send to Alice (message sent43). */
function earlierSendToAlice(): void {
  db.prepare(`INSERT INTO pending_actions
    (id,type,draft_id,status,to_header,cc_header,telegram_message_id,command_key,google_account,sent_message_id,created_at,updated_at)
    VALUES (43,'send_draft','draft43','sent',?,'',1949,?,'work','sent43',?,?)`)
    .run(ADDRESS, `msg:1:1948:${ADDRESS}`, SENT, SENT);
  db.prepare(`INSERT INTO command_sends (idem_key,status,account,thread_id,sent_message_id,created_at,sent_at)
    VALUES (?,'sent','work','thread43','sent43',?,?)`).run(`msg:1:1948:${ADDRESS}`, SENT, SENT);
  saveMessage("assistant", `Sent to ${ADDRESS}.`);
}

type Step = Parameters<typeof modelReply>[0];
/** A checker model answer: JSON text, or "throw" for a provider failure. */
type CheckerStep = string | "throw" | ((payload: CheckerPayload) => string);
interface CheckerPayload {
  owner_message: string;
  reply: string;
  records: {
    tools: Array<{ name: string; effect: string; status: string; records?: string[]; note?: string }>;
    recorded_outcomes: Array<{ id: string; line: string }>;
    delivery_grounded: boolean;
    sends_found_by_lookup: Array<{ account: string; id: string }>;
    available_lookups: string[];
  };
}

const verdict = (value: string, issues: string[] = []) => JSON.stringify({ verdict: value, issues });

async function replay(
  ownerText: string,
  steps: Step[],
  options: { checks?: CheckerStep[]; realSend?: boolean; tool?: (name: string) => string | undefined } = {},
) {
  const calls: CompleteParams[] = [];
  const checkerCalls: CompleteParams[] = [];
  const payloads: CheckerPayload[] = [];
  const ran: string[] = [];
  const report = newRunReport();
  setToolInterceptorForTests((call) => {
    ran.push(call.name);
    const scripted = options.tool?.(call.name);
    if (scripted !== undefined) return scripted;
    if (call.name === "search_emails") {
      return JSON.stringify([{ id: "sent43", to: ADDRESS, account: "work", snippet: "SECRET-BODY the contract terms" }]);
    }
    if (call.name === "send_email" && options.realSend) return undefined;
    return "Done.";
  });
  if (options.checks) {
    setReplyCheckerForTests("model");
  }
  const checks = [...(options.checks ?? [])];
  setCompleteForTests(async (params) => {
    if (params.task === "reply_check") {
      checkerCalls.push(params);
      const payload = JSON.parse(String(params.messages[0]!.content)) as CheckerPayload;
      payloads.push(payload);
      const next = checks.shift();
      assert(next !== undefined, "unexpected additional checker call");
      if (next === "throw") throw new Error("checker provider down");
      return modelReply({ text: typeof next === "function" ? next(payload) : next });
    }
    calls.push({ ...params, messages: [...params.messages], tools: [...params.tools] });
    assert(steps.length > 0, "unexpected additional model call");
    return modelReply(steps.shift()!);
  });
  const reply = await runAgent(ownerText, {
    backend: "claude", report, guardText: ownerText,
    saveUserMessage: false, saveAssistantMessage: false,
    sendConfirmation: { chatId: 1, messageId: 1953 },
  });
  return { reply, calls, checkerCalls, payloads, ran, report, checksLeft: checks.length };
}

async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  reset();
  try { await run(); count++; originalLog(`PASS ${name}`); }
  catch (error) { failures.push(name); originalLog(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`); }
  finally { setCompleteForTests(undefined); setToolInterceptorForTests(undefined); setReplyCheckerForTests(undefined); }
}

await test("\"the email to Bharat is sent\" with no send this turn: flagged, retried read-only, no false claim reaches him", async () => {
  const honest = "Nothing has gone to Bharat yet. Shall I send it?";
  const result = await replay("Did the email to Bharat go?", [
    { text: "The email to Bharat is sent." },
    { text: honest },
  ], {
    checks: [
      (payload) => payload.records.tools.length === 0 && !payload.records.delivery_grounded
        ? verdict("unsupported_claim", ["No send to Bharat is on record this turn."])
        : verdict("ok"),
      verdict("ok"),
    ],
  });
  assert.equal(result.reply, honest);
  assert.equal(result.ran.length, 0, "nothing ran");
  assert.equal(result.payloads[0]!.reply, "The email to Bharat is sent.");
  assert.equal(result.payloads[0]!.owner_message, "Did the email to Bharat go?");
  assert.equal(result.payloads[0]!.records.delivery_grounded, false);
  // The retry: the issues and the records, and only read tools.
  const retry = result.calls[1]!;
  const prompt = String(retry.messages.at(-1)?.content);
  assert.match(prompt, /No send to Bharat is on record this turn\./);
  assert.match(prompt, /"delivery_grounded":false/);
  assert(retry.tools.length > 0 && retry.tools.every((tool) => tool.type === "function" && toolOwnership(tool.name)?.effect === "read"), "no write tool on the retry");
  // The checker is its own model route, with a schema and a deadline.
  const checkCall = result.checkerCalls[0]!;
  assert.equal(checkCall.route?.models[0]?.key, "anthropic:haiku");
  assert.equal(checkCall.tools.length, 0);
  assert.ok(checkCall.jsonSchema);
  assert.ok((checkCall.timeoutMs ?? Infinity) <= CHECKER_TIMEOUT_MS);
  // Logged to metric_turns.
  assert.deepEqual(result.report.replyChecks?.map((entry) => `${entry.verdict}:${entry.action}`), ["unsupported_claim:retry_read_only", "ok:sent"]);
  const metric = recordTurn({ chatId: 1, route: "test", path: "aadi", agentId: "aadi", report: result.report, meter: newTurnMeter(), success: true });
  const row = db.prepare("SELECT reply_checks_json FROM metric_turns WHERE id=?").get(metric) as { reply_checks_json: string };
  const logged = JSON.parse(row.reply_checks_json) as Array<{ verdict: string; action: string; issues: string[] }>;
  assert.deepEqual(logged.map((entry) => entry.action), ["retry_read_only", "sent"]);
  assert.deepEqual(logged[0]!.issues, ["No send to Bharat is on record this turn."]);
});

await test("the same false claim twice: outcome lines plus the withheld notice, never the claim", async () => {
  const claim = "The email to Bharat is sent.";
  const result = await replay("Send Bharat the deck", [{ text: claim }, { text: claim }], {
    checks: [verdict("unsupported_claim", ["No send on record."]), verdict("unsupported_claim", ["Still no send on record."])],
  });
  assert.equal(result.reply, `${NOTHING_CHANGED_TEXT}\n\n${UNCONFIRMED_TEXT}`);
  assert(!result.reply.includes(claim));
  assert.deepEqual(result.report.replyChecks?.map((entry) => entry.action), ["retry_read_only", "withheld"]);
});

await test("a refused send (attachment) and a reply claiming success: the refusal shows, the claim does not", async () => {
  earlierSendToAlice();
  const settings = config as { sendOnCommandEnabled: boolean };
  const previous = settings.sendOnCommandEnabled;
  settings.sendOnCommandEnabled = true;
  const seen: CheckInput[] = [];
  setReplyCheckerForTests((input) => {
    seen.push(input);
    const hidden = input.tools.some((tool) => tool.effect !== "read" && tool.status !== "ok");
    return { status: "checked", verdict: hidden ? "hides_failure" : "ok", issues: hidden ? ["The send was refused."] : [], model: "test", ms: 0 };
  });
  try {
    const result = await replay(`Send the attachment to ${ADDRESS}`, [
      { tools: [{ name: "search_emails", input: { query: `in:sent to:${ADDRESS}` } }] },
      { tools: [{ name: "send_email", input: { to: [ADDRESS], instruction: "Send the attachment", attachment_requested: true } }] },
      { text: `Sent to ${ADDRESS}.` },
      { text: `Sent to ${ADDRESS}.` },
    ], { realSend: true });
    assert.deepEqual(result.ran, ["search_emails", "send_email"]);
    assert.ok(result.reply.includes("I can't attach a file here"), result.reply);
    assert.ok(result.reply.endsWith(UNCONFIRMED_TEXT), result.reply);
    assert.ok(!result.reply.includes(`Sent to ${ADDRESS}`), result.reply);
    const send = seen[0]!.tools.find((tool) => tool.name === "send_email");
    assert.ok(send && send.status !== "ok", `the checker saw the send as not ok (${send?.status})`);
    assert.equal(seen[0]!.deliveryGrounded, false, "an older send to Alice is no credit for this one");
  } finally {
    settings.sendOnCommandEnabled = previous;
  }
});

await test("\"did I email Alice last week?\" answered from a lookup: ok, sent as written, no bodies to the checker", async () => {
  earlierSendToAlice();
  const answer = "Yes. You emailed Alice last week; that message is on record.";
  const result = await replay("Did I email Alice last week?", [
    { tools: [{ name: "search_emails", input: { query: `in:sent to:${ADDRESS}` } }] },
    { text: answer },
  ], {
    checks: [(payload) => payload.records.sends_found_by_lookup.some((send) => send.id === "sent43") ? verdict("ok") : verdict("unsupported_claim", ["No lookup found it."])],
  });
  assert.equal(result.reply, answer);
  assert.equal(result.calls.length, 2, "no retry");
  const payload = result.payloads[0]!;
  assert.deepEqual(payload.records.sends_found_by_lookup, [{ account: "work", id: "sent43" }]);
  assert.deepEqual(payload.records.tools.map((tool) => `${tool.name}:${tool.effect}:${tool.status}`), ["search_emails:read:ok"]);
  assert.equal(payload.records.delivery_grounded, true);
  assert.ok(payload.records.available_lookups.includes("search_emails"));
  assert.ok(!JSON.stringify(payload).includes("SECRET-BODY"), "no email body reaches the checker");
});

await test("checker down: outcome lines first, then the reply under \"Not double-checked:\"", async () => {
  const text = "Here is what I found.";
  const result = await replay("What's new?", [{ text }], { checks: ["throw", "throw"] });
  assert.equal(result.reply, `${NOTHING_CHANGED_TEXT}\n\n${NOT_CHECKED_LABEL}\n${text}`);
  assert.equal(result.checkerCalls.length, 2, "Haiku, then the Gemini Flash fallback");
  assert.deepEqual(result.checkerCalls.map((call) => call.route?.models[0]?.key), ["anthropic:haiku", "gemini:flash"]);
  assert.deepEqual(result.report.replyChecks?.map((entry) => `${entry.verdict}:${entry.action}`), ["unavailable:sent_unchecked"]);

  reset();
  const invalid = await replay("What's new?", [{ text }], { checks: ["not json", verdict("maybe")] });
  assert.equal(invalid.reply, `${NOTHING_CHANGED_TEXT}\n\n${NOT_CHECKED_LABEL}\n${text}`, "invalid output is the same as down");

  reset();
  const sent = await replay("send the Eternal email", [
    { tools: [{ name: "draft_reply", input: { send_immediately: true } }] },
    { text: "I sent it." },
  ], {
    checks: ["throw", "throw"],
    tool: (name) => {
      if (name !== "draft_reply") return undefined;
      recordImmediateDraftSend({ key: "checker-down", account: "work", threadId: null, to: "priya@acme.com", sentMessageId: "checker-down-sent" });
      recordEmailOutcome("send:work:checker-down-sent", "Sent to priya@acme.com.");
      return "Sent to priya@acme.com.";
    },
  });
  assert.equal(sent.reply, `Sent to priya@acme.com.\n\n${NOT_CHECKED_LABEL}\nI sent it.`, "the recorded line comes first, with no 'nothing was sent'");
});

await test("an incomplete reply is retried with the normal tools, then checked again", async () => {
  const result = await replay("What did Priya say about the pilot?", [
    { text: "Let me check her emails and get back to you." },
    { tools: [{ name: "search_emails", input: { query: "from:priya pilot" } }] },
    { text: "She said the pilot starts on the 20th." },
  ], {
    checks: [verdict("incomplete", ["It promises to look instead of looking."]), verdict("ok")],
  });
  assert.equal(result.reply, "She said the pilot starts on the 20th.");
  assert.deepEqual(result.ran, ["search_emails"]);
  assert(result.calls[1]!.tools.some((tool) => tool.type === "function" && toolOwnership(tool.name)?.effect !== "read"), "the normal tools, writes included");
  assert.deepEqual(result.report.replyChecks?.map((entry) => entry.action), ["retry_tools", "sent"]);
});

await test("a reply that is a JSON tool call never reaches him and is never run", async () => {
  const blob = JSON.stringify({ name: "send_email", arguments: { to: ["bharat@example.com"], instruction: "hi" } });
  const checked: string[] = [];
  setReplyCheckerForTests((input) => {
    checked.push(input.reply);
    return { status: "checked", verdict: "ok", issues: [], model: "test", ms: 0 };
  });
  const result = await replay("email Bharat hi", [{ text: blob }, { text: `<tool_call>${blob}</tool_call>` }]);
  assert.equal(result.reply, FORMAT_PROBLEM_TEXT);
  assert.deepEqual(result.ran, [], "nothing written as text was run");
  assert.equal(checked.length, 0, "raw data is not a reply to check");
  assert.match(String(result.calls[1]!.messages.at(-1)?.content), /real tool call/);
  assert.deepEqual(result.report.replyChecks?.map((entry) => `${entry.verdict}:${entry.action}`), ["raw_payload:format_retry", "raw_payload:format_withheld"]);

  reset();
  const recovered = await replay("email Bharat hi", [{ text: "```json\n" + blob + "\n```" }, { text: "Who is Bharat? I have no address for him." }]);
  assert.equal(recovered.reply, "Who is Bharat? I have no address for him.");
  assert.deepEqual(recovered.ran, []);
});

await test("every outgoing Telegram text passes the raw-data guard", async () => {
  assert.equal(isRawPayload('{"name":"send_email","arguments":{}}'), true);
  assert.equal(isRawPayload('[{"id":1}]'), true);
  assert.equal(isRawPayload("```json\n{\"a\":1}\n```"), true);
  assert.equal(isRawPayload("<tool_call>{}</tool_call>"), true);
  assert.equal(isRawPayload("42"), false, "a plain number is a message");
  assert.equal(isRawPayload("Sent to Alice. {draft}"), false);
  const api = new Api("123:test-token");
  const sent: string[] = [];
  api.config.use(async (_prev, method, payload) => {
    const fields = payload as { text?: string; caption?: string };
    sent.push(`${method}:${fields.text ?? fields.caption ?? ""}`);
    return { ok: true, result: { message_id: 1, date: 0, chat: { id: 1, type: "private", first_name: "Vishnu" }, text: fields.text ?? "" } } as never;
  });
  installOutgoingTextGuard(api);
  await api.sendMessage(1, "Hello.");
  await assert.rejects(api.sendMessage(1, '{"name":"send_email","arguments":{"to":["x@example.com"]}}'), RawTextBlockedError);
  await assert.rejects(api.editMessageText(1, 2, '{"id":12,"status":"done"}'), RawTextBlockedError);
  await assert.rejects(api.sendMessage(1, "<tool_call>send_email</tool_call>"), RawTextBlockedError);
  assert.deepEqual(sent, ["sendMessage:Hello."]);
});

await test("a finished job never shows a tool's raw output", () => {
  const operations = getAgent("operations")!.manifest.name;
  const knowledge = getAgent("knowledge")!.manifest.name;
  const text = summaryForOwner({
    workflowId: "w1", title: "job", state: "completed",
    tasks: [
      { key: "a", taskId: "t1", contextId: "c", agentId: "operations", capability: "add_task", state: "completed", attempts: 1, text: '{"id":12,"tag":"work","status":"open"}' },
      { key: "b", taskId: "t2", contextId: "c", agentId: "knowledge", capability: "goal", state: "completed", attempts: 1, text: '{"answer":"raw"}' },
      { key: "c", taskId: "t3", contextId: "c", agentId: "knowledge", capability: "goal", state: "completed", attempts: 1, text: "Jeff prefers morning calls." },
      { key: "d", taskId: "t4", contextId: "c", agentId: "operations", capability: "add_task", state: "failed", attempts: 1, error: { code: "failed", message: 'Tool failed: {"error":"bad"}', retryable: false, uncertain: true } },
    ],
  } as never);
  assert.equal(text, [
    `${operations}: Done.`,
    `${knowledge}: Done.`,
    `${knowledge}: Jeff prefers morning calls.`,
    `${operations}: Didn't finish (failed). It may have partly run; check before trying again.`,
  ].join("\n"));
  assert(!text.includes("{"), "no JSON");
});

await test("a provider 400 with a JSON body becomes a fixed message", async () => {
  const settled = await settleChatWork(async () => {
    throw new LlmChainError('All models for aadi failed: [anthropic:sonnet:400 {"type":"error","error":{"message":"bad"}}]', [
      { provider: "anthropic", model: "anthropic:sonnet", outcome: "other" },
    ]);
  }, 1_000);
  assert.equal(settled.status, "failed");
  if (settled.status === "failed") {
    const text = formatTurnFailure(settled.cause);
    assert.equal(text, "I couldn't finish that (Claude: request rejected). Nothing was sent or changed.");
    assert(!text.includes("{"));
  }
});

await test("verdicts are schema-checked", () => {
  assert.deepEqual(parseVerdict('{"verdict":"ok","issues":[]}'), { verdict: "ok", issues: [] });
  assert.deepEqual(parseVerdict("```json\n{\"verdict\":\"hides_failure\",\"issues\":[\"x\"]}\n```"), { verdict: "hides_failure", issues: ["x"] });
  assert.equal(parseVerdict('{"verdict":"fine"}'), undefined);
  assert.equal(parseVerdict('{"verdict":"ok","issues":"none"}'), undefined);
  assert.equal(parseVerdict("ok"), undefined);
});

console.log = originalLog;
originalLog(`Reply checker: ${count} passed, ${failures.length} failed.`);
if (failures.length) process.exitCode = 1;
