import { runAgent, setToolInterceptorForTests } from "../src/agent.ts";
import {
  detectClaimedActions,
  isSuccessfulToolResult,
  receiptFailureMessage,
  unreceiptedClaims,
} from "../src/receipt.ts";
import { setCompleteForTests } from "../src/llm.ts";
import { formatHealthReport } from "../src/scheduler.ts";
import {
  beginTurn,
  closeTurn,
  formatTurnFailure,
  formatTurnsHealthLine,
  settleChatWork,
} from "../src/turns.ts";
import { modelReply } from "./fakes.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function testReceiptDetection(): void {
  assert(
    detectClaimedActions("I sent the email to Priya.").includes("sent"),
    "detects a sent claim",
  );
  assert(
    detectClaimedActions("I couldn't send that.").length === 0,
    "negated sent is not a claim",
  );
  assert(
    unreceiptedClaims("I sent it.", []).includes("sent"),
    "sent with no tool is unreceipted",
  );
  assert(
    unreceiptedClaims("I sent it.", [{ name: "draft_reply", success: true }]).length ===
      0,
    "sent with a successful draft_reply is receipted",
  );
  assert(
    unreceiptedClaims("I sent it.", [{ name: "draft_reply", success: false }]).includes(
      "sent",
    ),
    "failed send tool is not a receipt",
  );
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
    const last = params.messages.at(-1);
    if (last?.role === "user" && /no tool did it/i.test(String(last.content))) {
      return modelReply({ text: "I sent the email to Priya." });
    }
    return modelReply({ text: "I sent the email to Priya." });
  });
  setToolInterceptorForTests(() => "should not run");
  const reply = await runAgent("send the Eternal email", {
    saveUserMessage: false,
    saveAssistantMessage: false,
    skipHistory: true,
  });
  assert(
    reply === receiptFailureMessage(["sent"]),
    `unreceipted sent claim is blocked, got: ${reply}`,
  );
  setCompleteForTests(undefined);
  setToolInterceptorForTests(undefined);
}

async function testThrownEmptyTimeout(): Promise<void> {
  const thrown = await settleChatWork(async () => {
    throw new Error("boom from model");
  }, 1_000);
  assert(thrown.status === "failed", "thrown work is failed");
  if (thrown.status === "failed") {
    assert(thrown.reason === "boom from model", "failed reason is the error");
    assert(
      formatTurnFailure(thrown.reason) === "I couldn't finish that: boom from model.",
      "failure message includes the reason",
    );
  }

  const empty = await settleChatWork(async () => "", 1_000);
  assert(empty.status === "empty", "empty string is empty");
  assert(
    formatTurnFailure("empty reply") === "I couldn't finish that: empty reply.",
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
    formatTurnFailure("timed out after 60s") ===
      "I couldn't finish that: timed out after 60s.",
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
  testReceiptDetection();
  await testFakeModelSentClaimBlocked();
  await testThrownEmptyTimeout();
  testHealthCounts();
  console.log("test-anti-laziness: ok");
}

await main();
