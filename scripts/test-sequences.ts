import "dotenv/config";
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Context } from "grammy";
import type { gmail_v1 } from "googleapis";
import { fakeTelegramApi, type TelegramLog } from "./fakes.ts";
import {
  addSalesDoNotContact,
  claimCommandSend,
  createPendingAction,
  createProposedSalesSequence,
  getSalesSequenceByThread,
  createAccount,
  listSalesSequenceSteps,
  migrateSalesSequenceLimits,
  recordCommandSendSent,
  salesSequenceStepCap,
  setCommandSendTelegramMessage,
  setPendingActionSentMessage,
  setPendingActionTelegramMessage,
  setSalesSequenceStepCapForTests,
  stopProposedSalesSequence,
  transitionPendingAction,
  upsertMeetingThread,
} from "../src/db.ts";
import {
  commandIntents,
  parseSequenceCommand,
  sequenceTargets,
  type SequenceCommand,
} from "../src/command_intent.ts";
import { bindRepliedMessageForTurn } from "../src/email_references.ts";
import { setGoogleAccountForTests, type LoadedGoogleAccount } from "../src/google/auth.ts";
import { setGmailClientForTests } from "../src/google/mail.ts";
import { setCompleteForTests, type CompleteResult } from "../src/llm.ts";
import { PERSONAL_DOMAINS } from "../src/meeting_book.ts";
import {
  countManualFollowups,
  EXCLUSION_LABELS,
  evaluatePitchExclusion,
  firstStepAt,
  hasOriginalOutreach,
  isExplicitSequenceRequest,
  matchesProspect,
  ownTeamCc,
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
    earlierTo: [],
    earlierCc: [],
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
  ["only a colleague in To, prospect on Cc", facts({ to: [mailbox("sam@epicode.in")], cc: [mailbox("priya@acme.com")] }), env(), "colleague_on_email"],
  ["colleague in To, another colleague on Cc", facts({ to: [mailbox("priya@acme.com"), mailbox("sam@epicode.in")], cc: [mailbox("lee@epicode.in")] }), env(), "colleague_on_email"],
  ["colleagues only, To and Cc", facts({ to: [mailbox("sam@epicode.in")], cc: [mailbox("lee@epicode.in")] }), env(), "no_external_recipient"],
  ["partner in To, colleague on Cc", facts({ to: [mailbox("a@pinnacle.in")], cc: [mailbox("sam@epicode.in")] }), env(), "partner_or_self_domain"],
  ["partner on Cc", facts({ cc: [mailbox("pia@pinnacle.in")] }), env(), "external_cc"],
  ["supertron partner on Cc", facts({ cc: [mailbox("ravi@supertroninfotech.com")] }), env(), "external_cc"],
  ["colleague and partner on Cc", facts({ cc: [mailbox("sam@epicode.in"), mailbox("pia@pinnacle.in")] }), env(), "external_cc"],
  ["colleague on Cc wrote on the thread", facts({ cc: [mailbox("sam@epicode.in")], threadSenders: ["sam@epicode.in"] }), env(), "other_sender"],
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
  ["earlier others", facts({ earlierTo: ["raj@acme.com"] }), env(), "other_recipient_in_thread"],
  ["earlier external on Cc", facts({ earlierCc: ["raj@acme.com"] }), env(), "other_recipient_in_thread"],
  ["partner on Cc of an earlier email", facts({ earlierCc: ["pia@pinnacle.in"] }), env(), "other_recipient_in_thread"],
  ["colleague in To of an earlier email", facts({ earlierTo: ["sam@epicode.in"] }), env(), "other_recipient_in_thread"],
  ["colleague in To earlier, Cc later", facts({ earlierTo: ["sam@epicode.in"], earlierCc: ["sam@epicode.in"] }), env(), "other_recipient_in_thread"],
  ["in sequence", facts(), env({ threadHasSequence: true }), "in_sequence"],
  ["open prospect", facts(), env({ prospectHasOpenSequence: () => true }), "prospect_in_sequence"],
  ["meeting flow", facts(), env({ threadInMeetingFlow: true }), "meeting_auto_scheduling"],
];
for (const [label, item, environment, expected] of cases) {
  const actual = evaluatePitchExclusion(item, environment);
  assert(actual === expected, `${label}: expected ${expected}, got ${actual}`);
}
// His own team on Cc (epicode.in colleagues, his own addresses) never blocks.
const ownTeamAllowed: Array<[string, PitchFacts]> = [
  ["colleague on Cc", facts({ cc: [mailbox("sam@epicode.in")] })],
  ["own address on Cc", facts({ cc: [mailbox("vishnu@gmail.example")] })],
  ["colleague and own address on Cc", facts({ cc: [mailbox("sam@epicode.in"), mailbox("vishnu@gmail.example")] })],
  ["two colleagues on Cc", facts({ cc: [mailbox("sam@epicode.in"), mailbox("lee@epicode.in")] })],
  ["colleague on Cc of an earlier email", facts({ earlierCc: ["sam@epicode.in"] })],
  ["colleague on Cc earlier and now", facts({ cc: [mailbox("sam@epicode.in")], earlierCc: ["sam@epicode.in"] })],
  ["prospect on an earlier email, colleague on its Cc", facts({ earlierTo: ["priya@acme.com"], earlierCc: ["sam@epicode.in"] })],
];
for (const [label, item] of ownTeamAllowed) {
  const actual = evaluatePitchExclusion(item, env());
  assert(actual === null, `${label}: expected it to be offerable, got ${actual}`);
}
{
  const self = new Set([ME, "vishnu@gmail.example"]);
  const cc = [
    mailbox("sam@epicode.in", "Sam"),
    mailbox("Lee@Epicode.in", "Lee"),
    mailbox("vishnu@gmail.example", "Vishnu"),
    mailbox(ME, "Vishnu"),
    mailbox("pia@pinnacle.in", "Pia"),
    mailbox("raj@acme.com", "Raj"),
    mailbox("sam@epicode.in", "Sam again"),
  ];
  const kept = ownTeamCc(cc, self, ME);
  assert(
    JSON.stringify(kept) === JSON.stringify(["sam@epicode.in", "lee@epicode.in", "vishnu@gmail.example"]),
    `own-team Cc keeps colleagues and his other addresses, drops the sender, externals and repeats: ${JSON.stringify(kept)}`,
  );
  assert(ownTeamCc([], self, ME).length === 0, "no Cc means none kept");
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
      get: async ({ id }: { id: string }) => {
        for (const [threadId, messages] of threads) {
          const found = messages.find((message) => message.id === id);
          if (found) {
            return { data: toGmailMessage(threadId, found) };
          }
        }
        throw new Error("no such message");
      },
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
pitch("t-colleague", "Raj <raj@beta.com>, Sam <sam@epicode.in>", "Dialer demo");
pitch("t-partner-cc", "Kim <kim@chi.com>", "IraVoice", 1, "Pia <pia@pinnacle.in>");
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
  assert(byThread.get("t-colleague")?.exclusion === "colleague_on_email", "colleague in To excluded");
  assert(byThread.get("t-partner-cc")?.exclusion === "external_cc", "partner on Cc excluded");
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

// ---- his own team on Cc: offered, enrolled, kept for follow-up 1 only ----
{
  const SELF_ALIAS = "vishnu.self@selftest.example";
  const previousSelf = process.env.SELF_EMAIL_ADDRESSES;
  process.env.SELF_EMAIL_ADDRESSES = SELF_ALIAS;
  const sent = (threadId: string, index: number, to: string, cc: string, daysAgo: number) => ({
    id: `${threadId}-m${index}`,
    from: `Vishnu Rajan <${ME}>`,
    to,
    cc,
    subject: index === 0 ? "IraVoice for Sigma" : "Re: IraVoice for Sigma",
    sentAt: Date.now() - daysAgo * DAY,
    sent: true,
  });
  const propose = (threadId: string, email: string, manual = 0) =>
    createProposedSalesSequence({
      threadId,
      prospectEmail: email,
      prospectDomain: email.split("@")[1]!,
      prospectKey: email,
      prospectName: "Gita Rao",
      prospectCompany: "Sigma",
      subject: "IraVoice for Sigma",
      originalMessageId: `${threadId}-m0`,
      originalSentAt: new Date().toISOString(),
      manualFollowups: manual,
      classifierConfidence: 0.9,
      classifierReason: "pitch",
    })!;

  threads.set("t-team-cc", [
    sent("t-team-cc", 0, "Gita Rao <gita@sigma2.com>", `Sam Iyer <sam@epicode.in>, Vishnu <${SELF_ALIAS}>`, 1),
  ]);
  threads.set("t-team-cc-bump", [
    sent("t-team-cc-bump", 0, "Hana <hana@sigma3.com>", "Sam Iyer <sam@epicode.in>", 3),
    sent("t-team-cc-bump", 1, "Hana <hana@sigma3.com>", "", 2),
  ]);
  threads.set("t-team-to-earlier", [
    sent("t-team-to-earlier", 0, "Sam Iyer <sam@epicode.in>", "", 3),
    sent("t-team-to-earlier", 1, "Ivy <ivy@sigma4.com>", "", 2),
  ]);
  threads.set("t-partner-cc-earlier", [
    sent("t-partner-cc-earlier", 0, "Jo <jo@sigma5.com>", "Pia <pia@pinnacle.in>", 3),
    sent("t-partner-cc-earlier", 1, "Jo <jo@sigma5.com>", "", 2),
  ]);
  const rows = await detectPitches({ lookbackDays: 21 });
  const byThread = new Map(rows.map((row) => [row.threadId, row]));
  assert(byThread.get("t-team-cc")?.exclusion === null, `a colleague on Cc is offerable, got ${byThread.get("t-team-cc")?.exclusion}`);
  assert(byThread.get("t-team-cc")?.prospect?.email === "gita@sigma2.com", "the prospect is the one in To");
  assert(byThread.get("t-team-cc-bump")?.exclusion === null, `a colleague on Cc of an earlier email is offerable, got ${byThread.get("t-team-cc-bump")?.exclusion}`);
  assert(byThread.get("t-team-to-earlier")?.exclusion === "other_recipient_in_thread", "a colleague in To of an earlier email still blocks");
  assert(byThread.get("t-partner-cc-earlier")?.exclusion === "other_recipient_in_thread", "a partner on Cc of an earlier email still blocks");

  // Start on the pitch with Sam and his own alias on Cc.
  const row = propose("t-team-cc", "gita@sigma2.com");
  const log = { edits: [] as string[], replies: [] as string[] };
  await handleSequenceCallback(callbackCtx(`seq:start:${row.id}`, log));
  const active = getSalesSequenceByThread("t-team-cc")!;
  assert(active.status === "active", `Start enrols with his own team on Cc: ${log.edits[0] ?? log.replies[0]}`);
  assert(active.prospect_email === "gita@sigma2.com", "the enrolled prospect is unchanged");
  const steps = listSalesSequenceSteps(row.id);
  assert(steps.length === 4, "four step rows exist");
  assert(steps[0]!.cc === `sam@epicode.in, ${SELF_ALIAS}`, `follow-up 1 keeps the colleague and his own address on Cc: ${steps[0]!.cc}`);
  assert(steps.slice(1).every((step) => step.cc === null), "follow-ups 2-4 have no Cc");

  // He bumped once himself: his bump took follow-up 1, so no sequence step has a Cc.
  const bumpRow = propose("t-team-cc-bump", "hana@sigma3.com", 1);
  await handleSequenceCallback(callbackCtx(`seq:start:${bumpRow.id}`, log));
  const bumped = getSalesSequenceByThread("t-team-cc-bump")!;
  assert(bumped.status === "active" && bumped.current_step === 2, "an earlier Cc does not block Start");
  const bumpSteps = listSalesSequenceSteps(bumpRow.id);
  assert(bumpSteps[0]!.status === "skipped", "his bump is follow-up 1");
  assert(bumpSteps.every((step) => step.cc === null), "the sequence never copies the colleague from follow-up 2 on");

  // A colleague moved into To before the tap: Start refuses.
  threads.set("t-team-to-now", [
    sent("t-team-to-now", 0, "Kai <kai@sigma6.com>", "Sam Iyer <sam@epicode.in>", 1),
  ]);
  const toRow = propose("t-team-to-now", "kai@sigma6.com");
  threads.get("t-team-to-now")!.push(
    sent("t-team-to-now", 1, "Kai <kai@sigma6.com>, Sam Iyer <sam@epicode.in>", "", 0.5),
  );
  const refusedLog = { edits: [] as string[], replies: [] as string[] };
  await handleSequenceCallback(callbackCtx(`seq:start:${toRow.id}`, refusedLog));
  const refusedRow = getSalesSequenceByThread("t-team-to-now")!;
  assert(refusedRow.status === "stopped" && refusedRow.stop_reason === "excluded:colleague_on_email", "a colleague in To still blocks Start");
  assert(refusedLog.edits[0]?.includes("a colleague is on the email"), "and says why");
  assert(listSalesSequenceSteps(toRow.id).length === 0, "no steps when Start is refused");

  if (previousSelf === undefined) {
    delete process.env.SELF_EMAIL_ADDRESSES;
  } else {
    process.env.SELF_EMAIL_ADDRESSES = previousSelf;
  }
}

// ---- Stage 2 has no send path ----
assert(mailCalls.length === 0, `nothing touched a send or draft API: ${mailCalls.join(",")}`);
for (const file of ["src/sequences.ts", "src/sequence_logic.ts", "src/tools/start_sequence.ts"]) {
  const src = await readFile(file, "utf8");
  assert(!src.includes("messages.send"), `${file} must not call messages.send`);
  assert(!src.includes("drafts."), `${file} must not touch drafts`);
}
// ---- follow-ups started by his own command: the words ----
{
  const parse = parseSequenceCommand;
  const direct = (words: string): Extract<SequenceCommand, { kind: "direct" }> => {
    const parsed = parse(words);
    assert(parsed.kind === "direct", `"${words}" is a direct command, got ${JSON.stringify(parsed)}`);
    return parsed as Extract<SequenceCommand, { kind: "direct" }>;
  };
  const one = direct("start a 3-step follow-up to Mayur, 4 days apart, asking for a demo");
  assert(
    one.followups === 3 && one.gapDays === 4 && one.cta === "ask for a demo" && !one.combined,
    `example 1: ${JSON.stringify(one)}`,
  );
  const two = direct("put my email to Mayur in a follow-up sequence, 5 follow-ups every 3 days, ask them to book a call");
  assert(
    two.followups === 5 && two.gapDays === 3 && two.cta === "ask them to book a call",
    `example 2: ${JSON.stringify(two)}`,
  );
  const plain = direct("start a sequence for Mayur");
  assert(
    plain.followups === 3 && plain.gapDays === null && plain.cta === null,
    "defaults: 3 follow-ups, the default gap, the ask inferred from his email",
  );
  for (const [words, followups, gap] of [
    ["start follow-ups for Mayur", 3, null],
    ["set up 2 follow-ups for Mayur every day", 2, 1],
    ["auto follow up with Mayur every other day", 3, 2],
    ["follow up Mayur 4 times, a week apart", 4, 7],
    ["start six follow-ups to Mayur every 14 days", 6, 14],
    ["add Mayur to the follow-up sequence, one follow-up", 1, null],
    ["Start 1 follow-up to Mayur, 1 day apart", 1, 1],
  ] as const) {
    const parsed = direct(words);
    assert(parsed.followups === followups && parsed.gapDays === gap, `"${words}": ${JSON.stringify(parsed)}`);
  }
  for (const [words, text] of [
    ["start 7 follow-ups to Mayur", "Not started: follow-ups can be 1 to 6."],
    ["start 0 follow-ups to Mayur", "Not started: follow-ups can be 1 to 6."],
    ["start ten follow-ups to Mayur", "Not started: follow-ups can be 1 to 6."],
    ["start 3 follow-ups to Mayur every 15 days", "Not started: the gap can be 1 to 14 days."],
    ["start 3 follow-ups to Mayur, 0 days apart", "Not started: the gap can be 1 to 14 days."],
    ["start 3 follow-ups to Mayur every 3 weeks", "Not started: the gap can be 1 to 14 days."],
  ] as const) {
    const parsed = parse(words);
    assert(parsed.kind === "refused" && parsed.text === text, `"${words}" is refused in one line, got ${JSON.stringify(parsed)}`);
  }
  for (const words of [
    "follow up with Mayur",
    "remind me to follow up with Mayur",
    "track my email to Mayur",
    "follow up on my email to Mayur",
    "offer a follow-up sequence for Mayur",
  ]) {
    assert(parse(words).kind === "soft", `"${words}" keeps the Start card, got ${parse(words).kind}`);
  }
  for (const words of [
    "don't start the sequence yet for Mayur",
    "start 3 follow-ups for Mayur, but not yet",
    "no follow-ups for Mayur",
    "email Mayur saying hi, no follow-ups",
    "hold off on the follow-ups for Mayur",
    "start follow-ups for Mayur later",
    "don't auto follow up with Mayur",
  ]) {
    assert(parse(words).kind === "negated", `"${words}" enrols nothing, got ${parse(words).kind}`);
  }
  // Send then enrol: only the trailing clause sets anything, never the body.
  const combined = direct("email Mayur saying we offer 5 plans every 3 days and set up 2 follow-ups every 4 days asking for a demo");
  assert(
    combined.combined && combined.followups === 2 && combined.gapDays === 4 && combined.cta === "ask for a demo",
    `combined: ${JSON.stringify(combined)}`,
  );
  assert(
    combined.emailPart === "email Mayur saying we offer 5 plans every 3 days",
    `the email part ends where the follow-up clause starts: ${combined.emailPart}`,
  );
  const bodyNumbers = direct("email Mayur saying we offer 5 plans, valid for 10 days, and start follow-ups");
  assert(
    bodyNumbers.combined && bodyNumbers.followups === 3 && bodyNumbers.gapDays === null,
    `numbers in the dictated body are never settings: ${JSON.stringify(bodyNumbers)}`,
  );
  const sendIt = direct("send it and start 3 follow-ups");
  assert(sendIt.combined && sendIt.followups === 3, "\"send it and start 3 follow-ups\" sends, then enrols");
  // E: follow-up words inside a dictated body are not a command.
  const body = parse("email Mayur saying we'll call and set up 3 follow-up meetings");
  assert(body.kind === "none" && body.mentionsFollowups, `a body's follow-up words start nothing: ${JSON.stringify(body)}`);
  const bodyKinds = commandIntents("email Mayur saying we'll call and set up 3 follow-up meetings");
  assert(bodyKinds.includes("send") && !bodyKinds.includes("sequence"), `it is a send, not a sequence: ${bodyKinds}`);
  const both = commandIntents("email Mayur saying we're live and set up 3 follow-ups");
  assert(both.includes("send") && both.includes("sequence"), `a send then enrol keeps both commands: ${both}`);
  assert(
    commandIntents("start a 3-step follow-up to Mayur, 4 days apart, asking for a demo").join(",") === "sequence",
    "a pure follow-up command is a sequence",
  );
  assert(commandIntents("put my email to Mayur in a follow-up sequence").includes("sequence"), "put ... in a follow-up sequence");
  const thisEmail = direct("put this email in a follow up sequence");
  assert(thisEmail.thisEmail && thisEmail.followups === 3 && !thisEmail.combined, "put this email in a follow-up sequence");
  assert(direct("add this to follow-ups").thisEmail, "add this to follow-ups");
  for (const words of [
    "start a follow-up call with Mayur",
    "set up a follow-up meeting with Mayur",
    "add a note to the follow-up email",
    "send a follow-up to Mayur",
  ]) {
    assert(parse(words).kind !== "direct", `"${words}" is not a follow-up sequence command`);
  }
  for (const [words, name] of [
    ["start a 3-step follow-up to Mayur, 4 days apart, asking for a demo", "Mayur"],
    ["put my email to Mayur in a follow-up sequence, 5 follow-ups every 3 days, ask them to book a call", "Mayur"],
    ["set up 3 follow-ups for Mayur Galande every 2 days", "Mayur Galande"],
    ["start follow-ups for Mayur", "Mayur"],
    ["add Mayur to follow-ups", "Mayur"],
    ["follow up Mayur 4 times, a week apart", "Mayur"],
  ] as const) {
    const targets = sequenceTargets(words);
    assert(targets?.join("|") === name, `"${words}" names ${name}, got ${targets}`);
  }
}

// ---- the startup rebuild: wider limits, the same rows, never a crash ----
const OLD_SALES_SCHEMA = `
  CREATE TABLE sales_sequences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    account TEXT NOT NULL DEFAULT 'work' CHECK (account = 'work'),
    prospect_email TEXT NOT NULL,
    prospect_domain TEXT NOT NULL,
    prospect_key TEXT NOT NULL,
    prospect_name TEXT NOT NULL DEFAULT '',
    prospect_company TEXT NOT NULL DEFAULT '',
    prospect_timezone TEXT,
    subject TEXT NOT NULL DEFAULT '',
    original_message_id TEXT NOT NULL,
    original_sent_at TEXT NOT NULL,
    status TEXT NOT NULL
      CHECK (status IN ('proposed', 'active', 'stopped', 'completed')),
    stop_reason TEXT,
    current_step INTEGER NOT NULL DEFAULT 1 CHECK (current_step BETWEEN 1 AND 4),
    steps_sent INTEGER NOT NULL DEFAULT 0 CHECK (steps_sent BETWEEN 0 AND 4),
    manual_followups INTEGER NOT NULL DEFAULT 0 CHECK (manual_followups BETWEEN 0 AND 3),
    original_ask TEXT CHECK (original_ask IN ('demo', 'partnership_call', 'meeting')),
    next_step_at TEXT,
    enrolled_at TEXT,
    classifier_confidence REAL,
    classifier_reason TEXT,
    card_message_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (account, thread_id)
  );
  CREATE UNIQUE INDEX idx_sales_sequences_open_prospect
    ON sales_sequences (prospect_key)
    WHERE status IN ('proposed', 'active');
  CREATE TABLE sales_sequence_steps (
    sequence_id INTEGER NOT NULL REFERENCES sales_sequences (id),
    step_no INTEGER NOT NULL CHECK (step_no BETWEEN 1 AND 4),
    scheduled_at TEXT,
    draft_text TEXT,
    check_result TEXT,
    status TEXT NOT NULL DEFAULT 'planned'
      CHECK (status IN ('planned', 'sending', 'sent', 'blocked', 'skipped')),
    sent_message_id TEXT,
    sent_at TEXT,
    reason TEXT,
    draft_id TEXT,
    claimed_at TEXT,
    blocked_at TEXT,
    waiting_ping_at TEXT,
    slot_lines TEXT,
    PRIMARY KEY (sequence_id, step_no)
  );
  CREATE INDEX idx_sales_sequence_steps_sent_message
    ON sales_sequence_steps (sent_message_id);
  ALTER TABLE sales_sequences ADD COLUMN prospect_timezone_source TEXT;
  ALTER TABLE sales_sequence_steps ADD COLUMN cc TEXT;
`;

function oldSalesDatabase(file = ":memory:"): Database.Database {
  const handle = new Database(file);
  handle.pragma("foreign_keys = ON");
  handle.exec(OLD_SALES_SCHEMA);
  const insert = handle.prepare(
    `INSERT INTO sales_sequences (thread_id, prospect_email, prospect_domain, prospect_key, prospect_name,
       subject, original_message_id, original_sent_at, status, current_step, steps_sent, manual_followups,
       original_ask, next_step_at, enrolled_at, prospect_timezone, prospect_timezone_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run("th-a", "ann@a.example", "a.example", "ann@a.example", "Ann", "Pitch A", "ma", "2026-11-01T05:00:00.000Z",
    "active", 2, 1, 0, "demo", "2026-11-25T05:00:00.000Z", "2026-11-02T05:00:00.000Z", "Asia/Kolkata", "email");
  insert.run("th-b", "ben@b.example", "b.example", "ben@b.example", "Ben", "Pitch B", "mb", "2026-10-01T05:00:00.000Z",
    "completed", 4, 4, 0, null, null, "2026-10-02T05:00:00.000Z", null, null);
  const step = handle.prepare(
    `INSERT INTO sales_sequence_steps (sequence_id, step_no, scheduled_at, draft_text, status, sent_message_id, sent_at, cc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  step.run(1, 1, "2026-11-03T05:00:00.000Z", "Hi Ann", "sent", "s1", "2026-11-03T05:00:00.000Z", "sam@epicode.in");
  for (const stepNo of [2, 3, 4]) {
    step.run(1, stepNo, stepNo === 2 ? "2026-11-25T05:00:00.000Z" : null, null, "planned", null, null, null);
  }
  for (const stepNo of [1, 2, 3, 4]) {
    step.run(2, stepNo, null, `Hi Ben ${stepNo}`, "sent", `b${stepNo}`, "2026-10-05T05:00:00.000Z", null);
  }
  return handle;
}

function salesRows(handle: Database.Database): { sequences: Array<Record<string, unknown>>; steps: Array<Record<string, unknown>> } {
  return {
    sequences: handle.prepare("SELECT * FROM sales_sequences ORDER BY id").all() as Array<Record<string, unknown>>,
    steps: handle.prepare("SELECT * FROM sales_sequence_steps ORDER BY sequence_id, step_no").all() as Array<Record<string, unknown>>,
  };
}

function sameOldColumns(before: Array<Record<string, unknown>>, after: Array<Record<string, unknown>>): boolean {
  return before.length === after.length &&
    before.every((row, index) => Object.keys(row).every((column) => row[column] === after[index]![column]));
}

function tableSql(handle: Database.Database, name: string): string {
  return (handle.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as { sql: string } | undefined)?.sql ?? "";
}

{
  const handle = oldSalesDatabase();
  const before = salesRows(handle);
  assert(migrateSalesSequenceLimits(handle) === "rebuilt", "an old database is rebuilt");
  const after = salesRows(handle);
  assert(sameOldColumns(before.sequences, after.sequences), "every sequence row is unchanged");
  assert(sameOldColumns(before.steps, after.steps), "every step row is unchanged, Cc included");
  assert(
    after.sequences.every((row) => row.total_steps === 4 && row.step_days === null && row.cta === null && row.command_key === null),
    "old sequences keep 4 steps, the default gap and the inferred ask",
  );
  assert(tableSql(handle, "sales_sequence_steps").includes("step_no BETWEEN 1 AND 9"), "steps now go up to 9");
  assert(tableSql(handle, "sales_sequences").includes("current_step BETWEEN 1 AND 9"), "and so does the current step");
  assert((handle.pragma("foreign_key_check") as unknown[]).length === 0, "foreign keys hold");
  assert(handle.pragma("integrity_check", { simple: true }) === "ok", "integrity holds");
  assert(handle.pragma("foreign_keys", { simple: true }) === 1, "foreign keys are back on");
  assert(
    (handle.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_sales_%' ORDER BY name").all() as Array<{ name: string }>)
      .map((row) => row.name).join(",") === "idx_sales_sequence_steps_sent_message,idx_sales_sequences_open_prospect",
    "both indexes are back",
  );
  let blocked = false;
  try {
    handle.prepare("INSERT INTO sales_sequence_steps (sequence_id, step_no, status) VALUES (999, 1, 'planned')").run();
  } catch {
    blocked = true;
  }
  assert(blocked, "a step for a missing sequence is still refused");
  handle.prepare("INSERT INTO sales_sequence_steps (sequence_id, step_no, status) VALUES (1, 9, 'planned')").run();
  assert(migrateSalesSequenceLimits(handle) === "skipped", "a rebuilt database is left alone");
  handle.close();
}

async function quietErrors<T>(run: () => T | Promise<T>): Promise<{ value: T; errors: string[] }> {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...items: unknown[]) => errors.push(items.join(" "));
  try {
    return { value: await run(), errors };
  } finally {
    console.error = original;
  }
}

{
  // Fails before anything changes: the work table's name is taken.
  const handle = oldSalesDatabase();
  handle.exec("CREATE TABLE sales_sequences_rebuild (x TEXT)");
  const before = salesRows(handle);
  const { value, errors } = await quietErrors(() => migrateSalesSequenceLimits(handle));
  assert(value === "failed", "a blocked rebuild reports failure");
  assert(errors.length === 1 && /rebuild failed/i.test(errors[0]!) && /capped at 4/.test(errors[0]!), `one clear error line, got ${JSON.stringify(errors)}`);
  assert(tableSql(handle, "sales_sequence_steps").includes("step_no BETWEEN 1 AND 4"), "the old schema stays");
  const after = salesRows(handle);
  assert(JSON.stringify(after) === JSON.stringify(before), "nothing changed");
  assert(handle.pragma("foreign_keys", { simple: true }) === 1, "foreign keys are back on after a failure");
  handle.close();
}

{
  // Fails at the very end, after the old tables were dropped: everything rolls back.
  const handle = oldSalesDatabase();
  handle.pragma("foreign_keys = OFF");
  handle.prepare("INSERT INTO sales_sequence_steps (sequence_id, step_no, status) VALUES (999, 1, 'planned')").run();
  handle.pragma("foreign_keys = ON");
  const before = salesRows(handle);
  const { value, errors } = await quietErrors(() => migrateSalesSequenceLimits(handle));
  assert(value === "failed" && errors.length === 1, "a foreign-key problem fails the rebuild with one line");
  assert(tableSql(handle, "sales_sequences").includes("current_step BETWEEN 1 AND 4"), "the old sequences table is back");
  assert(tableSql(handle, "sales_sequence_steps").includes("step_no BETWEEN 1 AND 4"), "the old steps table is back");
  assert(tableSql(handle, "sales_sequences_rebuild") === "" && tableSql(handle, "sales_sequence_steps_rebuild") === "", "no work tables are left");
  assert(JSON.stringify(salesRows(handle)) === JSON.stringify(before), "every row is as it was");
  handle.close();
}

{
  // The app itself starts on a database whose rebuild fails, and caps at 4.
  const dir = mkdtempSync(join(tmpdir(), "aadi-rebuild-"));
  try {
    const file = join(dir, "aadi.db");
    const handle = oldSalesDatabase(file);
    handle.exec("CREATE TABLE sales_sequences_rebuild (x TEXT)");
    handle.close();
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "-e", "import('./src/db.ts').then((m) => { console.log('CAP=' + m.salesSequenceStepCap() + ' ROWS=' + m.listActiveSalesSequences().length); })"],
      { env: { ...process.env, AADI_DB_PATH: file }, encoding: "utf8" },
    );
    assert(child.status === 0, `startup continues after a failed rebuild, exit ${child.status}: ${child.stderr}`);
    assert(child.stdout.includes("CAP=4 ROWS=1"), `it runs capped at 4 with its rows: ${child.stdout}`);
    const lines = child.stderr.split("\n").filter((line) => /rebuild failed/i.test(line));
    assert(lines.length === 1, `one error line at startup, got ${JSON.stringify(lines)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
assert(salesSequenceStepCap() === 9, "a fresh database allows 9 steps");

// ---- follow-ups started by his own command: enrolment ----
{
  let ownMessage = 300;
  const owner = (userText: string, messageId = ++ownMessage) => ({
    confirmation: { chatId: 1, messageId },
    userText,
    ownTurn: true,
  });
  const sentBefore = telegram.sent.length;
  pitch("t-cmd", "Mayur Galande <mayur@caia.example>", "IraVoice for Caia", 1);
  const turn = owner("start a 3-step follow-up to Mayur, 4 days apart, asking for a demo");
  const reply = await startSequenceFromTool("Mayur", turn, api);
  assert(
    reply.startsWith("Started 3 follow-ups to Mayur Galande (mayur@caia.example), every 4 days, CTA: ask for a demo. First one goes "),
    `the reply says exactly what was set, got: ${reply}`,
  );
  assert(telegram.sent.length === sentBefore, "no Start card");
  const row = getSalesSequenceByThread("t-cmd")!;
  assert(
    row.status === "active" && row.total_steps === 3 && row.step_days === 4 && row.cta === "ask for a demo",
    `enrolled with his settings: ${JSON.stringify(row)}`,
  );
  assert(row.command_key === `msg:1:${turn.confirmation.messageId}`, "keyed to his message");
  const steps = listSalesSequenceSteps(row.id);
  assert(steps.length === 3 && steps.every((step) => step.status === "planned"), "three planned steps");
  const pitchAt = threads.get("t-cmd")![0]!.sentAt;
  assert(
    new Date(row.next_step_at!).getTime() === Math.max(pitchAt + 4 * DAY, new Date(row.enrolled_at!).getTime()) ||
      Math.abs(new Date(row.next_step_at!).getTime() - (pitchAt + 4 * DAY)) < 5_000,
    "the first follow-up is 4 days after his email",
  );

  // C: the model's call and the command-guarantee fallback run on the same message.
  const again = await startSequenceFromTool("Mayur Galande", turn, api);
  assert(again === reply, `the second run reports the same start, got: ${again}`);
  assert(listSalesSequenceSteps(row.id).length === 3, "and creates no more steps");
  assert(
    [...threads.keys()].filter((id) => getSalesSequenceByThread(id)?.prospect_email === "mayur@caia.example").length === 1,
    "one sequence for Mayur",
  );
  const later = await startSequenceFromTool("Mayur", owner("start a 3-step follow-up to Mayur"), api);
  assert(later.startsWith("Not started"), `a new message for the same person is refused, got: ${later}`);

  pitch("t-cmd-default", "Neeraja <neeraja@nu.example>", "Pitch for Nia", 1);
  const plain = await startSequenceFromTool("Neeraja", owner("start a sequence for Neeraja"), api);
  assert(
    plain.startsWith("Started 3 follow-ups to Neeraja (neeraja@nu.example), every 2 days, CTA: same ask as your email. First one goes "),
    `defaults are said plainly, got: ${plain}`,
  );
  const niaRow = getSalesSequenceByThread("t-cmd-default")!;
  assert(niaRow.total_steps === 3 && niaRow.step_days === null && niaRow.cta === null, "defaults stored as defaults");

  // Not his own turn (a delegated goal, a workflow): the Start card, as before.
  pitch("t-cmd-deleg", "Olufemi <olufemi@omicron.example>", "Pitch for Olufemi", 1);
  const delegated = await startSequenceFromTool(
    "Olufemi",
    { confirmation: { chatId: 1, messageId: ++ownMessage }, userText: "start 3 follow-ups for Olufemi" },
    api,
  );
  assert(delegated.startsWith("Start card sent"), `a delegated call only offers the card, got: ${delegated}`);
  assert(getSalesSequenceByThread("t-cmd-deleg")!.status === "proposed", "and enrols nothing");

  // Soft phrasings keep the card even on his own turn.
  pitch("t-cmd-soft", "Pamposh <pamposh@pi3.example>", "Pitch for Pamposh", 1);
  const soft = await startSequenceFromTool("Pamposh", owner("remind me to follow up with Pamposh"), api);
  assert(soft.startsWith("Start card sent") && getSalesSequenceByThread("t-cmd-soft")!.status === "proposed", "soft phrasing: card");

  // Stop words and out-of-range settings enrol nothing.
  pitch("t-cmd-stop", "Quintus <quintus@qu.example>", "Pitch for Quintus", 1);
  const stopped = await startSequenceFromTool("Quintus", owner("don't start the sequence yet for Quintus"), api);
  assert(stopped === "Not started: you said not to start follow-ups.", `stop words win, got: ${stopped}`);
  const tooMany = await startSequenceFromTool("Quintus", owner("start 7 follow-ups to Quintus"), api);
  assert(tooMany === "Not started: follow-ups can be 1 to 6.", `one line naming the limit, got: ${tooMany}`);
  const tooFar = await startSequenceFromTool("Quintus", owner("start 2 follow-ups to Quintus every 20 days"), api);
  assert(tooFar === "Not started: the gap can be 1 to 14 days.", `gap limit, got: ${tooFar}`);
  assert(getSalesSequenceByThread("t-cmd-stop") === undefined, "nothing was created for Quintus");

  // The newest email decides. If it's excluded, say why; never fall back to an older one.
  pitch("t-cmd-old", "Rayyan <rayyan@rho2.example>", "Old pitch", 10);
  pitch("t-cmd-new", "Rayyan <rayyan@rho2.example>", "New pitch", 1, "Rajiv <rajiv@rho2.example>");
  const newest = await startSequenceFromTool("Rayyan", owner("start follow-ups for Rayyan"), api);
  assert(
    newest === `Not started for rayyan@rho2.example ('New pitch'): ${EXCLUSION_LABELS.external_cc}.`,
    `the newest email's reason, got: ${newest}`,
  );
  assert(!getSalesSequenceByThread("t-cmd-old") && !getSalesSequenceByThread("t-cmd-new"), "no thread was enrolled");
  for (const [threadId, to, cc, label] of [
    ["t-cmd-partner", "Siobhan <siobhan@pinnacle.in>", "", "partner_or_self_domain"],
    ["t-cmd-colleague", "Tomasz <tomasz@tau2.example>, Sam <sam@epicode.in>", "", "colleague_on_email"],
    ["t-cmd-two", "Urvashi <urvashi@up.example>, Vikrant <vikrant@up.example>", "", "multiple_recipients"],
  ] as const) {
    pitch(threadId, to, `Pitch ${threadId}`, 1, cc);
    const first = to.split("<")[0]!.trim();
    const refused = await startSequenceFromTool(first, owner(`start 3 follow-ups for ${first}`), api);
    assert(refused.includes(EXCLUSION_LABELS[label]), `${label} still refuses with its reason, got: ${refused}`);
    assert(getSalesSequenceByThread(threadId)?.status !== "active", `${label}: nothing active`);
  }

  // A: a database still capped at 4 says so for more than 4.
  setSalesSequenceStepCapForTests(4);
  try {
    pitch("t-cmd-cap", "Wesley <wesley@we.example>", "Pitch for Wesley", 1);
    const capped = await startSequenceFromTool("Wesley", owner("start 5 follow-ups for Wesley"), api);
    assert(capped === "Not started: this database still caps follow-ups at 4.", `the cap is named, got: ${capped}`);
    assert(getSalesSequenceByThread("t-cmd-cap") === undefined, "nothing created");
    const four = await startSequenceFromTool("Wesley", owner("start 4 follow-ups for Wesley"), api);
    assert(four.startsWith("Started 4 follow-ups to Wesley"), `4 still fits, got: ${four}`);
  } finally {
    setSalesSequenceStepCapForTests(undefined);
  }

  // Replying to an Aadi message about an email: that message only says which email.
  const draftCard = createPendingAction("d-unsent", null, "work");
  setPendingActionTelegramMessage(draftCard.id, 7001);
  const unsentTurn = owner("put this email in a follow up sequence");
  bindRepliedMessageForTurn(1, unsentTurn.confirmation.messageId, 7001);
  const unsent = await startSequenceFromTool("this email", unsentTurn, api);
  assert(
    unsent === "That draft isn't sent yet. Say 'send it and start follow-ups' or send it first.",
    `an unsent draft enrols nothing, got: ${unsent}`,
  );

  pitch("t-sent-cmd", "Umaima <umaima@upsilon.example>", "Hello Umaima", 0);
  claimCommandSend({ key: "msg:1:150:umaima@upsilon.example", account: "work", threadId: null });
  recordCommandSendSent("msg:1:150:umaima@upsilon.example", "t-sent-cmd-m1");
  setCommandSendTelegramMessage("msg:1:150:umaima@upsilon.example", 7002);
  const sentTurn = owner("add this to follow-ups");
  bindRepliedMessageForTurn(1, sentTurn.confirmation.messageId, 7002);
  const fromSent = await startSequenceFromTool("this email", sentTurn, api);
  assert(fromSent.startsWith("Started 3 follow-ups to Umaima (umaima@upsilon.example)"), `a sent email is enrolled, got: ${fromSent}`);
  assert(getSalesSequenceByThread("t-sent-cmd")!.status === "active", "on that email's thread");

  pitch("t-sent-draft", "Valtteri <valtteri@vee.example>", "Hello Valtteri", 0);
  const sentCard = createPendingAction("d-sent", null, "work");
  setPendingActionTelegramMessage(sentCard.id, 7003);
  transitionPendingAction(sentCard.id, "pending", "sent");
  setPendingActionSentMessage(sentCard.id, "t-sent-draft-m1");
  const draftTurn = owner("put this email in a follow-up sequence, 2 follow-ups");
  bindRepliedMessageForTurn(1, draftTurn.confirmation.messageId, 7003);
  const fromDraft = await startSequenceFromTool("this email", draftTurn, api);
  assert(fromDraft.startsWith("Started 2 follow-ups to Valtteri (valtteri@vee.example)"), `a sent draft card is enrolled, got: ${fromDraft}`);

  const unknownTurn = owner("add this to follow-ups");
  bindRepliedMessageForTurn(1, unknownTurn.confirmation.messageId, 9999);
  const unknown = await startSequenceFromTool("this email", unknownTurn, api);
  assert(unknown.startsWith("Not started: I can't tell which email that message is about."), `unknown message, got: ${unknown}`);

  // Send then enrol never enrols from start_sequence alone: the send does it.
  pitch("t-cmd-combined", "Xiaoming <xiaoming@xi.example>", "Pitch for Xiaoming", 1);
  const early = await startSequenceFromTool("Xiaoming", owner("email Xiaoming saying hi and start 3 follow-ups"), api);
  assert(early === "Not started yet: follow-ups start only once the email has gone out.", `got: ${early}`);
  assert(getSalesSequenceByThread("t-cmd-combined") === undefined, "nothing enrolled before the send");
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
