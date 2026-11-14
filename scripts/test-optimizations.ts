/**
 * The efficiency layer: resource references, the typed agent protocol, context
 * compression, the shared result cache, the global scheduler, circuit
 * breakers, correction signals, model recommendations, parallel workflows and
 * the measurements that report all of it.
 *
 * Scripted model and tools; nothing reaches a provider, Gmail, Calendar or
 * Telegram.
 */
import { readFileSync } from "node:fs";
import { newRunReport, setToolInterceptorForTests } from "../src/agent.ts";
import { issueGrant } from "../src/agents/auth.ts";
import { cacheGet, cachePut, cacheStats, clearCacheForTests, isCacheable } from "../src/agents/cache.ts";
import { historyForSpecialist, looksLikeFollowUp } from "../src/agents/context.ts";
import { delegate, startWorkflow } from "../src/agents/engine.ts";
import { setGoalLimitsForTests } from "../src/agents/goal_policy.ts";
import { runOwnerTurn } from "../src/agents/orchestrator.ts";
import { messageBytes, taskMessage, toAgentResult } from "../src/agents/protocol.ts";
import { canOpen, describeRef, extractRefs, makeRef, parseRef, readerFor } from "../src/agents/refs.ts";
import { db, saveMessage } from "../src/db.ts";
import { classifyFeedback, isRepeat, noteOwnerMessage, noteRetryTap } from "../src/feedback.ts";
import {
  acquire,
  governorSnapshot,
  runWithPriority,
  setGovernorLimitsForTests,
} from "../src/governor.ts";
import { setCompleteForTests, setRouteModelCompleteForTests, type CompleteParams, type CompleteResult } from "../src/llm.ts";
import { clearLlmBackendFlagsForTests } from "../src/llm_fallback.ts";
import { formatAgentsReport, initMetrics, optimizationStats } from "../src/metrics.ts";
import { getAgentModelSetting, resetAgentModelSettings, setAgentModelSetting } from "../src/models/agent_models.ts";
import { circuitState, formatProviderHealth, recordCall, resetCircuitsForTests, setCircuitProbe } from "../src/models/circuit.ts";
import { computeRecommendations, decideRecommendation, formatRecommendations, listRecommendations } from "../src/models/evaluation.ts";
import { formatAgentHealthLines } from "../src/scheduler.ts";
import { modelReply, nextMessageId } from "./fakes.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

if (process.env.AADI_DB_PATH !== ":memory:") {
  throw new Error("test-optimizations.ts must run with AADI_DB_PATH=:memory:");
}

const log = console.log;
console.log = () => undefined;
console.error = () => undefined;
console.warn = () => undefined;

initMetrics();
const passed: string[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const CHAT = 77;
const confirm = () => ({ chatId: CHAT, messageId: nextMessageId() });
const owner = (text: string) => issueGrant({ source: "owner_chat", ownerText: text, confirmation: confirm() });

const modelCalls: CompleteParams[] = [];
let script: Array<(params: CompleteParams) => CompleteResult | Promise<CompleteResult>> = [];
const toolLog: string[] = [];
let handlers: Record<string, (input: Record<string, unknown>) => string | undefined> = {};

function defaultModel(params: CompleteParams): CompleteResult {
  const last = params.messages.at(-1);
  return modelReply({ text: last?.role === "tool" ? `Done: ${last.content.slice(0, 60)}` : "Done." });
}
setCompleteForTests(async (params) => {
  // The loop keeps appending to the same array; keep what this call saw.
  modelCalls.push({ ...params, messages: [...params.messages] });
  // A history summary has no tools; it doesn't take a scripted step.
  if (params.tools.length === 0) {
    return modelReply({ text: "Summary." });
  }
  const step = script.shift();
  return step ? step(params) : defaultModel(params);
});
setToolInterceptorForTests((call) => {
  toolLog.push(call.name);
  const handler = handlers[call.name];
  return handler ? handler((call.input ?? {}) as Record<string, unknown>) : "ok";
});
setGoalLimitsForTests({ enabled: true, maxConcurrent: 3, goalBudgetUsd: 1, workflowBudgetUsd: 3, maxModelCalls: 60 });

async function say(text: string): Promise<string> {
  const confirmation = confirm();
  return runOwnerTurn(text, { ownerText: text, guardText: text, chatId: CHAT, sendConfirmation: confirmation, postCard: async () => undefined });
}

// ---------------------------------------------------------------- references
const emailRef = makeRef("email", "18c92abcdef0", { account: "work" });
assert(emailRef === "email:work:18c92abcdef0", `email reference form (${emailRef})`);
assert(JSON.stringify(parseRef(emailRef)) === JSON.stringify({ kind: "email", account: "work", id: "18c92abcdef0" }), "a reference parses back");
const eventRef = makeRef("calendar", "ev 1", { account: "personal", hint: "2026-11-18" });
assert(parseRef(eventRef)?.hint === "2026-11-18" && parseRef(eventRef)?.id === "ev 1", "calendar references carry the date to look in");
assert(readerFor(parseRef(emailRef)!)?.tool === "read_email" && readerFor(parseRef("account:Pinnacle")!)?.tool === "account_status", "each kind names the tool that opens it");
const salesTools = new Set(["account_status", "list_accounts"]);
assert(!canOpen(parseRef(emailRef)!, salesTools) && canOpen(parseRef("account:Pinnacle")!, salesTools), "an agent can open only references its own tools read");
assert(/not yours to open/.test(describeRef(emailRef, salesTools)), "and is told so");
assert(extractRefs('{"id":"18c92abcdef01234","account":"work"} document_id: 42 [work]').includes("email:work:18c92abcdef01234"), "references are pulled from tool output by pattern, no model");
// Passing a reference grants nothing: the Sales Agent asked to open an email is refused by the dispatcher.
script = [
  (params) => {
    assert(String(params.messages[0]?.content).includes("not yours to open"), "the goal shows the email reference as not openable");
    return modelReply({ tools: [{ name: "read_email", input: { id: "18c92abcdef0", account: "work" } }] });
  },
  (params) => {
    const last = params.messages.at(-1);
    assert(last?.role === "tool" && /belongs to another agent|not available/i.test(last.content), `read_email is refused to the Sales Agent (${last?.role === "tool" ? last.content : ""})`);
    return modelReply({ text: "Couldn't read it." });
  },
];
toolLog.length = 0;
await delegate({ agentId: "sales", capability: "goal", input: { goal: "Judge this email.", refs: [emailRef] }, grant: owner("judge it") });
assert(!toolLog.includes("read_email"), "a reference does not bypass tool ownership");
passed.push("references: pointers with the tool that opens them; opening one still needs that tool and permission");

// ---------------------------------------------------------------- the typed protocol
const deps = {
  read: {
    key: "read",
    agentId: "email",
    capability: "goal",
    state: "completed" as const,
    text: `Prospect asked to schedule a discussion. ${"Long thread text. ".repeat(400)}`,
    output: { summary: "Prospect asked to schedule a discussion.", data: { intent: "meeting", duration_min: 30 }, refs: [emailRef], tools: [{ tool: "read_email" }], run: { ms: 10 } },
  },
};
const message = taskMessage(
  {
    workflowId: "wf_test",
    taskId: "task_test",
    agentId: "sales",
    capability: "goal",
    input: { goal: "Judge follow-up.", refs: ["account:17"], constraints: { do_not_send: true }, expected_output: "decision and confidence" },
    contextRefs: [],
    contextId: "ctx",
    correlationId: "corr",
    authRef: "auth_123",
    depth: 1,
  },
  deps,
  { priority: "high" },
);
assert(message.type === "task" && message.from === "aadi" && message.to === "sales" && message.capability === "goal", "a task message names sender, receiver and capability");
assert(JSON.stringify(message.constraints) === '{"do_not_send":true}' && message.refs?.join() === "account:17" && message.expectedOutput === "decision and confidence", "with constraints, refs and the expected output");
assert(message.authRef === "auth_123" && !JSON.stringify(message).includes("ownerText") && !JSON.stringify(message).includes("confirmation"), "an authorization reference, never the authorization");
const dep = message.dependencyResults![0]!;
assert(dep.summary === "Prospect asked to schedule a discussion." && (dep.data as { intent?: string }).intent === "meeting" && dep.refs?.includes(emailRef), "a dependency arrives as summary, data and references");
assert(!JSON.stringify(dep).includes("Long thread text") && !JSON.stringify(dep).includes("read_email\"}"), "not as the raw thread or the tool trace");
assert(messageBytes(message) < 1500, `a structured message is small (${messageBytes(message)} bytes)`);
const salesResult = toAgentResult({
  state: "completed",
  text: "Prospect asked to schedule a discussion.",
  output: { summary: "Prospect asked to schedule a discussion.", data: { decision: "follow_up" }, confidence: 0.91, suggested_next_steps: ["calendar.goal", "email.goal"], tools: [], run: {} },
});
assert(salesResult.status === "completed" && salesResult.confidence === 0.91 && salesResult.suggestedNextSteps?.join() === "calendar.goal,email.goal", "results carry status, confidence and suggested next steps");
assert(!("tools" in (salesResult.data ?? {})) && (salesResult.data as { decision?: string }).decision === "follow_up", "and data without bookkeeping");
// A goal loop can finish with report_result, and suggestions name only real capabilities.
script = [() => modelReply({ tools: [{ name: "report_result", input: { summary: "Follow up.", data: { decision: "follow_up" }, confidence: 0.9, refs: [emailRef, "nonsense"], suggested_next_steps: ["calendar.goal", "nobody.fly"] } }] })];
const reported = await delegate({ agentId: "sales", capability: "goal", input: { goal: "Judge follow-up." }, grant: owner("judge") });
const out = reported.output as { data?: { decision?: string }; confidence?: number; refs?: string[]; suggested_next_steps?: string[] };
assert(reported.state === "completed" && reported.text === "Follow up." && out.data?.decision === "follow_up" && out.confidence === 0.9, `report_result gives a structured result (${reported.state})`);
assert(out.refs?.join() === emailRef && out.suggested_next_steps?.join() === "calendar.goal", "unknown references and capabilities are dropped");
passed.push("typed protocol: task and result objects with refs, constraints, compact dependencies and next steps; report_result");

// ---------------------------------------------------------------- context compression
for (let index = 0; index < 30; index += 1) {
  saveMessage("user", `Earlier question ${index} about the Northwind renewal and the Q3 pipeline numbers.`);
  saveMessage("assistant", `Earlier answer ${index}: ${"details ".repeat(40)}`);
}
modelCalls.length = 0;
const callsBefore = modelCalls.length;
await say("What's on my calendar on Friday afternoon please");
const specialistCall = modelCalls.find((params) => params.route?.agentId === "calendar")!;

assert(specialistCall !== undefined && specialistCall.messages.length === 1, `a standalone request gives the specialist no chat history (${specialistCall?.messages.length})`);
const standalone = db.prepare(`SELECT ctx_original_tokens, ctx_compressed_tokens FROM metric_agent_runs WHERE agent_id = 'calendar' AND kind = 'turn' ORDER BY id DESC LIMIT 1`).get() as {
  ctx_original_tokens: number;
  ctx_compressed_tokens: number;
};
assert(standalone.ctx_original_tokens > 1000 && standalone.ctx_compressed_tokens < standalone.ctx_original_tokens / 10, `the turn records what was avoided (${JSON.stringify(standalone)})`);
assert(modelCalls.length - callsBefore === 2, "compression needed no model call of its own");
saveMessage("user", "Find Hardik's latest email.");
saveMessage("tool", '{"id":"18c92abcdef01234","from":"hardik@pinnacle.in","account":"work"} [work]', "search_emails");
saveMessage("assistant", "Hardik asked for the renewal terms by Friday.");
modelCalls.length = 0;
await say("Draft a reply to that email saying Thursday works");
const followCall = modelCalls.find((params) => params.route?.agentId === "email")!;
const followText = JSON.stringify(followCall.messages) + JSON.stringify(followCall.system);
assert(followCall.messages.length >= 2 && followText.includes("Hardik asked for the renewal terms"), "a follow-up gets the previous exchange");
assert(!followText.includes("Earlier question 3 "), "but not the older conversation");
assert(followText.includes("email:work:18c92abcdef01234"), "and earlier tool output only as a reference");
assert(looksLikeFollowUp("send it to him") && !looksLikeFollowUp("What's the weather in Bangalore this week"), "follow-ups are told apart by pattern");
const measured = historyForSpecialist("Draft it", [], "Vishnu prefers short emails. The Q3 numbers are final.");
assert(measured.summary === "" && measured.measure.compressedTokens <= measured.measure.originalTokens, "only summary facts that share a word with the request are kept");
passed.push("context compression: no history for standalone requests, last exchange plus references for follow-ups, tokens avoided recorded, no model call");

// ---------------------------------------------------------------- shared result cache
clearCacheForTests();
let releaseRuns = 0;
handlers = {
  latest_release: () => {
    releaseRuns += 1;
    return "Latest stable release of A2A: v1.0.0 (2026-03-12). https://github.com/a2aproject/A2A/releases";
  },
};
script = [() => modelReply({ tools: [{ name: "latest_release", input: { project: "A2A", repo: "a2aproject/A2A" } }] })];
await delegate({ agentId: "knowledge", capability: "goal", input: { goal: "Find the latest A2A release." }, grant: owner("find the A2A release") });
script = [() => modelReply({ tools: [{ name: "latest_release", input: { repo: "https://github.com/A2AProject/A2A", project: "A2A" } }] })];
const fromSales = await say("Tell me the A2A protocol release that is current please");
assert(releaseRuns === 1, `the second agent got the cached release (${releaseRuns} run)`);
assert(/v1\.0\.0/.test(fromSales), "with the same answer");
const entry = db.prepare(`SELECT cache_key, created_by, source_refs_json, expires_at, freshness FROM agent_cache WHERE tool = 'latest_release'`).get() as {
  cache_key: string;
  created_by: string;
  source_refs_json: string;
  expires_at: string;
  freshness: string;
};
assert(entry.cache_key === "latest_release:a2aproject/a2a" && entry.created_by === "knowledge" && entry.freshness === "release", `the entry has key, creator and policy (${JSON.stringify(entry)})`);
assert(entry.source_refs_json.includes("github.com/a2aproject") && Date.parse(entry.expires_at) - Date.now() > 25 * 60_000, "its sources and a 30-minute life");
script = [() => modelReply({ tools: [{ name: "latest_release", input: { repo: "a2aproject/A2A", project: "A2A", fresh: true } }] })];
await say("Check the A2A release once more, I need it fresh");
assert(releaseRuns === 2, "fresh: true asks the source again");
assert(cacheGet("latest_release", { repo: "a2aproject/A2A" }, "test", Date.now() + 31 * 60_000) === undefined, "an expired entry is not used");
// Writes are never cached; a write clears the writer's changeable reads.
let statusRuns = 0;
handlers = {
  account_status: () => {
    statusRuns += 1;
    return `Pinnacle: stage proposal (${statusRuns})`;
  },
  update_account: () => "Updated Pinnacle.",
  add_task: () => "Task added.",
};
const grant = owner("check pinnacle");
await delegate({ agentId: "sales", capability: "account_status", input: { name: "Pinnacle" }, grant });
await delegate({ agentId: "sales", capability: "account_status", input: { name: "Pinnacle" }, grant });
assert(statusRuns === 1, "an account lookup is reused");
assert(!isCacheable("add_task") && !isCacheable("send_email") && !isCacheable("update_account"), "writes are never cacheable");
await delegate({ agentId: "sales", capability: "update_account", input: { name: "Pinnacle", stage: "won" }, grant: owner("mark pinnacle won") });
await delegate({ agentId: "sales", capability: "account_status", input: { name: "Pinnacle" }, grant });
assert(statusRuns === 2, "after an update the account is read again");
// Gmail: only address-only searches are reused, and his words can ask for the current state.
assert(!isCacheable("search_emails", { query: "from:hardik" }) && isCacheable("search_emails", { query: "from:hardik@pinnacle.in" }), "a search that names a person isn't cached; an address is");
let searchRuns = 0;
handlers = { search_emails: () => `Found ${(searchRuns += 1)} message(s).` };
const mailGrant = owner("show mail from hardik@pinnacle.in");
await delegate({ agentId: "email", capability: "search_emails", input: { query: "from:hardik@pinnacle.in" }, grant: mailGrant });
await delegate({ agentId: "email", capability: "search_emails", input: { query: "from:hardik@pinnacle.in" }, grant: mailGrant });
assert(searchRuns === 1, "the same address search a moment later is reused");
await delegate({ agentId: "email", capability: "search_emails", input: { query: "from:hardik@pinnacle.in" }, grant: owner("check again for mail from hardik@pinnacle.in") });
assert(searchRuns === 2, "\"check again\" in his words fetches the current state");
// The cache never widens permissions: a forwarded message can't reach a tool outside its list through it.
cachePut("send_email", {}, "should never be stored", "email");
assert((db.prepare(`SELECT COUNT(*) AS n FROM agent_cache WHERE tool = 'send_email'`).get() as { n: number }).n === 0, "a write result is never stored");
const stats = cacheStats(new Date(Date.now() - 3600_000).toISOString(), new Date(Date.now() + 1000).toISOString());
assert(stats.hits >= 3 && stats.misses >= 3 && stats.hitRate !== undefined, `hits and misses are counted (${JSON.stringify(stats)})`);
handlers = {};
passed.push("shared cache: cross-agent reuse with key, creator, sources and TTL; fresh bypass; expiry; writes never cached and clear stale reads");

// ---------------------------------------------------------------- global scheduler
setGovernorLimitsForTests({ providerConcurrency: 1, backgroundWhileActive: 0 });
const order: string[] = [];
const holder = await acquire("model:testprov", "delegated");
const queued = [
  runWithPriority("background", async () => {
    const slot = await acquire("model:testprov");
    order.push("background");
    slot.release();
  }),
  runWithPriority("delegated", async () => {
    const slot = await acquire("model:testprov");
    order.push("delegated");
    slot.release();
  }),
  runWithPriority("a2a", async () => {
    const slot = await acquire("model:testprov");
    order.push("a2a");
    slot.release();
  }),
  runWithPriority("foreground", async () => {
    const slot = await acquire("model:testprov");
    order.push("foreground");
    await sleep(20);
    slot.release();
  }),
];
await sleep(10);
assert(governorSnapshot().pools.find((pool) => pool.name === "model:testprov")?.queued === 4, "a full pool queues the work instead of failing it");
holder.release();
await Promise.all(queued);
assert(order.join(",") === "foreground,a2a,delegated,background", `the queue serves by priority (${order.join(",")})`);
// Background waits while Vishnu is mid-turn, even with a free slot.
setGovernorLimitsForTests({ providerConcurrency: 2, backgroundWhileActive: 0 });
const sequence: string[] = [];
let releaseTurn: () => void = () => undefined;
const turn = runWithPriority("foreground", async () => {
  sequence.push("turn started");
  await new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  sequence.push("turn done");
});
const scan = runWithPriority("background", async () => {
  const slot = await acquire("model:testprov2");
  sequence.push("scan ran");
  slot.release();
});
await sleep(20);
assert(!sequence.includes("scan ran"), "a background model call waits while a foreground turn runs");
releaseTurn();
await Promise.all([turn, scan]);
assert(sequence.join(",") === "turn started,turn done,scan ran", `and runs once the turn ends (${sequence.join(",")})`);
const waits = db.prepare(`SELECT COUNT(*) AS n FROM metric_waits WHERE pool LIKE 'model:testprov%'`).get() as { n: number };
assert(waits.n >= 4, `queue waits are recorded apart from execution (${waits.n})`);
// Global goal-loop limit across workflows.
setGovernorLimitsForTests({ goalLoops: 2 });
let inFlight = 0;
let maxInFlight = 0;
setCompleteForTests(async (params) => {
  if (params.tools.some((tool) => "name" in tool && tool.name === "request_input")) {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await sleep(40);
    inFlight -= 1;
  }
  return modelReply({ text: "ok" });
});
await Promise.all(
  [0, 1].map((flow) =>
    startWorkflow({
      title: `flow ${flow}`,
      origin: "delegate",
      grant: owner("two jobs"),
      tasks: ["knowledge", "sales", "operations"].map((agentId) => ({ key: agentId, agentId, capability: "goal", input: { goal: "a small check" }, depth: 1 })),
    }),
  ),
);
assert(maxInFlight <= 2 && maxInFlight >= 2, `at most 2 goal loops ran at once across both workflows (${maxInFlight})`);
setGovernorLimitsForTests(undefined);
setCompleteForTests(async (params) => {
  // The loop keeps appending to the same array; keep what this call saw.
  modelCalls.push({ ...params, messages: [...params.messages] });
  // A history summary has no tools; it doesn't take a scripted step.
  if (params.tools.length === 0) {
    return modelReply({ text: "Summary." });
  }
  const step = script.shift();
  return step ? step(params) : defaultModel(params);
});
passed.push("global scheduler: priority queue (foreground > a2a > delegated > background), background held while Vishnu is active, global goal-loop cap, waits recorded");

// ---------------------------------------------------------------- circuit breakers
resetCircuitsForTests({ consecutiveFailures: 3, cooldownMs: 60 });
clearLlmBackendFlagsForTests();
setAgentModelSetting("calendar", { primary: "gemini:flash", fallbacks: ["openai:fast"] });
let probeResult = true;
let probes = 0;
setCircuitProbe(async () => {
  probes += 1;
  return probeResult;
});
const served: string[] = [];
let geminiDown = true;
setCompleteForTests(undefined);
setRouteModelCompleteForTests(async (spec) => {
  served.push(spec.key);
  if (spec.provider === "gemini" && geminiDown) {
    throw new Error("503 Service Unavailable");
  }
  return modelReply({ text: `answered by ${spec.key}` });
});
for (let index = 0; index < 3; index += 1) {
  await delegate({ agentId: "calendar", capability: "goal", input: { goal: `check ${index}` }, grant: owner("check") });
}
assert(circuitState("gemini") === "OPEN", `three failures in a row open Gemini's circuit (${circuitState("gemini")})`);
served.length = 0;
const routed = await delegate({ agentId: "calendar", capability: "goal", input: { goal: "check while open" }, grant: owner("check") });
assert(routed.text === "answered by openai:fast" && !served.includes("gemini:flash"), `new work goes to the fallback without trying Gemini (${served.join(",")})`);
assert(/gemini OPEN/.test(formatProviderHealth()) && formatAgentHealthLines().some((line) => /providers:.*gemini OPEN/.test(line)), "provider health shows it in /health");
await sleep(80);
probeResult = false;
await delegate({ agentId: "calendar", capability: "goal", input: { goal: "after cooldown" }, grant: owner("check") });
await sleep(10);
assert(probes === 1 && circuitState("gemini") === "OPEN", `after the cooldown one probe ran and failed: open again (${probes} ${circuitState("gemini")})`);
await sleep(150);
probeResult = true;
geminiDown = false;
await delegate({ agentId: "calendar", capability: "goal", input: { goal: "after longer cooldown" }, grant: owner("check") });
await sleep(10);
assert(probes === 2 && circuitState("gemini") === "CLOSED", `a successful probe closes it (${circuitState("gemini")})`);
served.length = 0;
const healthy = await delegate({ agentId: "calendar", capability: "goal", input: { goal: "healthy again" }, grant: owner("check") });
assert(healthy.text === "answered by gemini:flash", "and Gemini takes the agent's work again");
// Slow, malformed and formatting failures count too.
resetCircuitsForTests({ minSamples: 4, failureRate: 0.5 });
recordCall("deepseek", "ok", 100);
recordCall("deepseek", "malformed", 100);
recordCall("deepseek", "tool_format", 100);
recordCall("deepseek", "rate_limit", 100);
assert(circuitState("deepseek") === "OPEN", "a high failure rate (malformed, tool formatting, 429) opens a circuit");
resetCircuitsForTests({ slowMs: 1000 });
for (let index = 0; index < 3; index += 1) {
  recordCall("kimi", "ok", 2000);
}
assert(circuitState("kimi") === "OPEN", "so does severe latency");
setRouteModelCompleteForTests(undefined);
resetCircuitsForTests();
setCompleteForTests(async (params) => {
  // The loop keeps appending to the same array; keep what this call saw.
  modelCalls.push({ ...params, messages: [...params.messages] });
  // A history summary has no tools; it doesn't take a scripted step.
  if (params.tools.length === 0) {
    return modelReply({ text: "Summary." });
  }
  const step = script.shift();
  return step ? step(params) : defaultModel(params);
});
passed.push("circuit breakers: open on failures, rate or latency; route to the fallback; one half-open probe; close on success, reopen on failure");

// ---------------------------------------------------------------- corrections
assert(classifyFeedback("No, I meant Hardik from Pinnacle.")?.category === "wrong_person", "\"No, I meant…\" is a wrong-person correction");
assert(classifyFeedback("That is the wrong meeting.")?.category === "wrong_item", "wrong meeting");
assert(classifyFeedback("Rewrite it, that email is too formal.")?.category === "tone", "tone");
assert(classifyFeedback("That research is outdated.")?.category === "outdated", "outdated");
for (const ordinary of ["no thanks", "No, that's all", "and also remind me tomorrow", "thanks!", "What about Friday?", "no problem"]) {
  assert(classifyFeedback(ordinary) === undefined, `an ordinary follow-up is not a correction: "${ordinary}"`);
}
assert(isRepeat("find hardik's latest email", "Find Hardik's latest email!") && !isRepeat("find hardik's latest email", "find priya's latest email"), "the same request again is a repeat");
await say("Find Hardik's latest email");
const lastTurnRow = db.prepare(`SELECT id, agents_json FROM metric_turns WHERE chat_id = ? ORDER BY id DESC LIMIT 1`).get(CHAT) as { id: number; agents_json: string };
const signal = noteOwnerMessage(CHAT, "No, I meant Hardik from Pinnacle.");
const feedbackRow = db.prepare(`SELECT * FROM metric_feedback ORDER BY id DESC LIMIT 1`).get() as Record<string, unknown>;
assert(signal?.kind === "correction" && feedbackRow.turn_id === lastTurnRow.id, "a correction is tied to the previous turn");
assert(feedbackRow.agent_id === JSON.parse(lastTurnRow.agents_json)[0] && typeof feedbackRow.model === "string" && feedbackRow.category === "wrong_person", `with its agent, model and category (${JSON.stringify(feedbackRow)})`);
assert(noteOwnerMessage(CHAT, "and also check Priya's") === undefined, "a plain follow-up records nothing");
noteRetryTap(CHAT);
assert((db.prepare(`SELECT COUNT(*) AS n FROM metric_feedback WHERE kind = 'retry'`).get() as { n: number }).n >= 1, "the Retry button counts as a retry");
passed.push("corrections: clear corrections, retries and complaints tied to the previous turn's agent, model and tools; follow-ups ignored");

// ---------------------------------------------------------------- recommendations
resetAgentModelSettings();
const insert = db.prepare(
  `INSERT INTO metric_agent_runs (created_at, agent_id, kind, primary_model, served_model, fallback, model_calls, input_tokens, output_tokens, cost_usd, latency_ms, tool_calls, tool_errors, outcome)
   VALUES (?, 'knowledge', 'goal', ?, ?, 0, 2, 900, 120, ?, ?, 2, 0, ?)`,
);
const now = new Date().toISOString();
for (let index = 0; index < 25; index += 1) {
  insert.run(now, "kimi:main", "kimi:main", 0.0018, 8200, index === 0 ? "failed" : "completed");
}
for (let index = 0; index < 20; index += 1) {
  insert.run(now, "kimi:main", "gemini:flash", 0.0007, 3100, index === 0 ? "failed" : "completed");
}
const before = getAgentModelSetting("knowledge").primary;
const recs = computeRecommendations();
const rec = recs.find((item) => item.agentId === "knowledge");
assert(rec !== undefined && rec.currentModel === "kimi:main" && rec.suggestedModel === "gemini:flash", `Gemini is recommended for Knowledge (${JSON.stringify(recs.map((item) => item.suggestedModel))})`);
assert(/faster and cheaper/.test(rec!.reason), `because it is faster and cheaper at similar success (${rec!.reason})`);
assert(getAgentModelSetting("knowledge").primary === before, "computing recommendations changes nothing");
const text = formatRecommendations(recs);
assert(/Knowledge Agent/.test(text) && /Current: Kimi/.test(text) && /Recommendation: consider Gemini/.test(text) && /tap Accept/.test(text), "the text shows both models and asks for his decision");
const rejected = decideRecommendation(rec!.id, false);
assert(rejected.ok && getAgentModelSetting("knowledge").primary === "kimi:main", "Reject keeps the model");
assert(!computeRecommendations().some((item) => item.agentId === "knowledge"), "and the same suggestion isn't made again in the window");
db.prepare(`UPDATE model_recommendations SET status = 'open', decided_at = NULL WHERE id = ?`).run(rec!.id);
const accepted = decideRecommendation(rec!.id, true);
const after = getAgentModelSetting("knowledge");
assert(accepted.ok && after.primary === "gemini:flash" && Array.isArray(after.fallbacks) && after.fallbacks[0] === "kimi:main", `Accept switches it, keeping Kimi as the fallback (${JSON.stringify(after)})`);
assert(listRecommendations("accepted").length === 1, "and the decision is recorded");
// The Telegram buttons go through the same decision, and /agents offers them.
const botSource = readFileSync("src/bot.ts", "utf8");
assert(/callbackQuery\(\/\^rec:\(a\|r\)/.test(botSource) && /decideRecommendation\(Number\(ctx\.match\[2\]\), ctx\.match\[1\] === "a"\)/.test(botSource), "the Accept and Reject buttons call the same decision");
assert(/rec:a:\$\{item\.id\}/.test(botSource) && /argument\.startsWith\("rec"\)/.test(botSource), "/agents recommendations shows one Accept and Reject pair per recommendation");
resetAgentModelSettings();
passed.push("recommendations: per agent and model from real runs and corrections; never applied without Accept; Reject is remembered");

// ---------------------------------------------------------------- parallel workflow with direct handoffs
resetAgentModelSettings();
const seenOrder: string[] = [];
let concurrent = 0;
let peak = 0;
setCompleteForTests(async (params) => {
  const agent = params.route?.agentId ?? "?";
  concurrent += 1;
  peak = Math.max(peak, concurrent);
  seenOrder.push(`${agent}:start`);
  await sleep(agent === "email" ? 5 : 40);
  concurrent -= 1;
  seenOrder.push(`${agent}:end`);
  if (agent === "email") {
    const textIn = String(params.messages[0]?.content ?? "");
    assert(textIn.includes('name="judge"') && textIn.includes('name="slots"'), "the draft step receives both results directly");
  }
  return modelReply({ tools: [{ name: "report_result", input: { summary: `${agent} result`, data: { agent } } }] });
});
const parallel = await startWorkflow({
  title: "Reply plan",
  origin: "delegate",
  grant: owner("review the reply, check my calendar and draft the best response"),
  tasks: [
    { key: "judge", agentId: "sales", capability: "goal", input: { goal: "Judge the opportunity.", refs: [emailRef], constraints: { do_not_send: true } }, depth: 1 },
    { key: "slots", agentId: "calendar", capability: "goal", input: { goal: "Find availability next week." }, depth: 1 },
    { key: "draft", agentId: "email", capability: "goal", input: { goal: "Draft the reply." }, dependsOn: ["judge", "slots"], depth: 1 },
  ],
});
assert(parallel.tasks.every((task) => task.state === "completed"), "all three steps complete");
assert(peak >= 2, `Sales and Calendar ran side by side (${peak})`);
assert(seenOrder.indexOf("email:start") > seenOrder.indexOf("sales:end") && seenOrder.indexOf("email:start") > seenOrder.indexOf("calendar:end"), "the draft waited for both");
const flow = db.prepare(`SELECT * FROM metric_workflows WHERE workflow_id = ?`).get(parallel.workflowId) as Record<string, number | string>;
assert(Number(flow.max_parallel) >= 2 && Number(flow.direct_handoffs) === 1 && Number(flow.messages) === 6, `the workflow records parallelism, handoffs and 6 messages (${JSON.stringify(flow)})`);
assert(Number(flow.message_bytes) / Number(flow.messages) < 2000, "messages stay small");
passed.push("parallelism: independent steps ran side by side, the dependent step waited and got both results directly; recorded");

// ---------------------------------------------------------------- the report
const report = formatAgentsReport("day");
for (const line of ["Optimizations", "Context tokens avoided:", "Cache: hit rate", "Scheduler queue:", "Circuit breaker activations:", "Parallel workflows:", "Agent-to-agent messages:", "Estimated model calls avoided:", "User corrections:", "providers:"]) {
  assert(report.includes(line), `/agents shows "${line}"`);
}
const optimizations = optimizationStats(new Date(Date.now() - 3600_000).toISOString(), new Date(Date.now() + 1000).toISOString());
assert(optimizations.contextTokensAvoided > 0 && optimizations.cacheHits > 0 && optimizations.parallelWorkflows >= 1 && optimizations.agentMessages > 0, `the numbers are real (${JSON.stringify(optimizations)})`);
assert(optimizations.llmCallsAvoided === optimizations.fastPath + optimizations.cacheLlmCallsSaved + optimizations.directHandoffs, "model calls avoided is the sum of its parts");
assert(newRunReport().queueMs === undefined, "a fresh run report has no queue time");
passed.push("measurements: tokens avoided, cache hit rate, queue latency, circuit activations, parallel workflows, messages, calls avoided");

setCompleteForTests(undefined);
setToolInterceptorForTests(undefined);
setGoalLimitsForTests(undefined);
log(passed.map((line) => `  ok  ${line}`).join("\n"));
log("Optimization checks passed.");
process.exit(0);
