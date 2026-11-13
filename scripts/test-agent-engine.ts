/**
 * The delegation engine: ordering, parallelism, retries, recovery after a real
 * crash, duplicate prevention, cancel, deadlines, pausing for input and
 * authorization. Uses a test agent whose capabilities record what they did.
 */
import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grantCountForTests, issueGrant, revokeGrant } from "../src/agents/auth.ts";
import {
  MAX_CONCURRENT_TASKS,
  MAX_DELEGATION_DEPTH,
  backoffMs,
  cancelTask,
  continueTask,
  delegate,
  expirePausedTasks,
  recoverTasks,
  setBackoffBaseMsForTests,
  startWorkflow,
} from "../src/agents/engine.ts";
import { WORKER_ID } from "../src/agents/dispatch.ts";
import { registerSpecialist } from "../src/agents/index.ts";
import type { CapabilityContext, LocalCapability } from "../src/agents/specialist.ts";
import { claimTask, createWorkflow, getTask, listTaskEvents, settleTask } from "../src/agents/store.ts";
import { AgentTaskError, InputRequiredSignal } from "../src/agents/types.ts";
import { db } from "../src/db.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

if (process.env.AADI_DB_PATH !== ":memory:") {
  throw new Error("test-agent-engine.ts must run with AADI_DB_PATH=:memory:");
}

const log = console.log;
console.log = () => undefined;
console.error = () => undefined;

const ran: string[] = [];
const count = (name: string) => ran.filter((item) => item === name).length;
let active = 0;
let peak = 0;
let flakyFailures = 2;
let reconcileVerdict: "done" | "not_done" | "unknown" = "done";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function capability(
  name: string,
  effect: LocalCapability["effect"],
  retry: LocalCapability["retry"],
  handler: (input: Record<string, unknown>, ctx: CapabilityContext) => Promise<{ text?: string; output?: Record<string, unknown> }>,
  extra: Partial<LocalCapability> = {},
): LocalCapability {
  return {
    name,
    description: name,
    kind: "workflow",
    effect,
    retry,
    usesLlm: false,
    inputSchema: { type: "object", properties: {} },
    handler: async (input, ctx) => {
      ran.push(name);
      return handler(input, ctx);
    },
    ...extra,
  };
}

registerSpecialist({
  id: "lab",
  name: "Lab",
  description: "Test agent.",
  version: "1",
  promptFile: "email.md",
  tools: [],
  noGoal: true,
  routing: { patterns: [], commandKinds: [] },
  capabilities: [
    capability("find", "read", "safe", async (input, ctx) => {
      // Persist-before-dispatch: by the time any work runs, the task is on record as working.
      const row = getTask(ctx.request.taskId);
      assert(row?.state === "working" && row.lease_owner === WORKER_ID, "the task is recorded and claimed before it runs");
      return { text: "found it", output: { value: String(input.value ?? "42") } };
    }),
    capability("use", "write", "safe", async (_input, ctx) => {
      const found = ctx.dependencies.find;
      return { text: `used ${String(found?.output?.value)}`, output: { got: found?.output?.value, state: found?.state } };
    }),
    capability("busy", "read", "safe", async () => {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(60);
      active -= 1;
      return { text: "done" };
    }),
    capability("flaky_read", "read", "safe", async () => {
      if (flakyFailures > 0) {
        flakyFailures -= 1;
        throw new AgentTaskError({ code: "transient", message: "503 from upstream", retryable: true });
      }
      return { text: "read ok" };
    }),
    capability("always_down", "read", "safe", async () => {
      throw new AgentTaskError({ code: "transient", message: "503 from upstream", retryable: true });
    }),
    capability("send_once", "external", "never", async () => {
      // The email went out, then the acknowledgment was lost.
      throw new AgentTaskError({ code: "transient", message: "socket hang up after send", retryable: true, uncertain: true });
    }),
    capability(
      "book_once",
      "external",
      "reconcile",
      async (_input, ctx) => {
        if (ctx.attempt === 1) {
          throw new AgentTaskError({ code: "transient", message: "timed out", retryable: true, uncertain: true });
        }
        return { text: "booked on the second try" };
      },
      { reconcile: async () => reconcileVerdict },
    ),
    capability("broken", "read", "safe", async () => {
      throw new TypeError("undefined is not a function");
    }),
    capability("forever", "read", "safe", async (_input, ctx) => {
      await new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      return {};
    }),
    capability("ask", "write", "safe", async (input, ctx) => {
      const answer = ctx.resume?.input.answer;
      if (answer === undefined) {
        throw new InputRequiredSignal({ question: "Which account?", fields: ["account"], from: "user" }, { step: "asked" });
      }
      return { text: `noted for ${String(answer)}`, output: { account: answer, topic: input.topic } };
    }, { inputSchema: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] } }),
    capability("send_now", "external", "never", async () => ({ text: "sent" })),
  ],
});

const owner = () => issueGrant({ source: "owner_chat", ownerText: "do it" });
const passed: string[] = [];
setBackoffBaseMsForTests(5);

// ---- dependencies: a later step waits for and receives the earlier result ----
const chain = await startWorkflow({
  title: "chain",
  origin: "chat",
  tasks: [
    { key: "use", agentId: "lab", capability: "use", input: {}, dependsOn: ["find"] },
    { key: "find", agentId: "lab", capability: "find", input: { value: "7" } },
  ],
});
assert(chain.state === "completed", `the workflow completes (${chain.state})`);
assert(ran.indexOf("find") < ran.indexOf("use"), "the dependency ran first");
assert(chain.tasks.find((task) => task.key === "use")!.output?.got === "7", "the dependent task received its result");
passed.push("dependent tasks run in order and receive the earlier result");

// ---- independent tasks run side by side, never more than the limit ----
const startedAt = Date.now();
const wide = await startWorkflow({
  title: "wide",
  origin: "chat",
  tasks: Array.from({ length: 7 }, (_, index) => ({ key: `b${index}`, agentId: "lab", capability: "busy", input: {} })),
});
const elapsed = Date.now() - startedAt;
assert(wide.state === "completed" && count("busy") === 7, "all seven ran");
assert(peak === MAX_CONCURRENT_TASKS, `at most ${MAX_CONCURRENT_TASKS} ran at once (peak ${peak})`);
assert(elapsed < 7 * 60, `in parallel, not one by one (${elapsed}ms for 7 x 60ms)`);
passed.push(`independent tasks run in parallel, bounded at ${MAX_CONCURRENT_TASKS} (7 x 60ms took ${elapsed}ms)`);

// ---- a read that fails for a moment is retried with backoff ----
assert(backoffMs(1, 1000) === 1000 && backoffMs(2, 1000) === 2000 && backoffMs(3, 1000) === 4000, "backoff doubles");
assert(backoffMs(30, 1000) <= 5 * 60 * 1000, "and is capped");
const flaky = await delegate({ agentId: "lab", capability: "flaky_read", input: {}, maxAttempts: 4 });
assert(flaky.state === "completed" && getTask(flaky.taskId)!.attempts === 3, `two failures, then success on attempt 3 (${flaky.state}, ${getTask(flaky.taskId)!.attempts})`);
const attempts = db
  .prepare(`SELECT attempt_no, outcome, error_code FROM agent_task_attempts WHERE task_id = ? ORDER BY attempt_no`)
  .all(flaky.taskId) as Array<{ attempt_no: number; outcome: string; error_code: string | null }>;
assert(attempts.length === 3 && attempts[0]!.error_code === "transient" && attempts[2]!.outcome === "completed", "each attempt is on record");
const down = await delegate({ agentId: "lab", capability: "always_down", input: {}, maxAttempts: 3 });
assert(down.state === "failed" && getTask(down.taskId)!.attempts === 3 && count("always_down") === 3, "retries stop at the limit");
const broken = await delegate({ agentId: "lab", capability: "broken", input: {}, maxAttempts: 3 });
assert(broken.state === "failed" && count("broken") === 1, "a real bug is not retried");
passed.push("transient read failures retry with capped exponential backoff; bugs and exhausted retries fail");

// ---- a send whose acknowledgment was lost is never sent again ----
const sent = await delegate({ agentId: "lab", capability: "send_once", input: {}, grant: owner(), maxAttempts: 5 });
assert(sent.state === "failed" && sent.error?.code === "uncertain_outcome", `it fails as uncertain (${sent.state} ${sent.error?.code})`);
assert(count("send_once") === 1 && getTask(sent.taskId)!.attempts === 1, "and ran exactly once despite 5 allowed attempts");
assert(/may or may not have happened/.test(sent.error?.message ?? ""), "the error says to check before repeating");
passed.push("lost acknowledgment on a send: reported uncertain, not re-sent");

// ---- reconcile: look before trying again ----
reconcileVerdict = "done";
const booked = await delegate({ agentId: "lab", capability: "book_once", input: {}, grant: owner(), maxAttempts: 3 });
assert(booked.state === "completed" && count("book_once") === 1, `already done: completed without a second run (${booked.state}, ran ${count("book_once")})`);
reconcileVerdict = "not_done";
const rebooked = await delegate({ agentId: "lab", capability: "book_once", input: {}, grant: owner(), maxAttempts: 3 });
assert(rebooked.state === "completed" && /second try/.test(rebooked.text ?? "") && count("book_once") === 3, "not done: run again");
reconcileVerdict = "unknown";
const unsure = await delegate({ agentId: "lab", capability: "book_once", input: {}, grant: owner(), maxAttempts: 3 });
assert(unsure.state === "failed" && unsure.error?.code === "uncertain_outcome" && count("book_once") === 4, "can't tell: stop and report");
passed.push("reconcile policy: done -> no rerun, not done -> rerun, unknown -> stop");

// ---- a failed step stops the steps that needed it ----
const usedBefore = count("use");
const blocked = await startWorkflow({
  title: "blocked",
  origin: "chat",
  tasks: [
    { key: "find", agentId: "lab", capability: "broken", input: {} },
    { key: "use", agentId: "lab", capability: "use", input: {}, dependsOn: ["find"] },
    { key: "other", agentId: "lab", capability: "find", input: {} },
  ],
});
const blockedUse = blocked.tasks.find((task) => task.key === "use")!;
assert(blockedUse.state === "failed" && blockedUse.error?.code === "dependency_failed" && count("use") === usedBefore, "the dependent step did not run");
assert(blocked.tasks.find((task) => task.key === "other")!.state === "completed", "an unrelated step still finished");
assert(blocked.state === "failed", "the workflow reports the failure");
passed.push("dependency failure stops dependents only");

// ---- the same request twice does the work once ----
const nowBefore = count("send_now");
const grant = owner();
const one = await delegate({ agentId: "lab", capability: "send_now", input: {}, grant, idempotencyKey: "send:msg-1" });
const two = await delegate({ agentId: "lab", capability: "send_now", input: {}, grant, idempotencyKey: "send:msg-1" });
assert(one.state === "completed" && two.state === "completed" && two.taskId === one.taskId, "the second call returns the first task");
assert(count("send_now") === nowBefore + 1, "the work ran once");
passed.push("idempotency key: a repeated request returns the first result, work runs once");

// ---- only one worker can hold a task ----
const held = createWorkflow({ title: "claim", origin: "chat", tasks: [{ key: "t", agentId: "lab", capability: "find", input: {} }] });
const heldId = held.tasks[0]!.task_id;
assert(getTask(heldId)!.state === "submitted", "a new task is on record before anything runs");
assert(claimTask(heldId, "worker-a", 60_000) !== undefined, "the first claim wins");
assert(claimTask(heldId, "worker-b", 60_000) === undefined, "the second claim gets nothing");
assert(settleTask(heldId, "worker-b", { state: "completed" }) === undefined, "a worker that doesn't hold it can't settle it");
assert(settleTask(heldId, "worker-a", { state: "completed" })?.state === "completed", "the holder can");
assert(settleTask(heldId, "worker-a", { state: "failed" }) === undefined, "and a finished task can't be settled again");
passed.push("claim exclusivity and single settlement");

// ---- cancel ----
const hanging = delegate({ agentId: "lab", capability: "forever", input: {} });
await sleep(30);
const hangingRow = db.prepare(`SELECT task_id FROM agent_tasks WHERE capability = 'forever' AND state = 'working'`).get() as { task_id: string };
assert(await cancelTask(hangingRow.task_id, "Vishnu said stop."), "cancel is accepted");
const stopped = await hanging;
assert(stopped.state === "canceled" && stopped.error?.code === "canceled", `the task is canceled (${stopped.state})`);
assert(!(await cancelTask(hangingRow.task_id)), "a finished task can't be canceled again");
passed.push("cancel stops a running task");

// ---- deadline ----
const late = await delegate({ agentId: "lab", capability: "forever", input: {}, deadlineMs: 80, maxAttempts: 3 });
assert(late.state === "failed" && late.error?.code === "deadline_exceeded", `a task past its deadline fails (${late.state} ${late.error?.code})`);
assert(getTask(late.taskId)!.attempts === 1, "and is not retried");
passed.push("deadline enforced, no retry after it");

// ---- limits and contracts ----
const deep = await delegate({ agentId: "lab", capability: "find", input: {}, depth: MAX_DELEGATION_DEPTH + 1 });
assert(deep.state === "rejected" && deep.error?.code === "depth_exceeded", "delegation depth is limited");
const nobody = await delegate({ agentId: "ghost", capability: "find", input: {} });
assert(nobody.state === "rejected" && nobody.error?.code === "unknown_agent", "an unknown agent is rejected");
const nothing = await delegate({ agentId: "lab", capability: "teleport", input: {} });
assert(nothing.state === "rejected" && nothing.error?.code === "unknown_capability", "an unknown capability is rejected");
const badInput = await delegate({ agentId: "lab", capability: "ask", input: { topic: 5 } });
assert(badInput.state === "rejected" && badInput.error?.code === "invalid_input", "input that breaks the contract is rejected");
passed.push("depth limit, unknown agent/capability and invalid input are rejected");

// ---- authorization ----
const sentBefore = count("send_now");
const noGrant = await delegate({ agentId: "lab", capability: "send_now", input: {} });
assert(noGrant.state === "auth-required" && noGrant.error?.code === "not_authorized", `no approval: waits for one (${noGrant.state})`);
const fromForward = await delegate({ agentId: "lab", capability: "send_now", input: {}, grant: issueGrant({ source: "forwarded" }) });
assert(fromForward.state === "rejected", "a forwarded message is refused");
const fromAgent = await delegate({ agentId: "lab", capability: "find", input: {}, grant: issueGrant({ source: "remote_agent" }) });
assert(fromAgent.state === "rejected", "another agent can't use a capability that isn't opened to it");
const expired = issueGrant({ source: "owner_chat", ownerText: "send it" });
revokeGrant(expired.ref);
const afterRevoke = await delegate({ agentId: "lab", capability: "send_now", input: {}, grant: expired });
assert(afterRevoke.state === "auth-required", "an approval that has ended no longer authorizes anything");
assert(count("send_now") === sentBefore, "none of those ran");
const approved = await continueTask(noGrant.taskId, {}, owner());
assert(approved?.state === "completed" && approved.taskId === noGrant.taskId && count("send_now") === sentBefore + 1, "with Vishnu's approval the same task goes ahead");
const secret = issueGrant({ source: "owner_chat", ownerText: "the secret words of the owner" });
await delegate({ agentId: "lab", capability: "send_now", input: {}, grant: secret });
const dump = JSON.stringify(
  ["agent_tasks", "agent_workflows", "agent_checkpoints", "agent_task_events", "agent_conversation_messages"].map((table) => {
    try {
      return db.prepare(`SELECT * FROM ${table}`).all();
    } catch {
      return [];
    }
  }),
);
assert(dump.includes(secret.ref), "the task records which approval it ran under");
assert(!dump.includes("the secret words of the owner"), "but the approval itself is never written to the database");
assert(grantCountForTests() > 0, "approvals live in memory only");
passed.push("authorization: external work needs Vishnu's own turn; the grant is never stored");

// ---- pausing for input, then the same task continues ----
const asked = await delegate({ agentId: "lab", capability: "ask", input: { topic: "renewal" }, grant: owner(), durable: true });
assert(asked.state === "input-required" && asked.inputRequired?.question === "Which account?", `the task pauses with its question (${asked.state})`);
const askedRow = getTask(asked.taskId)!;
const waitingOn = (taskId: string) =>
  db.prepare(`SELECT kind, prompt, state FROM agent_approvals WHERE task_id = ? ORDER BY id`).all(taskId) as Array<{ kind: string; prompt: string; state: string }>;
assert(JSON.stringify(waitingOn(asked.taskId)) === JSON.stringify([{ kind: "input", prompt: "Which account?", state: "pending" }]), "what it is waiting on is on record");
const answered = await continueTask(asked.taskId, { answer: "Acme" }, owner());
assert(answered?.state === "completed" && answered.text === "noted for Acme", "the answer completes it");
assert(answered!.taskId === asked.taskId && answered!.contextId === asked.contextId, "same task, same conversation");
assert(answered!.output?.topic === "renewal", "with its original input intact");
assert(getTask(asked.taskId)!.attempts === askedRow.attempts + 1, "as a second attempt of that task");
assert(db.prepare(`SELECT COUNT(*) AS n FROM agent_tasks WHERE capability = 'ask' AND state != 'rejected'`).get()!.n === 1, "no second task was created");
assert((await continueTask(asked.taskId, { answer: "again" }, owner())) === undefined, "a finished task can't be continued");
assert(waitingOn(asked.taskId).map((row) => row.state).join(",") === "granted", "and the wait is closed as answered");
const events = listTaskEvents(asked.taskId).map((event) => `${event.from_state}>${event.to_state}`);
assert(events.join(" ").includes("working>input-required") && events.join(" ").includes("input-required>submitted") && events.at(-1) === "working>completed", `every transition is on record (${events.join(", ")})`);
const turns = db.prepare(`SELECT COUNT(*) AS n FROM agent_conversation_messages WHERE context_id = ?`).get(asked.contextId) as { n: number };
assert(turns.n >= 4, "the conversation with the agent is kept under one context");
const abandoned = await delegate({ agentId: "lab", capability: "ask", input: { topic: "old" }, grant: owner(), durable: true });
assert(expirePausedTasks(new Date(Date.now() + 2 * 24 * 3600 * 1000)) === 0, "a paused task is kept for a while");
assert(expirePausedTasks(new Date(Date.now() + 4 * 24 * 3600 * 1000)) >= 1 && getTask(abandoned.taskId)!.state === "canceled", "and dropped if nobody answers");
assert(waitingOn(abandoned.taskId).map((row) => row.state).join(",") === "expired", "with its wait closed as expired");
const needsHim = await delegate({ agentId: "lab", capability: "send_now", input: {}, durable: true });
assert(needsHim.state === "auth-required" && waitingOn(needsHim.taskId)[0]?.kind === "authorization", `work that needs Vishnu waits for him, on record (${needsHim.state})`);
await cancelTask(needsHim.taskId);
assert(waitingOn(needsHim.taskId).map((row) => row.state).join(",") === "denied", "and dropping it closes the wait");
passed.push("input-required -> continue: same taskId and contextId; transitions, conversation and pending approvals recorded");

// ---- a real restart: kill -9 mid-task, then a new process recovers ----
const dir = mkdtempSync(join(tmpdir(), "aadi-engine-"));
const effectsFile = join(dir, "effects.log");
const env = { ...process.env, AADI_DB_PATH: join(dir, "crash.db"), CRASH_EFFECTS_FILE: effectsFile };
const children: ChildProcess[] = [];
function child(mode: string): { process: ChildProcess; output: () => string } {
  const proc = spawn(process.execPath, ["--import", "tsx", "scripts/agent-crash-child.ts", mode], { env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(proc);
  let out = "";
  proc.stdout?.on("data", (chunk: Buffer) => {
    out += chunk.toString();
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    out += chunk.toString();
  });
  return { process: proc, output: () => out };
}
async function until(read: () => string | undefined, what: string, ms = 40_000): Promise<string> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(25);
  }
}
try {
  const first = child("engine-start");
  await until(() => (first.output().includes("STARTED") ? "ok" : undefined), `the first process to be mid-task: ${first.output().slice(-300)}`);
  first.process.kill("SIGKILL");
  await new Promise((resolve) => first.process.once("exit", resolve));
  const second = child("engine-recover");
  const line = await until(() => /RESULT (.+)/.exec(second.output())?.[1], "the restarted process to recover");
  const result = JSON.parse(line) as {
    report: { interrupted: number; resumed: number; uncertain: number };
    tasks: Array<{ task_key: string; state: string; attempts: number; error_json: string | null; result_json: string | null }>;
  };
  const byKey = Object.fromEntries(result.tasks.map((task) => [task.task_key, task]));
  const effects = readFileSync(effectsFile, "utf8").split("\n").filter(Boolean);
  const times = (name: string) => effects.filter((item) => item === name).length;
  assert(byKey.lookup!.state === "completed" && byKey.lookup!.attempts === 2 && times("lookup") === 2, `the read was run again and finished (${JSON.stringify(byKey.lookup)})`);
  assert(byKey.after!.state === "completed" && times("after_lookup") === 1, "the step waiting on it then ran");
  assert(byKey.send!.state === "failed" && /uncertain_outcome/.test(byKey.send!.error_json ?? ""), `the send is reported uncertain (${JSON.stringify(byKey.send)})`);
  assert(times("send_like") === 1, `and was NOT sent a second time (ran ${times("send_like")}x)`);
  assert(byKey.book!.state === "completed" && times("book_like") === 1, `the booking was found already done and not repeated (${JSON.stringify(byKey.book)})`);
  assert(result.report.resumed >= 2 && result.report.uncertain === 1, `the recovery report says so (${JSON.stringify(result.report)})`);
  passed.push("kill -9 mid-workflow: read re-run, dependent resumed, send not repeated (uncertain), booking reconciled as done");
} finally {
  for (const proc of children) {
    proc.kill("SIGKILL");
  }
  rmSync(dir, { recursive: true, force: true });
}

// ---- nothing in this process is left to recover ----
const idle = await recoverTasks({ wait: true });
assert(idle.uncertain === 0, "a recovery scan on a healthy process changes nothing");

setBackoffBaseMsForTests(undefined);
log(passed.map((line) => `  ok  ${line}`).join("\n"));
log("Agent engine checks passed.");
process.exit(0);
