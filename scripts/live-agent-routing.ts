/**
 * The real chat model, routed the way a Telegram turn is, on invented data.
 *
 * Every tool handler is replaced by a fixture, and Gmail and Google accounts are
 * stubs that throw, so nothing reads a mailbox, sends, books or reaches Telegram.
 * The database is in memory. Only the model calls are real.
 *
 * Run it once per mode to compare:
 *   AGENT_ROUTING=off  npm run live:agent-routing   (one agent with every tool)
 *   AGENT_ROUTING=full npm run live:agent-routing   (direct answers, specialists, delegation)
 */
import { writeFileSync } from "node:fs";
import { setToolInterceptorForTests } from "../src/agent.ts";
import { issueGrant } from "../src/agents/auth.ts";
import { localSpecialists } from "../src/agents/index.ts";
import { runOwnerTurn, tryDirectAnswer, type Route } from "../src/agents/orchestrator.ts";
import { config } from "../src/config.ts";
import { db } from "../src/db.ts";
import { setGoogleAccountForTests } from "../src/google/auth.ts";
import { setGmailClientForTests } from "../src/google/mail.ts";
import { tools } from "../src/tools/index.ts";

if (process.env.AADI_DB_PATH !== ":memory:") {
  throw new Error("live-agent-routing.ts must run with AADI_DB_PATH=:memory:");
}

setGoogleAccountForTests(() => undefined);
setGmailClientForTests(() => {
  throw new Error("Gmail is not reachable from this check.");
});

const log = console.log;
console.log = () => undefined;
console.error = () => undefined;

const DAY = 24 * 3600_000;
const ist = (at: Date) => new Date(at.getTime() + 330 * 60_000);
const meetingDay = (() => {
  let at = new Date(Date.now() + 3 * DAY);
  while ([0, 6].includes(ist(at).getUTCDay())) {
    at = new Date(at.getTime() + DAY);
  }
  return ist(at);
})();
const dayLabel = meetingDay.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

let toolCalls: Array<{ name: string; ownerTurn: boolean }> = [];
const fixtures: Record<string, (input: Record<string, unknown>) => string> = {
  search_emails: () =>
    JSON.stringify([
      {
        id: "m-armaan-1",
        account: "work",
        from: "Armaan Shah <armaan@example.com>",
        subject: "Re: Meeting next week",
        date: new Date(Date.now() - DAY).toUTCString(),
        snippet: `${dayLabel} at 4pm IST works for me`,
      },
    ]),
  read_email: () => `From: Armaan Shah <armaan@example.com>\nSubject: Re: Meeting next week\n\n${dayLabel} at 4pm IST works for me. See you then.`,
  read_thread: () => `From: Armaan Shah <armaan@example.com>\nSubject: Re: Meeting next week\n\n${dayLabel} at 4pm IST works for me. See you then.`,
  list_events: () => "No events found.",
  create_meeting: (input) => `Meeting created with ${String(input.person ?? "Armaan")} at ${String(input.start_time)}. Meet link sent.`,
  book_meeting: (input) => `Booked at ${String(input.start_time)}. Invite sent.`,
  set_reminder: (input) => `Reminder set: "${String(input.text)}" at ${String(input.remind_at ?? input.time ?? "the time given")}.`,
  start_sequence: () => "Start card posted for Rahul Mehta <rahul@example.com>. Nothing is enrolled until Vishnu taps Start.",
  list_tasks: () => "1. [work] Send the Acme deck (due tomorrow)\n2. [personal] Renew the domain",
  add_task: (input) => `Task added: ${String(input.text)}`,
  web_search: () => "Could not search right now.",
};
setToolInterceptorForTests((call, turn) => {
  toolCalls.push({ name: call.name, ownerTurn: turn.confirmation !== undefined });
  return fixtures[call.name]?.(call.input as Record<string, unknown>) ?? "No results.";
});

interface UsageRow {
  task: string;
  model: string;
  input_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  cost_usd: number;
}
const usageSince = (id: number) => db.prepare(`SELECT * FROM usage_log WHERE id > ? ORDER BY id`).all(id) as UsageRow[];
const lastUsageId = () => (db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM usage_log`).get() as { id: number }).id;

const PHRASES = [
  "What's my next meeting?",
  "Show my scheduled emails.",
  "What's on my calendar tomorrow?",
  "Remind me to call the bank at 5pm tomorrow.",
  "Start a follow-up sequence for Rahul.",
  "What are my open tasks?",
  "Check if Armaan replied about the meeting and book it if he confirmed a time",
  "ok thanks, that's all for now",
];

interface Measured {
  phrase: string;
  route: string;
  modelCalls: number;
  models: string[];
  firstCallContext: number;
  inputTokens: number;
  cacheWrite: number;
  cacheRead: number;
  outputTokens: number;
  costUsd: number;
  ms: number;
  tools: string[];
  reply: string;
}

let messageId = 9000;
async function turn(phrase: string): Promise<Measured> {
  toolCalls = [];
  const before = lastUsageId();
  const confirmation = { chatId: 1, messageId: (messageId += 1) };
  const startedAt = Date.now();
  let route = "aadi";
  let reply: string;
  const grant = issueGrant({ source: "owner_chat", confirmation, ownerText: phrase });
  const direct = await tryDirectAnswer(phrase, { chatId: 1, grant });
  if (direct) {
    route = "direct (no model)";
    reply = direct.text;
  } else {
    const picked: { value?: Route; report?: { widened: boolean } } = {};
    reply = await runOwnerTurn(phrase, {
      ownerText: phrase,
      guardText: phrase,
      chatId: 1,
      sendConfirmation: confirmation,
      postCard: async () => undefined,
      route: picked,
    });
    const value = picked.value;
    route =
      value?.kind === "specialist"
        ? `${value.agentId} agent${picked.report?.widened ? " -> handed back to Aadi" : ""}`
        : toolCalls.length > 0 && config.agentRouting === "full" && phrase.startsWith("Check if")
          ? "aadi -> delegated"
          : "aadi";
  }
  const ms = Date.now() - startedAt;
  const usage = usageSince(before);
  const sum = (pick: (row: UsageRow) => number) => usage.reduce((total, row) => total + pick(row), 0);
  const first = usage[0];
  return {
    phrase,
    route,
    modelCalls: usage.length,
    models: [...new Set(usage.map((row) => row.model))],
    firstCallContext: first ? first.input_tokens + first.cache_write_tokens + first.cache_read_tokens : 0,
    inputTokens: sum((row) => row.input_tokens),
    cacheWrite: sum((row) => row.cache_write_tokens),
    cacheRead: sum((row) => row.cache_read_tokens),
    outputTokens: sum((row) => row.output_tokens),
    costUsd: sum((row) => row.cost_usd),
    ms,
    tools: toolCalls.map((call) => call.name),
    reply: reply.replace(/\s+/g, " ").slice(0, 150),
  };
}

// What each loop sends before the conversation: its prompt and its tool list.
const toolChars = (names: readonly string[]) => names.reduce((total, name) => total + JSON.stringify(tools[name]!.definition).length, 0);
const { defaultToolNames } = await import("../src/agent.ts");
const { readFile } = await import("node:fs/promises");
const aadiNames = defaultToolNames(config.sendOnCommandEnabled);
const prefixes = [
  { loop: "aadi", promptChars: (await readFile("prompts/system.md", "utf8")).length, tools: aadiNames.length, toolChars: toolChars(aadiNames) },
];
for (const agent of localSpecialists()) {
  if (agent.definition.noGoal) {
    continue;
  }
  const names = agent.toolNames().filter((name) => aadiNames.includes(name));
  prefixes.push({ loop: agent.definition.id, promptChars: (await agent.prompt()).length, tools: names.length, toolChars: toolChars(names) });
}

const results: Measured[] = [];
// Two passes: the first writes the prompt cache, the second reads it.
for (const pass of ["cold", "warm"] as const) {
  for (const phrase of PHRASES) {
    try {
      const measured = await turn(phrase);
      results.push({ ...measured, phrase: `${pass}: ${phrase}` });
      log(
        [
          `[${config.agentRouting}/${pass}] ${phrase}`,
          `  route=${measured.route} model_calls=${measured.modelCalls} models=${measured.models.join("+") || "-"} ms=${measured.ms}`,
          `  first_call_context=${measured.firstCallContext} input=${measured.inputTokens} cache_write=${measured.cacheWrite} cache_read=${measured.cacheRead} output=${measured.outputTokens} cost_usd=${measured.costUsd.toFixed(5)}`,
          `  tools=[${measured.tools.join(", ")}]`,
          `  reply: ${measured.reply}`,
        ].join("\n"),
      );
    } catch (error) {
      log(`[${config.agentRouting}/${pass}] ${phrase}\n  FAILED: ${error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : "unknown"}`);
    }
  }
}

const memory = process.memoryUsage();
const totals = {
  mode: config.agentRouting,
  turns: results.length,
  modelCalls: results.reduce((total, row) => total + row.modelCalls, 0),
  costUsd: Number(results.reduce((total, row) => total + row.costUsd, 0).toFixed(5)),
  ms: results.reduce((total, row) => total + row.ms, 0),
  rssMb: Math.round(memory.rss / 1048576),
  heapUsedMb: Math.round(memory.heapUsed / 1048576),
};
log(`\nprefix sizes (chars): ${JSON.stringify(prefixes)}`);
log(`totals: ${JSON.stringify(totals)}`);
if (process.env.LIVE_ROUTING_OUT) {
  writeFileSync(process.env.LIVE_ROUTING_OUT, JSON.stringify({ totals, prefixes, results }, null, 2));
}
process.exit(0);
