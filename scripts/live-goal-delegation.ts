/**
 * Real Gemini and chat models, fixture tools, in-memory database.
 *
 * 1. Gemini multi-turn function calling must echo thought_signature.
 * 2. A plain lookup stays on Aadi.
 * 3. A complex judgment, with no mention of delegation, is handed to two goals.
 *
 *   npm run live:goal-delegation
 */
if (process.env.AADI_DB_PATH !== ":memory:") {
  throw new Error("live-goal-delegation.ts must run with AADI_DB_PATH=:memory:");
}
process.env.AGENT_GOAL_DELEGATION = "true";

const { complete } = await import("../src/llm.ts");
const { setToolInterceptorForTests } = await import("../src/agent.ts");
const { runOwnerTurn } = await import("../src/agents/orchestrator.ts");
const { config } = await import("../src/config.ts");
const { db } = await import("../src/db.ts");
const { setGoogleAccountForTests } = await import("../src/google/auth.ts");
const { setGmailClientForTests } = await import("../src/google/mail.ts");

setGoogleAccountForTests(() => undefined);
setGmailClientForTests(() => {
  throw new Error("Gmail is not reachable from this check.");
});

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const echo = {
  type: "function" as const,
  name: "echo",
  description: "Echo the text you were given.",
  inputSchema: {
    type: "object" as const,
    properties: { text: { type: "string" } },
    required: ["text"],
  },
};

const thoughtStarted = Date.now();
const system = { cacheable: "You are a test assistant. Call the tool you are asked to call." };
const first = await complete({
  backend: "gemini",
  noFallback: true,
  system,
  tools: [echo],
  toolChoice: { name: "echo" },
  messages: [{ role: "user", content: "Call echo with the text ping." }],
  task: "other",
});
const signature = first.toolCalls[0]?.thoughtSignature;
assert(first.toolCalls.length > 0, "Gemini did not call echo");
assert(typeof signature === "string" && signature.length > 20, "Gemini omitted thought_signature on the function call");
const second = await complete({
  backend: "gemini",
  noFallback: true,
  system,
  tools: [echo],
  messages: [
    { role: "user", content: "Call echo with the text ping." },
    { role: "assistant", textParts: first.textParts, toolCalls: first.toolCalls },
    { role: "tool", toolCallId: first.toolCalls[0]!.id, content: "pong" },
  ],
  task: "other",
});
assert(!/thought_signature/i.test(second.textParts.join(" ")), "the follow-up turn was rejected");
console.log(
  `thought_signature: round trip ok, chars=${signature.length}, follow_up_tools=${second.toolCalls.length}, ms=${Date.now() - thoughtStarted}`,
);

const FORBIDDEN = new Set([
  "send_email",
  "confirm_send_pending_draft",
  "draft_new_email",
  "draft_reply",
  "draft_mom",
  "update_draft",
  "start_sequence",
  "create_event",
  "create_meeting",
  "book_meeting",
  "move_event",
  "delete_calendar_event",
  "add_calendar_attendee",
  "propose_calendar_event",
]);

const calls: string[] = [];
setToolInterceptorForTests((call) => {
  calls.push(call.name);
  if (FORBIDDEN.has(call.name)) {
    return `Refused by the check: ${call.name} is not run here.`;
  }
  if (call.name === "web_search" || call.name === "latest_release") {
    return "A2A protocol\nLatest stable release: 1.2.0 (2026-09-01). Source: https://example.test/a2a/releases\nThe 1.3.0-rc.1 prerelease is not stable.";
  }
  if (call.name === "list_accounts" || call.name === "account_status" || call.name === "list_sales_facts") {
    return "No accounts tracked yet.";
  }
  if (call.name === "get_current_time") {
    return "Friday, 13 November 2026, 11:30 pm IST";
  }
  return "No results.";
});

const phrases = [
  {
    name: "lookup",
    expectGoals: 0,
    text: "What's the latest stable A2A release, and do we already track an account named Acme? Don't email anyone and don't change the calendar.",
  },
  {
    name: "judgment",
    expectGoals: 2,
    text: "I need two judgments before I talk to anyone. From the official A2A release list, decide whether the latest stable release is a breaking change a client would care about, and keep any prerelease out of that decision. Then decide whether a company we have never tracked, called Northwind, is worth a first conversation about that release, using the release decision. Don't email anyone and don't change the calendar.",
  },
];
assert(
  !phrases.some((phrase) => /\b(?:delegate|delegation|goal|specialist|agents?)\b/i.test(phrase.text)),
  "the prompts must not mention delegation",
);

interface UsageRow {
  model: string;
  cost_usd: number;
}
console.log(`routing=${config.agentRouting} goal_delegation=${config.goalDelegation.enabled}`);
let messageId = 92000;
for (const phrase of phrases) {
  calls.length = 0;
  const before = (db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM usage_log`).get() as { id: number }).id;
  const goalBefore = (db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM agent_goal_runs`).get() as { id: number }).id;
  const started = Date.now();
  const reply = await runOwnerTurn(phrase.text, {
    ownerText: phrase.text,
    guardText: phrase.text,
    chatId: 1,
    sendConfirmation: { chatId: 1, messageId: (messageId += 1) },
    postCard: async () => undefined,
  });
  const usage = db.prepare(`SELECT model, cost_usd FROM usage_log WHERE id > ?`).all(before) as UsageRow[];
  const goals = db.prepare(`SELECT agent_id, task_id, tier, backend, model, llm_calls, cost_usd, latency_ms, outcome, tools_json FROM agent_goal_runs WHERE id > ? ORDER BY id`).all(goalBefore) as Array<{
    agent_id: string;
    task_id: string;
    tier: string;
    backend: string;
    model: string;
    llm_calls: number;
    cost_usd: number;
    latency_ms: number;
    outcome: string;
    tools_json: string;
  }>;
  const forbidden = calls.filter((name) => FORBIDDEN.has(name));
  const cost = usage.reduce((total, row) => total + row.cost_usd, 0);
  console.log(`\n[${phrase.name}] ms=${Date.now() - started} model_calls=${usage.length} cost_usd=${cost.toFixed(6)} goal_loops=${goals.length}`);
  console.log(`tools=[${calls.join(", ")}] models=${[...new Set(usage.map((row) => row.model))].join(", ") || "-"}`);
  for (const goal of goals) {
    console.log(
      `  agent=${goal.agent_id} task=${goal.task_id} tier=${goal.tier} backend=${goal.backend} model=${goal.model} llm_calls=${goal.llm_calls} cost_usd=${goal.cost_usd} ms=${goal.latency_ms} outcome=${goal.outcome} tools=${goal.tools_json}`,
    );
  }
  console.log(`reply: ${reply.replace(/\s+/g, " ").slice(0, 360)}`);
  if (forbidden.length > 0) {
    throw new Error(`forbidden tools were requested: ${forbidden.join(", ")}`);
  }
  if (phrase.expectGoals === 0 && goals.length !== 0) {
    throw new Error("the lookup started a specialist goal loop");
  }
  if (phrase.expectGoals > 0) {
    const agents = new Set(goals.map((goal) => goal.agent_id));
    if (goals.length < phrase.expectGoals || agents.size < 2) {
      throw new Error(`expected two specialist goals, got ${goals.length} from ${[...agents].join(",") || "nobody"}`);
    }
  }
}
console.log("\nLive goal delegation check passed.");
process.exit(0);
