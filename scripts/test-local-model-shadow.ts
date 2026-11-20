import "dotenv/config";

process.env.AADI_DB_PATH ??= ":memory:";

import http from "node:http";
import {
  historyForAgentForTests,
} from "../src/agent.ts";
import {
  buildSummarizerInput,
  SUMMARISE_SYSTEM,
  setHistoryLimitsForTests,
} from "../src/chat_history.ts";
import {
  clearMessages,
  clearLocalModelRunsForTests,
  getSetting,
  listLocalModelRuns,
  saveMessage,
  CONVERSATION_SUMMARY_KEY,
  CONVERSATION_SUMMARY_UNTIL_KEY,
  setSetting,
} from "../src/db.ts";
import { setCompleteForTests } from "../src/llm.ts";
import {
  LOCAL_NUM_PREDICT,
  callLocalChat,
  formatLocalModelHealthLine,
  localModelShadowInFlightForTests,
  maybeShadowFoldSummary,
  resetLocalModelShadowForTests,
  setLocalModelConfigForTests,
} from "../src/local_model.ts";
import { redactAllSecrets } from "../src/chat_history.ts";
import { modelReply } from "./fakes.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

type FakeMode = "ok" | "hang" | "secret";

async function withFakeOllama<T>(
  mode: FakeMode,
  run: (baseUrl: string, state: { bodies: unknown[]; hits: number }) => Promise<T>,
): Promise<T> {
  const state = { bodies: [] as unknown[], hits: 0 };
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/chat") {
      state.hits += 1;
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        try {
          state.bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          state.bodies.push(null);
        }
        if (mode === "hang") {
          // Never respond.
          return;
        }
        const content =
          mode === "secret"
            ? "Summary OTP 999888 password hunter2 kept for compare."
            : "Local fold: Vishnu prefers Tuesday; open Priya draft.";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            model: "gemma4:e2b",
            message: { role: "assistant", content },
            done: true,
          }),
        );
      });
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("fake ollama: no port");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await run(baseUrl, state);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function waitForRuns(min: number, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (listLocalModelRuns(50).length >= min) {
      return;
    }
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${min} local_model_runs`);
}

async function testCallLocalChatPayload(): Promise<void> {
  await withFakeOllama("ok", async (baseUrl, state) => {
    setLocalModelConfigForTests({
      enabled: true,
      url: baseUrl,
      model: "gemma4:e2b",
    });
    const result = await callLocalChat({
      system: SUMMARISE_SYSTEM,
      user: "New turns:\nuser: hello",
    });
    assert(result.text.includes("Local fold"), `text=${result.text}`);
    assert(state.hits === 1, `hits=${state.hits}`);
    const body = state.bodies[0] as {
      model: string;
      stream: boolean;
      think: boolean;
      messages: { role: string; content: string }[];
      options: { num_predict: number };
    };
    assert(body.model === "gemma4:e2b", `model=${body.model}`);
    assert(body.stream === false, "stream must be false");
    assert(body.think === false, "think must be false");
    assert(body.options.num_predict === LOCAL_NUM_PREDICT, "num_predict 500");
    assert(body.messages[0]?.role === "system", "system first");
    assert(body.messages[0]?.content === SUMMARISE_SYSTEM, "same SUMMARISE_SYSTEM");
    assert(body.messages[1]?.role === "user", "user second");
  });
  setLocalModelConfigForTests(undefined);
  resetLocalModelShadowForTests();
}

async function testShadowStoresRedactedAndCloudMeta(): Promise<void> {
  clearMessages();
  clearLocalModelRunsForTests();
  setSetting(CONVERSATION_SUMMARY_KEY, "");
  setSetting(CONVERSATION_SUMMARY_UNTIL_KEY, "0");
  await withFakeOllama("secret", async (baseUrl) => {
    setLocalModelConfigForTests({
      enabled: true,
      url: baseUrl,
      model: "gemma4:e2b",
    });
    resetLocalModelShadowForTests();
    const input = buildSummarizerInput(
      [
        {
          id: 1,
          role: "user",
          content: "remember OTP 123456",
          created_at: "2026-11-01T00:00:00Z",
          tool_name: null,
        },
      ],
      "",
    );
    maybeShadowFoldSummary({
      input,
      cloudSummary: "Cloud fold about Tuesday.",
      cloudBackend: "gemini",
      cloudModel: "gemini-3.6-flash",
      untilId: 42,
    });
    await waitForRuns(1);
    const row = listLocalModelRuns(1)[0]!;
    assert(row.status === "ok", `status=${row.status}`);
    assert(row.until_id === 42, `until_id=${row.until_id}`);
    assert(row.cloud_backend === "gemini", `cloud_backend=${row.cloud_backend}`);
    assert(
      row.cloud_model === "gemini-3.6-flash",
      `cloud_model=${row.cloud_model}`,
    );
    assert(row.cloud_summary === "Cloud fold about Tuesday.", "cloud summary stored");
    assert(row.local_summary != null, "local summary stored");
    assert(!row.local_summary!.includes("999888"), "OTP digits redacted");
    assert(!row.local_summary!.includes("hunter2"), "password redacted");
    assert(row.local_summary!.includes("[redacted]"), "redaction marker present");
    assert(
      row.local_summary ===
        redactAllSecrets(
          "Summary OTP 999888 password hunter2 kept for compare.",
        ),
      "stored text matches redactAllSecrets",
    );
    assert(row.input_chars === input.length, "input_chars matches");
  });
  setLocalModelConfigForTests(undefined);
  resetLocalModelShadowForTests();
}

async function testHangDoesNotDelayHistoryForAgent(): Promise<void> {
  clearMessages();
  clearLocalModelRunsForTests();
  setSetting(CONVERSATION_SUMMARY_KEY, "");
  setSetting(CONVERSATION_SUMMARY_UNTIL_KEY, "0");
  // One fold only so a single hanging shadow is in flight.
  setHistoryLimitsForTests({ keepMax: 5, fold: 10, tokenBudget: 80_000 });
  await withFakeOllama("hang", async (baseUrl, state) => {
    setLocalModelConfigForTests({
      enabled: true,
      url: baseUrl,
      model: "gemma4:e2b",
      // Keep production default (180s) so the hang proves we do not await it.
      totalTimeoutMs: 180_000,
    });
    resetLocalModelShadowForTests();
    setCompleteForTests(async (params) => {
      if (params.tools.length === 0) {
        const blob = `${params.system.cacheable}\n${JSON.stringify(params.messages)}`;
        if (blob.includes("Summarise this Telegram chat")) {
          return {
            ...modelReply({
              text: "Cloud fold summary for hang test.",
            }),
            servedBy: "gemini",
            servedModel: "gemini-3.6-flash",
          };
        }
        return modelReply({ text: '{"facts":[]}' });
      }
      return modelReply({ text: "ok" });
    });
    for (let index = 0; index < 12; index += 1) {
      saveMessage(index % 2 === 0 ? "user" : "assistant", `hang turn ${index}`);
    }
    const started = Date.now();
    const result = await historyForAgentForTests(false);
    const elapsed = Date.now() - started;
    assert(elapsed < 1_000, `historyForAgent took ${elapsed}ms (must be <1s while local hangs)`);
    assert(
      result.summary.includes("Cloud fold summary"),
      `summary=${result.summary}`,
    );
    assert(
      getSetting(CONVERSATION_SUMMARY_KEY)?.includes("Cloud fold summary") === true,
      "cloud summary saved before shadow",
    );
    const hitDeadline = Date.now() + 500;
    while (state.hits < 1 && Date.now() < hitDeadline) {
      await sleep(10);
    }
    assert(state.hits >= 1, `shadow POST never reached fake server; hits=${state.hits}`);
    assert(localModelShadowInFlightForTests(), "hanging shadow still in flight");
  });
  // closeAllConnections aborts the hang; wait for the shadow catch to settle.
  const settleDeadline = Date.now() + 2_000;
  while (localModelShadowInFlightForTests() && Date.now() < settleDeadline) {
    await sleep(20);
  }
  setCompleteForTests(undefined);
  setLocalModelConfigForTests(undefined);
  resetLocalModelShadowForTests();
  setHistoryLimitsForTests(undefined);
  clearLocalModelRunsForTests();
}

async function testNoShadowWhenCloudFails(): Promise<void> {
  clearMessages();
  clearLocalModelRunsForTests();
  setSetting(CONVERSATION_SUMMARY_KEY, "");
  setSetting(CONVERSATION_SUMMARY_UNTIL_KEY, "0");
  setHistoryLimitsForTests({ keepMax: 5, fold: 5, tokenBudget: 80_000 });
  await withFakeOllama("ok", async (baseUrl, state) => {
    setLocalModelConfigForTests({
      enabled: true,
      url: baseUrl,
      model: "gemma4:e2b",
    });
    resetLocalModelShadowForTests();
    setCompleteForTests(async (params) => {
      if (params.tools.length === 0) {
        const blob = `${params.system.cacheable}\n${JSON.stringify(params.messages)}`;
        if (blob.includes("Summarise this Telegram chat")) {
          throw new Error("cloud fold boom");
        }
        return modelReply({ text: '{"facts":[]}' });
      }
      return modelReply({ text: "ok" });
    });
    for (let index = 0; index < 12; index += 1) {
      saveMessage(index % 2 === 0 ? "user" : "assistant", `fail turn ${index}`);
    }
    await historyForAgentForTests(false);
    await sleep(200);
    assert(state.hits === 0, `shadow must not run when cloud fails; hits=${state.hits}`);
    assert(listLocalModelRuns(10).length === 0, "no local_model_runs on cloud failure");
  });
  setCompleteForTests(undefined);
  setLocalModelConfigForTests(undefined);
  resetLocalModelShadowForTests();
  setHistoryLimitsForTests(undefined);
}

async function testOneAtATime(): Promise<void> {
  clearLocalModelRunsForTests();
  await withFakeOllama("hang", async (baseUrl, state) => {
    setLocalModelConfigForTests({
      enabled: true,
      url: baseUrl,
      model: "gemma4:e2b",
      totalTimeoutMs: 2_000,
    });
    resetLocalModelShadowForTests();
    maybeShadowFoldSummary({
      input: "first",
      cloudSummary: "a",
      cloudBackend: "gemini",
      cloudModel: "gemini-3.6-flash",
      untilId: 1,
    });
    const hitDeadline = Date.now() + 500;
    while (state.hits < 1 && Date.now() < hitDeadline) {
      await sleep(10);
    }
    maybeShadowFoldSummary({
      input: "second",
      cloudSummary: "b",
      cloudBackend: "gemini",
      cloudModel: "gemini-3.6-flash",
      untilId: 2,
    });
    await sleep(50);
    assert(state.hits === 1, `one call at a time; hits=${state.hits}`);
    assert(localModelShadowInFlightForTests(), "first still in flight");
  });
  const settleDeadline = Date.now() + 2_500;
  while (localModelShadowInFlightForTests() && Date.now() < settleDeadline) {
    await sleep(20);
  }
  setLocalModelConfigForTests(undefined);
  resetLocalModelShadowForTests();
  clearLocalModelRunsForTests();
}

function testHealthLineOff(): void {
  setLocalModelConfigForTests({ enabled: false });
  assert(
    formatLocalModelHealthLine() === "local-model: off",
    `health=${formatLocalModelHealthLine()}`,
  );
  setLocalModelConfigForTests(undefined);
}

async function main(): Promise<void> {
  testHealthLineOff();
  await testCallLocalChatPayload();
  await testShadowStoresRedactedAndCloudMeta();
  await testHangDoesNotDelayHistoryForAgent();
  await testNoShadowWhenCloudFails();
  await testOneAtATime();
  console.log("test-local-model-shadow: ok");
}

await main();
