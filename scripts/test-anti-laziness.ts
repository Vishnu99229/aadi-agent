import { recordImmediateDraftSend } from "../src/db.ts";
import { recordEmailOutcome } from "../src/email_outcomes.ts";
import { runAgent, setToolInterceptorForTests } from "../src/agent.ts";
import { isSuccessfulToolResult } from "../src/receipt.ts";
import { setReplyCheckerForTests } from "../src/reply_checker.ts";
import { LlmChainError, setCompleteForTests } from "../src/llm.ts";
import { formatHealthReport } from "../src/scheduler.ts";
import {
  beginTurn,
  closeTurn,
  formatTurnFailure,
  formatTurnsHealthLine,
  retryKeyboard,
  settleChatWork,
} from "../src/turns.ts";
import { modelReply } from "./fakes.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function testToolResults(): void {
  assert(
    !isSuccessfulToolResult("Not sent: missing draft_id."),
    "Not sent is not success",
  );
  assert(isSuccessfulToolResult("Sent to priya@acme.com."), "Sent to is success");
}

async function testFakeModelSentClaimBlocked(): Promise<void> {
  setCompleteForTests(async (params) => {
    if (params.tools.length === 0) {
      return modelReply({ text: '{"facts":[]}' });
    }
    return modelReply({ text: "I sent the email to Priya." });
  });
  // The checker reads the records: nothing ran, so the claim is unsupported both times.
  const seen: string[] = [];
  setReplyCheckerForTests((input) => {
    seen.push(input.tools.map((tool) => `${tool.name}:${tool.status}`).join(","));
    return { status: "checked", verdict: "unsupported_claim", issues: ["No send is on record."], model: "test", ms: 0 };
  });
  setToolInterceptorForTests(() => "should not run");
  const reply = await runAgent("send the Eternal email", {
    saveUserMessage: false,
    saveAssistantMessage: false,
    skipHistory: true,
  });
  assert(seen.length === 2 && seen.every((tools) => tools === ""), `checked twice with no tool on record (${seen.join(" | ")})`);
  assert(
    reply === "Nothing was sent or changed this turn.\n\nI've left out the rest of my reply because I couldn't confirm it.",
    `an unsupported sent claim is withheld, got: ${reply}`,
  );
  setReplyCheckerForTests(undefined);
  setCompleteForTests(undefined);
  setToolInterceptorForTests(undefined);
}

async function testRealToolSuccessAllowed(): Promise<void> {
  setCompleteForTests(async (params) => {
    if (params.tools.length === 0) {
      return modelReply({ text: '{"facts":[]}' });
    }
    const last = params.messages.at(-1);
    if (last?.role === "tool") {
      return modelReply({ text: "I sent the email to Priya." });
    }
    return modelReply({
      text: "",
      tools: [{ name: "draft_reply", input: { send_immediately: true } }],
    });
  });
  setToolInterceptorForTests(() => {
    const line = "Sent to priya@acme.com.";
    recordImmediateDraftSend({ key: "test-delivery", account: "work", threadId: null, to: "priya@acme.com", sentMessageId: "test-sent" });
    recordEmailOutcome("send:work:test-sent", line);
    return line;
  });
  const reply = await runAgent("send the Eternal email", {
    saveUserMessage: false,
    saveAssistantMessage: false,
    skipHistory: true,
  });
  assert(
    reply === "Sent to priya@acme.com.\n\nI sent the email to Priya.",
    `successful send tool allows the claim, got: ${reply}`,
  );
  setCompleteForTests(undefined);
  setToolInterceptorForTests(undefined);
}

function testRetryButton(): void {
  const keyboard = retryKeyboard(42);
  const row = keyboard.inline_keyboard[0]?.[0];
  assert(row?.text === "Retry", "failure keyboard is labelled Retry");
  assert(row?.callback_data === "retry:42", "Retry callback includes the turn id");
}

async function testThrownEmptyTimeout(): Promise<void> {
  const thrown = await settleChatWork(async () => {
    throw new Error("boom from model");
  }, 1_000);
  assert(thrown.status === "failed", "thrown work is failed");
  if (thrown.status === "failed") {
    assert(thrown.reason === "boom from model", "the logged reason is the error");
    assert(
      formatTurnFailure(thrown.cause) === "I couldn't finish that (internal error). Nothing was sent or changed.",
      `an internal error gets the fixed message, got: ${formatTurnFailure(thrown.cause)}`,
    );
  }

  // A provider 400 with a JSON body: the message names the provider and class, never the body.
  const body = '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.1: bad"}}';
  const provider = await settleChatWork(async () => {
    throw new LlmChainError(`All models for aadi failed: [anthropic:sonnet:${body}]`, [
      { provider: "anthropic", model: "anthropic:sonnet", outcome: "other" },
      { provider: "gemini", model: "gemini:flash", outcome: "rate_limit" },
    ]);
  }, 1_000);
  assert(provider.status === "failed", "a provider failure is failed");
  if (provider.status === "failed") {
    const text = formatTurnFailure(provider.cause);
    assert(text === "I couldn't finish that (Claude: request rejected). Nothing was sent or changed.", `fixed provider message, got: ${text}`);
    assert(!text.includes("{") && !text.includes("invalid_request_error"), "no JSON from the provider body");
    assert(
      formatTurnFailure(provider.cause, true) === "I couldn't finish that (Claude: request rejected). Something may already have changed; check before trying again.",
      "a turn that wrote something does not promise that nothing changed",
    );
  }
  const limited = await settleChatWork(async () => {
    throw new LlmChainError("All LLM backends failed: [gemini:429]", [{ provider: "gemini", model: "gemini", outcome: "rate_limit" }]);
  }, 1_000);
  if (limited.status === "failed") {
    assert(formatTurnFailure(limited.cause) === "I couldn't finish that (Gemini: rate limit). Nothing was sent or changed.", "rate limit class");
  }

  const empty = await settleChatWork(async () => "", 1_000);
  assert(empty.status === "empty", "empty string is empty");
  assert(
    formatTurnFailure({ kind: "empty" }) === "I couldn't finish that (the model returned an empty reply). Nothing was sent or changed.",
    "empty failure message",
  );

  const timed = await settleChatWork(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 400);
    });
    return "late";
  }, 30);
  assert(timed.status === "timeout", "slow work times out");
  assert(
    formatTurnFailure({ kind: "timeout" }) ===
      "I couldn't finish that (the reply timed out). Nothing was sent or changed.",
    "timeout failure message",
  );
}

function testHealthCounts(): void {
  const gate = beginTurn();
  closeTurn(gate, "failed", Date.now() - 12, "boom");
  const timed = beginTurn();
  closeTurn(timed, "timeout", Date.now() - 60_000);
  const line = formatTurnsHealthLine();
  assert(/1 failed/.test(line), `health failed count: ${line}`);
  assert(/1 timed out/.test(line), `health timeout count: ${line}`);
  const report = formatHealthReport();
  assert(report.includes("turns today:"), "health report includes turns today");
}

async function main(): Promise<void> {
  testToolResults();
  await testFakeModelSentClaimBlocked();
  await testRealToolSuccessAllowed();
  testRetryButton();
  await testThrownEmptyTimeout();
  testHealthCounts();
  console.log("test-anti-laziness: ok");
}

await main();
