/**
 * Answering Aadi's "which one should I ignore?" without repeating the biller.
 * His next message binds to Aadi's own latest open ignore question: "all of
 * them" ignores every item shown, "the LinkedIn one" only that one, "no" or
 * "cancel" nothing. A forward, a stale or expired question, or a message about
 * something else never ignores anything.
 *
 * Real bot updates through bot.handleUpdate, a scripted model, an in-memory
 * database. Nothing reaches Telegram or a provider.
 */
import { bot } from "../src/bot.ts";
import { canonicalBiller } from "../src/bill_aliases.ts";
import { createBill, db, getBill } from "../src/db.ts";
import { billIsIgnored, findActiveRulesForQuery, invalidateIgnoreCache } from "../src/ignore.ts";
import {
  answerPendingIgnore,
  clearPendingIgnoreQuestion,
  parseIgnoreAnswer,
  PENDING_IGNORE_TTL_MS,
  pendingIgnoreQuestion,
} from "../src/ignore_pending.ts";
import { setCompleteForTests, type CompleteParams, type CompleteResult } from "../src/llm.ts";
import { recordPresentedEntities } from "../src/referents.ts";
import { handler as ignoreBill } from "../src/tools/ignore_bill.ts";
import { handler as ignoreItem } from "../src/tools/ignore_item.ts";
import { handler as resumeItem } from "../src/tools/resume_item.ts";
import { modelReply, nextMessageId } from "./fakes.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

if (process.env.AADI_DB_PATH !== ":memory:") {
  throw new Error("test-ignore-answer.ts must run with AADI_DB_PATH=:memory:");
}

const log = console.log;
console.log = () => undefined;
console.warn = () => undefined;
console.error = () => undefined;
const passed: string[] = [];

const CHAT = 1;
const QUESTION = "There are 7 Google Play bills tracked. Should I ignore all of them, or just the LinkedIn one?";

// ---------------------------------------------------------------- the seven Google Play bills
const SEVEN: Array<[string, number]> = [
  ["Google Play", 5],
  ["Google Play", 12],
  ["Google Play Facebook Inc", 18],
  ["Google Play Facebook Inc", 19],
  ["Google Play", 32],
  ["Google Play (LinkedIn Community & Network subscription)", 35],
  ["Google Play (Facebook, Inc.)", 75],
];
const ymd = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
let ids: number[] = [];
function seed(): void {
  db.prepare("DELETE FROM ignore_rule_events").run();
  db.prepare("DELETE FROM ignore_rules").run();
  db.prepare("DELETE FROM bills").run();
  invalidateIgnoreCache();
  clearPendingIgnoreQuestion(CHAT);
  ids = SEVEN.map(([biller, days], index) => createBill(biller, null, "INR", ymd(days), `thread-${index}-${Date.now()}`)!.id);
}
const ignored = () => ids.filter((id) => billIsIgnored(getBill(id)!));
const linkedinId = () => ids[5]!;

// ---------------------------------------------------------------- the bot, with a scripted model
const replies: Array<{ text: string; messageId: number; date: number }> = [];
bot.api.config.use(async (_prev, method, payload) => {
  if (method === "getMe") {
    return { ok: true, result: { id: 999, is_bot: true, first_name: "Aadi", username: "aadi_test_bot" } } as never;
  }
  if (method === "sendMessage") {
    const text = (payload as { text: string }).text;
    const reply = { text, messageId: nextMessageId(), date: Math.floor(Date.now() / 1000) };
    replies.push(reply);
    return { ok: true, result: { message_id: reply.messageId, date: reply.date, chat: { id: CHAT, type: "private" }, text } } as never;
  }
  return { ok: true, result: true } as never;
});
await bot.init();

let modelCalls = 0;
const toolResults: string[] = [];
setCompleteForTests(async (params: CompleteParams): Promise<CompleteResult> => {
  if (params.tools.length === 0) {
    return modelReply({ text: '{"facts":[]}' });
  }
  modelCalls += 1;
  const asked = [...params.messages].reverse().find((message) => message.role === "user" && typeof message.content === "string")?.content as string ?? "";
  const lastTool = [...params.messages].reverse().find((message) => message.role === "tool");
  const result = lastTool && lastTool.role === "tool" ? lastTool.content : undefined;
  if (/ignore google play bill going forward/i.test(asked)) {
    if (result === undefined) {
      return modelReply({ tools: [{ name: "ignore_bill", input: { query: "google play" } }] });
    }
    toolResults.push(result);
    return modelReply({ text: QUESTION });
  }
  if (/\ball of them\b/i.test(asked)) {
    // An overeager model: with no open question it tries to ignore every match itself.
    if (result === undefined) {
      return modelReply({ tools: [{ name: "ignore_bill", input: { query: "google play", all_matches: true } }] });
    }
    toolResults.push(result);
    return modelReply({ text: result });
  }
  return modelReply({ text: "Okay." });
});

interface SayOptions {
  forwarded?: boolean;
  replyTo?: { messageId: number; date: number; fromBot: boolean; text: string };
}
async function say(text: string, options: SayOptions = {}): Promise<string[]> {
  const before = replies.length;
  const messageId = nextMessageId();
  const date = Math.floor(Date.now() / 1000);
  await bot.handleUpdate({
    update_id: messageId,
    message: {
      message_id: messageId,
      date,
      chat: { id: CHAT, type: "private", first_name: "Vishnu" },
      from: { id: CHAT, is_bot: false, first_name: "Vishnu" },
      text,
      ...(options.forwarded ? { forward_origin: { type: "user", date, sender_user: { id: 4242, is_bot: false, first_name: "Someone" } } } : {}),
      ...(options.replyTo
        ? {
            reply_to_message: {
              message_id: options.replyTo.messageId,
              date: options.replyTo.date,
              chat: { id: CHAT, type: "private" },
              from: options.replyTo.fromBot ? { id: 999, is_bot: true, first_name: "Aadi" } : { id: CHAT, is_bot: false, first_name: "Vishnu" },
              text: options.replyTo.text,
            },
          }
        : {}),
    },
  } as never);
  await new Promise((resolve) => setTimeout(resolve, 30));
  return replies.slice(before).map((reply) => reply.text);
}
async function ask(): Promise<{ messageId: number; date: number }> {
  seed();
  toolResults.length = 0;
  const out = await say("ignore google play bill going forward");
  assert(out.includes(QUESTION), `Aadi asks which one (${JSON.stringify(out)})`);
  assert(/Found 7 matching bills — which one should I ignore\?/.test(toolResults[0] ?? ""), `the tool listed all 7 (${toolResults[0]})`);
  assert(pendingIgnoreQuestion(CHAT)?.candidates.length === 7, "and the 7 shown are remembered");
  assert(ignored().length === 0, "nothing is ignored yet");
  const question = replies.at(-1)!;
  return { messageId: question.messageId, date: question.date };
}

// ---------------------------------------------------------------- "All of them" ignores all 7
{
  await ask();
  const before = modelCalls;
  const out = await say("All of them");
  assert(ignored().length === 7, `all 7 Google Play bills are ignored (${ignored().length})`);
  assert(modelCalls === before, "answered in code, no model call");
  assert(/Ignoring 7 of the 7 shown/.test(out.join("\n")), `and Aadi says so (${JSON.stringify(out)})`);
  assert(pendingIgnoreQuestion(CHAT) === undefined, "the question is used up");
  const again = await say("All of them");
  assert(!again.join("\n").includes("Ignoring"), "a second \"all of them\" binds to nothing");
}
for (const phrasing of ["all the bills ignore", "ignore them all", "all 7", "yes all of them please"]) {
  await ask();
  await say(phrasing);
  assert(ignored().length === 7, `"${phrasing}" ignores all 7 (${ignored().length})`);
}
{
  // The 05:38 case: his Telegram reply to Aadi's question.
  const question = await ask();
  await say("All of them", { replyTo: { ...question, fromBot: true, text: QUESTION } });
  assert(ignored().length === 7, "a reply to Aadi's question is an answer to it");
}
passed.push("\"All of them\" (and \"all the bills ignore\", \"ignore them all\", \"all 7\", a reply to the question) ignores all 7, in code");

// ---------------------------------------------------------------- a subset
{
  await ask();
  await say("the LinkedIn one");
  assert(ignored().join(",") === String(linkedinId()), `"the LinkedIn one" ignores only that one (${ignored().join(",")} vs ${linkedinId()})`);
  await ask();
  await say("Facebook ones");
  const facebook = ids.filter((id) => /facebook/i.test(getBill(id)!.biller));
  assert(ignored().sort().join(",") === facebook.sort().join(","), `"Facebook ones" ignores the three Facebook bills (${ignored().join(",")})`);
  await ask();
  await say("the 6th one");
  assert(ignored().join(",") === String(linkedinId()), "an ordinal picks from the list as shown");
}
passed.push("a subset: \"the LinkedIn one\" only that one, \"Facebook ones\" the Facebook bills, \"the 6th one\" by position");

// ---------------------------------------------------------------- no / cancel
for (const phrasing of ["no", "cancel", "don't ignore them", "none of them", "No, not all of them"]) {
  await ask();
  const out = await say(phrasing);
  assert(ignored().length === 0, `"${phrasing}" ignores nothing (${ignored().length})`);
  assert(out.join("\n").includes("Nothing changed"), `and says so (${JSON.stringify(out)})`);
  assert(pendingIgnoreQuestion(CHAT) === undefined, "the question is closed");
}
passed.push("\"no\", \"cancel\", \"don't ignore them\", \"none of them\" and \"No, not all of them\" ignore nothing");

// ---------------------------------------------------------------- what never answers it
{
  await ask();
  await say("all of them", { forwarded: true });
  assert(ignored().length === 0, "a forwarded \"all of them\" ignores nothing");
  assert(pendingIgnoreQuestion(CHAT) !== undefined, "and doesn't touch his open question");
}
{
  seed();
  toolResults.length = 0;
  const out = await say("all of them");
  assert(ignored().length === 0, `"all of them" with no open question ignores nothing (${JSON.stringify(out)})`);
  assert(toolResults.some((result) => /own instruction in this turn/.test(result)), "even when the model tries: the tool's own guard refuses");
}
{
  await ask();
  const raw = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = ?").get(`ignore_pending_question:${CHAT}`)!.value as string);
  raw.expiresAt = Date.now() - 1;
  db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(JSON.stringify(raw), `ignore_pending_question:${CHAT}`);
  await say("All of them");
  assert(ignored().length === 0, "an answer after the question expired ignores nothing");
}
{
  const question = await ask();
  await say("All of them", { replyTo: { messageId: question.messageId - 50, date: question.date - 3600, fromBot: true, text: "An older message" } });
  assert(ignored().length === 0, "a reply to an older message is not an answer");
}
{
  await ask();
  await say("What's on my calendar tomorrow?");
  await say("all of them");
  assert(ignored().length === 0, "after an unrelated message, a later \"all of them\" binds to nothing");
}
passed.push("never: a forward, no open question, an expired question, a reply to an older message, or after an unrelated message");

// ---------------------------------------------------------------- the rules underneath
{
  seed();
  const candidates = [
    { label: "A", names: "Google Play", confirmLabel: "x", input: { entityType: "bill" as const, matchKey: "google play", matchScope: "source" as const, tag: "personal" as const } },
    { label: "B", names: "Google Play (LinkedIn Community & Network subscription)", confirmLabel: "y", input: { entityType: "bill" as const, matchKey: "google play linkedin", matchScope: "source" as const, tag: "personal" as const } },
  ];
  assert(parseIgnoreAnswer("Did Google send the invoice?", candidates).kind === "unrelated", "a question that mentions a name is not an answer");
  assert(parseIgnoreAnswer("yes", candidates).kind === "unrelated", "a bare yes is not read as all");
  assert(parseIgnoreAnswer("not the linkedin one", candidates).kind === "cancel", "any negation cancels");
  assert(PENDING_IGNORE_TTL_MS === 30 * 60_000, "questions expire after 30 minutes");
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
    `ignore_pending_question:${CHAT}`,
    JSON.stringify({ askedAt: Date.now(), expiresAt: Date.now() + PENDING_IGNORE_TTL_MS, instruction: "x", candidates }),
  );
  assert(answerPendingIgnore({ chatId: CHAT, messageId: 1, ownWords: "all", now: Date.now() + PENDING_IGNORE_TTL_MS + 1 }) === undefined, "an expired question answers nothing");
  clearPendingIgnoreQuestion(CHAT);
}
{
  seed();
  const confirmation = { chatId: CHAT, messageId: nextMessageId() };
  ignoreBill({ query: "google play" }, { iteration: 1, calledTools: ["ignore_bill"], userText: "ignore all google play bills", confirmation });
  assert(ignored().length === 7, "\"ignore all google play bills\" ignores every match in one go");
  seed();
  const facebookId = ids[2]!;
  ignoreBill({ query: "google play", bill_ids: [linkedinId(), facebookId] }, { iteration: 1, calledTools: ["ignore_bill"], userText: "ignore the linkedin and facebook google play bills", confirmation });
  const expected = ids.filter((id) => /linkedin|facebook/i.test(canonicalBiller(getBill(id)!.biller)));
  assert(ignored().sort().join(",") === expected.sort().join(","), `bill_ids ignores those billers in one go (${ignored().join(",")})`);
  seed();
  ignoreBill({ query: "google play", all_matches: true }, { iteration: 1, calledTools: ["ignore_bill"], userText: "ignore google play bills", confirmation });
  assert(ignored().length === 0 && pendingIgnoreQuestion(CHAT) !== undefined, "all_matches alone, without his \"all\", still asks");
}
passed.push("rules: unrelated, bare yes and negations; 30-minute expiry; the tool ignores several shown billers in one go only on his words");

// ---------------------------------------------------------------- review fixes on #33
// Each case runs on its own so every failure shows, not just the first.
const failures: string[] = [];
async function check(name: string, run: () => Promise<void> | void): Promise<void> {
  try {
    await run();
    passed.push(name);
  } catch (error) {
    failures.push(`${name}\n        ${error instanceof Error ? error.message : String(error)}`);
  }
}
const turnFor = (tool: string, userText: string) => ({
  iteration: 1,
  calledTools: [tool],
  userText,
  confirmation: { chatId: CHAT, messageId: nextMessageId() },
});
const activeRules = () => (db.prepare("SELECT COUNT(*) AS n FROM ignore_rules WHERE status = 'active'").get() as { n: number }).n;

await check("1. resume keeps partial-name matching: \"resume linkedin bills\" restores the LinkedIn Google Play bill", async () => {
  await ask();
  await say("the LinkedIn one");
  assert(ignored().join(",") === String(linkedinId()), `only the LinkedIn bill is ignored (${ignored().join(",")})`);
  const found = findActiveRulesForQuery("linkedin bills").length;
  assert(found === 1, `findActiveRulesForQuery("linkedin bills") finds the rule (${found})`);
  const out = resumeItem({ query: "linkedin bills" }, turnFor("resume_item", "resume linkedin bills"));
  assert(ignored().length === 0 && activeRules() === 0, `"resume linkedin bills" restores it (${JSON.stringify(out)})`);
});

await check("2. a name narrows an ordinal, never widens it: \"the 6th Google Play one\" and \"the 6th one\" ignore only the 6th", async () => {
  await ask();
  await say("the 6th Google Play one");
  assert(ignored().join(",") === String(linkedinId()), `"the 6th Google Play one" ignores only the 6th (ignored ${ignored().length}: ${ignored().join(",")})`);
  await ask();
  await say("the 6th one");
  assert(ignored().join(",") === String(linkedinId()), `"the 6th one" ignores only the 6th (ignored ${ignored().length})`);
  await ask();
  const out = await say("the 6th Facebook one");
  assert(ignored().length === 0, `a name that contradicts the position ignores nothing (ignored ${ignored().length})`);
  assert(/Nothing changed/.test(out.join("\n")), `and says so (${JSON.stringify(out)})`);
  assert(pendingIgnoreQuestion(CHAT) !== undefined, "and the question stays open for the real answer");
  await say("the 6th one");
  assert(ignored().join(",") === String(linkedinId()), "which still works");
  await ask();
  const parts = parseIgnoreAnswer("the 2nd and the LinkedIn one", pendingIgnoreQuestion(CHAT)!.candidates);
  assert(parts.kind === "some" && parts.indexes.join(",") === "1,5", `separate parts still add up (${JSON.stringify(parts)})`);
  clearPendingIgnoreQuestion(CHAT);
});

await check("3. a negation stops a bulk ignore on the direct ignore_bill path, the same as in an answer", async () => {
  const negated: Array<[string, string, boolean]> = [
    ["don't ignore all Google Play bills", "google play", false],
    ["do not ignore every bill", "bill", false],
    ["do not ignore every bill", "google play", true],
    ["don\u2019t ignore all google play bills", "google play", true],
    ["never ignore all the google play bills", "google play", false],
    ["don't ignore both of the facebook ones", "google play facebook", false],
  ];
  for (const [userText, query, allMatches] of negated) {
    seed();
    const out = ignoreBill({ query, all_matches: allMatches }, turnFor("ignore_bill", userText));
    assert(activeRules() === 0 && ignored().length === 0, `"${userText}" (query "${query}") ignores nothing (${activeRules()} rules; ${JSON.stringify(out)})`);
    assert(/Nothing changed/.test(out), `"${userText}" says nothing changed (${JSON.stringify(out)})`);
    assert(pendingIgnoreQuestion(CHAT) === undefined, `"${userText}" opens no which-one question`);
  }
  seed();
  const picked = ignoreBill({ query: "google play", bill_ids: [linkedinId()] }, turnFor("ignore_bill", "don't ignore the linkedin google play bill"));
  assert(activeRules() === 0, `picked ids with a negation ignore nothing (${JSON.stringify(picked)})`);
  seed();
  ignoreBill({ query: "google play" }, turnFor("ignore_bill", "ignore all google play bills"));
  assert(ignored().length === 7, `"ignore all google play bills" still ignores all 7 (${ignored().length})`);
  for (const phrasing of ["don\u2019t ignore them", "never ignore them", "stop ignoring them"]) {
    await ask();
    const out = await say(phrasing);
    assert(ignored().length === 0 && /Nothing changed/.test(out.join("\n")), `answer "${phrasing}" cancels (${JSON.stringify(out)})`);
  }
});

await check("4a. ignore_item: \"don't ignore all linkedin bills\" ignores nothing", () => {
  seed();
  const out = ignoreItem({ query: "linkedin bills" }, turnFor("ignore_item", "don't ignore all linkedin bills"));
  assert(activeRules() === 0, `no rule is made (${activeRules()}; ${JSON.stringify(out)})`);
  assert(/Nothing changed/.test(out), `and it says so (${JSON.stringify(out)})`);
});

await check("4b. ignore_item: \"don't ignore all of them\" after a shown list ignores nothing", () => {
  seed();
  const shown = ids.slice(0, 3).map((id) => ({ type: "bill" as const, id: String(id), label: getBill(id)!.biller, matchKey: getBill(id)!.biller }));
  recordPresentedEntities(CHAT, shown, "ignore_which");
  const out = ignoreItem({ query: "all of them" }, turnFor("ignore_item", "don't ignore all of them"));
  assert(activeRules() === 0, `no rule is made (${activeRules()}; ${JSON.stringify(out)})`);
  assert(/Nothing changed/.test(out), `and it says so (${JSON.stringify(out)})`);
  const yes = ignoreItem({ query: "all of them" }, turnFor("ignore_item", "ignore all of them"));
  assert(activeRules() === 3, `"ignore all of them" still ignores the three shown (${activeRules()}; ${JSON.stringify(yes)})`);
});

await check("4c. resume_item: a negated \"all\" resumes nothing, and only his words authorise all", async () => {
  await ask();
  await say("All of them");
  const before = activeRules();
  assert(before > 1 && ignored().length === 7, `set up: every Google Play biller ignored (${before} rules)`);
  const no = resumeItem({ query: "all" }, turnFor("resume_item", "don't resume all ignored items"));
  assert(activeRules() === before, `"don't resume all ignored items" resumes nothing (${activeRules()}; ${JSON.stringify(no)})`);
  assert(/Nothing changed/.test(no), `and says so (${JSON.stringify(no)})`);
  const no2 = resumeItem({ query: "all google play" }, turnFor("resume_item", "don't resume all google play bills"));
  assert(activeRules() === before, `"don't resume all google play bills" resumes nothing (${activeRules()}; ${JSON.stringify(no2)})`);
  const which = resumeItem({ query: "all google play" }, turnFor("resume_item", "resume the google play bills"));
  assert(activeRules() === before && /Which ignored item should I resume\?/.test(which), `the model's "all" without his asks which (${activeRules()}; ${JSON.stringify(which)})`);
  const yes = resumeItem({ query: "all" }, turnFor("resume_item", "stop ignoring all of them"));
  assert(activeRules() === 0 && ignored().length === 0, `"stop ignoring all of them" resumes all (${activeRules()}; ${JSON.stringify(yes)})`);
});

await check("4d. skip this month has no bulk path: \"skip all google play bills this month\" asks which", () => {
  seed();
  const out = ignoreBill({ query: "google play" }, turnFor("ignore_bill", "skip all google play bills this month"));
  assert(/which one should I skip\?/.test(out), `it asks (${JSON.stringify(out)})`);
  assert(ids.every((id) => getBill(id)!.status === "upcoming"), "and skips nothing");
});

if (failures.length > 0) {
  setCompleteForTests(undefined);
  log(passed.map((line) => `  ok  ${line}`).join("\n"));
  log(failures.map((line) => `  FAIL ${line}`).join("\n"));
  log(`test-ignore-answer: ${failures.length} failed`);
  process.exit(1);
}

setCompleteForTests(undefined);
log(passed.map((line) => `  ok  ${line}`).join("\n"));
log("test-ignore-answer: ok");
process.exit(0);
