/**
 * Name-based contact resolution, end to end: the real bot handlers, routing,
 * agent loops, dispatcher, search_emails, resolve_contact and the contact
 * service. Only the model (scripted), Telegram, Gmail and Calendar are
 * stand-ins. Nothing real is read or sent.
 */
import "dotenv/config";
import type { calendar_v3, gmail_v1 } from "googleapis";
import { setToolInterceptorForTests } from "../src/agent.ts";
import { issueGrant, revokeGrant } from "../src/agents/auth.ts";
import { continueTask, delegate } from "../src/agents/engine.ts";
import { specialistFor } from "../src/agents/index.ts";
import { toolOwnership } from "../src/agents/registry.ts";
import { listPausedTasks } from "../src/agents/store.ts";
import { bot } from "../src/bot.ts";
import { resolveRecipient } from "../src/command_recipients.ts";
import {
  matchAnswer,
  optionLabels,
  peopleNamedInQuery,
  rewriteQuery,
  whichQuestion,
  type Contact,
} from "../src/contact_logic.ts";
import { askWhichContact, contactQuestionAsked, hasOpenContactQuestion } from "../src/contact_questions.ts";
import {
  clearContactCacheForTests,
  resolveContact,
  setContactCalendarForTests,
} from "../src/contacts.ts";
import { createAccount, createMemory, db } from "../src/db.ts";
import { setGoogleAccountForTests, type LoadedGoogleAccount } from "../src/google/auth.ts";
import { setGmailClientForTests } from "../src/google/mail.ts";
import { setCompleteForTests, type CompleteParams } from "../src/llm.ts";
import { askedOnlyToLook, receiptFailureMessage, unreceiptedClaims } from "../src/receipt.ts";
import { FORWARDED_TOOLS, TOOL_ORDER, tools } from "../src/tools/index.ts";
import { modelReply, nextMessageId } from "./fakes.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

if (process.env.AADI_DB_PATH !== ":memory:") {
  throw new Error("test-contact-resolution.ts must run with AADI_DB_PATH=:memory:");
}

const log = console.log;
console.log = () => undefined;
console.error = () => undefined;
console.warn = () => undefined;

const passed: string[] = [];
const CHAT = 1;
const SELF = "vishnu@epicode.com";
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

// ---------------------------------------------------------------------
// The outside world: one work mailbox, one calendar, a few saved records
// ---------------------------------------------------------------------
interface Mail {
  id: string;
  from: string;
  to: string;
  cc?: string;
  subject: string;
  snippet: string;
  at: Date;
  labels?: string[];
  listUnsubscribe?: string;
}

const HARDIK_P = "hardik.singh@pinnacle-systems.com";
const HARDIK_E = "hardik@epicode.com";
const ME = `Vishnu Rajan <${SELF}>`;

const mailbox: Mail[] = [
  { id: "h1", from: `Hardik Singh <${HARDIK_P}>`, to: ME, subject: "Renewal terms", snippet: "Please send the renewal terms by Friday", at: ago(1) },
  { id: "h2", from: `Hardik <${HARDIK_E}>`, to: ME, subject: "Sprint demo", snippet: "Demo is moved to Thursday", at: ago(2) },
  { id: "h0", from: `Hardik Singh <${HARDIK_P}>`, to: ME, subject: "Intro", snippet: "Good to meet you", at: ago(20) },
  { id: "n1", from: "Hardik Digest <news@hardikdigest.com>", to: ME, subject: "Weekly digest", snippet: "Top stories", at: ago(0.5), listUnsubscribe: "<mailto:off@hardikdigest.com>" },
  { id: "p1", from: "Priya Nair <priya@acme.com>", to: ME, subject: "Pilot dates", snippet: "The pilot starts on the 20th", at: ago(3) },
  { id: "m1", from: ME, to: "Meera Iyer <meera@zenith.io>", subject: "Proposal", snippet: "Attached is the proposal", at: ago(5), labels: ["SENT"] },
  { id: "m2", from: "Meera Iyer <meera@zenith.io>", to: ME, subject: "Re: Proposal", snippet: "Looks good, one question", at: ago(4) },
  { id: "z1", from: "Z. Mistry <zm@farpoint.io>", to: ME, subject: "Invoice", snippet: "Invoice attached", at: ago(6) },
  { id: "a1", from: "Arjun Menon <arjun@northwind.co>", to: ME, subject: "Contract", snippet: "Signed copy", at: ago(7) },
  { id: "a2", from: "Arjun Menon <arjun.menon@gmail.com>", to: ME, subject: "From my phone", snippet: "Running late", at: ago(8) },
];

type Check = (mail: Mail) => boolean;

/** Enough of Gmail's query language for what Aadi sends: operators, groups, OR and -negation. */
function tokenize(query: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < query.length) {
    const char = query[index]!;
    if (/\s/.test(char)) {
      index += 1;
    } else if (char === "(" || char === ")") {
      tokens.push(char);
      index += 1;
    } else {
      let end = index;
      let depth = 0;
      let quoted = false;
      while (end < query.length) {
        const at = query[end]!;
        if (at === '"') {
          quoted = !quoted;
        } else if (!quoted && at === "(" && query[end - 1] === ":") {
          depth += 1;
        } else if (!quoted && at === ")" && depth > 0) {
          depth -= 1;
        } else if (!quoted && depth === 0 && (/\s/.test(at) || at === ")")) {
          break;
        }
        end += 1;
      }
      tokens.push(query.slice(index, end));
      index = end;
    }
  }
  return tokens;
}

function termCheck(term: string): Check {
  const negated = term.startsWith("-");
  const body = negated ? term.slice(1) : term;
  const operator = /^(from|to|cc|bcc):(.*)$/i.exec(body);
  let check: Check;
  if (operator) {
    const field = operator[1]!.toLowerCase() as "from" | "to" | "cc";
    const alternatives = operator[2]!
      .replace(/^[("]+|[)"]+$/g, "")
      .split(/\s+OR\s+/)
      .map((value) => value.toLowerCase().split(/\s+/).filter(Boolean));
    check = (mail) => {
      const header = (mail[field] ?? "").toLowerCase();
      return alternatives.some((words) => words.every((word) => header.includes(word)));
    };
  } else if (/^[a-z_]+:/i.test(body)) {
    check = () => true;
  } else {
    const word = body.replace(/"/g, "").toLowerCase();
    check = (mail) => `${mail.subject} ${mail.snippet}`.toLowerCase().includes(word);
  }
  return negated ? (mail) => !check(mail) : check;
}

function parse(tokens: string[], position: { at: number }): Check {
  const clauses: Check[][] = [];
  let joinNext = false;
  while (position.at < tokens.length && tokens[position.at] !== ")") {
    const token = tokens[position.at]!;
    position.at += 1;
    if (token === "OR") {
      joinNext = true;
      continue;
    }
    let item: Check;
    if (token === "(") {
      item = parse(tokens, position);
      position.at += 1;
    } else {
      item = termCheck(token);
    }
    if (joinNext && clauses.length > 0) {
      clauses.at(-1)!.push(item);
    } else {
      clauses.push([item]);
    }
    joinNext = false;
  }
  return (mail) => clauses.every((clause) => clause.some((check) => check(mail)));
}

const matches = (query: string): Mail[] =>
  mailbox.filter(parse(tokenize(query), { at: 0 })).sort((left, right) => right.at.getTime() - left.at.getTime());

/** Every Gmail query Aadi ran, so a test can see exactly who was searched for. */
let queries: string[] = [];
const searches = () => queries.filter((query) => /^from:/.test(query));

function fakeGmail(mails: readonly Mail[], address: string): gmail_v1.Gmail {
  return {
    users: {
      getProfile: async () => ({ data: { emailAddress: address } }),
      messages: {
        list: async ({ q, maxResults }: { q: string; maxResults?: number }) => {
          queries.push(q);
          const found = mails === mailbox ? matches(q) : [];
          return { data: { messages: found.slice(0, maxResults ?? 100).map((mail) => ({ id: mail.id })) } };
        },
        get: async ({ id }: { id: string }) => {
          const mail = mailbox.find((item) => item.id === id)!;
          return {
            data: {
              id,
              labelIds: mail.labels ?? ["INBOX"],
              internalDate: String(mail.at.getTime()),
              snippet: mail.snippet,
              payload: {
                headers: [
                  { name: "From", value: mail.from },
                  { name: "To", value: mail.to },
                  { name: "Cc", value: mail.cc ?? "" },
                  { name: "Subject", value: mail.subject },
                  { name: "Date", value: mail.at.toUTCString() },
                  ...(mail.listUnsubscribe ? [{ name: "List-Unsubscribe", value: mail.listUnsubscribe }] : []),
                ],
              },
            },
          };
        },
      },
    },
  } as unknown as gmail_v1.Gmail;
}

const events = [
  {
    summary: "Orbit sync",
    start: { dateTime: ago(10).toISOString() },
    attendees: [
      { email: "rohan@orbit.in", displayName: "Rohan Mehta" },
      { email: SELF, displayName: "Vishnu Rajan", self: true },
    ],
  },
  {
    summary: "Pinnacle renewal call",
    start: { dateTime: ago(15).toISOString() },
    attendees: [{ email: HARDIK_P, displayName: "Hardik Singh" }],
  },
];

function fakeCalendar(own: boolean): calendar_v3.Calendar {
  return {
    events: {
      list: async ({ q }: { q?: string }) => {
        const words = (q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        const items = own
          ? events.filter((event) => {
              const text = `${event.summary} ${event.attendees.map((who) => `${who.displayName} ${who.email}`).join(" ")}`.toLowerCase();
              return words.every((word) => text.includes(word));
            })
          : [];
        return { data: { items } };
      },
    },
  } as unknown as calendar_v3.Calendar;
}

const account = (id: "work" | "personal"): LoadedGoogleAccount =>
  ({ id, tag: id, label: id, tokenPath: "", client: {} }) as unknown as LoadedGoogleAccount;
const work = account("work");
const personal = account("personal");
setGoogleAccountForTests((id) => (id === "work" ? work : personal));
setGmailClientForTests((which) =>
  which.id === "work" ? fakeGmail(mailbox, SELF) : fakeGmail([], "vishnu.personal@gmail.com"),
);
setContactCalendarForTests((which) => fakeCalendar(which.id === "work"));

// Relationship record: the account knows Hardik's full name and whose domain this is.
createAccount({
  name: "Pinnacle",
  emailDomains: JSON.stringify(["pinnacle-systems.com"]),
  people: JSON.stringify(["Hardik Singh"]),
});
// Known contacts: a follow-up prospect, and an address Vishnu told Aadi himself.
db.prepare(
  `INSERT INTO sales_sequences (thread_id, prospect_email, prospect_domain, prospect_key, prospect_name,
     prospect_company, original_message_id, original_sent_at, status)
   VALUES ('t-anita', 'anita@lumen.co', 'lumen.co', 'anita@lumen.co', 'Anita Rao', 'Lumen', 'm-anita', ?, 'stopped')`,
).run(ago(9).toISOString());
createMemory({ content: "Kabir's email is ks@helio.dev.", category: "person", tag: "work", source: "explicit" });
// Something Aadi read, not something he said: it must not make a contact.
createMemory({ content: "Dev's email is dev@elsewhere.example.", category: "person", tag: "work", source: "auto" });

const forget = () => {
  db.prepare("DELETE FROM contact_choices").run();
  db.prepare("UPDATE contact_questions SET status = 'dropped' WHERE status = 'open'").run();
};
const emailsOf = (contact: Contact) => contact.emails.join(",");

const HARDIK_QUESTION = "Which Hardik are you referring to?\n- Hardik Singh, Pinnacle\n- Hardik, Epicode";

// =====================================================================
// 1. The service: unique names, full names, capitals and spaces
// =====================================================================
for (const query of ["Priya", "priya", "  PRIYA  ", "Priya Nair", "priya   NAIR", "nair priya"]) {
  const found = await resolveContact(query);
  assert(found.kind === "one" && emailsOf(found.contact) === "priya@acme.com", `"${query}" is Priya Nair (${found.kind})`);
}
passed.push('unique name: "Priya", "  PRIYA  ", "Priya Nair" and "priya   NAIR" all resolve to priya@acme.com');

const meera = await resolveContact("meera");
assert(meera.kind === "one" && emailsOf(meera.contact) === "meera@zenith.io", "someone he only wrote to is found from sent mail");
const rohan = await resolveContact("Rohan");
assert(
  rohan.kind === "one" && emailsOf(rohan.contact) === "rohan@orbit.in" && rohan.contact.sources.join() === "calendar" && rohan.contact.company === "Orbit",
  "a calendar attendee with no mail is found",
);
const anita = await resolveContact("anita");
assert(anita.kind === "one" && emailsOf(anita.contact) === "anita@lumen.co" && anita.contact.sources.includes("known"), "a follow-up prospect is a known contact");
const kabir = await resolveContact("Kabir");
assert(kabir.kind === "one" && emailsOf(kabir.contact) === "ks@helio.dev", "an address Vishnu told Aadi is a known contact");
assert((await resolveContact("Dev")).kind === "none", "an address from an automatic memory is not");
assert((await resolveContact("Vishnu")).kind === "none", "Vishnu himself is never a match");
passed.push("sources: Gmail (received and sent), calendar attendees, sequence prospects and his own memories each resolve a name; automatic memories and his own address don't");

const arjun = await resolveContact("Arjun");
assert(
  arjun.kind === "one" && emailsOf(arjun.contact) === "arjun@northwind.co,arjun.menon@gmail.com",
  `one person with a work and a personal address is one match (${JSON.stringify(arjun)})`,
);
passed.push("same full name on a company and a personal address is one person with both addresses, not a question");

// =====================================================================
// 2. Duplicate names are never narrowed
// =====================================================================
const hardik = await resolveContact("Hardik");
assert(hardik.kind === "many" && hardik.options.length === 2, `two Hardiks (${JSON.stringify(hardik)})`);
if (hardik.kind !== "many") {
  throw new Error("unreachable");
}
assert(optionLabels(hardik.options).join(" | ") === "Hardik Singh, Pinnacle | Hardik, Epicode", `labels: ${optionLabels(hardik.options).join(" | ")}`);
assert(whichQuestion("hardik", hardik.options) === HARDIK_QUESTION, "the question lists both");
assert(!hardik.options.some((option) => option.emails.includes("news@hardikdigest.com")), "a newsletter sender is not a person");
assert(
  hardik.options[0]!.sources.includes("relationship") && hardik.options[0]!.sources.includes("calendar") && hardik.options[0]!.sources.includes("gmail"),
  "Hardik Singh is known from mail, the calendar and the Pinnacle account record",
);
passed.push('duplicate name: "Hardik" is two people (Hardik Singh, Pinnacle / Hardik, Epicode); the newsletter "Hardik Digest" is not one of them');

for (const [query, email] of [
  ["Hardik Singh", HARDIK_P],
  ["hardik  SINGH", HARDIK_P],
  ["Hardik from Pinnacle", HARDIK_P],
  ["Hardik at Epicode", HARDIK_E],
  [HARDIK_E, HARDIK_E],
] as const) {
  const found = await resolveContact(query);
  assert(found.kind === "one" && emailsOf(found.contact) === email, `"${query}" is ${email} (${JSON.stringify(found)})`);
}
passed.push('full name: "Hardik Singh", "hardik  SINGH" and "Hardik from Pinnacle" pick out one of the two; "Hardik at Epicode" the other');

const company = await resolveContact("Pinnacle");
assert(company.kind === "none" && company.company === "Pinnacle", "a company name is not a person");
const nobody = await resolveContact("Zubin");
assert(nobody.kind === "none" && !nobody.company, "an unknown name matches nobody");
passed.push('unknown: "Zubin" matches nobody; "Pinnacle" is recognised as a company, not a person');

// =====================================================================
// 3. Reading an answer: exactly one, or nothing
// =====================================================================
const options = hardik.options;
const pick = (answer: string) => {
  const match = matchAnswer(options, answer);
  return match.kind === "one" ? options[match.index]!.emails[0] : match.kind;
};
assert(pick("Pinnacle") === HARDIK_P && pick("pinnacle") === HARDIK_P && pick("the Pinnacle one") === HARDIK_P, "by company");
assert(pick("Epicode") === HARDIK_E && pick("Hardik from Epicode please") === HARDIK_E, "by the other company");
assert(pick("Hardik Singh") === HARDIK_P && pick("  SINGH ") === HARDIK_P, "by full name");
assert(pick("1") === HARDIK_P && pick("2") === HARDIK_E && pick("the second one") === HARDIK_E && pick("first") === HARDIK_P, "by number");
assert(pick(HARDIK_E) === HARDIK_E, "by address");
assert(pick("Hardik") === "several" && pick("hardik please") === "several", "an answer that fits both settles nothing");
assert(pick("3") === "nobody" && pick("what's on my calendar tomorrow") === "nobody" && pick("") === "nobody", "anything else is not an answer");
assert(pick("someone@new.example") === "address", "a new address is taken as given");
passed.push('answers: "Pinnacle", "Hardik Singh", "2", "the second one" or an address pick exactly one; "Hardik" fits both and picks neither');

const named = peopleNamedInQuery('from:hardik to:"priya nair" cc:(meera iyer) -from:bob from:x@y.com from:pinnacle.com from:me from:(a OR b) from:support is:unread');
assert(named.map((item) => `${item.operator}:${item.name}`).join("|") === "from:hardik|to:priya nair|cc:meera iyer", `names in a query: ${JSON.stringify(named)}`);
assert(
  rewriteQuery("from:arjun newer_than:7d", [{ named: peopleNamedInQuery("from:arjun newer_than:7d")[0]!, contact: (arjun as { contact: Contact }).contact }]) ===
    "from:(arjun@northwind.co OR arjun.menon@gmail.com) newer_than:7d",
  "a name is swapped for the person's addresses",
);

// =====================================================================
// The bot, as Vishnu sees it
// =====================================================================
interface Sent {
  text: string;
  buttons: Array<{ text: string; data: string }>;
}
const chat: Sent[] = [];
bot.api.config.use(async (_prev, method, payload) => {
  if (method === "getMe") {
    return { ok: true, result: { id: 999, is_bot: true, first_name: "Aadi", username: "aadi_test_bot" } } as never;
  }
  if (method === "sendMessage") {
    const { text, reply_markup: markup } = payload as {
      text: string;
      reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> };
    };
    chat.push({
      text,
      buttons: (markup?.inline_keyboard ?? []).flat().map((button) => ({ text: button.text, data: button.callback_data })),
    });
    return { ok: true, result: { message_id: nextMessageId(), date: 0, chat: { id: CHAT, type: "private" }, text } } as never;
  }
  return { ok: true, result: true } as never;
});
await bot.init();

type Step = { text?: string; tools?: Array<{ name: string; input?: unknown }> };
let script: Step[] = [];
let modelCalls: CompleteParams[] = [];
let extraction: Record<string, unknown> = {};
setCompleteForTests(async (params) => {
  if (params.jsonSchema) {
    return modelReply({ text: JSON.stringify(extraction) });
  }
  if (params.tools.length === 0) {
    return modelReply({ text: '{"facts":[]}' });
  }
  // The loop keeps adding to the same array, so keep what this call was given.
  modelCalls.push({ ...params, messages: [...params.messages] });
  const next = script.shift();
  if (!next) {
    throw new Error("the model was called more times than the test scripted");
  }
  return modelReply(next);
});

const bodies: Record<string, string> = {
  h1: "From: Hardik Singh\nPlease send the renewal terms by Friday.",
  h2: "From: Hardik\nThe sprint demo is moved to Thursday.",
  p1: "From: Priya Nair\nThe pilot starts on the 20th.",
  m2: "From: Meera Iyer\nLooks good, one question on pricing.",
  z1: "From: Z. Mistry\nInvoice attached.",
};
let toolsRun: string[] = [];
let stubSearch: ((query: string) => string) | undefined;
setToolInterceptorForTests((call) => {
  toolsRun.push(call.name);
  const input = call.input as Record<string, unknown>;
  if (call.name === "read_email") {
    return bodies[String(input.id)] ?? "Not found.";
  }
  if (call.name === "list_events") {
    return "1. [work] Orbit sync\nAccount: work\nStart: 2026-11-03T15:00:00+05:30\nAttendees: Rohan Mehta <rohan@orbit.in>";
  }
  if (call.name === "add_task") {
    return "Task added (work).";
  }
  if (call.name === "get_current_time") {
    return "Friday, 13 November 2026 at 11:00:00 am IST";
  }
  if (call.name === "search_emails" && stubSearch) {
    return stubSearch(String(input.query));
  }
  return undefined;
});

function reset(steps: Step[]): void {
  script = steps;
  modelCalls = [];
  toolsRun = [];
  queries = [];
}

async function say(text: string, steps: Step[] = []): Promise<Sent[]> {
  reset(steps);
  const before = chat.length;
  const messageId = nextMessageId();
  await bot.handleUpdate({
    update_id: messageId,
    message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: CHAT, type: "private", first_name: "Vishnu" },
      from: { id: CHAT, is_bot: false, first_name: "Vishnu" },
      text,
    },
  } as never);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert(script.length === 0, `the model made every scripted call (${script.length} left) for "${text}": ${chat.slice(before).map((item) => item.text).join(" / ")}`);
  return chat.slice(before);
}

async function tap(data: string, steps: Step[] = []): Promise<Sent[]> {
  reset(steps);
  const before = chat.length;
  const id = nextMessageId();
  await bot.handleUpdate({
    update_id: id,
    callback_query: {
      id: String(id),
      chat_instance: "test",
      from: { id: CHAT, is_bot: false, first_name: "Vishnu" },
      message: { message_id: nextMessageId(), date: 0, chat: { id: CHAT, type: "private", first_name: "Vishnu" }, text: "question" },
      data,
    },
  } as never);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert(script.length === 0, `the model made every scripted call (${script.length} left) after the tap`);
  return chat.slice(before);
}

const search = (query: string): Step => ({ tools: [{ name: "search_emails", input: { query, account: "work" } }] });
const read = (id: string): Step => ({ tools: [{ name: "read_email", input: { id, account: "work" } }] });
const texts = (sent: Sent[]) => sent.map((item) => item.text).join(" / ");

// =====================================================================
// 4. One match: resolved and carried out, and "sent" in a summary is fine
// =====================================================================
const PRIYA_SUMMARY = "Priya's latest email was sent on Tuesday. She says the pilot starts on the 20th.";
const unique = await say("Find the latest email from Priya and summarise it", [search("from:priya"), read("p1"), { text: PRIYA_SUMMARY }]);
assert(unique.length === 1 && unique[0]!.text === PRIYA_SUMMARY, `the summary is the reply (${texts(unique)})`);
assert(searches().join("|") === "from:(priya@acme.com)", `the search ran on her address (${searches().join("|")})`);
assert(!hasOpenContactQuestion(CHAT) && unique[0]!.buttons.length === 0, "nothing was asked");
assert(modelCalls.length === 3, `no retry was forced (${modelCalls.length} model calls)`);
passed.push('unique: "Find the latest email from Priya and summarise it" searched from:(priya@acme.com) and answered in one go');
passed.push(`read-only summary: a reply saying her email "was sent on Tuesday" is delivered as written, not replaced by "${receiptFailureMessage(["sent"])}"`);

// =====================================================================
// 5. Two matches: asked, with the request kept
// =====================================================================
const ASK = "Find the latest email from Hardik and summarise it";
const asked = await say(ASK, [search("from:hardik")]);
assert(asked.length === 1 && asked[0]!.text === HARDIK_QUESTION, `Aadi asks which Hardik (${texts(asked)})`);
assert(
  asked[0]!.buttons.map((button) => button.text).join("|") === "Hardik Singh, Pinnacle|Hardik, Epicode|Someone else",
  `the choices are buttons too (${asked[0]!.buttons.map((button) => button.text).join("|")})`,
);
assert(modelCalls.length === 1, `the turn ended on the question (${modelCalls.length} model calls)`);
assert(searches().length === 0 && !toolsRun.includes("read_email"), "no mail was searched or read for either Hardik");
assert(hasOpenContactQuestion(CHAT), "the question is waiting for him");
passed.push(`duplicate: "${ASK}" ends the turn with "Which Hardik are you referring to?" and both choices; nothing was searched or read`);

// "Hardik" fits both, so it settles nothing and nobody is picked.
const vague = await say("Hardik");
assert(vague.length === 1 && vague[0]!.text.includes(HARDIK_QUESTION) && vague[0]!.buttons.length === 3, `asked again (${texts(vague)})`);
assert(modelCalls.length === 0 && searches().length === 0 && hasOpenContactQuestion(CHAT), "still nothing searched, and the question stays open");
passed.push('never the first: answering "Hardik" (fits both) asks again and searches nothing');

// =====================================================================
// 6. His answer completes the original request
// =====================================================================
const HARDIK_SUMMARY = "Hardik Singh's latest email asks for the renewal terms by Friday.";
const answered = await say("Pinnacle", [search("from:hardik"), read("h1"), { text: HARDIK_SUMMARY }]);
assert(answered.length === 1 && answered[0]!.text === HARDIK_SUMMARY, `the summary follows the answer (${texts(answered)})`);
assert(searches().join("|") === `from:(${HARDIK_P})`, `only Hardik Singh's mail was searched (${searches().join("|")})`);
const firstPrompt = JSON.stringify(modelCalls[0]!.messages.filter((message) => message.role === "user").at(-1));
assert(
  firstPrompt.includes(ASK) && firstPrompt.includes(`Vishnu chose: Hardik Singh <${HARDIK_P}>, Pinnacle`),
  `the model gets his original request and who he chose (${firstPrompt.slice(0, 300)})`,
);
assert(!hasOpenContactQuestion(CHAT), "the question is closed");
passed.push('follow-up: after "Pinnacle" Aadi re-ran his original request, searched from:(hardik.singh@pinnacle-systems.com) and summarised it, with no repeat from him');

// His choice of who to read is not a choice of who gets mail: the send path still sees two.
const recipient = await resolveRecipient({ gmail: fakeGmail(mailbox, SELF), query: "Hardik", selfAddresses: new Set([SELF]) });
assert(recipient.kind === "many", `the send gate's own lookup is unchanged (${recipient.kind})`);
passed.push("authorization: choosing which Hardik to read does not choose a recipient; the send path's own lookup still finds two and asks");

// The same question by tap, for the other Hardik.
forget();
const again = await say(ASK, [search("from:hardik")]);
const epicodeButton = again[0]!.buttons.find((button) => button.text === "Hardik, Epicode")!;
const EPICODE_SUMMARY = "Hardik says the sprint demo is moved to Thursday.";
const tapped = await tap(epicodeButton.data, [search("from:hardik"), read("h2"), { text: EPICODE_SUMMARY }]);
assert(tapped.length === 1 && tapped[0]!.text === EPICODE_SUMMARY, `the tap completes the request (${texts(tapped)})`);
assert(searches().join("|") === `from:(${HARDIK_E})`, `the other Hardik's mail was searched (${searches().join("|")})`);
const twice = await tap(epicodeButton.data);
assert(twice.length === 1 && /expired/.test(twice[0]!.text) && modelCalls.length === 0, "a second tap does nothing");
passed.push('follow-up by tap: tapping "Hardik, Epicode" re-ran the request for hardik@epicode.com; a second tap does nothing');

// A new request that happens to name one of them is a new request, not an answer.
forget();
await say(ASK, [search("from:hardik")]);
const newRequest = await say("draft a note to Hardik Singh about pricing", [{ text: "What should the note say?" }]);
assert(newRequest.length === 1 && newRequest[0]!.text === "What should the note say?" && searches().length === 0, `a new request is not taken as an answer (${texts(newRequest)})`);
assert(!hasOpenContactQuestion(CHAT), "and the old question is dropped");

// A message that isn't an answer drops the question and is handled normally.
forget();
await say(ASK, [search("from:hardik")]);
const other = await say("what is 2 plus 2", [{ text: "4." }]);
assert(other.length === 1 && other[0]!.text === "4." && !hasOpenContactQuestion(CHAT), `an unrelated message is answered and the question dropped (${texts(other)})`);
passed.push("unrelated reply: a message that isn't an answer is handled as a new message and nobody is picked");

// =====================================================================
// 7. Nobody matches: ask for an address or more detail
// =====================================================================
forget();
const ZUBIN_ASK = "Find the latest email from Zubin and summarise it";
const unknown = await say(ZUBIN_ASK, [search("from:zubin")]);
assert(
  unknown.length === 1 &&
    unknown[0]!.text ===
      "I couldn't find anyone called Zubin in your contacts, Gmail, calendar or accounts. What's their email address, or their full name or company?",
  `Aadi asks for an address or more detail (${texts(unknown)})`,
);
assert(unknown[0]!.buttons.length === 0 && modelCalls.length === 1, "one question, no guesses");
const ZUBIN_SUMMARY = "Z. Mistry's latest email has the invoice attached.";
const gaveAddress = await say("zm@farpoint.io", [search("from:zubin"), read("z1"), { text: ZUBIN_SUMMARY }]);
assert(gaveAddress.length === 1 && gaveAddress[0]!.text === ZUBIN_SUMMARY, `the address completes the request (${texts(gaveAddress)})`);
assert(searches().join("|") === "from:(zm@farpoint.io)", `searched the address he gave (${searches().join("|")})`);
passed.push('unknown: "Zubin" → Aadi asks for an email address or full name/company; "zm@farpoint.io" completes the original request');

forget();
await say("Find the latest email from Mira and summarise it", [search("from:mira")]);
const MEERA_SUMMARY = "Meera says it looks good and has one question on pricing.";
const gaveName = await say("Meera Iyer", [search("from:mira"), read("m2"), { text: MEERA_SUMMARY }]);
assert(gaveName.length === 1 && gaveName[0]!.text === MEERA_SUMMARY && searches().join("|") === "from:(meera@zenith.io)", `a fuller name completes it (${texts(gaveName)} ${searches().join("|")})`);
forget();
await say(ZUBIN_ASK, [search("from:zubin")]);
const stillNot = await say("Farpoint Labs");
assert(stillNot.length === 1 && /still can't find/.test(stillNot[0]!.text) && modelCalls.length === 0, `more detail that still matches nobody asks for the address (${texts(stillNot)})`);
const dropped = await say("never mind");
assert(dropped.length === 1 && /leaving that/.test(dropped[0]!.text) && !hasOpenContactQuestion(CHAT), "he can drop it");
passed.push('unknown, more detail: "Meera Iyer" for "Mira" completes the request; detail that still matches nobody asks for the address; "never mind" drops it');

// A sender that is not a person (a newsletter, a company) is searched as written.
forget();
const digest = await say("any email from pinnacle this week?", [search("from:pinnacle newer_than:7d"), { text: "One from Hardik Singh about renewal terms." }]);
assert(digest[0]!.text === "One from Hardik Singh about renewal terms." && searches().join("|") === "from:pinnacle newer_than:7d", `a company search is left as written (${searches().join("|")})`);
passed.push('company: "from:pinnacle" is searched as written, with no question');

// =====================================================================
// 8. One service for Email, Calendar and Sales
// =====================================================================
for (const id of ["email", "calendar", "sales"]) {
  assert(specialistFor(id)!.toolNames().includes("resolve_contact"), `the ${id} agent has resolve_contact`);
}
assert(toolOwnership("resolve_contact")?.owner === "aadi" && toolOwnership("resolve_contact")?.effect === "read", "it is a shared read tool");
assert(TOOL_ORDER.at(-1) === "list_documents" && !(FORWARDED_TOOLS as readonly string[]).includes("resolve_contact"), "the tool list still ends as before");

forget();
const met = await say("When did I last meet Rohan?", [
  { tools: [{ name: "resolve_contact", input: { name: "Rohan" } }] },
  { tools: [{ name: "list_events", input: { start_date: "2026-10-01", end_date: "2026-11-13" } }] },
  { text: "You last met Rohan Mehta of Orbit on 3 November." },
]);
assert(met.at(-1)!.text === "You last met Rohan Mehta of Orbit on 3 November.", `the Calendar Agent answers (${texts(met)})`);
const resolvedFor = JSON.stringify(modelCalls[1]!.messages.at(-1));
assert(/One match for .*Rohan Mehta <rohan@orbit\.in>, Orbit/.test(resolvedFor), `resolve_contact told it who Rohan is (${resolvedFor.slice(0, 200)})`);

const whoCalendar = await say("When did I last meet Hardik?", [{ tools: [{ name: "resolve_contact", input: { name: "Hardik" } }] }]);
assert(whoCalendar.length === 1 && whoCalendar[0]!.text === HARDIK_QUESTION && !toolsRun.includes("list_events"), `the Calendar Agent asks too (${texts(whoCalendar)})`);
forget();
const whoSales = await say("where are we with Hardik's account?", [{ tools: [{ name: "resolve_contact", input: { name: "Hardik" } }] }]);
assert(whoSales.length === 1 && whoSales[0]!.text === HARDIK_QUESTION, `and so does an account question (${texts(whoSales)})`);
passed.push("reusable: resolve_contact is shared by the Email, Calendar and Sales agents; a calendar and an account question about Hardik get the same question");

// Through Aadi's own loop: a delegated goal that hits two Hardiks ends the whole turn on the question.
forget();
const viaAadi = await say("Find the latest email from Hardik and add a task to chase him", [
  {
    tools: [
      {
        name: "delegate_tasks",
        input: {
          title: "Hardik's email",
          tasks: [{ key: "mail", agent: "email", capability: "goal", input: { goal: "Find the latest email from Hardik and summarise it" } }],
        },
      },
    ],
  },
  search("from:hardik"),
]);
assert(viaAadi.length === 1 && viaAadi[0]!.text === HARDIK_QUESTION && viaAadi[0]!.buttons.length === 3, `a delegated task asks the same way (${texts(viaAadi)})`);
assert(listPausedTasks(CHAT).length === 0 && !toolsRun.includes("add_task"), "nothing is left paused and nothing else was done");
const DONE = "Hardik Singh wants the renewal terms by Friday. Task added.";
const viaAadiAnswered = await say("Hardik Singh", [
  search("from:hardik"),
  read("h1"),
  { tools: [{ name: "add_task", input: { title: "Chase Hardik Singh on renewal terms", tag: "work" } }] },
  { text: DONE },
]);
assert(viaAadiAnswered.at(-1)!.text === DONE && searches().join("|") === `from:(${HARDIK_P})`, `his answer completes both parts (${texts(viaAadiAnswered)})`);
passed.push("delegated: a goal Aadi handed to the Email Agent ends the turn on the same question, leaves no paused task, and the answer completes the whole request");

// A capability that runs as a task pauses the task instead, and resumes with his answer.
forget();
extraction = { confirmed_time: null, summary: "The demo is moved to Thursday." };
let taskQueries: string[] = [];
stubSearch = (query) => {
  taskQueries.push(query);
  return JSON.stringify([{ id: "h2", account: "work", from: `Hardik <${HARDIK_E}>`, subject: "Sprint demo", date: ago(2).toUTCString(), snippet: "Demo is moved" }]);
};
const grant = issueGrant({ source: "owner_chat", confirmation: { chatId: CHAT, messageId: nextMessageId() }, ownerText: "did Hardik reply about the demo?" });
const paused = await delegate({ agentId: "email", capability: "check_reply", input: { person: "Hardik" }, chatId: CHAT, grant });
assert(paused.state === "input-required" && paused.inputRequired?.question === HARDIK_QUESTION, `check_reply pauses on two Hardiks (${paused.state})`);
assert(taskQueries.length === 0, "and searches nothing until he answers");
const resumed = await continueTask(paused.taskId, { answer: "Epicode" }, grant);
assert(resumed?.state === "completed" && resumed.output?.replied === true, `it resumes with his answer (${resumed?.state})`);
assert(taskQueries[0] === `from:(${HARDIK_E}) newer_than:7d`, `and checks only that Hardik (${taskQueries[0]})`);
revokeGrant(grant.ref);
stubSearch = undefined;
taskQueries = [];
passed.push('workflow: check_reply for "Hardik" pauses the task with the same question and, on "Epicode", checks from:(hardik@epicode.com) only');

// =====================================================================
// 9. Who may ask, and who may answer
// =====================================================================
forget();
reset([]);
const offTurn = await tools.search_emails!.handler({ query: "from:hardik", account: "work" }, { iteration: 1, calledTools: ["search_emails"] });
assert(offTurn.startsWith("[") && !hasOpenContactQuestion(CHAT), "a background or forwarded search is left as it was and opens no question");
const cantAsk = askWhichContact({}, "Hardik", hardik);
assert(/^Not looked up/.test(cantAsk) && /Ask Vishnu/.test(cantAsk) && contactQuestionAsked(CHAT, 0) === undefined, "off his own turn the tool only reports; it can't open a question for him");
passed.push("authorization: only Vishnu's own turn opens a question; background and forwarded searches are unchanged and can't ask on his behalf");

// A forwarded message can't answer an open question.
await say(ASK, [search("from:hardik")]);
reset([{ text: "That's a forwarded note about Pinnacle." }]);
const forwardId = nextMessageId();
await bot.handleUpdate({
  update_id: forwardId,
  message: {
    message_id: forwardId,
    date: Math.floor(Date.now() / 1000),
    chat: { id: CHAT, type: "private", first_name: "Vishnu" },
    from: { id: CHAT, is_bot: false, first_name: "Vishnu" },
    forward_origin: { type: "hidden_user", sender_user_name: "Someone", date: 0 },
    text: "Pinnacle",
  },
} as never);
await new Promise((resolve) => setTimeout(resolve, 30));
assert(searches().length === 0 && hasOpenContactQuestion(CHAT), "a forwarded \"Pinnacle\" chooses nobody and the question stays open");
passed.push('authorization: a forwarded message saying "Pinnacle" does not answer the question');
forget();

// =====================================================================
// 10. The receipt check on read-only turns
// =====================================================================
const isReadTool = (name: string) => toolOwnership(name)?.effect === "read";
const readOk = [{ name: "search_emails", success: true }, { name: "read_email", success: true }];
const lookup = { ownerText: ASK, isReadTool };
const claims = (reply: string, receipts = readOk, context = lookup) => unreceiptedClaims(reply, receipts, context).join(",");
assert(claims("Hardik's email was sent on Monday.") === "", "a passive 'was sent' in a summary is a description");
assert(claims("He sent the email at 9am and the meeting is scheduled for Friday.") === "", "so is what the sender did");
assert(claims('He wrote: "I sent the contract yesterday."') === "", "and words quoted from the email");
assert(claims("I sent the email to Hardik.") === "sent", "Aadi saying it sent something is still checked");
assert(claims("Hardik's email was sent on Monday.", []) === "sent", "with nothing read, the claim is checked");
assert(claims("Hardik's email was sent on Monday.", [{ name: "search_emails", success: false }]) === "sent", "a failed read doesn't count");
assert(claims("The email was sent.", [...readOk, { name: "send_email", success: false }]) === "sent", "a send that was tried and failed is still checked");
assert(claims("The email was sent.", readOk, { ownerText: "send Hardik the deck", isReadTool }) === "sent", "when he asked to send, it is checked");
assert(claims("The email was sent.", readOk, { ownerText: "yes, do it", isReadTool }) === "sent", "a go-ahead is not a lookup");
assert(claims("The email was sent.", readOk, { ownerText: "Find Hardik's email and reply to it", isReadTool }) === "sent", "look-up-and-act is checked");
assert(claims("His reply was sent this morning.", readOk, { ownerText: "Did Hardik reply?", isReadTool }) === "", "a question about the past is a lookup");
assert(claims("The email was sent.", readOk, { ownerText: "Did Hardik reply? If not, send him a nudge", isReadTool }) === "sent", "unless it also asks for the action");
assert(unreceiptedClaims("As of today Nifty closed higher.", readOk, lookup).join() === "searched", "live-lookup claims are never relaxed");
assert(unreceiptedClaims("The email was sent.", readOk).join() === "sent", "without context the check is exactly as before");
assert(askedOnlyToLook(ASK, "sent") && !askedOnlyToLook("email him back", "sent") && !askedOnlyToLook("", "sent"), "what counts as a lookup");
passed.push('receipt check: "was sent" in a read-only summary passes; "I sent…", a go-ahead, a requested or attempted send, and live-lookup claims are all still checked');

setCompleteForTests(undefined);
setToolInterceptorForTests(undefined);
setGmailClientForTests(undefined);
setGoogleAccountForTests(undefined);
setContactCalendarForTests(undefined);
clearContactCacheForTests();

for (const line of passed) {
  log(`ok  ${line}`);
}
log("Contact resolution checks passed.");
process.exit(0);
