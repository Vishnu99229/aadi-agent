/**
 * Agent-centric models: the registry, each agent's own primary and fallback,
 * Auto, unavailable providers, persistence across a real restart, the model
 * applying on every path an agent reasons on (and on none where it doesn't),
 * provider fallback after a tool already ran, every specialist's goal loop,
 * the Build Agent's own reasoning, the settings screen and the measurements.
 *
 * The model and every tool are scripted. Nothing reaches a provider, Gmail,
 * Calendar, GitHub, Cursor or Telegram.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "grammy";
import { newRunReport, setToolInterceptorForTests } from "../src/agent.ts";
import { handleAgentModelCallback } from "../src/agent_model_panel.ts";
import { issueGrant } from "../src/agents/auth.ts";
import { continueTask, delegate, startWorkflow } from "../src/agents/engine.ts";
import { setGoalLimitsForTests } from "../src/agents/goal_policy.ts";
import { localSpecialists, specialistFor } from "../src/agents/index.ts";
import { pickRoute, runOwnerTurn, tryDirectAnswer, type Route } from "../src/agents/orchestrator.ts";
import { getAgent } from "../src/agents/registry.ts";
import { LOCAL_AGENT_IDS } from "../src/agents/types.ts";
import { db, getSetting } from "../src/db.ts";
import {
  setCompleteForTests,
  setNamedBackendCompleteForTests,
  setRouteModelCompleteForTests,
  type CompleteParams,
  type CompleteResult,
} from "../src/llm.ts";
import { clearLlmBackendFlagsForTests, flagProvider } from "../src/llm_fallback.ts";
import { formatAgentsReport, initMetrics } from "../src/metrics.ts";
import {
  autoRank,
  getAgentModelSetting,
  MODEL_AGENT_IDS,
  resetAgentModelSettings,
  resolveAgentModel,
  setAgentModelSetting,
} from "../src/models/agent_models.ts";
import {
  availableModels,
  getModel,
  listModels,
  PROVIDERS,
  reloadModelRegistryForTests,
} from "../src/models/registry.ts";
import { modelReply, nextMessageId } from "./fakes.ts";
import { asksForCodeChange } from "../src/tools/prepare_build.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

if (process.env.AADI_DB_PATH !== ":memory:") {
  throw new Error("test-agent-models.ts must run with AADI_DB_PATH=:memory:");
}

const log = console.log;
console.log = () => undefined;
console.error = () => undefined;
console.warn = () => undefined;

const passed: string[] = [];
initMetrics();

// ---------------------------------------------------------------- registry
assert(PROVIDERS.join(",") === "openai,anthropic,gemini,deepseek,kimi", "five providers");
for (const provider of PROVIDERS) {
  assert(listModels().some((spec) => spec.provider === provider), `${provider} has at least one model`);
  assert(availableModels(provider).length > 0, `${provider} is available with its test key`);
}
for (const spec of listModels()) {
  assert(spec.key.startsWith(`${spec.provider}:`) && spec.modelId.length > 0, `${spec.key} names its provider and model id`);
  assert(typeof spec.supportsTools === "boolean" && typeof spec.supportsVision === "boolean", `${spec.key} lists its capabilities`);
  assert(spec.cost.inputCostPerMillion >= 0 && spec.cost.outputCostPerMillion >= 0, `${spec.key} has cost rates`);
}
assert(getModel("openai:strong")?.modelId === "gpt-test-strong", "a model id comes from the environment (OPENAI_MODEL_STRONG)");
process.env.MODELS_EXTRA = "openai/gpt-next-1=GPT Next@3";
reloadModelRegistryForTests();
const extra = listModels().find((spec) => spec.modelId === "gpt-next-1");
assert(extra?.key === "openai:x-gpt-next-1" && extra.displayName === "GPT Next" && extra.quality === 3, "MODELS_EXTRA adds a model without a code change");
delete process.env.MODELS_EXTRA;
reloadModelRegistryForTests();
const savedKimi = process.env.KIMI_API_KEY;
delete process.env.KIMI_API_KEY;
assert(availableModels("kimi").length === 0, "a provider with no key has no available models");
process.env.KIMI_API_KEY = savedKimi;
passed.push(`registry: ${listModels().length} models across 5 providers, ids and costs from the environment, availability from keys`);

// ---------------------------------------------------------------- defaults and per-agent choice
const firstOf = (agent: string): string | undefined => resolveAgentModel(agent).models[0]?.key;
const routeOf = (agent: string): string => resolveAgentModel(agent).models.map((spec) => spec.key).join(">");
assert(routeOf("aadi") === "openai:strong>gemini:flash", `Aadi: OpenAI strong, Gemini fallback (${routeOf("aadi")})`);
assert(routeOf("email") === "openai:fast>gemini:flash", `Email: OpenAI fast (${routeOf("email")})`);
assert(routeOf("calendar") === "gemini:flash>openai:fast", `Calendar: Gemini Flash (${routeOf("calendar")})`);
assert(routeOf("sales") === "anthropic:sonnet>openai:strong", `Sales: Claude Sonnet (${routeOf("sales")})`);
assert(routeOf("knowledge") === "kimi:main>gemini:flash", `Knowledge: Kimi (${routeOf("knowledge")})`);
assert(routeOf("operations") === "deepseek:flash>openai:fast", `Operations: DeepSeek Flash (${routeOf("operations")})`);
assert(routeOf("build") === "openai:strong>anthropic:sonnet", `Build: OpenAI strong (${routeOf("build")})`);
assert(MODEL_AGENT_IDS.every((id) => getAgentModelSetting(id).fallbacks.length > 0), "every agent has a fallback");

setAgentModelSetting("email", { primary: "anthropic:sonnet", fallbacks: ["deepseek:flash", "gemini:flash"] });
assert(routeOf("email") === "anthropic:sonnet>deepseek:flash>gemini:flash", `a chosen primary and fallback chain is used in order (${routeOf("email")})`);
assert(routeOf("calendar") === "gemini:flash>openai:fast", "one agent's choice leaves the others alone");
let threw = false;
try {
  setAgentModelSetting("email", { primary: "openai:does-not-exist" });
} catch {
  threw = true;
}
assert(threw, "an unknown model is refused");
passed.push("per-agent primary and ordered fallback chain; the experiment defaults spread the agents across providers");

// ---------------------------------------------------------------- unavailable providers
delete process.env.KIMI_API_KEY;
const noKimi = resolveAgentModel("knowledge");
assert(noKimi.models[0]?.key === "gemini:flash", `no Kimi key: Knowledge falls to its fallback (${noKimi.models[0]?.key})`);
assert(noKimi.skipped.some((item) => item.key === "kimi:main" && item.reason === "no API key"), "and says why Kimi was skipped");
setAgentModelSetting("knowledge", { fallbacks: [] });
const netted = resolveAgentModel("knowledge");
assert(netted.safetyNet && netted.models.length > 0 && netted.models[0]!.provider !== "kimi", "nothing it asked for can run: a safety net model stands in");
process.env.KIMI_API_KEY = savedKimi;
setAgentModelSetting("knowledge", { fallbacks: ["gemini:flash"] });
flagProvider("openai", "401 invalid api key");
assert(firstOf("aadi") === "gemini:flash", `OpenAI paused after an auth error: Aadi uses its fallback (${firstOf("aadi")})`);
assert(resolveAgentModel("aadi").skipped.some((item) => item.reason.includes("paused")), "the pause is the reason given");
clearLlmBackendFlagsForTests();
assert(firstOf("aadi") === "openai:strong", "and is used again once the pause is cleared");
passed.push("provider unavailable: no key or paused skips to the fallback; nothing usable falls to a safety net");

// ---------------------------------------------------------------- auto
setAgentModelSetting("calendar", { primary: "auto", fallbacks: "auto", tier: "light" });
const lightAuto = resolveAgentModel("calendar");
assert(lightAuto.mode === "auto" && lightAuto.models[0]?.quality === 1, `light Auto picks a fast model (${lightAuto.models[0]?.key})`);
assert(lightAuto.models.length >= 2 && lightAuto.models[1]!.provider !== lightAuto.models[0]!.provider, "Auto's fallback is on another provider");
const deepAuto = resolveAgentModel("calendar", { tier: "deep" });
assert(deepAuto.models[0]?.quality === 3, `a deep run on Auto picks a strong model (${deepAuto.models[0]?.key})`);
assert(autoRank("light", { vision: true }).every((spec) => spec.supportsVision), "Auto only picks models that can do what the run needs");
const calendarAgent = specialistFor("calendar")!;
assert(calendarAgent.toolNames().includes("list_events"), "Auto changes nothing about the agent's tools");
setAgentModelSetting("calendar", { primary: "gemini:flash", fallbacks: ["openai:fast"], tier: "light" });
passed.push("Auto picks by tier, capability and cost, with a fallback on another provider, and leaves tools alone");

// ---------------------------------------------------------------- persistence
const stored = getSetting("agent_models_v1") ?? "";
assert(stored.includes("anthropic:sonnet") && !/test-openai|test-gemini|sk-/.test(stored), "choices are saved in SQLite as model keys, never API keys");
const dir = mkdtempSync(join(tmpdir(), "aadi-models-"));
const childEnv = { ...process.env, AADI_DB_PATH: join(dir, "models.db") };
async function child(mode: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["--import", "tsx", "scripts/agent-models-child.ts", mode], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    proc.once("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`child ${mode} exited ${code}`))));
  });
}
assert((await child("set")).includes("SET"), "the first process saves a choice");
const readBack = JSON.parse(/READ (.+)/.exec(await child("read"))?.[1] ?? "{}") as {
  setting?: { primary: string; fallbacks: string[]; tier: string };
  route?: string[];
  effort?: string;
};
rmSync(dir, { recursive: true, force: true });
assert(readBack.setting?.primary === "gemini:flash" && readBack.setting.tier === "deep", `a new process reads the same choice (${JSON.stringify(readBack)})`);
assert(readBack.route?.join(">") === "gemini:flash>deepseek:flash" && readBack.effort === "high", "and resolves the same route and effort");
passed.push("settings persist in SQLite and survive a real restart (separate processes, same database file)");

// ---------------------------------------------------------------- the model applies everywhere an agent reasons
interface Seen {
  agent: string;
  model: string;
  tools: string[];
  system: string;
  effort?: string;
}
let seen: Seen[] = [];
let script: Array<(params: CompleteParams) => CompleteResult> = [];
const toolLog: Array<{ name: string; input: unknown }> = [];
let handlers: Record<string, (input: unknown) => string | undefined> = {};

function toolNames(params: CompleteParams): string[] {
  return params.tools.map((tool) => ("name" in tool ? tool.name : "?"));
}

setCompleteForTests(async (params) => {
  seen.push({
    agent: params.route?.agentId ?? `backend:${params.backend ?? "chat"}`,
    model: params.route?.models[0]?.key ?? String(params.backend),
    tools: toolNames(params),
    system: params.system.cacheable,
    effort: params.effort,
  });
  const step = script.shift();
  if (step) {
    return step(params);
  }
  const last = params.messages.at(-1);
  return modelReply({ text: last?.role === "tool" ? `Done: ${last.content.slice(0, 80)}` : "Done." });
});
setToolInterceptorForTests((call) => {
  toolLog.push({ name: call.name, input: call.input });
  const handler = handlers[call.name];
  return handler ? handler(call.input) : "ok";
});

const CHAT = 41;
function confirm() {
  return { chatId: CHAT, messageId: nextMessageId() };
}
async function say(text: string): Promise<{ reply: string; route?: Route }> {
  const out: { value?: Route } = {};
  const confirmation = confirm();
  const reply = await runOwnerTurn(text, {
    ownerText: text,
    guardText: text,
    chatId: CHAT,
    sendConfirmation: confirmation,
    postCard: async () => undefined,
    route: out,
  });
  return { reply, route: out.value };
}
const ownerGrant = (text: string) => issueGrant({ source: "owner_chat", ownerText: text, confirmation: confirm() });

setGoalLimitsForTests({ enabled: true, maxConcurrent: 2, goalBudgetUsd: 1, workflowBudgetUsd: 2, maxModelCalls: 30 });

// Direct one-domain specialist turn.
seen = [];
const prioritize = await say("Look at my week and tell me which meetings I should prioritize.");
assert(prioritize.route?.kind === "specialist" && prioritize.route.agentId === "calendar", `the calendar question goes to the Calendar Agent (${JSON.stringify(prioritize.route)})`);
assert(seen.length > 0 && seen.every((call) => call.agent === "calendar" && call.model === "gemini:flash"), `every model call used the Calendar Agent's model (${JSON.stringify(seen.map((call) => call.model))})`);
assert(seen[0]!.effort === "low", "at the Calendar Agent's own tier (light: low effort)");

// Aadi's own turn.
seen = [];
const general = await say("Write me a two line poem about the monsoon please.");
assert(general.route?.kind === "aadi", "a general message stays with Aadi");
assert(seen.every((call) => call.agent === "aadi" && call.model === "openai:strong"), `Aadi used Aadi's model (${seen.map((call) => call.model).join(",")})`);

// A specialist that hands the turn back continues on Aadi's model.
seen = [];
script = [
  (params) => {
    assert(params.route?.agentId === "calendar", "the turn starts on the Calendar Agent");
    return modelReply({ tools: [{ name: "escalate_to_aadi", input: { reason: "needs a task" } }] });
  },
  () => modelReply({ text: "Handled by Aadi." }),
];
await say("Can you check my calendar for Friday afternoon please");
assert(seen[0]?.model === "gemini:flash" && seen[1]?.agent === "aadi" && seen[1]?.model === "openai:strong", `after the hand-back Aadi's model answers (${seen.map((call) => `${call.agent}:${call.model}`).join(",")})`);

// A delegated goal, and its resume after a question.
seen = [];
script = [() => modelReply({ tools: [{ name: "request_input", input: { question: "Which quarter?" } }] })];
const paused = await delegate({ agentId: "sales", capability: "goal", input: { goal: "Judge whether Northwind needs a follow-up." }, grant: ownerGrant("judge Northwind"), durable: true });
assert(paused.state === "input-required", `the sales goal pauses for input (${paused.state})`);
assert(seen.length === 1 && seen[0]!.agent === "sales" && seen[0]!.model === "anthropic:sonnet", `the goal used the Sales Agent's model (${JSON.stringify(seen)})`);
seen = [];
const resumed = await continueTask(paused.taskId, { answer: "Q4" }, ownerGrant("Q4"));
assert(resumed?.state === "completed", `the resumed goal completes (${resumed?.state})`);
assert(seen.length > 0 && seen.every((call) => call.agent === "sales" && call.model === "anthropic:sonnet"), "and the resumed conversation used the same agent's model");

// A goal that runs after its dependency came back.
seen = [];
script = [];
const flow = await startWorkflow({
  title: "Reply review",
  origin: "delegate",
  grant: ownerGrant("review Hardik's reply"),
  tasks: [
    { key: "read", agentId: "email", capability: "goal", input: { goal: "Read and interpret Hardik's latest reply." }, depth: 1 },
    { key: "judge", agentId: "sales", capability: "goal", input: { goal: "Decide whether this needs a follow-up." }, dependsOn: ["read"], depth: 1 },
  ],
});
assert(flow.tasks.every((task) => task.state === "completed"), `both goals complete (${flow.tasks.map((task) => task.state).join(",")})`);
const order = seen.map((call) => `${call.agent}:${call.model}`);
assert(order[0] === "email:anthropic:sonnet" && order.at(-1) === "sales:anthropic:sonnet", `each goal on its own agent's model, the dependent one after (${order.join(",")})`);
passed.push("one resolver everywhere: specialist turn, Aadi turn, hand-back, delegated goal, resumed goal, goal after a dependency");

// ---------------------------------------------------------------- deterministic paths stay model-free
seen = [];
const soon = new Date(Date.now() + 3 * 3600_000);
handlers = {
  list_events: () => `1. [work] Acme renewal call\nStart: ${soon.toISOString()}\nEnd: ${new Date(soon.getTime() + 1800_000).toISOString()}\nAttendees: priya@acme.com`,
};
const next = await tryDirectAnswer("What's my next meeting?", { chatId: CHAT, grant: ownerGrant("What's my next meeting?") });
assert(next !== undefined && /Acme renewal call/.test(next.text), `the next meeting is answered (${next?.text})`);
assert(seen.length === 0, `with no model call, whatever the Calendar Agent's model is (${seen.length})`);
const status = await tryDirectAnswer("Show my latest Cursor build.", { chatId: CHAT });
assert(status !== undefined && seen.length === 0, "the latest build status is answered with no model call");
handlers = {};
passed.push("deterministic fast path: 0 model calls for the next meeting and build status");

// ---------------------------------------------------------------- identity does not follow the model
const email = specialistFor("email")!;
const before = { prompt: await email.prompt(), tools: email.toolNames().join(","), capabilities: email.getCapabilities().map((item) => `${item.name}:${item.effect}`).join(",") };
setAgentModelSetting("email", { primary: "kimi:main", fallbacks: ["openai:fast"] });
const after = { prompt: await email.prompt(), tools: email.toolNames().join(","), capabilities: email.getCapabilities().map((item) => `${item.name}:${item.effect}`).join(",") };
assert(JSON.stringify(before) === JSON.stringify(after), "changing the Email Agent's model leaves its prompt, tools and permissions as they were");
seen = [];
await delegate({ agentId: "email", capability: "goal", input: { goal: "Find Hardik's latest email." }, grant: ownerGrant("find Hardik's latest email") });
assert(seen[0]?.model === "kimi:main" && seen[0].system === before.prompt, "its next goal runs on Kimi with the same prompt");
const offered = seen[0]!.tools.filter((name) => name !== "request_input" && name !== "report_result");
assert(offered.every((name) => before.tools.split(",").includes(name)), `and is offered only the Email Agent's own tools (${offered.join(",")})`);
assert(seen[0]!.tools.includes("search_emails") && !seen[0]!.tools.includes("list_accounts"), "and the same tools");
passed.push("identity is the agent's, not the model's: same prompt, tools and permissions on OpenAI, Claude or Kimi");

// ---------------------------------------------------------------- provider fallback after a successful tool call
resetAgentModelSettings();
let providerCalls: string[] = [];
let addTaskRuns = 0;
handlers = {
  add_task: () => {
    addTaskRuns += 1;
    return "Task added: call the bank (work).";
  },
};
setCompleteForTests(undefined);
// Anything off the agent's route (a history summary) stays scripted too.
setNamedBackendCompleteForTests(async () => modelReply({ text: "Summary." }));
setRouteModelCompleteForTests(async (spec, params) => {
  providerCalls.push(spec.key);
  if (spec.key === "openai:strong") {
    if (params.messages.at(-1)?.role === "tool") {
      throw new Error("503 Service Unavailable");
    }
    return modelReply({ tools: [{ name: "add_task", input: { text: "call the bank", tag: "work" } }] });
  }
  // The fallback sees the same history and asks for the same call again, then a new one.
  const tools = params.messages.filter((message) => message.role === "tool").length;
  if (tools === 1) {
    return modelReply({
      tools: [
        { name: "add_task", input: { text: "call the bank", tag: "work" } },
        { name: "add_task", input: { text: "pay rent", tag: "personal" } },
      ],
    });
  }
  return modelReply({ text: "Added both tasks." });
});
// The task request is Operations' domain; give it OpenAI first and Gemini as fallback.
setAgentModelSetting("operations", { primary: "openai:strong", fallbacks: ["gemini:flash"] });
const fallbackStart = (db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM metric_turns`).get() as { id: number }).id;
const fallbackTurn = await say("Add a task to call the bank, and another to pay rent, thanks.");
assert(providerCalls[0] === "openai:strong" && providerCalls.includes("gemini:flash"), `OpenAI failed after the tool ran; Gemini took over (${providerCalls.join(",")})`);
assert(addTaskRuns === 2, `the first task was not added twice; the new one was added (${addTaskRuns})`);
assert(/Added both/.test(fallbackTurn.reply), "the turn finished on the fallback");
const turnRow = db.prepare(`SELECT fallbacks, duplicate_skipped, models_json FROM metric_turns WHERE id > ? ORDER BY id DESC LIMIT 1`).get(fallbackStart) as {
  fallbacks: number;
  duplicate_skipped: number;
  models_json: string;
};
assert(turnRow.fallbacks >= 1 && turnRow.duplicate_skipped === 1, `the turn records the fallback and the skipped duplicate (${JSON.stringify(turnRow)})`);
assert(JSON.parse(turnRow.models_json).includes("gemini:flash"), "and which model served it");
setRouteModelCompleteForTests(undefined);
setNamedBackendCompleteForTests(undefined);
handlers = {};
passed.push("provider fallback after a successful tool call: the same call is replayed, not re-run; a new call still runs");

// ---------------------------------------------------------------- every specialist has a goal loop
setCompleteForTests(async (params) => {
  seen.push({ agent: params.route?.agentId ?? "?", model: params.route?.models[0]?.key ?? "?", tools: toolNames(params), system: "", effort: params.effort });
  return modelReply({ text: `${params.route?.agentId} reporting.` });
});
for (const id of LOCAL_AGENT_IDS) {
  seen = [];
  const agent = getAgent(id)!;
  assert(agent.getCapabilities().some((item) => item.name === "goal" && item.kind === "goal"), `${id} has a goal capability`);
  const done = await delegate({ agentId: id, capability: "goal", input: { goal: `A small judgment for the ${id} agent.` }, grant: ownerGrant("a judgment") });
  assert(done.state === "completed" && done.text === `${id} reporting.`, `${id}'s goal loop runs and reports (${done.state} ${done.text})`);
  assert(seen.length === 1 && seen[0]!.agent === id && seen[0]!.model === firstOf(id), `${id}'s loop used ${id}'s model (${seen[0]?.model})`);
}
assert(localSpecialists().every((agent) => !agent.definition.noGoal), "no specialist is goal-less");
passed.push("all six specialists run their own goal loop on their own model");

// ---------------------------------------------------------------- the Build Agent reasons; nothing starts
const buildsBefore = (db.prepare(`SELECT COUNT(*) AS n FROM builds`).get() as { n: number }).n;
db.prepare(`INSERT INTO builds (task, status, pr_number, pr_url, error, summary, files_json) VALUES (?, 'failed', 77, 'https://github.com/x/y/pull/77', 'checks failed: test', 'Added /ping', '["src/bot.ts","scripts/test-ping.ts"]')`).run("Add a /ping command");
seen = [];
toolLog.length = 0;
handlers = {
  get_build: () => undefined,
  get_build_checks: () =>
    JSON.stringify({
      found: true,
      overall: "failed",
      failed_details: [{ name: "test", annotations: [{ path: "scripts/test-ping.ts", line: 12, message: "expected 'pong' but got 'Pong'" }], failedSteps: ["npm test"] }],
    }),
  prepare_build: () => undefined,
};
setCompleteForTests(async (params) => {
  seen.push({ agent: params.route?.agentId ?? "?", model: params.route?.models[0]?.key ?? "?", tools: toolNames(params), system: params.system.cacheable });
  const tools = params.messages.filter((message) => message.role === "tool").length;
  if (tools === 0) {
    return modelReply({ tools: [{ name: "get_build", input: { status: "failed" } }] });
  }
  if (tools === 1) {
    return modelReply({ tools: [{ name: "get_build_checks", input: { build_id: 1 } }] });
  }
  if (tools === 2) {
    // A model that oversteps tries to prepare a build; the tool refuses.
    return modelReply({ tools: [{ name: "prepare_build", input: { request: "Fix the ping test" } }] });
  }
  return modelReply({ text: "Test problem: the test expects 'pong' but the code returns 'Pong' as designed." });
});
const review = await say("Review the last failed Aadi build and tell me whether this is a code problem or test problem.");
assert(review.route?.kind === "specialist" && review.route.agentId === "build", `the review goes to the Build Agent (${JSON.stringify(review.route)})`);
assert(seen.every((call) => call.agent === "build" && call.model === "openai:strong"), `with the Build Agent's own model (${seen.map((call) => call.model).join(",")})`);
assert(/BUILD AGENT/.test(seen[0]!.system) && seen[0]!.tools.includes("get_build_checks") && !seen[0]!.tools.includes("send_email"), "its own prompt and build tools only");
assert(toolLog.map((call) => call.name).join(",") === "get_build,get_build_checks,prepare_build", `it read the build and its checks (${toolLog.map((call) => call.name).join(",")})`);
assert(/Test problem/.test(review.reply), "and returned its analysis");
assert((db.prepare(`SELECT COUNT(*) AS n FROM builds`).get() as { n: number }).n === buildsBefore + 1, "no build was prepared or started: a review isn't a change request");
assert(!asksForCodeChange("Review the last failed Aadi build and tell me whether this is a code problem or test problem."), "a review is not a change request");
assert(!asksForCodeChange("Is the code change in the last build ready?"), "nouns are not requests");
assert(asksForCodeChange("Fix the ping test so it accepts Pong") && asksForCodeChange("Build me a /ping command"), "a real request is");
handlers = {};
passed.push("Build Agent: its own loop and model read the build and CI, explain the failure, and start nothing");

// ---------------------------------------------------------------- measurements
const paths = (db.prepare(`SELECT DISTINCT path FROM metric_turns`).all() as Array<{ path: string }>).map((row) => row.path).sort();
assert(["aadi", "fast", "specialist"].every((path) => paths.includes(path)), `turns are recorded by path (${paths.join(",")})`);
const goalRuns = (db.prepare(`SELECT COUNT(*) AS n FROM metric_agent_runs WHERE kind = 'goal'`).get() as { n: number }).n;
assert(goalRuns >= 8, `goal runs are recorded per agent (${goalRuns})`);
const firstModel = db.prepare(`SELECT first_model_ms FROM metric_agent_runs WHERE kind = 'turn' AND first_model_ms IS NOT NULL LIMIT 1`).get() as
  | { first_model_ms: number }
  | undefined;
assert(firstModel !== undefined && firstModel.first_model_ms >= 0, "time to first model response is recorded");
const report = formatAgentsReport("day");
for (const label of ["Aadi Orchestrator", "Email Agent", "Calendar Agent", "Sales Agent", "Knowledge Agent", "Operations Agent", "Build Agent"]) {
  assert(report.includes(label), `/agents shows ${label}`);
}
assert(/Delegated workflows: \d+/.test(report) && /Fast-path requests: \d+/.test(report) && /Avg delegated latency/.test(report), "/agents shows the totals");
assert(/p95/.test(report) && /Fallbacks:/.test(report) && !/improv/i.test(report), "with percentiles and fallback rates, and no claim of improvement");
assert(formatAgentsReport("week").startsWith("Agents, last 7 days"), "/agents week shows 7 days");
assert(newRunReport().servedModels.length === 0, "a run report starts empty");
passed.push("measurements: per turn and per agent, first-response time, /agents and /agents week");

// ---------------------------------------------------------------- the settings screen
const edits: string[] = [];
const answers: string[] = [];
let keyboard: Array<Array<{ text: string; callback_data?: string }>> = [];
function tap(data: string): Context {
  return {
    callbackQuery: { data },
    answerCallbackQuery: async (text?: string) => {
      answers.push(text ?? "");
      return true;
    },
    editMessageText: async (text: string, options?: { reply_markup?: { inline_keyboard: typeof keyboard } }) => {
      edits.push(text);
      keyboard = options?.reply_markup?.inline_keyboard ?? [];
      return true;
    },
    editMessageReplyMarkup: async () => true,
  } as unknown as Context;
}
const openAdvanced = async () => {
  edits.push("ADVANCED");
};
await handleAgentModelCallback(tap("am:h"), openAdvanced);
assert(/Agent Models/.test(edits.at(-1)!) && /Aadi Orchestrator\nPrimary: OpenAI \/ /.test(edits.at(-1)!) && /Reasoning tier:/.test(edits.at(-1)!), "the home screen lists every agent's primary, fallback and tier");
await handleAgentModelCallback(tap("am:p:1:p"), openAdvanced);
assert(keyboard.flat().map((button) => button.text).slice(0, 5).join(",") === "OpenAI,Claude,Gemini,DeepSeek,Kimi", "Primary model offers the five providers");
await handleAgentModelCallback(tap("am:m:1:p:o"), openAdvanced);
const openaiButtons = keyboard.flat().filter((button) => button.callback_data?.startsWith("am:s:"));
assert(openaiButtons.length > 0 && openaiButtons.every((button) => button.callback_data!.includes(":openai:")), "then only that provider's available models");
await handleAgentModelCallback(tap("am:s:1:p:openai:strong"), openAdvanced);
assert(answers.at(-1) === "Saved" && getAgentModelSetting("email").primary === "openai:strong", "tapping a model saves it for that agent");
await handleAgentModelCallback(tap("am:ts:1:deep"), openAdvanced);
assert(getAgentModelSetting("email").tier === "deep", "the reasoning tier is saved");
await handleAgentModelCallback(tap("am:auto:1"), openAdvanced);
assert(getAgentModelSetting("email").primary === "auto" && getAgentModelSetting("email").fallbacks === "auto", "Auto turns on");
await handleAgentModelCallback(tap("am:p:1:f"), openAdvanced);
assert(keyboard.flat().some((button) => button.callback_data === "am:fa:1"), "Fallback model offers Auto");
delete process.env.KIMI_API_KEY;
await handleAgentModelCallback(tap("am:m:1:p:k"), openAdvanced);
assert(/no API key/.test(answers.at(-1)!), "a provider with no key says so instead of listing models");
process.env.KIMI_API_KEY = savedKimi;
await handleAgentModelCallback(tap("am:adv"), openAdvanced);
assert(edits.at(-1) === "ADVANCED", "Advanced models opens the system task models");
resetAgentModelSettings();
passed.push("settings screen: providers, available models only, fallback, Auto, tier, Advanced models");

setCompleteForTests(undefined);
setToolInterceptorForTests(undefined);
setGoalLimitsForTests(undefined);
assert(pickRoute("What's my next meeting?").kind === "direct", "the fast path is still the first route");
log(passed.map((line) => `  ok  ${line}`).join("\n"));
log("Agent model checks passed.");
process.exit(0);
