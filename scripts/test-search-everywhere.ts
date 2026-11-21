/**
 * search_everywhere: one read across notes, past chat, memories, documents,
 * Drive and Gmail, the routing that brings lookups to the Knowledge Agent, and
 * a local (laptop) Knowledge run that may call it.
 *
 * Gmail, Drive and the meaning search are fakes; notes, chat, memories and
 * documents are real rows in an in-memory database. The model is scripted.
 * Nothing reaches a provider, Gmail, Drive or Telegram.
 */
import http from "node:http";
import { runAgent, setToolInterceptorForTests } from "../src/agent.ts";
import { pickRoute, runOwnerTurn, type Route } from "../src/agents/orchestrator.ts";
import { specialistFor } from "../src/agents/index.ts";
import { createDocument, createMemory, createNote, saveMessage, setSetting } from "../src/db.ts";
import { setCompleteForTests, type CompleteParams, type CompleteResult } from "../src/llm.ts";
import { initMetrics } from "../src/metrics.ts";
import { LOCAL_AGENT_SETTING, setLocalAgentModelConfigForTests } from "../src/models/local_agent_models.ts";
import {
  handler as searchEverywhere,
  SEARCH_EVERYWHERE_MAX_CHARS,
  SEARCH_EVERYWHERE_SOURCE_TIMEOUT_MS,
  setSearchEverywhereForTests,
  type EmailHit,
} from "../src/tools/search_everywhere.ts";
import { modelReply, nextMessageId } from "./fakes.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

if (process.env.AADI_DB_PATH !== ":memory:") {
  throw new Error("test-search-everywhere.ts must run with AADI_DB_PATH=:memory:");
}

const log = console.log;
console.log = () => undefined;
console.warn = () => undefined;
console.error = () => undefined;

const passed: string[] = [];
initMetrics();
setToolInterceptorForTests(undefined);

const SHRIRAM_THREAD = "SLIC KYC – Details Required from Shriram (Flows, SMS Templates, APIs)";
const MUNIL_THREAD = "Epicode <> Talkdesk - exploring a telephony and dialer partnership";
const ALL_SOURCES = "Sources checked: Notes, Chat history, Memories, Documents, Drive, Gmail";
const MODEL = "gemma4:e2b";

// ---------------------------------------------------------------- data
createNote("Pinnacle weekly", "Sumeet", "work", "Went over the DLT templates for Shriram Life.", null);
createMemory({ content: "Shriram Life is an end client that comes through Pinnacle.", category: "deal", tag: "work", source: "explicit" });
createDocument("Epicode pricing tiers.pdf", "work", "Epicode pricing tiers for telephony: Starter, Growth, Scale.", null);
saveMessage("user", "Munil from Talkdesk wants a call next week");
saveMessage("assistant", "I couldn’t find any saved notes matching Munil and pricing.");

const gmailQueries: string[] = [];
const email = (subject: string, from: string, snippet: string, account = "work"): EmailHit => ({
  account,
  from,
  to: "vishnu@epicode.in",
  subject,
  date: "Fri, 30 Oct 2026 18:01:13 +0530",
  snippet,
});
let gmail: (query: string) => EmailHit[] = (query) => {
  const q = query.toLowerCase();
  if (q.includes("shriram")) {
    return [
      email(`Re: ${SHRIRAM_THREAD}`, "Sumeet Monga <sumeet.monga@pinnacle.in>", "Attaching the BRD for the SLIC KYC flows."),
      email(`Re: ${SHRIRAM_THREAD}`, "Sharadhi Ballal <sharadhi@epicode.in>", "Updated BRD with the SMS templates.", "personal"),
      email(SHRIRAM_THREAD, "Armaan Ibrahim <armaan.ibrahim@pinnacle.in>", "Please share the BRD and API list."),
    ];
  }
  if (q === "to:munil") {
    return Array.from({ length: 5 }, (_, index) => email(index === 0 ? MUNIL_THREAD : `Re: ${MUNIL_THREAD}`, "Vishnu Rajan <vishnu.rajan@epicode.in>", "Following up on the partnership."));
  }
  return [];
};
const driveFiles = [
  { id: "1", name: "Shriram Life - SLIC", mimeType: "application/vnd.google-apps.folder", webViewLink: "https://drive.example/1", modifiedTime: "2026-10-30T10:00:00Z" },
  { id: "2", name: "Shriram : Pending Tasks", mimeType: "application/vnd.google-apps.spreadsheet", webViewLink: "https://drive.example/2", modifiedTime: "2026-10-29T10:00:00Z" },
];
const seamsFor = (overrides: Parameters<typeof setSearchEverywhereForTests>[0] = {}) =>
  setSearchEverywhereForTests({
    gmail: async (query) => {
      gmailQueries.push(query);
      return gmail(query);
    },
    drive: async (query) => driveFiles.filter((file) => file.name.toLowerCase().includes(query.toLowerCase())),
    semanticHistory: async () => [],
    ...overrides,
  });
seamsFor();

// ---------------------------------------------------------------- routing
const route = (text: string): Route => pickRoute(text, { mode: "full" });
const routeOf = (text: string) => {
  const picked = route(text);
  return picked.kind === "specialist" ? picked.agentId : picked.kind;
};
assert(routeOf("Can you find my notes on the Shriram brd") === "knowledge", `"find my notes on the Shriram brd" goes to Knowledge (${JSON.stringify(route("Can you find my notes on the Shriram brd"))})`);
assert(routeOf("What did munil say about pricing") === "knowledge", `"what did munil say" goes to Knowledge (${JSON.stringify(route("What did munil say about pricing"))})`);
assert(routeOf("Where is the SOW doc for Pinnacle") === "knowledge", "a document word goes to Knowledge");
assert(routeOf("reply to Munil about pricing") === "email", `a reply command goes to Email (${JSON.stringify(route("reply to Munil about pricing"))})`);
assert(routeOf("draft an email with the BRD notes") === "email", `a draft command goes to Email, not Knowledge (${JSON.stringify(route("draft an email with the BRD notes"))})`);
assert(routeOf("remind me to read the BRD") === "operations", `a reminder goes to Operations (${JSON.stringify(route("remind me to read the BRD"))})`);
assert(routeOf("search my inbox for the Northwind thread") === "email", "a lookup word doesn't pull an inbox search away from Email");
const plain = "Who handles onboarding at Northwind?";
assert(routeOf(plain) === "aadi", `with Knowledge on cloud, an unclaimed question stays with Aadi (${JSON.stringify(route(plain))})`);
setSetting(LOCAL_AGENT_SETTING, JSON.stringify({ knowledge: MODEL }));
assert(routeOf(plain) === "knowledge", "with Knowledge on the laptop, an unclaimed question goes to Knowledge");
assert(routeOf("Book a call with Northwind tomorrow at 4") !== "knowledge", "a command is never sent there");
assert(routeOf("What did Munil say about pricing and is he free Thursday?") === "aadi", "a message with a second request stays with Aadi, even with Knowledge local");
setSetting(LOCAL_AGENT_SETTING, "{}");
passed.push("routing: notes, document words and recall phrasing reach Knowledge; commands still win; a plain question goes to local Knowledge");

// ---------------------------------------------------------------- the tool itself
{
  assert(SEARCH_EVERYWHERE_SOURCE_TIMEOUT_MS === 10_000, "10 s per source");
  const text = await searchEverywhere({ query: "Shriram BRD" });
  assert(text.includes(ALL_SOURCES) && text.includes("Sources that failed: none"), `every source is checked (${text})`);
  assert(text.includes(`Gmail: 3 matches`) && text.includes(`${SHRIRAM_THREAD} (3 messages)`), "Gmail groups the thread and counts its messages");
  assert(
    /Drive: 0 full matches; closest partly match/.test(text) && text.includes("Shriram Life - SLIC") && text.includes("Shriram : Pending Tasks"),
    "Drive is searched word by word when the phrase finds nothing, and files with only one word are partial",
  );
  assert(/Notes: 0 full matches; closest partly match/.test(text) && text.includes("Pinnacle weekly"), "a note with only one of the words is shown as a partial match");
  assert(text.length <= SEARCH_EVERYWHERE_MAX_CHARS, `capped at ${SEARCH_EVERYWHERE_MAX_CHARS} chars (${text.length})`);
}
{
  gmailQueries.length = 0;
  const text = await searchEverywhere({ query: "pricing", person: "Munil" });
  assert(
    gmailQueries.slice(0, 3).join(" | ") === "from:Munil pricing | to:Munil pricing | pricing",
    `Gmail tries from:, then to:, then the words (${gmailQueries.join(" | ")})`,
  );
  assert(gmailQueries.includes("from:Munil") && gmailQueries.includes("to:Munil"), "and then every thread with him");
  assert(text.includes(`the only thread with Munil: "${MUNIL_THREAD}"`) && text.includes("5 messages to Munil, 0 messages from Munil (no reply from them)"), `the closest thing is named (${text})`);
  assert(/Documents: 1 match/.test(text) && text.includes("Epicode pricing tiers.pdf"), "a pricing document is found");
  assert(!text.includes("couldn’t find any saved notes"), "Aadi's earlier 'couldn't find' reply is not a hit");
}
passed.push("tool: per-source counts and top hits, Gmail from:/to:/words then the closest thread, partial matches, 3,000-char cap");

{
  seamsFor({ drive: () => new Promise(() => undefined), timeoutMs: 150 });
  const started = Date.now();
  const text = await searchEverywhere({ query: "Shriram BRD" });
  assert(Date.now() - started < 2_000, "a hanging source doesn't hold up the lookup");
  assert(text.includes("Sources that failed: Drive (timed out after 0.15 s)"), `the timed-out source is listed as failed (${text})`);
  assert(text.includes("Sources checked: Notes, Chat history, Memories, Documents, Gmail") && text.includes(SHRIRAM_THREAD), "and the other sources still answer");
  seamsFor({ gmail: async () => { throw new Error("invalid_grant"); } });
  const failed = await searchEverywhere({ query: "Shriram BRD" });
  assert(failed.includes("Sources that failed: Gmail (failed)") && !failed.includes("invalid_grant"), "a failing source is listed, without its error text");
  seamsFor();
}
passed.push("failures: a timed-out or failing source is listed as failed and the rest still answer");

{
  const secrets = ["482913", "hunter2", "4111", "551204", "778899", "246810"];
  gmail = () => [
    email("Your login code 778899", "Bank <alerts@bank.example>", "Your OTP is 482913. Password: hunter2. Card 4111 1111 1111 1111. Verification code 551204."),
  ];
  createNote("Portal access", "IT", "work", "The portal otp 246810 expired; Pinnacle access for Shriram pending.", null);
  const text = await searchEverywhere({ query: "Shriram portal" });
  const leaked = secrets.filter((secret) => text.includes(secret));
  assert(leaked.length === 0, `no OTP, password or card number in the output (leaked: ${leaked.join(",")})\n${text}`);
  assert(text.includes("[redacted]"), "they are replaced, not dropped silently");
}
passed.push("redaction: OTPs, codes, passwords and card numbers never appear");

// ---------------------------------------------------------------- end to end on Knowledge's cloud model
gmail = (query) => {
  const q = query.toLowerCase();
  if (q.includes("shriram")) {
    return [email(`Re: ${SHRIRAM_THREAD}`, "Sumeet Monga <sumeet.monga@pinnacle.in>", "Attaching the BRD for the SLIC KYC flows.")];
  }
  return q === "to:munil"
    ? Array.from({ length: 5 }, () => email(`Re: ${MUNIL_THREAD}`, "Vishnu Rajan <vishnu.rajan@epicode.in>", "Following up."))
    : [];
};
let cloudPlay: ((params: CompleteParams) => CompleteResult | undefined) | undefined;
const cloudCalls: Array<{ agent: string; tools: string[] }> = [];
setCompleteForTests(async (params) => {
  if (params.tools.length === 0) {
    return modelReply({ text: '{"facts":[]}' });
  }
  cloudCalls.push({ agent: params.route?.agentId ?? "?", tools: params.tools.map((tool) => ("name" in tool ? tool.name : "?")) });
  return cloudPlay?.(params) ?? modelReply({ text: "Cloud answer." });
});
const lastTool = (params: CompleteParams) => {
  const message = [...params.messages].reverse().find((item) => item.role === "tool");
  return message && message.role === "tool" ? message.content : undefined;
};
const CHAT = 91;
async function owner(text: string): Promise<{ reply: string; route?: Route }> {
  const out: { value?: Route } = {};
  const reply = await runOwnerTurn(text, {
    ownerText: text,
    guardText: text,
    chatId: CHAT,
    sendConfirmation: { chatId: CHAT, messageId: nextMessageId() },
    postCard: async () => undefined,
    route: out,
  });
  return { reply, route: out.value };
}

{
  const called: unknown[] = [];
  cloudPlay = (params) => {
    if (params.route?.agentId !== "knowledge") {
      return undefined;
    }
    const result = lastTool(params);
    if (result === undefined) {
      return modelReply({ tools: [{ name: "search_everywhere", input: { query: "Shriram BRD" } }] });
    }
    called.push(result);
    const thread = /^- (.+?) \[/m.exec(result.slice(result.indexOf("Gmail:")))?.[1] ?? "nothing";
    return modelReply({ text: `It's in your email, in the thread "${thread}".` });
  };
  const { reply, route: picked } = await owner("Can you find my notes on the Shriram brd");
  assert(picked?.kind === "specialist" && picked.agentId === "knowledge", `the turn goes to Knowledge (${JSON.stringify(picked)})`);
  assert(called.length === 1, "search_everywhere ran once");
  assert(reply.includes(SHRIRAM_THREAD), `the reply cites the email thread (${reply})`);
}
{
  cloudPlay = (params) => {
    if (params.route?.agentId !== "knowledge") {
      return undefined;
    }
    const result = lastTool(params);
    if (result === undefined) {
      return modelReply({ tools: [{ name: "search_everywhere", input: { query: "pricing", person: "Munil" } }] });
    }
    const checked = /^Sources checked: .+$/m.exec(result)?.[0] ?? "";
    const closest = /Closest: (.*)\)$/m.exec(result)?.[1] ?? "";
    return modelReply({ text: `Nothing from Munil about pricing. ${checked}. Closest: ${closest}.` });
  };
  const { reply, route: picked } = await owner("What did munil say about pricing");
  assert(picked?.kind === "specialist" && picked.agentId === "knowledge", "the turn goes to Knowledge");
  assert(reply.includes(ALL_SOURCES), `the reply names the sources checked (${reply})`);
  assert(reply.includes(`the only thread with Munil: "${MUNIL_THREAD}"`) && reply.includes("no reply from them"), `and the only Munil thread, with no reply (${reply})`);
}
cloudPlay = undefined;
passed.push("end to end: Shriram BRD cites the email thread; Munil names every source checked and the only thread, unanswered");

// ---------------------------------------------------------------- a local Knowledge run
type OllamaStep = { content?: string; tools?: Array<{ name: string; arguments?: unknown }> };
type OllamaBody = { tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; tool_name?: string; content?: string }> };
async function withOllama<T>(steps: OllamaStep[], run: (url: string, bodies: OllamaBody[]) => Promise<T>): Promise<T> {
  const bodies: OllamaBody[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as OllamaBody);
      const step = steps.shift() ?? { content: "(out of steps)" };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        model: MODEL,
        message: { role: "assistant", content: step.content ?? "", ...(step.tools ? { tool_calls: step.tools.map((tool) => ({ function: { name: tool.name, arguments: tool.arguments ?? {} } })) } : {}) },
        done: true,
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("no port");
  }
  try {
    return await run(`http://127.0.0.1:${address.port}`, bodies);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
setSetting(LOCAL_AGENT_SETTING, JSON.stringify({ knowledge: MODEL }));
const knowledgeTurn = (text: string) =>
  runAgent(text, { agentId: "knowledge", modelAgent: "knowledge", guardText: text, saveUserMessage: false, saveAssistantMessage: false });
const WRITES = specialistFor("knowledge")!.definition.tools.filter((tool) => tool.effect !== "read").map((tool) => tool.name);
await withOllama(
  [{ tools: [{ name: "search_everywhere", arguments: { query: "Shriram BRD" } }] }, { content: "It's in the SLIC KYC email thread." }],
  async (url, bodies) => {
    setLocalAgentModelConfigForTests({ model: MODEL, url });
    cloudCalls.length = 0;
    const reply = await knowledgeTurn("Where is the Shriram BRD?");
    const offered = (bodies[0]?.tools ?? []).map((tool) => tool.function.name);
    assert(offered.includes("search_everywhere"), `a local run is offered search_everywhere (${offered.join(",")})`);
    assert(!offered.includes("search_emails"), "but not search_emails");
    assert(WRITES.length > 0 && WRITES.every((name) => !offered.includes(name)) && !offered.includes("ignore_item"), `and no write tool (${offered.join(",")})`);
    const result = bodies[1]?.messages.find((message) => message.role === "tool" && message.tool_name === "search_everywhere");
    assert(result?.content?.includes(SHRIRAM_THREAD) === true, "search_everywhere ran and its result went back to the laptop, mail included");
    assert(/\n\n\(gemma4:e2b, local, \d+s\)$/.test(reply) && cloudCalls.length === 0, `answered locally (${reply})`);
  },
);
await withOllama([{ tools: [{ name: "search_emails", arguments: { query: "Shriram BRD" } }] }], async (url, bodies) => {
  setLocalAgentModelConfigForTests({ model: MODEL, url });
  cloudCalls.length = 0;
  const reply = await knowledgeTurn("Where is the Shriram BRD?");
  assert(bodies.length === 1, "the laptop asked for search_emails once");
  assert(reply === "Cloud answer.\n\n(answered by cloud: needed a tool the laptop model can't use)", `search_emails from a local run reruns on cloud (${JSON.stringify(reply)})`);
  assert(cloudCalls.length > 0 && cloudCalls.every((call) => call.agent === "knowledge"), "on Knowledge's cloud model");
});
setSetting(LOCAL_AGENT_SETTING, "{}");
setLocalAgentModelConfigForTests(undefined);
passed.push("local Knowledge: offered search_everywhere and no search_emails or write tool; calling search_emails reruns on cloud");

setCompleteForTests(undefined);
setSearchEverywhereForTests(undefined);
log(passed.map((line) => `  ok  ${line}`).join("\n"));
log("test-search-everywhere: ok");
