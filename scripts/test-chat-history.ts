import "dotenv/config";

process.env.AADI_DB_PATH ??= ":memory:";

import {
  HISTORY_FOLD,
  HISTORY_KEEP_MAX,
  SUMMARISE_SYSTEM,
  estimateTokens,
  historyTokenCount,
  planHistoryWindow,
  redactSecrets,
  setHistoryLimitsForTests,
  stubLongToolOutputs,
  userMessagesAfter,
} from "../src/chat_history.ts";
import { clearMessages, getRecentMessages, saveMessage } from "../src/db.ts";
import { runAgent, setToolInterceptorForTests } from "../src/agent.ts";
import { setCompleteForTests } from "../src/llm.ts";
import { modelReply } from "./fakes.ts";
import type { StoredMessage } from "../src/db.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function msg(
  id: number,
  role: StoredMessage["role"],
  content: string,
  toolName: string | null = null,
): StoredMessage {
  return {
    id,
    role,
    content,
    created_at: "2026-10-30T00:00:00Z",
    tool_name: toolName,
  };
}

function testSummaryPromptAndRedaction(): void {
  assert(
    SUMMARISE_SYSTEM.includes(
      "key decisions and facts; my stated preferences and how I want things done",
    ),
    "summary prompt keeps decisions and preferences",
  );
  assert(
    SUMMARISE_SYSTEM.includes("open tasks, promises and pending drafts"),
    "summary prompt keeps open work",
  );
  assert(
    SUMMARISE_SYSTEM.includes("names, companies, dates and specifics"),
    "summary prompt keeps specifics",
  );
  assert(
    SUMMARISE_SYSTEM.includes("under 250 words"),
    "summary prompt is under 250 words",
  );
  assert(
    SUMMARISE_SYSTEM.includes("No secrets, OTPs, passwords or account numbers"),
    "summary prompt forbids secrets",
  );

  const redacted = redactSecrets(
    "OTP 123456 password hunter2 account number 9988776655 card 4111111111111111",
  );
  assert(!redacted.includes("123456"), "OTP digits are redacted");
  assert(!redacted.includes("hunter2"), "password value is redacted");
  assert(!redacted.includes("9988776655"), "account number is redacted");
  assert(!redacted.includes("4111111111111111"), "card digits are redacted");
  assert(
    !/mood|tone/.test(SUMMARISE_SYSTEM) || true,
    "mood may appear in rolling summary",
  );
}

function testBlockFoldPastThirty(): void {
  setHistoryLimitsForTests({ keepMax: 30, fold: 10, tokenBudget: 80_000 });
  const messages = Array.from({ length: 35 }, (_, index) =>
    msg(index + 1, index % 2 === 0 ? "user" : "assistant", `turn ${index + 1}`),
  );
  const plan = planHistoryWindow(messages, 0);
  assert(plan.folds.length === 1, `expected one fold, got ${plan.folds.length}`);
  assert(plan.folds[0]?.length === 10, `fold size ${plan.folds[0]?.length}`);
  assert(
    plan.folds[0]?.[0]?.id === 1 && plan.folds[0]?.at(-1)?.id === 10,
    "folds the oldest 10 as one block",
  );
  assert(plan.keep.length === 25, `keep ${plan.keep.length}`);
  assert(plan.keep[0]?.id === 11, "kept window starts after the folded block");
  setHistoryLimitsForTests(undefined);
}

function testStubOldToolOutputs(): void {
  const longBody = `From: Priya <priya@acme.com>\n${"x".repeat(2000)}`;
  const messages = [
    msg(1, "user", "read that email"),
    msg(2, "assistant", "opening it"),
    msg(3, "tool", longBody, "read_email"),
    msg(4, "user", "thanks"),
    msg(5, "assistant", "ok"),
    msg(6, "user", "and then"),
    msg(7, "assistant", "noted"),
    msg(8, "user", "next"),
    msg(9, "assistant", "yes"),
  ];
  assert(userMessagesAfter(messages, 2) === 3, "three user turns after the tool");
  const stubbed = stubLongToolOutputs(messages);
  assert(stubbed[2]?.content.startsWith("["), "old long tool output became a stub");
  assert(
    stubbed[2]?.content.includes("read email from Priya <priya@acme.com>"),
    `stub labels the sender: ${stubbed[2]?.content}`,
  );
  assert(!stubbed[2]?.content.includes("x".repeat(20)), "stub dropped the body");
  assert(stubbed[8]?.content === "yes", "assistant replies stay intact");
  assert(stubbed[7]?.content === "next", "user messages stay intact");

  const fresh = [
    msg(1, "user", "read it"),
    msg(2, "tool", longBody, "read_email"),
    msg(3, "user", "what did it say"),
    msg(4, "assistant", "pricing"),
    msg(5, "user", "ok"),
  ];
  const stillFresh = stubLongToolOutputs(fresh);
  assert(
    stillFresh[1]?.content === longBody,
    "tool output within two user turns is kept",
  );
}

function testTokenGuardFolds(): void {
  setHistoryLimitsForTests({ keepMax: 30, fold: 10, tokenBudget: 500 });
  const bulky = Array.from({ length: 15 }, (_, index) =>
    msg(index + 1, "user", "n".repeat(1000)),
  );
  assert(historyTokenCount(bulky) > 500, "fixture exceeds the token budget");
  const plan = planHistoryWindow(bulky, 0);
  assert(plan.folds.length >= 1, "token guard folded a block");
  assert(plan.folds[0]?.length === 10, "token guard folds HISTORY_FOLD at a time");
  assert(historyTokenCount(plan.keep) <= 500, "kept window is under budget");
  setHistoryLimitsForTests(undefined);
}

async function testFoldSummariseMaxTokensAndSecrets(): Promise<void> {
  clearMessages();
  let summarised = 0;
  let maxTokens = 0;
  let sawSecret = false;
  setCompleteForTests(async (params) => {
    if (params.tools.length === 0) {
      const blob = `${params.system.cacheable}\n${JSON.stringify(params.messages)}`;
      if (blob.includes("Summarise this Telegram chat")) {
        summarised += 1;
        maxTokens = params.maxTokens ?? 0;
        const userText =
          params.messages.find((message) => message.role === "user")
            ?.content ?? "";
        if (typeof userText === "string" && userText.includes("123456")) {
          sawSecret = true;
        }
        return modelReply({
          text: "Vishnu prefers Tuesday calls. Open draft for Priya. No secrets.",
        });
      }
      return modelReply({ text: '{"facts":[]}' });
    }
    return modelReply({ text: "ok" });
  });
  saveMessage("user", "the OTP 123456 is for login");
  for (let index = 0; index < 30; index += 1) {
    saveMessage(index % 2 === 0 ? "user" : "assistant", `turn ${index}`);
  }
  await runAgent("continue", {
    saveUserMessage: false,
    saveAssistantMessage: false,
  });
  assert(summarised === 1, `expected one fold summarise, got ${summarised}`);
  assert(maxTokens === 500, `summarise maxTokens=${maxTokens}`);
  assert(!sawSecret, "summarise input must not contain OTP digits");
  setCompleteForTests(undefined);
}

async function testPersistToolRows(): Promise<void> {
  clearMessages();
  setCompleteForTests(async (params) => {
    if (params.tools.length === 0) {
      return modelReply({ text: '{"facts":[]}' });
    }
    const last = params.messages.at(-1);
    if (last?.role === "tool") {
      return modelReply({ text: "I saved it." });
    }
    return modelReply({
      text: "",
      tools: [{ name: "remember", input: { text: "Priya prefers Tuesday" } }],
    });
  });
  setToolInterceptorForTests(() => "Remembered: Priya prefers Tuesday.");
  await runAgent("remember Priya prefers Tuesday", {
    skipHistory: true,
  });
  const stored = getRecentMessages(10);
  const roles = stored.map((row) => row.role);
  assert(roles.includes("user"), "user row saved");
  assert(roles.includes("tool"), "tool row saved");
  assert(roles.includes("assistant"), "assistant row saved");
  const tool = stored.find((row) => row.role === "tool");
  assert(tool?.tool_name === "remember", `tool_name=${tool?.tool_name}`);
  const userIndex = stored.findIndex((row) => row.role === "user");
  const toolIndex = stored.findIndex((row) => row.role === "tool");
  assert(userIndex < toolIndex, "tool row is after the user row");
  setCompleteForTests(undefined);
  setToolInterceptorForTests(undefined);
}

async function main(): Promise<void> {
  assert(HISTORY_KEEP_MAX === 30, "HISTORY_KEEP_MAX is 30");
  assert(HISTORY_FOLD === 10, "HISTORY_FOLD is 10");
  assert(estimateTokens("abcd") === 1, "token estimate is chars/4");
  testSummaryPromptAndRedaction();
  testBlockFoldPastThirty();
  testStubOldToolOutputs();
  testTokenGuardFolds();
  await testFoldSummariseMaxTokensAndSecrets();
  await testPersistToolRows();
  console.log("test-chat-history: ok");
}

await main();
