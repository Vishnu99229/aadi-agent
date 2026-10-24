process.env.AADI_DB_PATH = ":memory:";
process.env.LLM_PROVIDER = "claude";
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.OWNER_TELEGRAM_ID = "1";
process.env.CLAUDE_MODEL = "claude-haiku-4-5";
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.BRIEF_TIME = "08:00";
process.env.CURSOR_API_KEY = "cursor-test";
process.env.GITHUB_TOKEN = "github-test";
process.env.AUTO_DEPLOY = "true";

import { createRequire } from "node:module";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Call = { method: string; url: string; body: string };

const calls: Call[] = [];
let route: (call: Call) => Response = () => {
  throw new Error("fetch route was not set");
};

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

async function readBody(body: BodyInit | null | undefined): Promise<string> {
  if (typeof body === "string") {
    return body;
  }
  return "";
}

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const call = {
    method: (init?.method ?? "GET").toUpperCase(),
    url: requestUrl(input),
    body: await readBody(init?.body),
  };
  calls.push(call);
  return route(call);
};

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function resetCalls(): void {
  calls.length = 0;
}

function pull(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7,
    node_id: "PR_NODE",
    title: "Tighten merge",
    html_url: "https://github.com/Vishnu99229/aadi-agent/pull/7",
    draft: false,
    merged: false,
    mergeable: true,
    mergeable_state: "clean",
    head: { sha: "abc123" },
    merge_commit_sha: null,
    ...extra,
  };
}

function count(method: string, part: string): number {
  return calls.filter(
    (call) => call.method === method && call.url.includes(part),
  ).length;
}

const { isPullConflict, mergePullSquash, PullMergeError } = await import(
  "../src/github_api.ts"
);

{
  resetCalls();
  route = () =>
    json(
      200,
      pull({
        merged: true,
        merge_commit_sha: "already-merged",
      }),
    );
  const sha = await mergePullSquash(7, { pollDelayMs: 0 });
  assert(sha === "already-merged", "already merged returns the merge sha");
  assert(count("POST", "/graphql") === 0, "merged pull skips ready-for-review");
  assert(count("PUT", "/merge") === 0, "merged pull skips squash");
}

{
  resetCalls();
  let gets = 0;
  route = (call) => {
    if (call.url.includes("/graphql")) {
      const body = JSON.parse(call.body) as {
        query?: string;
        variables?: { id?: string };
      };
      assert(
        body.query?.includes("markPullRequestReadyForReview") === true,
        "ready-for-review mutation",
      );
      assert(body.variables?.id === "PR_NODE", "pull node id");
      return json(200, {
        data: {
          markPullRequestReadyForReview: { pullRequest: { isDraft: false } },
        },
      });
    }
    if (call.url.includes("/merge")) {
      return json(200, { sha: "squash-sha" });
    }
    if (call.method === "GET" && call.url.includes("/pulls/7")) {
      gets += 1;
      if (gets === 1) {
        return json(
          200,
          pull({ draft: true, mergeable_state: "draft", mergeable: false }),
        );
      }
      return json(200, pull({ draft: false, mergeable_state: "clean" }));
    }
    throw new Error(`unexpected ${call.method} ${call.url}`);
  };
  const sha = await mergePullSquash(7, { pollDelayMs: 0 });
  assert(sha === "squash-sha", "draft pull merges after ready");
  assert(count("POST", "/graphql") === 1, "draft is marked ready once");
  const graphqlAt = calls.findIndex((call) => call.url.includes("/graphql"));
  const mergeAt = calls.findIndex((call) => call.url.includes("/merge"));
  assert(graphqlAt >= 0 && graphqlAt < mergeAt, "ready-for-review happens before merge");
}

{
  resetCalls();
  route = (call) => {
    if (call.url.includes("/graphql")) {
      return json(200, {
        errors: [{ message: "Resource not accessible by integration" }],
      });
    }
    if (call.method === "GET") {
      return json(200, pull({ draft: true, mergeable_state: "draft" }));
    }
    throw new Error(`unexpected ${call.method} ${call.url}`);
  };
  let message = "";
  try {
    await mergePullSquash(7, { pollDelayMs: 0 });
  } catch (error) {
    message = error instanceof Error ? error.message : "";
  }
  assert(
    message === "Resource not accessible by integration",
    "graphql error is exact",
  );
  assert(count("PUT", "/merge") === 0, "graphql failure does not merge");
}

{
  resetCalls();
  const states: Array<string | null> = [null, "unknown", "clean"];
  let gets = 0;
  route = (call) => {
    if (call.url.includes("/merge")) {
      return json(200, { sha: "after-unknown" });
    }
    if (call.method === "GET" && call.url.includes("/pulls/7")) {
      const state = states[Math.min(gets, states.length - 1)];
      gets += 1;
      return json(200, pull({ mergeable_state: state, mergeable: state === "clean" }));
    }
    throw new Error(`unexpected ${call.method} ${call.url}`);
  };
  const sha = await mergePullSquash(7, { pollDelayMs: 0 });
  assert(sha === "after-unknown", "merge after unknown clears");
  assert(gets === 3, `unknown state is polled 3 times, got ${gets}`);
  assert(count("PUT", "/merge") === 1, "merge runs once unknown clears");
}

{
  resetCalls();
  let gets = 0;
  route = (call) => {
    if (call.method === "GET" && call.url.includes("/pulls/7")) {
      gets += 1;
      const state = gets === 1 ? "unknown" : "dirty";
      return json(200, pull({ mergeable_state: state, mergeable: false }));
    }
    throw new Error(`unexpected ${call.method} ${call.url}`);
  };
  const started = Date.now();
  let caught: unknown;
  try {
    await mergePullSquash(7);
  } catch (error) {
    caught = error;
  }
  const elapsed = Date.now() - started;
  assert(caught instanceof PullMergeError, "dirty throws PullMergeError");
  assert(
    caught instanceof PullMergeError && caught.kind === "conflict",
    "dirty is a conflict",
  );
  assert(
    caught instanceof Error &&
      caught.message === "mergeable_state is dirty (merge conflict)",
    "conflict message",
  );
  assert(isPullConflict(caught), "conflict helper");
  assert(gets === 2, "unknown waits then sees the conflict");
  assert(elapsed >= 1800, "unknown waits about 2 seconds");
  assert(count("PUT", "/merge") === 0, "conflict does not call merge");
}

{
  resetCalls();
  route = (call) => {
    if (call.method === "GET") {
      return json(200, pull({ mergeable_state: "blocked", mergeable: false }));
    }
    throw new Error(`unexpected ${call.method} ${call.url}`);
  };
  let caught: unknown;
  try {
    await mergePullSquash(7, { pollDelayMs: 0 });
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof PullMergeError, "blocked throws PullMergeError");
  assert(
    caught instanceof PullMergeError && caught.kind === "blocked",
    "blocked kind",
  );
  assert(!isPullConflict(caught), "blocked is not a conflict");
  assert(count("PUT", "/merge") === 0, "blocked does not call merge");
}

{
  resetCalls();
  let gets = 0;
  route = (call) => {
    if (call.url.includes("/graphql")) {
      return json(200, {
        data: {
          markPullRequestReadyForReview: { pullRequest: { isDraft: false } },
        },
      });
    }
    if (call.method === "GET" && call.url.includes("/pulls/7")) {
      gets += 1;
      return json(
        200,
        pull({ draft: true, mergeable_state: "draft", mergeable: false }),
      );
    }
    throw new Error(`unexpected ${call.method} ${call.url}`);
  };
  let message = "";
  try {
    await mergePullSquash(7, { pollDelayMs: 0 });
  } catch (error) {
    message = error instanceof Error ? error.message : "";
  }
  assert(message === "Pull request is still a draft.", "still draft after polls");
  assert(gets === 4, "initial pull plus 3 draft polls");
  assert(count("PUT", "/merge") === 0, "draft is not merged");
}

{
  resetCalls();
  let gets = 0;
  route = (call) => {
    if (call.url.includes("/merge")) {
      return json(405, { message: "Pull Request is not mergeable" });
    }
    if (call.method === "GET") {
      gets += 1;
      return json(
        200,
        pull({
          merged: false,
          mergeable_state: "clean",
        }),
      );
    }
    throw new Error(`unexpected ${call.method} ${call.url}`);
  };
  let message = "";
  try {
    await mergePullSquash(7, { pollDelayMs: 0 });
  } catch (error) {
    message = error instanceof Error ? error.message : "";
  }
  assert(message === "Pull Request is not mergeable", "exact GitHub merge error");
  assert(gets === 2, "merge failure rechecks the pull");
}

const require = createRequire(import.meta.url);
const fetchPath = require.resolve("node-fetch");
const realNodeFetch = require("node-fetch") as ((
  input: unknown,
  init?: { method?: string; body?: unknown },
) => Promise<unknown>) & { default?: unknown };
function telegramFetch(
  input: unknown,
  init?: { method?: string; body?: unknown },
): Promise<Response> {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : String(input);
  const call = {
    method: (init?.method ?? "GET").toUpperCase(),
    url,
    body: typeof init?.body === "string" ? init.body : "",
  };
  calls.push(call);
  return Promise.resolve(route(call));
}
Object.assign(telegramFetch, realNodeFetch);
telegramFetch.default = telegramFetch;
const cached = require.cache[fetchPath];
if (!cached) {
  throw new Error("node-fetch was not loaded");
}
cached.exports = telegramFetch;

const { createBuild, getBuild, updateBuild } = await import("../src/db.ts");
const { handleBuildCallback, pollRunningBuilds } = await import("../src/builds.ts");

function keyboardText(markup: unknown): string {
  return JSON.stringify(markup ?? {});
}

function assertReviewKeyboard(markup: unknown, id: number): void {
  const text = keyboardText(markup);
  assert(text.includes("Deploy"), "Deploy button");
  assert(text.includes("Ask for changes"), "Ask button");
  assert(text.includes("Discard"), "Discard button");
  assert(text.includes(`build:deploy:${id}`), "deploy callback");
  assert(text.includes(`build:ask:${id}`), "ask callback");
  assert(text.includes(`build:discard:${id}`), "discard callback");
}

function installFlow(options: {
  pull: Record<string, unknown>;
  mergeStatus?: number;
  mergeBody?: unknown;
  telegramFailTimes?: number;
}): void {
  let telegramFails = 0;
  route = (call) => {
    if (call.url.includes("api.telegram.org")) {
      telegramFails += 1;
      if (telegramFails <= (options.telegramFailTimes ?? 0)) {
        return json(200, {
          ok: false,
          error_code: 400,
          description: "message is too long",
        });
      }
      return json(200, { ok: true, result: { message_id: 10 } });
    }
    if (call.url.includes("/pulls/7/files")) {
      return json(200, [{ filename: "src/bot.ts" }]);
    }
    if (call.url.includes("/check-runs")) {
      return json(200, {
        check_runs: [
          { name: "CI", status: "completed", conclusion: "success" },
        ],
      });
    }
    if (call.url.includes("/actions/runs")) {
      return json(200, { workflow_runs: [] });
    }
    if (call.url.includes("/graphql")) {
      return json(200, {
        data: {
          markPullRequestReadyForReview: { pullRequest: { isDraft: false } },
        },
      });
    }
    if (call.url.includes("/pulls/7/merge")) {
      return json(
        options.mergeStatus ?? 405,
        options.mergeBody ?? { message: "Pull Request is not mergeable" },
      );
    }
    if (call.url.includes("/pulls/7")) {
      return json(200, options.pull);
    }
    throw new Error(`unexpected ${call.method} ${call.url}`);
  };
}

function sentMessages(): Array<{ text?: string; reply_markup?: unknown }> {
  return calls
    .filter((call) => call.url.includes("sendMessage"))
    .map((call) => JSON.parse(call.body) as { text?: string; reply_markup?: unknown });
}

const previousCwd = process.cwd();
const scratch = await mkdtemp(join(tmpdir(), "aadi-merge-"));
process.chdir(scratch);

try {
  const ready = createBuild("show the merge card");
  updateBuild(ready.id, {
    status: "waiting_checks",
    pr_number: 7,
    pr_url: "https://github.com/Vishnu99229/aadi-agent/pull/7",
    summary: "Show merge buttons",
    files_json: JSON.stringify(["src/bot.ts"]),
  });
  resetCalls();
  installFlow({
    pull: pull({ mergeable_state: "clean" }),
    mergeStatus: 405,
    mergeBody: { message: "Pull Request is not mergeable" },
  });
  await pollRunningBuilds();
  const sent = sentMessages();
  assert(sent.length === 1, "auto-merge failure sends one card");
  assert(
    sent[0]?.text?.includes("Could not squash-merge the pull request.") === true,
    "auto-merge failure names squash-merge",
  );
  assert(
    sent[0]?.text?.includes("Pull Request is not mergeable") === true,
    "auto-merge card includes the GitHub error",
  );
  assertReviewKeyboard(sent[0]?.reply_markup, ready.id);
  const stored = getBuild(ready.id);
  assert(stored?.status === "waiting_approval", "failure waits for approval");
  assert(
    stored?.error?.includes("Pull Request is not mergeable") === true,
    "stored error includes the GitHub message",
  );

  const fallback = createBuild("fallback keyboard");
  updateBuild(fallback.id, {
    status: "waiting_checks",
    pr_number: 7,
    pr_url: "https://github.com/Vishnu99229/aadi-agent/pull/7",
    summary: "Fallback",
    files_json: JSON.stringify(["src/bot.ts"]),
  });
  resetCalls();
  installFlow({
    pull: pull({ mergeable_state: "blocked", mergeable: false }),
    telegramFailTimes: 1,
  });
  await pollRunningBuilds();
  const fallbackSent = sentMessages();
  assert(fallbackSent.length === 2, "failed card is sent again");
  assert(
    fallbackSent[1]?.text?.includes("mergeable_state is blocked") === true,
    "fallback text includes the blocked error",
  );
  assertReviewKeyboard(fallbackSent[1]?.reply_markup, fallback.id);
  assert(
    getBuild(fallback.id)?.status === "waiting_approval",
    "fallback still waits for approval",
  );

  const conflict = createBuild("manual conflict");
  updateBuild(conflict.id, {
    status: "waiting_approval",
    pr_number: 7,
    pr_url: "https://github.com/Vishnu99229/aadi-agent/pull/7",
    files_json: JSON.stringify(["src/bot.ts"]),
  });
  resetCalls();
  installFlow({
    pull: pull({ mergeable_state: "dirty", mergeable: false }),
  });
  const edits: Array<{ text: string; markup: unknown }> = [];
  await handleBuildCallback({
    callbackQuery: { data: `build:deploy:${conflict.id}` },
    answerCallbackQuery: async () => undefined,
    editMessageText: async (text: string, extra?: { reply_markup?: unknown }) => {
      edits.push({ text, markup: extra?.reply_markup });
    },
    editMessageReplyMarkup: async () => {
      throw new Error("text edit should succeed");
    },
  } as never);
  assert(edits.length === 1, "deploy failure edits the message");
  assert(
    edits[0]?.text.includes("Resolve the conflict on GitHub.") === true,
    "conflict asks Vishnu to resolve it on GitHub",
  );
  assert(
    edits[0]?.text.includes("mergeable_state is dirty (merge conflict)") === true,
    "conflict text includes the merge error",
  );
  assertReviewKeyboard(edits[0]?.markup, conflict.id);
  assert(count("GET", "/pulls/7") === 2, "manual deploy retries the merge once");
  assert(count("PUT", "/merge") === 0, "dirty conflict never calls merge");
  assert(
    getBuild(conflict.id)?.status === "waiting_approval",
    "conflict keeps the build waiting",
  );

  const retry = createBuild("manual api error");
  updateBuild(retry.id, {
    status: "waiting_approval",
    pr_number: 7,
    pr_url: "https://github.com/Vishnu99229/aadi-agent/pull/7",
    files_json: JSON.stringify(["src/bot.ts"]),
  });
  resetCalls();
  installFlow({
    pull: pull({ mergeable_state: "clean" }),
    mergeStatus: 405,
    mergeBody: { message: "Pull Request is not mergeable" },
  });
  const retryEdits: Array<{ text: string; markup: unknown }> = [];
  await handleBuildCallback({
    callbackQuery: { data: `build:deploy:${retry.id}` },
    answerCallbackQuery: async () => undefined,
    editMessageText: async (text: string, extra?: { reply_markup?: unknown }) => {
      retryEdits.push({ text, markup: extra?.reply_markup });
    },
    editMessageReplyMarkup: async () => undefined,
  } as never);
  assert(count("PUT", "/merge") === 2, "manual deploy retries a failed merge");
  assert(retryEdits.length === 1, "api failure still edits the card");
  assert(
    retryEdits[0]?.text.includes("Pull Request is not mergeable") === true,
    "manual failure includes the GitHub error",
  );
  assert(
    retryEdits[0]?.text.includes("Resolve the conflict on GitHub.") === false,
    "non-conflict failure stays on the GitHub message",
  );
  assertReviewKeyboard(retryEdits[0]?.markup, retry.id);
} finally {
  process.chdir(previousCwd);
}

console.log("merge-ready tests passed");
