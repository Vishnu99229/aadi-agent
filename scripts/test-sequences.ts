import "dotenv/config";
import { readFile } from "node:fs/promises";
import type { Api, Context } from "grammy";
import type { gmail_v1 } from "googleapis";
import { fakeTelegramApi, type TelegramLog } from "./fakes.ts";
import {
  addSalesDoNotContact,
  createProposedSalesSequence,
  getSalesSequenceByThread,
  createAccount,
  listSalesSequenceSteps,
  stopProposedSalesSequence,
  upsertMeetingThread,
} from "../src/db.ts";
import { setGoogleAccountForTests, type LoadedGoogleAccount } from "../src/google/auth.ts";
import { setGmailClientForTests } from "../src/google/mail.ts";
import { setCompleteForTests, type CompleteResult } from "../src/llm.ts";
import { PERSONAL_DOMAINS } from "../src/meeting_book.ts";
import {
  countManualFollowups,
  evaluatePitchExclusion,
  firstStepAt,
  hasOriginalOutreach,
  isExplicitSequenceRequest,
  matchesProspect,
  parsePitchClassification,
  pitchCardText,
  pitchClassifierInput,
  prospectKey,
  type PitchEnvironment,
  type PitchFacts,
} from "../src/sequence_logic.ts";
import {
  detectPitches,
  handleSequenceCallback,
  handleSequenceCommand,
  requestSequenceCard,
  runSequenceDetection,
  startSequenceFromTool,
} from "../src/sequences.ts";
import { unreceiptedClaims } from "../src/receipt.ts";
import { FORWARDED_TOOLS, TOOL_ORDER, tools } from "../src/tools/index.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

if (process.env.AADI_DB_PATH !== ":memory:") {
  throw new Error("test-sequences.ts must run with AADI_DB_PATH=:memory:");
}

const ME = "vishnu.rajan@epicode.in";
const DAY = 24 * 60 * 60 * 1000;

// ---- pure exclusion logic ----
function mailbox(email: string, name = "Priya") {
  return { name, email };
}

function facts(overrides: Partial<PitchFacts> = {}): PitchFacts {
  return {
    to: [mailbox("priya@acme.com")],
    cc: [],
    threadSenders: [],
    earlierRecipients: [],
    manualFollowups: 0,
    isCalendarOrAutomated: false,
    noReplyOrIgnored: false,
    ...overrides,
  };
}

function env(overrides: Partial<PitchEnvironment> = {}): PitchEnvironment {
  return {
    selfAddresses: new Set([ME, "vishnu@gmail.example"]),
    blockedDomains: new Set(["epicode.in", "pinnacle.in"]),
    personalDomains: PERSONAL_DOMAINS,
    isAccountEmail: () => false,
    isDoNotContact: () => false,
    threadHasSequence: false,
    prospectHasOpenSequence: () => false,
    threadInMeetingFlow: false,
    ...overrides,
  };
}

assert(evaluatePitchExclusion(facts(), env()) === null, "a lone prospect passes");
const cases: Array<[string, PitchFacts, PitchEnvironment, string]> = [
  ["automated", facts({ isCalendarOrAutomated: true }), env(), "calendar_or_automated"],
  ["self only", facts({ to: [mailbox(ME)] }), env(), "no_external_recipient"],
  ["colleagues only", facts({ to: [mailbox("sam@epicode.in")] }), env(), "no_external_recipient"],
  ["colleague in To", facts({ to: [mailbox("priya@acme.com"), mailbox("sam@epicode.in")] }), env(), "colleague_on_email"],
  ["colleague in Cc", facts({ cc: [mailbox("sam@epicode.in")] }), env(), "colleague_on_email"],
  ["two recipients", facts({ to: [mailbox("priya@acme.com"), mailbox("raj@acme.com")] }), env(), "multiple_recipients"],
  ["external Cc", facts({ cc: [mailbox("raj@acme.com")] }), env(), "external_cc"],
  ["Cc only", facts({ to: [mailbox(ME)], cc: [mailbox("raj@acme.com")] }), env(), "external_cc"],
  ["partner domain", facts({ to: [mailbox("a@pinnacle.in")] }), env(), "partner_or_self_domain"],
  ["partner subdomain", facts({ to: [mailbox("a@mail.pinnacle.in")] }), env(), "partner_or_self_domain"],
  ["account", facts(), env({ isAccountEmail: () => true }), "account_match"],
  ["no-reply", facts({ noReplyOrIgnored: true }), env(), "noreply_or_ignored"],
  ["do not contact", facts(), env({ isDoNotContact: () => true }), "do_not_contact"],
  ["replied", facts({ threadSenders: ["priya@acme.com"] }), env(), "replied"],
  ["colleague of prospect replied", facts({ threadSenders: ["raj@acme.com"] }), env(), "replied"],
  ["bounce", facts({ threadSenders: ["mailer-daemon@googlemail.com"] }), env(), "bounced"],
  ["stranger", facts({ threadSenders: ["x@other.com"] }), env(), "other_sender"],
  ["earlier others", facts({ earlierRecipients: ["raj@acme.com"] }), env(), "other_recipient_in_thread"],
  ["colleague on an earlier email", facts({ earlierRecipients: ["sam@epicode.in"] }), env(), "other_recipient_in_thread"],
  ["in sequence", facts(), env({ threadHasSequence: true }), "in_sequence"],
  ["open prospect", facts(), env({ prospectHasOpenSequence: () => true }), "prospect_in_sequence"],
  ["meeting flow", facts(), env({ threadInMeetingFlow: true }), "meeting_auto_scheduling"],
];
for (const [label, item, environment, expected] of cases) {
  const actual = evaluatePitchExclusion(item, environment);
  assert(actual === expected, `${label}: expected ${expected}, got ${actual}`);
}
assert(
  evaluatePitchExclusion(
    facts({ to: [mailbox("priya@acme.com")], cc: [mailbox(ME)] }),
    env(),
  ) === null,
  "Vishnu's own address on Cc does not exclude",
);
assert(
  evaluatePitchExclusion(
    facts({ to: [mailbox("priya@gmail.com")], threadSenders: ["other@gmail.com"] }),
    env(),
  ) === "other_sender",
  "a stranger on the same free-mail domain is not the prospect replying",
);
assert(
  matchesProspect("priya@gmail.com", "priya@gmail.com", PERSONAL_DOMAINS),
  "free mail matches the exact address",
);
assert(
  !matchesProspect("other@gmail.com", "priya@gmail.com", PERSONAL_DOMAINS),
  "free mail never matches on domain",
);
assert(
  matchesProspect("raj@acme.com", "priya@acme.com", PERSONAL_DOMAINS),
  "a company domain matches on domain",
);

// ---- classifier parsing and input ----
assert(
  parsePitchClassification('x {"is_sales_pitch":true,"confidence":1.7,"reason":" a  b "} y')
    ?.confidence === 1,
  "confidence is clamped",
);
assert(parsePitchClassification("nope") === undefined, "non-JSON yields no verdict");
assert(
  parsePitchClassification('{"is_sales_pitch":"yes","confidence":0.9}') === undefined,
  "a wrong type yields no verdict",
);
{
  const input = pitchClassifierInput([
    { from: "a", subject: "s", body: "old ".repeat(3000) },
    { from: "b", subject: "s", body: "> quoted line\nlatest words" },
  ]);
  assert(input.includes("latest words"), "the latest message always reaches the model");
  assert(!input.includes("quoted line"), "quoted lines are dropped");
  assert(input.startsWith("<<<UNTRUSTED_THREAD>>>"), "thread text is marked untrusted");
}

// ---- card and timing ----
assert(
  pitchCardText({
    name: "Priya",
    email: "priya@acme.com",
    company: "Acme",
    subject: "IraVoice demo",
  }) ===
    "Looks like a sales pitch to Priya (priya@acme.com), Acme ('IraVoice demo'). Start a 4-step follow-up sequence?",
  "card wording matches the spec",
);
{
  const now = new Date("2026-11-06T10:00:00Z");
  assert(
    firstStepAt(new Date(now.getTime() - DAY), 2, now).getTime() === now.getTime() + DAY,
    "step 1 waits a full interval from the last send",
  );
  assert(
    firstStepAt(new Date(now.getTime() - 9 * DAY), 2, now).getTime() === now.getTime(),
    "an old pitch is due now, never in the past",
  );
}

// ---- stub Gmail ----
interface FakeMessage {
  id: string;
  from: string;
  to: string;
  cc?: string;
  subject: string;
  sentAt: number;
  sent: boolean;
  body?: string;
}

const threads = new Map<string, FakeMessage[]>();
const mailCalls: string[] = [];

function toGmailMessage(threadId: string, message: FakeMessage): gmail_v1.Schema$Message {
  return {
    id: message.id,
    threadId,
    internalDate: String(message.sentAt),
    labelIds: message.sent ? ["SENT"] : ["INBOX"],
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: message.from },
        { name: "To", value: message.to },
        { name: "Cc", value: message.cc ?? "" },
        { name: "Subject", value: message.subject },
      ],
      body: {
        data: Buffer.from(message.body ?? "pitch body", "utf8").toString("base64url"),
      },
    },
  };
}

const gmailStub = {
  users: {
    getProfile: async () => ({ data: { emailAddress: ME } }),
    settings: { sendAs: { list: async () => ({ data: { sendAs: [{ sendAsEmail: ME }] } }) } },
    threads: {
      get: async ({ id }: { id: string }) => ({
        data: {
          id,
          messages: (threads.get(id) ?? []).map((message) => toGmailMessage(id, message)),
        },
      }),
    },
    messages: {
      list: async ({ q }: { q: string }) => {
        const from = /from:(\S+)/.exec(q)?.[1];
        if (from) {
          const after = Number(/after:(\d+)/.exec(q)?.[1] ?? 0) * 1000;
          const matches = [...threads.entries()].flatMap(([threadId, messages]) =>
            messages
              .filter(
                (message) =>
                  !message.sent && message.from.includes(from) && message.sentAt > after,
              )
              .map((message) => ({ id: message.id, threadId })),
          );
          return { data: { messages: matches } };
        }
        const to = /to:"([^"]+)"/.exec(q)?.[1]?.toLowerCase();
        const matches = [...threads.entries()].flatMap(([threadId, messages]) =>
          messages
            .filter(
              (message) =>
                message.sent && (!to || message.to.toLowerCase().includes(to)),
            )
            .map((message) => ({ id: message.id, threadId })),
        );
        return { data: { messages: matches } };
      },
      send: async () => {
        mailCalls.push("messages.send");
        return { data: { id: "never" } };
      },
    },
    drafts: {
      send: async () => {
        mailCalls.push("drafts.send");
        return { data: { id: "never" } };
      },
      create: async () => {
        mailCalls.push("drafts.create");
        return { data: { id: "never" } };
      },
    },
  },
} as unknown as gmail_v1.Gmail;

const workAccount = {
  id: "work",
  tag: "work",
  label: "work (Epicode)",
  client: {},
} as unknown as LoadedGoogleAccount;

setGoogleAccountForTests((id) => (id === "work" ? workAccount : undefined));
setGmailClientForTests(() => gmailStub);

let modelCalls = 0;
let verdict = { is_sales_pitch: true, confidence: 0.92, reason: "Outbound product pitch" };
setCompleteForTests(async () => {
  modelCalls += 1;
  return {
    textParts: [JSON.stringify(verdict)],
    toolCalls: [],
    usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    stopReason: "end_turn",
  } as CompleteResult;
});

function pitch(threadId: string, to: string, subject: string, ageDays = 1, cc = ""): void {
  threads.set(threadId, [
    {
      id: `${threadId}-m1`,
      from: `Vishnu Rajan <${ME}>`,
      to,
      cc,
      subject,
      sentAt: Date.now() - ageDays * DAY,
      sent: true,
    },
  ]);
}

function card(api: TelegramLog): string {
  return api.sent[api.sent.length - 1] ?? "";
}

function callbackCtx(data: string, log: { edits: string[]; replies: string[] }): Context {
  return {
    callbackQuery: { data },
    answerCallbackQuery: async () => true,
    editMessageText: async (text: string) => {
      log.edits.push(text);
      return true;
    },
    editMessageReplyMarkup: async () => true,
    reply: async (text: string) => {
      log.replies.push(text);
      return {};
    },
  } as unknown as Context;
}

const telegram: TelegramLog = { sent: [], edited: [] };
const api: Api = fakeTelegramApi(telegram);

// ---- detection never enrols on its own ----
pitch("t-lone", "Priya Shah <priya@acme.com>", "IraVoice for Acme support");
pitch("t-partner", "Sonal <sonal@pinnacle.in>", "BotCompose");
pitch("t-colleague", "Raj <raj@beta.com>", "Dialer demo", 1, "Sam <sam@epicode.in>");
pitch("t-internal", "Sam <sam@epicode.in>", "Internal");
threads.set("t-replied", [
  {
    id: "r1",
    from: `Vishnu <${ME}>`,
    to: "Mina <mina@gamma.com>",
    subject: "Demo",
    sentAt: Date.now() - 3 * DAY,
    sent: true,
  },
  {
    id: "r2",
    from: "Mina <mina@gamma.com>",
    to: ME,
    subject: "Re: Demo",
    sentAt: Date.now() - 2 * DAY,
    sent: false,
  },
]);
pitch("t-dnc", "Dan <dan@delta.com>", "IraVoice");
addSalesDoNotContact("dan@delta.com", "test");
pitch("t-meeting", "Mo <mo@epsilon.com>", "IraVoice");
upsertMeetingThread({
  threadId: "t-meeting",
  recipientEmail: "mo@epsilon.com",
  recipientName: "Mo",
  company: "Epsilon",
  senderType: "prospect_enquiry",
  status: "proposed",
  subject: "IraVoice",
});
createAccount({
  name: "Zeta Corp",
  relationship: "end_client",
  emailDomains: JSON.stringify(["zeta.com"]),
});
pitch("t-client", "Zed <zed@zeta.com>", "Dialer");

{
  const rows = await detectPitches({ lookbackDays: 21 });
  const byThread = new Map(rows.map((row) => [row.threadId, row]));
  assert(byThread.get("t-lone")?.exclusion === null, "lone prospect is offerable");
  assert(byThread.get("t-partner")?.exclusion === "partner_or_self_domain", "partner excluded");
  assert(byThread.get("t-colleague")?.exclusion === "colleague_on_email", "colleague excluded");
  assert(byThread.get("t-internal")?.exclusion === "no_external_recipient", "internal excluded");
  assert(byThread.get("t-replied")?.exclusion === "replied", "replied excluded");
  assert(byThread.get("t-dnc")?.exclusion === "do_not_contact", "do-not-contact excluded");
  assert(byThread.get("t-meeting")?.exclusion === "meeting_auto_scheduling", "meeting flow excluded");
  assert(byThread.get("t-client")?.exclusion === "partner_or_self_domain", "end_client excluded");
  assert(modelCalls === 1, "only the surviving thread reaches the model");
  assert(getSalesSequenceByThread("t-lone") === undefined, "detectPitches writes no sequence row");
  assert(telegram.sent.length === 0, "detectPitches posts nothing");
}

modelCalls = 0;
{
  const rows = await detectPitches({ lookbackDays: 21, classifyExcluded: true });
  const internal = rows.find((row) => row.threadId === "t-internal");
  const partner = rows.find((row) => row.threadId === "t-partner");
  assert(internal?.classification === null, "the report never classifies internal mail");
  assert(partner?.classification !== null, "the report does classify excluded external mail");
  assert(partner?.exclusion === "partner_or_self_domain", "a verdict never clears an exclusion");
}

modelCalls = 0;
{
  const offered = await runSequenceDetection(api);
  assert(offered === 1, `one card for one candidate, got ${offered}`);
  assert(
    card(telegram) ===
      "Looks like a sales pitch to Priya Shah (priya@acme.com), Acme ('IraVoice for Acme support'). Start a 4-step follow-up sequence?",
    "the card names the prospect",
  );
  const row = getSalesSequenceByThread("t-lone")!;
  assert(row.status === "proposed", "a card leaves the sequence proposed");
  assert(listSalesSequenceSteps(row.id).length === 0, "no steps exist before Start");
  assert(row.next_step_at === null, "nothing is scheduled before Start");

  assert((await runSequenceDetection(api)) === 0, "the card is not repeated");
  assert(telegram.sent.length === 1, "one card only across scans");
  assert(modelCalls === 1, "a proposed thread is not classified again");
}

// ---- a low-confidence or negative verdict gets no card ----
{
  verdict = { is_sales_pitch: true, confidence: 0.4, reason: "Unsure" };
  pitch("t-unsure", "Una <una@eta.com>", "Hello");
  assert((await runSequenceDetection(api)) === 0, "low confidence gets no card");
  modelCalls = 0;
  await runSequenceDetection(api);
  assert(modelCalls === 0, "a classified message is not sent to the model again");
  verdict = { is_sales_pitch: false, confidence: 0.99, reason: "Not a pitch" };
  pitch("t-not", "Nia <nia@theta.com>", "Invoice");
  assert((await runSequenceDetection(api)) === 0, "a non-pitch gets no card");
  verdict = { is_sales_pitch: true, confidence: 0.92, reason: "Outbound product pitch" };
}

// ---- card buttons ----
{
  const row = getSalesSequenceByThread("t-lone")!;
  const log = { edits: [] as string[], replies: [] as string[] };
  await handleSequenceCallback(callbackCtx(`seq:start:${row.id}`, log));
  const active = getSalesSequenceByThread("t-lone")!;
  assert(active.status === "active", "Start activates");
  assert(active.next_step_at !== null, "Start schedules step 1");
  const steps = listSalesSequenceSteps(row.id);
  assert(steps.length === 4, "Start creates four steps");
  assert(steps.every((step) => step.status === "planned"), "all steps start planned");
  assert(steps[0]!.scheduled_at !== null && steps[1]!.scheduled_at === null, "only step 1 is scheduled");
  assert(log.edits[0]?.startsWith("Started a 4-step sequence"), "the card reports the start");

  await handleSequenceCallback(callbackCtx(`seq:start:${row.id}`, log));
  assert(listSalesSequenceSteps(row.id).length === 4, "a second tap changes nothing");
}

{
  pitch("t-no", "Noor <noor@iota.com>", "Pitch");
  await runSequenceDetection(api);
  const row = getSalesSequenceByThread("t-no")!;
  const log = { edits: [] as string[], replies: [] as string[] };
  await handleSequenceCallback(callbackCtx(`seq:no:${row.id}`, log));
  const stopped = getSalesSequenceByThread("t-no")!;
  assert(stopped.status === "stopped" && stopped.stop_reason === "declined", "No stops it");
  assert(listSalesSequenceSteps(row.id).length === 0, "No creates no steps");
  await handleSequenceCallback(callbackCtx(`seq:start:${row.id}`, log));
  assert(getSalesSequenceByThread("t-no")!.status === "stopped", "Start after No does nothing");
  const before = telegram.sent.length;
  await runSequenceDetection(api);
  assert(telegram.sent.length === before, "a declined thread is not offered again");
}

{
  pitch("t-never", "Nev <nev@kappa.com>", "Pitch");
  await runSequenceDetection(api);
  const row = getSalesSequenceByThread("t-never")!;
  const log = { edits: [] as string[], replies: [] as string[] };
  await handleSequenceCallback(callbackCtx(`seq:never:${row.id}`, log));
  assert(getSalesSequenceByThread("t-never")!.stop_reason === "do_not_contact", "Never stops it");
  pitch("t-never-2", "Nev <nev@kappa.com>", "Second pitch");
  const before = telegram.sent.length;
  await runSequenceDetection(api);
  assert(telegram.sent.length === before, "Never blocks that person's other threads");
  const reply = await requestSequenceCard("nev@kappa.com", api);
  assert(reply.startsWith("Not started"), "an explicit command cannot override do-not-contact");
}

// ---- Start re-checks the live thread ----
{
  pitch("t-late", "Lee <lee@lambda.com>", "Pitch");
  await runSequenceDetection(api);
  const row = getSalesSequenceByThread("t-late")!;
  threads.get("t-late")!.push({
    id: "t-late-r",
    from: "Lee <lee@lambda.com>",
    to: ME,
    subject: "Re: Pitch",
    sentAt: Date.now(),
    sent: false,
  });
  const log = { edits: [] as string[], replies: [] as string[] };
  await handleSequenceCallback(callbackCtx(`seq:start:${row.id}`, log));
  const after = getSalesSequenceByThread("t-late")!;
  assert(after.status === "stopped", "a reply since the card blocks Start");
  assert(after.stop_reason === "excluded:replied", "the stop reason names the exclusion");
  assert(listSalesSequenceSteps(row.id).length === 0, "no steps when Start is refused");
  assert(log.edits[0]?.startsWith("Not started"), "the card says why");
}

{
  pitch("t-other", "Ola <ola@mu.com>", "Pitch", 2);
  threads.set("t-other-2", [
    {
      id: "ola-inbound",
      from: "Ola <ola@mu.com>",
      to: ME,
      subject: "Separate topic",
      sentAt: Date.now() - DAY,
      sent: false,
    },
  ]);
  const rows = await detectPitches({ lookbackDays: 21 });
  assert(
    rows.find((row) => row.threadId === "t-other")?.exclusion === "replied_elsewhere",
    "mail from the prospect on another thread since the pitch excludes it",
  );
}

// ---- explicit requests only ever show a Start card ----
for (const phrase of [
  "start a sequence for Rajan",
  "Start a follow-up sequence for Talkdesk",
  "auto follow up with Rajan",
  "auto-follow-up with priya@acme.com",
]) {
  assert(isExplicitSequenceRequest(phrase), `explicit: ${phrase}`);
}
// Since the old tracker was removed, its phrasings ask for the Start card too.
for (const phrase of [
  "follow up on my email to Rajan",
  "remind me to follow up with Rajan",
  "track my email to Rajan",
]) {
  assert(isExplicitSequenceRequest(phrase), `explicit now: ${phrase}`);
}
for (const phrase of ["start following up with Rajan", "follow up with me"]) {
  assert(!isExplicitSequenceRequest(phrase), `not explicit: ${phrase}`);
}
assert(
  isExplicitSequenceRequest(
    'For my test account "Aadi QA Demo", propose a follow-up sequence to qa-prospect@example.com requesting a 15-minute demo. Show me the sequence for approval. Do not start the sequence or send any emails.',
  ),
  "proposing a follow-up sequence is an explicit request",
);
assert(!isExplicitSequenceRequest("follow up sequence tomorrow"), "the word sequence is not a person's name");
assert(!hasOriginalOutreach("") && !hasOriginalOutreach(null) && hasOriginalOutreach("1a1cba5a"), "a card needs a sent message id");
{
  const shown = pitchCardText({
    name: "Aadi QA Demo",
    email: "qa-prospect@example.com",
    company: "",
    subject: "Demo",
    manualFollowups: 0,
  });
  assert(shown.includes("(qa-prospect@example.com)"), "the card shows the stored address");
  assert(!shown.includes("<qa-prospect@example.com>"), "the address is not wrapped in angle brackets");
}
{
  const claim =
    "Offer posted for Aadi QA Demo (qa-prospect@example.com). The follow-up sequence card is shown above. Nothing is enrolled until you tap Start.";
  assert(
    unreceiptedClaims(claim, []).includes("offered"),
    "a Start card claimed with no tool is not accepted",
  );
  assert(
    unreceiptedClaims(claim, [{ name: "start_sequence", success: true }]).length === 0,
    "a real Start card satisfies the claim",
  );
  assert(
    unreceiptedClaims(claim, [{ name: "start_sequence", success: false }]).includes("offered"),
    "a refused sequence tool does not count as a card",
  );
}
{
  const before = telegram.sent.length;
  const refused = await startSequenceFromTool(
    "qa-prospect@example.com",
    {
      confirmation: { chatId: 1, messageId: 9 },
      userText:
        'For my test account "Aadi QA Demo", propose a follow-up sequence to qa-prospect@example.com. Do not start the sequence or send any emails.',
    },
    api,
  );
  assert(refused.startsWith("Not started"), `no originating sent email means no card (${refused})`);
  assert(telegram.sent.length === before, "no Start card was posted");
}
assert(isExplicitSequenceRequest("follow up with Rajan"), "follow up with a person is a sequence");
assert(isExplicitSequenceRequest("follow up Abhishek 4 times"), "follow up N times is a sequence");
assert(isExplicitSequenceRequest("add Abhishek to sequence"), "add to sequence is a sequence");
{
  pitch("t-explicit", "Asha Rao <asha@nu.com>", "BotCompose intro", 5);
  modelCalls = 0;
  const before = telegram.sent.length;
  const reply = await requestSequenceCard("Asha", api);
  assert(reply.startsWith("Start card sent for Asha Rao (asha@nu.com)"), `explicit card: ${reply}`);
  assert(telegram.sent.length === before + 1, "an explicit request sends one card");
  assert(card(telegram).startsWith("Looks like a sales pitch to Asha Rao (asha@nu.com), Nu"), "same card as detection");
  assert(getSalesSequenceByThread("t-explicit")!.prospect_email === "asha@nu.com", "the card's address is the stored recipient");
  assert(modelCalls === 0, "an explicit request needs no classifier");
  const row = getSalesSequenceByThread("t-explicit")!;
  assert(row.status === "proposed", "an explicit request never enrols");
  assert(row.enrolled_at === null && row.next_step_at === null, "nothing is scheduled");
  assert(listSalesSequenceSteps(row.id).length === 0, "no steps before Start");

  const log = { edits: [] as string[], replies: [] as string[] };
  await handleSequenceCallback(callbackCtx(`seq:start:${row.id}`, log));
  assert(getSalesSequenceByThread("t-explicit")!.status === "active", "only Start enrols");
  assert(
    (await requestSequenceCard("Asha", api)).startsWith("Not started"),
    "no second card once active",
  );
}
{
  pitch("t-amb-1", "Vik One <vik.one@xi.com>", "One");
  pitch("t-amb-2", "Vik Two <vik.two@omicron.com>", "Two");
  const before = telegram.sent.length;
  const reply = await requestSequenceCard("Vik", api);
  assert(reply.includes("Which one?"), "several people asks which");
  assert(telegram.sent.length === before, "ambiguous sends no card");
  assert(getSalesSequenceByThread("t-amb-1") === undefined, "ambiguous creates no row");
  assert(getSalesSequenceByThread("t-amb-2") === undefined, "ambiguous creates no row");
}
{
  assert((await requestSequenceCard("sonal", api)).includes("partner"), "partner refused");
  assert((await requestSequenceCard("zed", api)).includes("partner"), "end_client refused");
  assert((await requestSequenceCard("nobody-here", api)).startsWith("Not started"), "no match refused");
  assert(getSalesSequenceByThread("t-partner") === undefined, "no row for a partner");
}
{
  const declined = createProposedSalesSequence({
    threadId: "t-revive",
    prospectEmail: "ria@pi.com",
    prospectDomain: "pi.com",
    prospectKey: "ria@pi.com",
    prospectName: "Ria",
    prospectCompany: "Pi",
    subject: "Pitch",
    originalMessageId: "t-revive-m1",
    originalSentAt: new Date().toISOString(),
    manualFollowups: 0,
    classifierConfidence: 0.9,
    classifierReason: "x",
  })!;
  stopProposedSalesSequence(declined.id, "declined");
  pitch("t-revive", "Ria <ria@pi.com>", "Pitch");
  const reply = await requestSequenceCard("ria@pi.com", api);
  assert(reply.startsWith("Start card sent"), "an explicit request can re-offer a declined thread");
  assert(getSalesSequenceByThread("t-revive")!.status === "proposed", "re-offering does not enrol");
  assert(listSalesSequenceSteps(declined.id).length === 0, "re-offering creates no steps");
}

// ---- one open sequence per person, several per company ----
assert(prospectKey("Mira@CallCloud.com") === "mira@callcloud.com", "the key is the person's address");
assert(prospectKey("Ravi@Gmail.com") === "ravi@gmail.com", "free-mail key is the address too");
{
  verdict = { is_sales_pitch: true, confidence: 0.92, reason: "Outbound product pitch" };
  await runSequenceDetection(api);
  pitch("t-co-1", "Ana <ana@upsilon.com>", "Pitch one");
  pitch("t-co-2", "Ben <ben@upsilon.com>", "Pitch two");
  const before = telegram.sent.length;
  const offered = await runSequenceDetection(api);
  assert(offered === 2, `a card for each of two contacts at one company, got ${offered}`);
  assert(telegram.sent.length === before + 2, "two cards were posted");
  const ana = getSalesSequenceByThread("t-co-1")!;
  const ben = getSalesSequenceByThread("t-co-2")!;
  assert(ana.status === "proposed" && ben.status === "proposed", "both colleagues have a row");
  const log = { edits: [] as string[], replies: [] as string[] };
  await handleSequenceCallback(callbackCtx(`seq:start:${ana.id}`, log));
  await handleSequenceCallback(callbackCtx(`seq:start:${ben.id}`, log));
  assert(getSalesSequenceByThread("t-co-1")!.status === "active", "the first colleague starts");
  assert(getSalesSequenceByThread("t-co-2")!.status === "active", "the second colleague starts too");
}
{
  pitch("t-same-1", "Eve <eve@phi.com>", "Pitch one", 2);
  pitch("t-same-2", "Eve <eve@phi.com>", "Pitch two", 1);
  assert((await runSequenceDetection(api)) === 1, "one person on two threads gets one card");
  const rows = [getSalesSequenceByThread("t-same-1"), getSalesSequenceByThread("t-same-2")];
  assert(rows.filter(Boolean).length === 1, "only one open row for that person");
}
{
  pitch("t-free-1", "Ravi <ravi@gmail.com>", "Pitch");
  pitch("t-free-2", "Sara <sara@gmail.com>", "Pitch");
  assert((await runSequenceDetection(api)) === 2, "two free-mail people are two separate prospects");
  assert(getSalesSequenceByThread("t-free-1")!.status === "proposed", "first free-mail card");
  assert(getSalesSequenceByThread("t-free-2")!.status === "proposed", "second free-mail card");
}

// ---- manual follow-ups count toward the 4 ----
{
  const me = { sentByMe: true, toProspect: true };
  const note = { sentByMe: true, toProspect: false };
  const reply = { sentByMe: false, toProspect: false };
  assert(countManualFollowups([me]) === 0, "the pitch alone is no follow-up");
  assert(countManualFollowups([me, me]) === 1, "one bump");
  assert(countManualFollowups([me, me, me, me]) === 3, "three bumps");
  assert(countManualFollowups([me, note, note]) === 0, "a note to self is no follow-up");
  assert(countManualFollowups([me, me, reply, me]) === 1, "a reply in between resets the count");

  assert(
    pitchCardText({ name: "Priya", email: "p@a.com", company: "A", subject: "S", manualFollowups: 1 }) ===
      "Looks like a sales pitch to Priya (p@a.com), A ('S'). You've already followed up once - Aadi will send up to 3 more. Start the follow-up sequence?",
    "one manual follow-up on the card",
  );
  assert(
    pitchCardText({ name: "Priya", email: "p@a.com", company: "A", subject: "S", manualFollowups: 2 }).includes(
      "You've already followed up twice - Aadi will send up to 2 more.",
    ),
    "two manual follow-ups on the card",
  );
  assert(
    evaluatePitchExclusion(facts({ manualFollowups: 3 }), env()) === null,
    "three bumps still leaves one step",
  );
  assert(
    evaluatePitchExclusion(facts({ manualFollowups: 4 }), env()) === "followups_used_up",
    "four bumps means no card",
  );
}
function bumped(threadId: string, to: string, subject: string, bumps: number): void {
  const now = Date.now();
  threads.set(
    threadId,
    Array.from({ length: bumps + 1 }, (_, index) => ({
      id: `${threadId}-m${index}`,
      from: `Vishnu Rajan <${ME}>`,
      to,
      subject: index === 0 ? subject : `Re: ${subject}`,
      sentAt: now - (bumps + 1 - index) * DAY,
      sent: true,
    })),
  );
}
{
  bumped("t-bump", "Bo <bo@psi.com>", "Pitch", 1);
  const before = telegram.sent.length;
  await runSequenceDetection(api);
  assert(telegram.sent.length === before + 1, "a bumped thread still gets a card");
  assert(
    card(telegram).includes("You've already followed up once - Aadi will send up to 3 more."),
    "the card counts the manual follow-up",
  );
  const row = getSalesSequenceByThread("t-bump")!;
  assert(row.manual_followups === 1, "the count is stored");
  const log = { edits: [] as string[], replies: [] as string[] };
  await handleSequenceCallback(callbackCtx(`seq:start:${row.id}`, log));
  const active = getSalesSequenceByThread("t-bump")!;
  assert(active.current_step === 2, "the sequence starts at step 2");
  const steps = listSalesSequenceSteps(row.id);
  assert(steps[0]!.status === "skipped" && steps[0]!.reason === "manual_followup", "his bump takes step 1");
  assert(steps.filter((step) => step.status === "planned").length === 3, "at most 3 more");
  assert(steps[1]!.scheduled_at !== null && steps[2]!.scheduled_at === null, "step 2 is next");
  assert(log.edits[0]?.includes("up to 3 more"), "the start message says how many");
}
{
  bumped("t-late-bump", "Cy <cy@omega.com>", "Pitch", 0);
  await runSequenceDetection(api);
  const row = getSalesSequenceByThread("t-late-bump")!;
  assert(row.manual_followups === 0, "no bump when the card went out");
  bumped("t-late-bump", "Cy <cy@omega.com>", "Pitch", 2);
  const log = { edits: [] as string[], replies: [] as string[] };
  await handleSequenceCallback(callbackCtx(`seq:start:${row.id}`, log));
  const active = getSalesSequenceByThread("t-late-bump")!;
  assert(active.manual_followups === 2 && active.current_step === 3, "Start recounts from the live thread");
}
{
  bumped("t-used-up", "Di <di@alpha.com>", "Pitch", 4);
  const before = telegram.sent.length;
  await runSequenceDetection(api);
  assert(telegram.sent.length === before, "four manual follow-ups means no card");
  assert(getSalesSequenceByThread("t-used-up") === undefined, "and no row");
  assert(
    (await requestSequenceCard("di@alpha.com", api)).includes("all 4 follow-ups"),
    "an explicit request gets the same refusal",
  );
  threads.delete("t-used-up");
}
{
  threads.set("t-self-notes", [
    { id: "n1", from: `V <${ME}>`, to: "Eli <eli@beta2.com>", subject: "Pitch", sentAt: Date.now() - 3 * DAY, sent: true },
  ]);
  await runSequenceDetection(api);
  assert(getSalesSequenceByThread("t-self-notes")!.manual_followups === 0, "the lone pitch counts as zero");
}

// ---- forwarded and non-owner paths ----
{
  let threw = false;
  try {
    await startSequenceFromTool("Priya", { userText: "start a sequence for Priya" }, api);
  } catch {
    threw = true;
  }
  assert(threw, "the tool refuses a turn without owner confirmation");

  pitch("t-tool", "Tia <tia@phi.com>", "Pitch");
  const confirmation = { chatId: 1, messageId: 5 };
  const sentBefore = telegram.sent.length;
  const vague = await startSequenceFromTool(
    "tia@phi.com",
    { confirmation, userText: "check in with Tia" },
    api,
  );
  assert(vague.startsWith("No card sent"), "a vague phrase gets no card even if the model calls the tool");
  assert(telegram.sent.length === sentBefore, "the vague phrase posted nothing");
  assert(getSalesSequenceByThread("t-tool") === undefined, "the vague phrase created no row");
  const clear = await startSequenceFromTool(
    "tia@phi.com",
    { confirmation, userText: "start a sequence for Tia" },
    api,
  );
  assert(clear.startsWith("Start card sent"), "a clear phrase shows the card");
  assert(getSalesSequenceByThread("t-tool")!.status === "proposed", "the tool never enrols");

  // The old tracker's phrasings now reach the same Start card.
  for (const phrase of [
    "follow up on my email to Tia",
    "Follow up on my last email to tia@phi.com",
    "follow up on the email I sent Tia",
    "Follow up with Tia on my email",
    "Remind me to follow up with Tia",
    "remind me to follow up with Tia on Monday",
    "track my email to Tia",
  ]) {
    assert(isExplicitSequenceRequest(phrase), `"${phrase}" offers the Start card`);
  }
  for (const phrase of ["follow up with me tomorrow", "remind me to follow up with me on Friday", "remind me to email Tia"]) {
    assert(!isExplicitSequenceRequest(phrase), `"${phrase}" is not a sequence request`);
  }
  assert(isExplicitSequenceRequest("Follow up with Tia"), "\"Follow up with Tia\" offers the Start card");
  const remapped = await startSequenceFromTool(
    "tia@phi.com",
    { confirmation, userText: "follow up on my email to Tia" },
    api,
  );
  assert(remapped.startsWith("Start card sent"), `"follow up on my email to X" shows the card, got: ${remapped}`);
  assert(getSalesSequenceByThread("t-tool")!.status === "proposed", "and still enrols nothing");
  const reminded = await startSequenceFromTool(
    "tia@phi.com",
    { confirmation, userText: "remind me to follow up with Tia" },
    api,
  );
  assert(reminded.startsWith("Start card sent"), "\"remind me to follow up with X\" shows the card");

  const replies: string[] = [];
  pitch("t-fwd", "Fay <fay@rho.com>", "Pitch");
  await handleSequenceCommand({
    message: { forward_origin: { type: "user" } },
    match: "fay@rho.com",
    reply: async (text: string) => {
      replies.push(text);
      return {};
    },
  } as unknown as Context);
  assert(replies[0]?.includes("forwarded"), "a forwarded /sequence is refused");
  assert(getSalesSequenceByThread("t-fwd") === undefined, "a forwarded /sequence starts nothing");

  assert(
    !(FORWARDED_TOOLS as readonly string[]).includes("start_sequence"),
    "start_sequence stays out of FORWARDED_TOOLS",
  );
  assert((TOOL_ORDER as readonly string[]).includes("start_sequence"), "start_sequence is registered");
  assert(Boolean(tools.start_sequence), "start_sequence has a module");
}

// ---- schema guards ----
{
  const first = createProposedSalesSequence({
    threadId: "t-dup-a",
    prospectEmail: "dup@sigma.com",
    prospectDomain: "sigma.com",
    prospectKey: "dup@sigma.com",
    prospectName: "Dup",
    prospectCompany: "Sigma",
    subject: "A",
    originalMessageId: "a",
    originalSentAt: new Date().toISOString(),
    manualFollowups: 0,
    classifierConfidence: null,
    classifierReason: null,
  });
  const second = createProposedSalesSequence({
    threadId: "t-dup-b",
    prospectEmail: "dup@sigma.com",
    prospectDomain: "sigma.com",
    prospectKey: "dup@sigma.com",
    prospectName: "Dup",
    prospectCompany: "Sigma",
    subject: "B",
    originalMessageId: "b",
    originalSentAt: new Date().toISOString(),
    manualFollowups: 0,
    classifierConfidence: null,
    classifierReason: null,
  });
  const colleague = createProposedSalesSequence({
    threadId: "t-dup-c",
    prospectEmail: "other@sigma.com",
    prospectDomain: "sigma.com",
    prospectKey: "other@sigma.com",
    prospectName: "Other",
    prospectCompany: "Sigma",
    subject: "C",
    originalMessageId: "c",
    originalSentAt: new Date().toISOString(),
    manualFollowups: 0,
    classifierConfidence: null,
    classifierReason: null,
  });
  assert(first !== undefined && second === undefined, "the database allows one open sequence per person");
  assert(colleague !== undefined, "a colleague at the same company gets their own");
}

// ---- Stage 2 has no send path ----
assert(mailCalls.length === 0, `nothing touched a send or draft API: ${mailCalls.join(",")}`);
for (const file of ["src/sequences.ts", "src/sequence_logic.ts", "src/tools/start_sequence.ts"]) {
  const src = await readFile(file, "utf8");
  assert(!src.includes("messages.send"), `${file} must not call messages.send`);
  assert(!src.includes("drafts."), `${file} must not touch drafts`);
}
{
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  pitch("t-log", "Secret Name <secret@tau.com>", "Secret subject");
  threads.get("t-log")![0]!.body = "secret body";
  await runSequenceDetection(api);
  console.log = original;
  const joined = logs.join("\n");
  assert(!/secret/i.test(joined), "logs carry no names, addresses, subjects or bodies");
}

setGoogleAccountForTests(undefined);
setGmailClientForTests(undefined);
setCompleteForTests(undefined);
console.log("test-sequences: ok");
