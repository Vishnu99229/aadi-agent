/**
 * The laptop model in the agent picker: gemma4:e2b for the Knowledge Agent only,
 * on its read tools, with the cloud models answering when the laptop can't.
 *
 * A fake Ollama server on 127.0.0.1 plays the laptop, the cloud model and every
 * tool are scripted, and nothing reaches a provider, Gmail, Calendar or Telegram.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "grammy";
import {
  asksForMemoryWrite,
  newRunReport,
  runAgent,
  setToolInterceptorForTests,
  type RunAgentOptions,
} from "../src/agent.ts";
import { handleAgentModelCallback } from "../src/agent_model_panel.ts";
import { issueGrant } from "../src/agents/auth.ts";
import { delegate } from "../src/agents/engine.ts";
import { setGoalLimitsForTests } from "../src/agents/goal_policy.ts";
import { specialistFor } from "../src/agents/index.ts";
import { pickRoute, runOwnerTurn, type Route } from "../src/agents/orchestrator.ts";
import { getRecentMessages, getSetting, setSetting } from "../src/db.ts";
import { setCompleteForTests, type CompleteParams, type CompleteResult } from "../src/llm.ts";
import { initMetrics } from "../src/metrics.ts";
import { MODEL_AGENT_IDS, resolveAgentModel } from "../src/models/agent_models.ts";
import {
  LOCAL_AGENT_CONNECT_TIMEOUT_MS,
  LOCAL_AGENT_SETTING,
  LOCAL_AGENT_TOTAL_TIMEOUT_MS,
  LOCAL_LOCKED_TEXT,
  localModelForAgent,
  setLocalAgentModelConfigForTests,
  toggleLocalModel,
} from "../src/models/local_agent_models.ts";
import { modelReply, nextMessageId } from "./fakes.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

if (process.env.AADI_DB_PATH !== ":memory:") {
  throw new Error("test-local-model-picker.ts must run with AADI_DB_PATH=:memory:");
}

const log = console.log;
console.log = () => undefined;
console.warn = () => undefined;
console.error = () => undefined;

const passed: string[] = [];
initMetrics();

const MODEL = "gemma4:e2b";
const K = MODEL_AGENT_IDS.indexOf("knowledge");
const READ_TOOLS = specialistFor("knowledge")!
  .definition.tools.filter((tool) => tool.effect === "read")
  .map((tool) => tool.name)
  .sort();
const NOTE = {
  slow: "(answered by cloud: laptop too slow)",
  unreachable: "(answered by cloud: laptop unreachable)",
  memory: "(answered by cloud: needed a memory write)",
  tool: "(answered by cloud: needed a tool the laptop model can't use)",
};
const FOOTER = /\n\n\(gemma4:e2b, local, \d+s\)$/;

// ---------------------------------------------------------------- fakes
type OllamaStep = { content?: string; tools?: Array<{ name: string; arguments?: unknown }> } | "hang";
type OllamaBody = {
  model: string;
  stream: boolean;
  think: boolean;
  tools?: Array<{ type: string; function: { name: string } }>;
  messages: Array<{ role: string; content?: string; tool_name?: string; tool_calls?: Array<{ function: { name: string } }> }>;
};

async function withOllama<T>(steps: OllamaStep[], run: (url: string, bodies: OllamaBody[]) => Promise<T>): Promise<T> {
  const bodies: OllamaBody[] = [];
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/api/chat") {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as OllamaBody);
      const step = steps.shift() ?? { content: "(the fake laptop ran out of steps)" };
      if (step === "hang") {
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: MODEL,
          message: {
            role: "assistant",
            content: step.content ?? "",
            ...(step.tools ? { tool_calls: step.tools.map((tool) => ({ function: { name: tool.name, arguments: tool.arguments ?? {} } })) } : {}),
          },
          done: true,
          prompt_eval_count: 10,
          eval_count: 5,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fake ollama: no port");
  }
  try {
    return await run(`http://127.0.0.1:${address.port}`, bodies);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** A port that was just listening and is now closed: connection refused. */
async function closedPortUrl(): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("no port");
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${address.port}`;
}

function toolNames(params: CompleteParams): string[] {
  return params.tools.map((tool) => ("name" in tool ? tool.name : "?"));
}

let cloudCalls: Array<{ agent: string; tools: string[] }> = [];
/** Plays a cloud agent for one test; undefined falls through to "Cloud answer.". */
let cloudPlay: ((params: CompleteParams) => CompleteResult | undefined) | undefined;
setCompleteForTests(async (params) => {
  if (params.tools.length === 0) {
    return modelReply({ text: '{"facts":[]}' });
  }
  cloudCalls.push({ agent: params.route?.agentId ?? `backend:${params.backend ?? "chat"}`, tools: toolNames(params) });
  return cloudPlay?.(params) ?? modelReply({ text: "Cloud answer." });
});

const toolLog: string[] = [];
setToolInterceptorForTests((call) => {
  toolLog.push(call.name);
  return call.name === "search_memories" ? "Jeff: prefers morning calls." : "ok";
});

function knowledgeTurn(text: string, extra: Partial<RunAgentOptions> = {}): Promise<string> {
  return runAgent(text, {
    agentId: "knowledge",
    modelAgent: "knowledge",
    guardText: text,
    saveUserMessage: false,
    saveAssistantMessage: false,
    ...extra,
  });
}

const CHAT = 77;
const ownerGrant = (text: string) =>
  issueGrant({ source: "owner_chat", ownerText: text, confirmation: { chatId: CHAT, messageId: nextMessageId() } });
setGoalLimitsForTests({ enabled: true, maxConcurrent: 2, goalBudgetUsd: 1, workflowBudgetUsd: 2, maxModelCalls: 30 });

// ---------------------------------------------------------------- the rules
assert(LOCAL_AGENT_CONNECT_TIMEOUT_MS === 3_000 && LOCAL_AGENT_TOTAL_TIMEOUT_MS === 120_000, "3 s to connect, 120 s for the whole local run");
assert(READ_TOOLS.length === 14, `Knowledge has 14 read tools (${READ_TOOLS.length})`);
for (const text of ["Remember that Jeff prefers morning calls.", "Forget Jeff's old number", "Update the memory about Northwind", "Add this to the Q&A bank"]) {
  assert(asksForMemoryWrite(text), `"${text}" asks for a memory write`);
}
for (const text of ["What do you remember about Jeff?", "Find the pricing deck in my Drive", "Do you remember the Northwind call?"]) {
  assert(!asksForMemoryWrite(text), `"${text}" only reads`);
}
passed.push("rules: 3 s connect, 120 s total, 14 read tools, memory-write requests recognised");

// ---------------------------------------------------------------- the picker
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
const openAdvanced = async () => undefined;
const buttons = () => keyboard.flat();
const noSearchModelButton = () => buttons().every((button) => !/bge/i.test(`${button.text} ${button.callback_data ?? ""}`));

await handleAgentModelCallback(tap("am:h"), openAdvanced);
assert(
  edits.at(-1)!.includes(`Local models (laptop)\n${MODEL} (slow, laptop): Knowledge Agent only. Off.\nbge-m3: search model, not in use`),
  `the home screen has the laptop section (${edits.at(-1)})`,
);
assert(noSearchModelButton(), "bge-m3 has no button on the home screen");
await handleAgentModelCallback(tap(`am:a:${K}`), openAdvanced);
assert(/Local models \(laptop\)\ngemma4:e2b \(slow, laptop\): off\.\nbge-m3: search model, not in use/.test(edits.at(-1)!), `Knowledge's screen shows both local models (${edits.at(-1)})`);
assert(buttons().some((button) => button.text === `${MODEL} (slow, laptop)` && button.callback_data === `am:lm:${K}`), "gemma4:e2b is a button for Knowledge");
assert(noSearchModelButton(), "bge-m3 is only a line of text");

// bge-m3 can't be picked: not by a crafted button, not by the API, and a stored one is ignored.
await handleAgentModelCallback(tap(`am:lm:${K}:bge-m3`), openAdvanced);
assert(/bge-m3/.test(answers.at(-1)!) && !getSetting(LOCAL_AGENT_SETTING), `a crafted bge-m3 tap is refused and nothing is saved (${answers.at(-1)})`);
assert("refused" in toggleLocalModel("knowledge", "bge-m3"), "toggleLocalModel refuses bge-m3");
setSetting(LOCAL_AGENT_SETTING, JSON.stringify({ knowledge: "bge-m3" }));
assert(localModelForAgent("knowledge") === undefined && resolveAgentModel("knowledge").local === undefined, "a stored bge-m3 still runs on cloud");
setSetting(LOCAL_AGENT_SETTING, "{}");
passed.push("bge-m3: shown as a line, never a button; a crafted tap, the API and a stored value are all refused");

await handleAgentModelCallback(tap(`am:lm:${K}`), openAdvanced);
assert(answers.at(-1) === `${MODEL} on` && getSetting(LOCAL_AGENT_SETTING) === JSON.stringify({ knowledge: MODEL }), "tapping gemma4:e2b switches Knowledge to it, under its own key");
assert(buttons().some((button) => button.text === `✅ ${MODEL} (slow, laptop)`) && /gemma4:e2b \(slow, laptop\): on\./.test(edits.at(-1)!), "and the screen shows it on");
assert(getSetting("agent_models_v1") === undefined || getSetting("agent_models_v1") === null, "agent_models_v1 is not written");
await handleAgentModelCallback(tap("am:h"), openAdvanced);
assert(/Knowledge Agent only\. On for Knowledge Agent\./.test(edits.at(-1)!), "the home screen says it is on");
for (const [index, agent] of MODEL_AGENT_IDS.entries()) {
  if (agent === "knowledge") {
    continue;
  }
  await handleAgentModelCallback(tap(`am:a:${index}`), openAdvanced);
  assert(buttons().some((button) => button.text === `🔒 ${LOCAL_LOCKED_TEXT}` && button.callback_data === `am:ll:${index}`), `${agent} shows the button locked`);
  assert(!buttons().some((button) => button.callback_data?.startsWith("am:lm:")), `${agent} has no gemma4:e2b toggle`);
  assert(edits.at(-1)!.includes(`${MODEL}: ${LOCAL_LOCKED_TEXT}`), `${agent}'s screen says why`);
  await handleAgentModelCallback(tap(`am:ll:${index}`), openAdvanced);
  assert(answers.at(-1) === LOCAL_LOCKED_TEXT, `tapping the lock on ${agent} explains it`);
  await handleAgentModelCallback(tap(`am:lm:${index}`), openAdvanced);
  assert(answers.at(-1) === LOCAL_LOCKED_TEXT && getSetting(LOCAL_AGENT_SETTING) === JSON.stringify({ knowledge: MODEL }), `a crafted toggle for ${agent} is refused`);
}
await handleAgentModelCallback(tap(`am:lm:${K}`), openAdvanced);
assert(answers.at(-1) === "Back to the cloud models" && getSetting(LOCAL_AGENT_SETTING) === "{}" && localModelForAgent("knowledge") === undefined, "tapping it again switches back to cloud");
passed.push("picker: gemma4:e2b toggles for Knowledge; the other six agents are locked, in the buttons and in code");

// ---------------------------------------------------------------- a locked agent set to local still runs on cloud
const cloudRoutes = Object.fromEntries(MODEL_AGENT_IDS.map((id) => [id, resolveAgentModel(id).models.map((spec) => spec.key).join(">")]));
setSetting(LOCAL_AGENT_SETTING, JSON.stringify(Object.fromEntries(MODEL_AGENT_IDS.map((id) => [id, MODEL]))));
for (const id of MODEL_AGENT_IDS) {
  const resolved = resolveAgentModel(id);
  assert(resolved.models.map((spec) => spec.key).join(">") === cloudRoutes[id], `${id} keeps its cloud route`);
  if (id === "knowledge") {
    assert(resolved.local?.model === MODEL, "Knowledge resolves to the laptop model first");
  } else {
    assert(resolved.local === undefined && localModelForAgent(id) === undefined, `${id} set to local still resolves to cloud`);
  }
}
await withOllama([{ content: "the laptop should never be asked" }], async (url, bodies) => {
  setLocalAgentModelConfigForTests({ model: MODEL, url });
  cloudCalls = [];
  const email = await runAgent("What did Jeff email me about?", { agentId: "email", modelAgent: "email", saveUserMessage: false, saveAssistantMessage: false });
  const aadi = await runAgent("Good morning", { modelAgent: "aadi", saveUserMessage: false, saveAssistantMessage: false });
  assert(bodies.length === 0, `no locked agent reached the laptop (${bodies.length})`);
  assert(email === "Cloud answer." && aadi === "Cloud answer.", `both answered on cloud with no footer (${email} / ${aadi})`);
  assert(cloudCalls.some((call) => call.agent === "email") && cloudCalls.some((call) => call.agent === "aadi"), "on their own cloud models");
});
setSetting(LOCAL_AGENT_SETTING, JSON.stringify({ knowledge: MODEL }));
passed.push("enforced where the model is resolved: every locked agent with a stored local choice runs on cloud");

// ---------------------------------------------------------------- a local answer, with its footer
await withOllama(
  [{ tools: [{ name: "search_memories", arguments: { query: "Jeff" } }] }, { content: "Jeff prefers morning calls." }],
  async (url, bodies) => {
    setLocalAgentModelConfigForTests({ model: MODEL, url });
    cloudCalls = [];
    toolLog.length = 0;
    const report = newRunReport();
    const text = "What do we know about Jeff's call times?";
    const reply = await runAgent(text, { agentId: "knowledge", modelAgent: "knowledge", guardText: text, report });
    assert(/^Jeff prefers morning calls\./.test(reply) && FOOTER.test(reply), `the reply carries the local footer (${JSON.stringify(reply)})`);
    assert(cloudCalls.length === 0, "no cloud call");
    assert(bodies.length === 2, `two laptop calls: the tool step and the answer (${bodies.length})`);
    const first = bodies[0]!;
    assert(first.model === MODEL && first.stream === false && first.think === false, "Ollama chat: the model, no streaming, thinking off");
    const offered = (first.tools ?? []).map((tool) => tool.function.name).sort();
    assert(offered.join(",") === READ_TOOLS.join(","), `only Knowledge's 14 read tools are offered (${offered.join(",")})`);
    assert(first.messages[0]?.role === "system", "the agent's prompt goes as the system message");
    const second = bodies[1]!.messages;
    assert(second.some((message) => message.role === "assistant" && message.tool_calls?.[0]?.function.name === "search_memories"), "the tool call is sent back");
    assert(second.some((message) => message.role === "tool" && message.tool_name === "search_memories" && message.content === "Jeff: prefers morning calls."), "with its result as role tool");
    assert(toolLog.join(",") === "search_memories", `the read tool ran (${toolLog.join(",")})`);
    assert(report.backend === `local:${MODEL}`, `the run is recorded as local (${report.backend})`);
    const saved = getRecentMessages(10);
    assert(saved.filter((message) => message.role === "user" && message.content === text).length === 1, "the turn is saved once");
    assert(saved.some((message) => message.role === "assistant" && message.content === "Jeff prefers morning calls."), "the saved reply has no footer");
  },
);
passed.push("local answer: Knowledge's read tools on Ollama, tool results sent back, footer on the reply");

// ---------------------------------------------------------------- timeout: cloud answers, with a note
await withOllama(["hang"], async (url, bodies) => {
  setLocalAgentModelConfigForTests({ model: MODEL, url, totalTimeoutMs: 300 });
  cloudCalls = [];
  const started = Date.now();
  const reply = await knowledgeTurn("Summarise the pricing document.");
  assert(reply === `Cloud answer.\n\n${NOTE.slow}`, `too slow: cloud answers with a note (${JSON.stringify(reply)})`);
  assert(bodies.length === 1 && Date.now() - started < 3_000, "after one laptop call that ran out of time");
  assert(cloudCalls.length > 0 && cloudCalls.every((call) => call.agent === "knowledge" && call.tools.includes("remember")), "on Knowledge's cloud model with its normal tools");
});
passed.push("timeout: the laptop is given up on and Knowledge's cloud model answers, with '(answered by cloud: laptop too slow)'");

// ---------------------------------------------------------------- unreachable: cloud answers, with a note
{
  setLocalAgentModelConfigForTests({ model: MODEL, url: await closedPortUrl() });
  cloudCalls = [];
  const started = Date.now();
  const reply = await knowledgeTurn("Summarise the pricing document.");
  assert(reply === `Cloud answer.\n\n${NOTE.unreachable}`, `unreachable: cloud answers with a note (${JSON.stringify(reply)})`);
  assert(Date.now() - started < 3_000, "without waiting out the connect timeout");
  assert(cloudCalls.length > 0 && cloudCalls.every((call) => call.agent === "knowledge" && call.tools.includes("remember")), "on Knowledge's cloud model with its normal tools");
}
passed.push("unreachable: Knowledge's cloud model answers, with '(answered by cloud: laptop unreachable)'");

// ---------------------------------------------------------------- memory writes go to cloud
await withOllama([{ tools: [{ name: "remember", arguments: { fact: "Jeff prefers mornings" } }] }], async (url, bodies) => {
  setLocalAgentModelConfigForTests({ model: MODEL, url });
  cloudCalls = [];
  toolLog.length = 0;
  const reply = await knowledgeTurn("Look up Jeff's details.");
  assert(bodies.length === 1, "the laptop answered once, with a call to remember");
  assert(toolLog.length === 0, `nothing ran from the local run (${toolLog.join(",")})`);
  assert(reply === `Cloud answer.\n\n${NOTE.memory}`, `the turn reran on cloud with the note (${JSON.stringify(reply)})`);
  assert(cloudCalls.length > 0 && cloudCalls.every((call) => call.agent === "knowledge" && call.tools.includes("remember")), "with Knowledge's normal tools");
});
await withOllama([{ content: "the laptop should never be asked" }], async (url, bodies) => {
  setLocalAgentModelConfigForTests({ model: MODEL, url });
  cloudCalls = [];
  const own = await knowledgeTurn("Remember that Jeff prefers morning calls.");
  assert(bodies.length === 0 && own === `Cloud answer.\n\n${NOTE.memory}`, `his own "remember" goes straight to cloud (${JSON.stringify(own)})`);
  const goal = "Remember that Jeff prefers morning calls.";
  const delegated = await delegate({ agentId: "knowledge", capability: "goal", input: { goal }, grant: ownerGrant(goal) });
  assert(bodies.length === 0, "a delegated request to remember never reaches the laptop");
  assert(delegated.state === "completed" && delegated.text === `Cloud answer.\n\n${NOTE.memory}`, `and is answered on cloud with the note (${delegated.state} ${JSON.stringify(delegated.text)})`);
});
passed.push("memory writes: a local call to remember is stopped before it runs and the turn reruns on cloud; a request to remember never goes local");

// ---------------------------------------------------------------- a delegated read runs local
await withOllama([{ content: "Jeff prefers mornings." }], async (url, bodies) => {
  setLocalAgentModelConfigForTests({ model: MODEL, url });
  cloudCalls = [];
  const goal = "Find what we know about Jeff's call times.";
  const done = await delegate({ agentId: "knowledge", capability: "goal", input: { goal }, grant: ownerGrant(goal) });
  assert(done.state === "completed" && /^Jeff prefers mornings\./.test(done.text ?? "") && FOOTER.test(done.text ?? ""), `a delegated read answers locally (${JSON.stringify(done.text)})`);
  const offered = (bodies[0]?.tools ?? []).map((tool) => tool.function.name);
  assert(READ_TOOLS.every((name) => offered.includes(name)) && offered.includes("report_result") && !offered.includes("escalate_to_aadi"), `with its read tools and the task tools (${offered.join(",")})`);
  assert(!offered.some((name) => ["remember", "update_memory", "forget_memory", "learn_qa_bank", "ignore_item"].includes(name)), "and no write tool");
  assert(cloudCalls.length === 0, "no cloud call");
});
passed.push("delegated goal: Knowledge's read goal runs on the laptop with only read and task tools");

// ---------------------------------------------------------------- escalate_to_aadi reruns on cloud
{
  const text = "Search my Drive for the pricing deck";
  const picked = pickRoute(text);
  assert(picked.kind === "specialist" && picked.agentId === "knowledge", `the request goes to Knowledge (${JSON.stringify(picked)})`);
  await withOllama([{ tools: [{ name: "escalate_to_aadi", arguments: { reason: "needs email" } }] }], async (url, bodies) => {
    setLocalAgentModelConfigForTests({ model: MODEL, url });
    cloudCalls = [];
    toolLog.length = 0;
    const out: { value?: Route } = {};
    const reply = await runOwnerTurn(text, { ownerText: text, guardText: text, chatId: CHAT, route: out });
    assert(out.value?.kind === "specialist" && out.value.agentId === "knowledge", "a one-domain Knowledge turn");
    assert(bodies.length === 1 && (bodies[0]?.tools ?? []).some((tool) => tool.function.name === "escalate_to_aadi"), "the laptop was offered escalate_to_aadi and called it");
    assert(reply === `Cloud answer.\n\n${NOTE.tool}`, `the turn reran on cloud (${JSON.stringify(reply)})`);
    assert(cloudCalls[0]?.agent === "knowledge" && cloudCalls[0].tools.includes("escalate_to_aadi") && cloudCalls[0].tools.includes("remember"), "as Knowledge with its normal tools, which can hand back to Aadi");
  });
}
passed.push("escalate_to_aadi from a local run: the turn reruns on Knowledge's cloud model, which can hand back to Aadi");

// ---------------------------------------------------------------- a job with a local step: one line, in code
{
  const LINE = `(includes a step answered by ${MODEL}, local)`;
  const text = "Find what we know about Jeff's call times and judge whether Northwind is worth a first conversation.";
  const knowledgeStep = (key: string, goal: string) => ({ key, agent: "knowledge", capability: "goal", goal, complexity: "light" });
  const salesStep = { key: "northwind", agent: "sales", capability: "goal", goal: "Judge whether Northwind is worth a first conversation.", complexity: "light" };
  /** Aadi hands out the job, then answers from its results; Sales answers on cloud. */
  const playJob = (tasks: unknown[]) => (params: CompleteParams): CompleteResult | undefined => {
    if (params.route?.agentId === "aadi") {
      return params.messages.some((message) => message.role === "tool")
        ? modelReply({ text: "Summary for Vishnu." })
        : modelReply({ tools: [{ name: "delegate_tasks", input: { title: "Jeff and Northwind", tasks } }] });
    }
    return params.route?.agentId === "sales" ? modelReply({ text: "Sales finding: Northwind is worth a call." }) : undefined;
  };
  const job = async (): Promise<string> => {
    const out: { value?: Route } = {};
    const reply = await runOwnerTurn(text, {
      ownerText: text,
      guardText: text,
      chatId: CHAT,
      sendConfirmation: { chatId: CHAT, messageId: nextMessageId() },
      postCard: async () => undefined,
      route: out,
    });
    assert(out.value?.kind === "aadi", `the job goes to Aadi (${JSON.stringify(out.value)})`);
    return reply;
  };
  const occurrences = (reply: string) => reply.split(LINE).length - 1;

  // Two steps: Knowledge on the laptop, Sales on cloud.
  await withOllama([{ content: "Jeff prefers morning calls." }], async (url, bodies) => {
    setLocalAgentModelConfigForTests({ model: MODEL, url });
    cloudCalls = [];
    cloudPlay = playJob([knowledgeStep("jeff", "Find what we know about Jeff's call times."), salesStep]);
    const reply = await job();
    assert(bodies.length === 1, `the Knowledge step went to the laptop (${bodies.length})`);
    assert(cloudCalls.some((call) => call.agent === "sales") && !cloudCalls.some((call) => call.agent === "knowledge"), "Sales ran on cloud, Knowledge did not");
    assert(reply === `Summary for Vishnu.\n\n${LINE}` && occurrences(reply) === 1, `the final reply ends with the line once (${JSON.stringify(reply)})`);
    assert(!getRecentMessages(20).some((message) => message.content.includes("(includes a step")), "the line is not saved to history");
  });

  // Two Knowledge steps on the laptop: still one line.
  await withOllama([{ content: "Jeff prefers morning calls." }, { content: "Northwind's last call notes are from May." }], async (url, bodies) => {
    setLocalAgentModelConfigForTests({ model: MODEL, url });
    cloudPlay = playJob([
      knowledgeStep("jeff", "Find what we know about Jeff's call times."),
      knowledgeStep("notes", "Find our call notes on Northwind."),
      salesStep,
    ]);
    const reply = await job();
    assert(bodies.length === 2 && occurrences(reply) === 1, `two local steps, one line (${bodies.length} ${JSON.stringify(reply)})`);
  });

  // The same two-step job with the laptop unreachable: Knowledge falls back, no line.
  setLocalAgentModelConfigForTests({ model: MODEL, url: await closedPortUrl() });
  cloudCalls = [];
  cloudPlay = playJob([knowledgeStep("jeff", "Find what we know about Jeff's call times."), salesStep]);
  const fellBack = await job();
  assert(cloudCalls.some((call) => call.agent === "knowledge") && cloudCalls.some((call) => call.agent === "sales"), "both steps ran on cloud");
  assert(fellBack === "Summary for Vishnu." && occurrences(fellBack) === 0, `no line when every local attempt fell back (${JSON.stringify(fellBack)})`);
  cloudPlay = undefined;
}
passed.push("job: a Knowledge step answered locally adds '(includes a step answered by gemma4:e2b, local)' once to Aadi's final reply, not to history; a fallback adds nothing");

// ---------------------------------------------------------------- the choice survives a restart
{
  const dir = mkdtempSync(join(tmpdir(), "aadi-local-models-"));
  const env = { ...process.env, AADI_DB_PATH: join(dir, "local.db") };
  const child = (mode: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, ["--import", "tsx", "scripts/local-model-picker-child.ts", mode], { env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      proc.stdout?.on("data", (chunk: Buffer) => {
        out += chunk.toString();
      });
      proc.once("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`child ${mode} exited ${code}`))));
    });
  try {
    assert(/SET \{"on":true\}/.test(await child("set")), "the first process switches Knowledge to the laptop");
    const read = JSON.parse(/READ (.+)/.exec(await child("read"))?.[1] ?? "{}") as { local?: string; resolved?: string; cloud?: string[] };
    assert(read.local === MODEL && read.resolved === MODEL, `a new process reads the same choice (${JSON.stringify(read)})`);
    assert((read.cloud ?? []).length > 0, "and still has the cloud models behind it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
passed.push("the choice is saved in SQLite and survives a real restart");

setCompleteForTests(undefined);
setToolInterceptorForTests(undefined);
setLocalAgentModelConfigForTests(undefined);
setGoalLimitsForTests(undefined);
log(passed.map((line) => `  ok  ${line}`).join("\n"));
log("test-local-model-picker: ok");
