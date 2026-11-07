import "dotenv/config";
import type { Api, Context } from "grammy";
import type { gmail_v1 } from "googleapis";
import { setApprovalsTestHooks } from "../src/approvals.ts";
import { config } from "../src/config.ts";
import {
  activateSalesSequence,
  addSalesDoNotContact,
  createAccount,
  createFollowup,
  createMeetingProposal,
  createPendingEventAction,
  createProposedSalesSequence,
  getMeetingThread,
  getPromiseByMessageId,
  getSalesSequence,
  getSalesSequenceStep,
  isSalesDoNotContact,
  listActiveSalesSequences,
  setSalesSequenceTimezone,
  stopActiveSalesSequence,
} from "../src/db.ts";
import {
  activeFollowups,
  collectCandidates,
  createFollowupDraftForApproval,
  dueFollowupsNow,
} from "../src/followups.ts";
import { setGoogleAccountForTests, type LoadedGoogleAccount } from "../src/google/auth.ts";
import { setGmailClientForTests } from "../src/google/mail.ts";
import { setCompleteForTests, type CompleteParams, type CompleteResult } from "../src/llm.ts";
import {
  blockedAutoSendDomains,
  PERSONAL_DOMAINS,
  processInboundMeetingMessage,
  setMeetingTestHooks,
} from "../src/meeting_book.ts";
import { runPromiseScan } from "../src/promises.ts";
import { formatHealthReport, HEALTH_JOBS } from "../src/scheduler.ts";
import {
  evaluateSequenceSendGate,
  sendSequenceStep,
  SequenceSendRefusedError,
  type SequenceSendGateInput,
} from "../src/security/sequence_send.ts";
import { domainInSet, evaluatePitchExclusion, prospectKey } from "../src/sequence_logic.ts";
import {
  classifyInbound,
  evaluateStopRules,
  inSendWindow,
  matchSequencesForStop,
  nextSendWindow,
  outOfOfficeUntil,
  slotInProspectHours,
  topReplyText,
  type InboundFact,
} from "../src/sequence_rules.ts";
import {
  handleSequencesCommand,
  handleSequenceStopCallback,
  registerSequenceSend,
  runSequenceTick,
  sequencesPanel,
  setSequenceRunnerTestHooks,
  setSequenceTimezoneFromTool,
  stopSequenceFromTool,
} from "../src/sequence_runner.ts";
import {
  chooseProspectZone,
  LOCATION_SYSTEM,
  parseDateHeaderOffset,
  parseLocationGuess,
  slotDisplayZone,
  zoneDisplay,
  zoneForHeaderOffset,
  zoneFromWords,
  zoneLabel,
  zoneOffsetMinutes,
} from "../src/sequence_timezone.ts";
import { ASK_SYSTEM, offerSlots, prepareSequenceStep, SLOTS_TOKEN, WRITER_SYSTEM } from "../src/sequence_writer.ts";
import { handleSequenceCallback } from "../src/sequences.ts";
import { FORWARDED_TOOLS, TOOL_ORDER, tools } from "../src/tools/index.ts";
import { fakeTelegramApi } from "./fakes.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

if (process.env.AADI_DB_PATH !== ":memory:") {
  throw new Error("test-sequence-send.ts must run with AADI_DB_PATH=:memory:");
}

const log = console.log;
const quiet = process.env.TEST_VERBOSE ? log : () => undefined;
console.log = quiet;
console.error = quiet;

const ME = "vishnu.rajan@epicode.in";
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const settings = config as unknown as Record<string, unknown>;

// ---- a Gmail that answers the queries the runner really sends ----
interface Msg {
  id: string;
  threadId: string;
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  at: number;
  sent: boolean;
  body: string;
  messageId: string;
  references?: string;
  extra?: Record<string, string>;
}

const world = new Map<string, Msg[]>();
const drafts = new Map<string, { raw: string; threadId: string }>();
let idCounter = 0;
let clock = new Date();

function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function push(message: Omit<Msg, "id" | "messageId"> & { id?: string; messageId?: string }): Msg {
  const id = message.id ?? nextId("m");
  const full: Msg = { ...message, id, messageId: message.messageId ?? `<${id}@mail.example>` };
  world.set(full.threadId, [...(world.get(full.threadId) ?? []), full]);
  return full;
}

function toGmail(message: Msg): gmail_v1.Schema$Message {
  return {
    id: message.id,
    threadId: message.threadId,
    internalDate: String(message.at),
    labelIds: message.sent ? ["SENT"] : ["INBOX"],
    snippet: message.body.slice(0, 120),
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: message.from },
        { name: "To", value: message.to },
        { name: "Cc", value: message.cc ?? "" },
        { name: "Bcc", value: message.bcc ?? "" },
        { name: "Subject", value: message.subject },
        { name: "Message-ID", value: message.messageId },
        { name: "References", value: message.references ?? "" },
        ...Object.entries(message.extra ?? {}).map(([name, value]) => ({ name, value })),
      ].filter((item) => item.value !== ""),
      body: { data: Buffer.from(message.body, "utf8").toString("base64url") },
    },
  };
}

function allMessages(): Msg[] {
  return [...world.values()].flat();
}

function search(q: string): Msg[] {
  let items = allMessages();
  const after = /after:(\d+)/.exec(q);
  if (after) {
    const floor = Number(after[1]) * 1000;
    items = items.filter((item) => item.at >= floor);
  }
  const newer = /newer_than:(\d+)d/.exec(q);
  if (newer) {
    const floor = clock.getTime() - Number(newer[1]) * DAY;
    items = items.filter((item) => item.at >= floor);
  }
  if (q.includes("in:sent")) {
    items = items.filter((item) => item.sent);
  }
  if (q.includes("from:(mailer-daemon")) {
    const address = /"([^"]+)"/.exec(q)?.[1] ?? "";
    items = items.filter(
      (item) => /mailer-daemon|postmaster/i.test(item.from) && item.body.includes(address),
    );
  } else {
    const fromOrTo = /\(from:(\S+) OR to:([^)\s]+)\)/.exec(q);
    const from = /\bfrom:(\S+)/.exec(q);
    const to = /\(to:(\S+) OR/.exec(q);
    const quotedTo = /to:"([^"]+)"/.exec(q);
    if (fromOrTo) {
      items = items.filter(
        (item) => item.from.includes(fromOrTo[1]!) || item.to.includes(fromOrTo[2]!),
      );
    } else if (from) {
      items = items.filter((item) => !item.sent && item.from.toLowerCase().includes(from[1]!));
    } else if (to) {
      items = items.filter((item) =>
        [item.to, item.cc ?? "", item.bcc ?? ""].some((value) => value.toLowerCase().includes(to[1]!)),
      );
    } else if (quotedTo) {
      items = items.filter((item) => item.to.toLowerCase().includes(quotedTo[1]!.toLowerCase()));
    }
  }
  return items.sort((left, right) => right.at - left.at);
}

function parseRaw(raw: string): { headers: Record<string, string>; plain: string; text: string } {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const block = text.split("\r\n\r\n")[0] ?? "";
  const headers: Record<string, string> = {};
  for (const line of block.split("\r\n")) {
    const at = line.indexOf(":");
    if (at > 0) {
      headers[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim();
    }
  }
  const part = /Content-Type: text\/plain[^\r]*\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/.exec(text);
  const plain = Buffer.from((part?.[1] ?? "").replace(/\s/g, ""), "base64").toString("utf8");
  return { headers, plain, text };
}

type SendMode = "ok" | "deliver_then_throw" | "throw_no_deliver" | "reject_403" | "reject_400";
let sendMode: SendMode = "ok";
const sends: Array<{ threadId: string; raw: string; parsed: ReturnType<typeof parseRaw>; id: string }> = [];
let gmailCalls = 0;

function deliver(raw: string, threadId: string): Msg {
  const parsed = parseRaw(raw);
  return push({
    threadId,
    from: `Vishnu Rajan <${ME}>`,
    to: parsed.headers.to ?? "",
    cc: parsed.headers.cc,
    bcc: parsed.headers.bcc,
    subject: parsed.headers.subject ?? "",
    at: clock.getTime(),
    sent: true,
    body: parsed.plain,
    references: parsed.headers.references,
  });
}

const gmail = {
  users: {
    getProfile: async () => ({ data: { emailAddress: ME } }),
    settings: {
      sendAs: {
        list: async () => ({
          data: {
            sendAs: [
              { sendAsEmail: ME, isDefault: true, signature: "<div>Vishnu Rajan<br>GTM, Epicode</div>" },
            ],
          },
        }),
      },
    },
    threads: {
      get: async ({ id }: { id: string }) => ({
        data: { id, messages: (world.get(id) ?? []).map(toGmail) },
      }),
    },
    messages: {
      list: async ({ q }: { q: string }) => {
        gmailCalls += 1;
        return {
          data: { messages: search(q).map((item) => ({ id: item.id, threadId: item.threadId })) },
        };
      },
      get: async ({ id }: { id: string }) => {
        const found = allMessages().find((item) => item.id === id);
        if (!found) {
          throw new Error("no such message");
        }
        return { data: toGmail(found) };
      },
      send: async ({ requestBody }: { requestBody: { threadId: string; raw: string } }) => {
        if (sendMode === "throw_no_deliver") {
          throw new Error("socket hang up");
        }
        if (sendMode === "reject_403" || sendMode === "reject_400") {
          throw Object.assign(new Error("rejected"), {
            response: { status: sendMode === "reject_403" ? 403 : 400 },
          });
        }
        const message = deliver(requestBody.raw, requestBody.threadId);
        sends.push({
          threadId: requestBody.threadId,
          raw: requestBody.raw,
          parsed: parseRaw(requestBody.raw),
          id: message.id,
        });
        if (sendMode === "deliver_then_throw") {
          throw new Error("socket hang up");
        }
        return { data: { id: message.id } };
      },
    },
    drafts: {
      create: async ({ requestBody }: { requestBody: { message: { raw: string; threadId: string } } }) => {
        const id = nextId("draft");
        drafts.set(id, { raw: requestBody.message.raw, threadId: requestBody.message.threadId });
        return { data: { id } };
      },
      get: async ({ id }: { id: string }) => {
        const draft = drafts.get(id);
        if (!draft) {
          throw new Error("no such draft");
        }
        const parsed = parseRaw(draft.raw);
        return {
          data: {
            id,
            message: {
              threadId: draft.threadId,
              payload: {
                mimeType: "text/plain",
                headers: Object.entries(parsed.headers).map(([name, value]) => ({ name, value })),
                body: { data: Buffer.from(parsed.plain, "utf8").toString("base64url") },
              },
            },
          },
        };
      },
      update: async ({ id, requestBody }: { id: string; requestBody: { message: { raw: string; threadId: string } } }) => {
        drafts.set(id, { raw: requestBody.message.raw, threadId: requestBody.message.threadId });
        return { data: { id } };
      },
      send: async ({ requestBody }: { requestBody: { id: string } }) => {
        const draft = drafts.get(requestBody.id)!;
        const message = deliver(draft.raw, draft.threadId);
        draftSends.push({ id: requestBody.id, parsed: parseRaw(draft.raw), messageId: message.id });
        drafts.delete(requestBody.id);
        return { data: { id: message.id } };
      },
      delete: async ({ id }: { id: string }) => {
        drafts.delete(id);
        return { data: {} };
      },
    },
  },
} as unknown as gmail_v1.Gmail;

const draftSends: Array<{ id: string; parsed: ReturnType<typeof parseRaw>; messageId: string }> = [];

const workAccount = { id: "work", tag: "work", label: "work", client: {} } as unknown as LoadedGoogleAccount;
const personalAccount = { id: "personal", tag: "personal", label: "personal", client: {} } as unknown as LoadedGoogleAccount;

setGoogleAccountForTests((id) => (id === "work" ? workAccount : personalAccount));
setGmailClientForTests(() => gmail);

const telegram = { sent: [] as string[], edited: [] as string[] };
const api: Api = fakeTelegramApi(telegram);
setApprovalsTestHooks({ telegram: api, gmailFor: () => gmail });

let busy: Array<{ start: Date; end: Date }> = [];
setMeetingTestHooks({ loadBusy: async () => busy });

const calendar: Array<{ email: string }> = [];
setSequenceRunnerTestHooks({
  calendarEvents: async (email) =>
    calendar.filter((item) => item.email === email).map((item) => ({ attendees: [{ email: item.email }] })),
});

// ---- the models ----
const modelCalls: CompleteParams[] = [];
const NO_LOCATION = '{"timezone":"","basis":"none"}';
let locationAnswer = NO_LOCATION;
let writerBody: string | undefined;
let duringWrite: (() => void) | undefined;

function answer(text: string): CompleteResult {
  return {
    textParts: [text],
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "end_turn",
  } as CompleteResult;
}

function restoreModels(): void {
  setCompleteForTests(async (params: CompleteParams) => {
    modelCalls.push(params);
    const system = (params.system as { cacheable?: string }).cacheable ?? "";
    if (system === WRITER_SYSTEM) {
      duringWrite?.();
      const content = String((params.messages[0] as { content: unknown }).content);
      const first = /RECIPIENT: (\S+)/.exec(content)?.[1]?.replace(/,$/, "") ?? "there";
      const slots = content.includes(SLOTS_TOKEN);
      return answer(
        JSON.stringify({
          body:
            writerBody ??
            (slots
              ? `Hi ${first},\n\nJust a quick follow-up on a short demo.\n\n${SLOTS_TOKEN}\n\nDo any of these suit you?`
              : `Hi ${first},\n\nJust a quick follow-up on my earlier note. IraVoice answers inbound support calls in Hindi and English.\n\nWould a short demo next week work?`),
        }),
      );
    }
    if (system === LOCATION_SYSTEM) {
      return answer(locationAnswer);
    }
    if (system === ASK_SYSTEM) {
      return answer('{"ask":"demo"}');
    }
    if (system.includes("has_promise")) {
      return answer('{"has_promise":true,"promise":"send the deck","confidence":"high"}');
    }
    return answer('{"needs_followup":true,"reason":"Asked for a demo","importance":"high"}');
  });
}
restoreModels();

// ---- scenario helpers ----
function nextTuesdayMorning(): Date {
  const at = new Date(Date.now() + 2 * DAY);
  while (at.getUTCDay() !== 2) {
    at.setTime(at.getTime() + DAY);
  }
  at.setUTCHours(6, 0, 0, 0);
  return at;
}

clock = nextTuesdayMorning();

function nextScenario(): void {
  for (const row of listActiveSalesSequences()) {
    stopActiveSalesSequence(row.id, "test_cleanup");
  }
  clock = new Date(clock.getTime() + DAY);
  while (clock.getUTCDay() === 0 || clock.getUTCDay() === 6) {
    clock = new Date(clock.getTime() + DAY);
  }
  clock.setUTCHours(6, 0, 0, 0);
  sendMode = "ok";
  locationAnswer = NO_LOCATION;
  writerBody = undefined;
  duringWrite = undefined;
  busy = [];
  modelCalls.length = 0;
  telegram.sent.length = 0;
  telegram.edited.length = 0;
}

let enrolCounter = 0;

interface Enrolled {
  id: number;
  threadId: string;
  email: string;
  domain: string;
  pitch: Msg;
  first: string;
}

function enrol(options: {
  first?: string;
  email?: string;
  manual?: number;
  company?: string;
  timezone?: string;
} = {}): Enrolled {
  enrolCounter += 1;
  const first = options.first ?? "Priya";
  const domain = options.email ? options.email.split("@")[1]! : `co${enrolCounter}.example`;
  const email = options.email ?? `${first.toLowerCase()}@${domain}`;
  const threadId = `thread-${enrolCounter}`;
  const company = options.company ?? `Co${enrolCounter}`;
  const subject = `IraVoice for ${company}`;
  const pitch = push({
    threadId,
    from: `Vishnu Rajan <${ME}>`,
    to: `${first} Shah <${email}>`,
    subject,
    at: clock.getTime() - 3 * DAY,
    sent: true,
    body: `Hi ${first},\n\nEpicode builds IraVoice, which answers inbound support calls in Hindi and English.\n\nWould you be open to a short demo next week?\n\nThanks,\nVishnu`,
  });
  const manual = options.manual ?? 0;
  for (let index = 0; index < manual; index += 1) {
    push({
      threadId,
      from: `Vishnu Rajan <${ME}>`,
      to: `${first} Shah <${email}>`,
      subject: `Re: ${subject}`,
      at: clock.getTime() - 2.5 * DAY + index * MIN,
      sent: true,
      body: "Any thoughts on a short demo?",
    });
  }
  const row = createProposedSalesSequence({
    threadId,
    prospectEmail: email,
    prospectDomain: domain,
    prospectKey: prospectKey(email),
    prospectName: `${first} Shah`,
    prospectCompany: company,
    subject,
    originalMessageId: pitch.id,
    originalSentAt: new Date(pitch.at).toISOString(),
    manualFollowups: manual,
    classifierConfidence: 0.9,
    classifierReason: "pitch",
  })!;
  activateSalesSequence(row.id, {
    nextStepAt: new Date(clock.getTime() - MIN).toISOString(),
    enrolledAt: new Date(clock.getTime() - DAY).toISOString(),
    manualFollowups: manual,
  });
  if (options.timezone) {
    setSalesSequenceTimezone(row.id, options.timezone, "email");
  }
  return { id: row.id, threadId, email, domain, pitch, first };
}

function tick(at: Date = clock) {
  clock = at;
  return runSequenceTick(api, { now: at });
}

/** To the first send window on or after the sequence's next step. */
function whenDue(id: number): Date {
  return nextSendWindow(new Date(getSalesSequence(id)!.next_step_at!), getSalesSequence(id)!.prospect_timezone);
}

function after(ms: number): Date {
  return new Date(clock.getTime() + ms);
}

function reply(item: Enrolled, body: string, extra: Partial<Msg> = {}): Msg {
  return push({
    threadId: item.threadId,
    from: `${item.first} Shah <${item.email}>`,
    to: `Vishnu Rajan <${ME}>`,
    subject: `Re: IraVoice`,
    at: clock.getTime() - HOUR,
    sent: false,
    body,
    ...extra,
  });
}

const confirmation = { chatId: 1, messageId: 42 };

// ======== timezones and the send window (pure) ========
assert(parseDateHeaderOffset("Thu, 5 Nov 2026 10:00:00 -0500") === "-05:00", "reads a negative offset");
assert(parseDateHeaderOffset("Thu, 5 Nov 2026 10:00:00 +0530 (IST)") === "+05:30", "reads an offset before a comment");
assert(parseDateHeaderOffset("Thu, 5 Nov 2026 10:00:00 +0000") === "+00:00", "+0000 is read");
assert(parseDateHeaderOffset("Thu, 5 Nov 2026 10:00:00 -0000") === undefined, "-0000 is unknown by definition");
assert(parseDateHeaderOffset("Thu, 5 Nov 2026 10:00:00 GMT") === undefined, "a named zone is unknown");
assert(parseDateHeaderOffset("not a date") === undefined, "garbage is unknown");
assert(slotDisplayZone(null) === null && slotDisplayZone("+05:30") === null && slotDisplayZone("Asia/Kolkata") === null, "IST isn't shown twice");
assert(slotDisplayZone("-05:00") === "-05:00" && slotDisplayZone("America/Chicago") === "America/Chicago", "another zone is shown");

// Daylight saving comes from the zone, not a stored offset.
assert(zoneOffsetMinutes("America/New_York", new Date("2026-11-10T12:00:00Z")) === -300, "New York is UTC-5 in November");
assert(zoneOffsetMinutes("America/New_York", new Date("2026-07-10T12:00:00Z")) === -240, "and UTC-4 in July");
assert(zoneOffsetMinutes("Asia/Kolkata", new Date()) === 330 && zoneOffsetMinutes(null, new Date()) === 330, "IST, and unknown means IST");
assert(zoneOffsetMinutes("-07:00", new Date()) === -420, "a fixed offset is used as it is");
assert(zoneOffsetMinutes("Not/AZone", new Date()) === 330, "an invalid zone falls back to IST");

const ist = (value: string): Date => new Date(`${value}+05:30`);
const utc = (value: string): Date => new Date(`${value}Z`);
assert(inSendWindow(ist("2026-11-10T09:00:00"), null), "09:00 IST Tuesday is in the window");
assert(!inSendWindow(ist("2026-11-10T08:59:00"), null), "08:59 is before it");
assert(inSendWindow(ist("2026-11-10T16:59:00"), null), "16:59 is in it");
assert(!inSendWindow(ist("2026-11-10T17:00:00"), null), "17:00 is after it");
assert(!inSendWindow(ist("2026-11-14T11:00:00"), null), "Saturday is out");
assert(!inSendWindow(ist("2026-11-15T11:00:00"), null), "Sunday is out");
// US prospects get mail in their morning, whatever the hour in India.
const usZones: Array<[string, string, string]> = [
  ["America/New_York", "2026-11-10T14:00:00", "US Eastern"],
  ["America/Chicago", "2026-11-10T15:00:00", "US Central"],
  ["America/Denver", "2026-11-10T16:00:00", "US Mountain"],
  ["America/Phoenix", "2026-11-10T16:00:00", "US Mountain (Arizona)"],
  ["America/Los_Angeles", "2026-11-10T17:00:00", "US Pacific"],
  ["America/Anchorage", "2026-11-10T18:00:00", "Alaska"],
  ["Pacific/Honolulu", "2026-11-10T19:00:00", "Hawaii"],
];
for (const [zone, nineAm, label] of usZones) {
  assert(inSendWindow(utc(nineAm), zone), `09:00 in ${label} is in the window`);
  assert(!inSendWindow(new Date(utc(nineAm).getTime() - MIN), zone), `08:59 in ${label} is not`);
  assert(inSendWindow(new Date(utc(nineAm).getTime() + 8 * HOUR - MIN), zone), `16:59 in ${label} is in`);
  assert(!inSendWindow(new Date(utc(nineAm).getTime() + 8 * HOUR), zone), `17:00 in ${label} is out`);
  assert(
    nextSendWindow(ist("2026-11-10T11:00:00"), zone).getTime() === utc(nineAm).getTime(),
    `from 11:00 IST the next ${label} window opens at their 09:00`,
  );
  assert(zoneLabel(zone) === label, `${zone} is labelled ${label}`);
}
assert(inSendWindow(utc("2026-07-14T13:00:00"), "America/New_York"), "09:00 EDT in July is in, an hour earlier in UTC");
assert(!inSendWindow(utc("2026-11-10T13:00:00"), "America/New_York"), "the same UTC hour in November is 08:00 EST");
assert(inSendWindow(ist("2026-11-10T21:00:00"), "America/New_York"), "21:00 IST is 10:30 in New York: no IST floor");
assert(inSendWindow(ist("2026-11-10T21:00:00"), "-05:00"), "a fixed offset works the same");
assert(
  nextSendWindow(utc("2026-11-13T22:30:00"), "America/Los_Angeles").getTime() === utc("2026-11-13T22:30:00").getTime(),
  "Friday 14:30 Pacific is still in, though it's Saturday in India",
);
assert(
  nextSendWindow(utc("2026-11-14T01:00:00"), "America/Los_Angeles").getTime() === utc("2026-11-16T17:00:00").getTime(),
  "Friday evening Pacific rolls to Monday 09:00 Pacific",
);
assert(
  nextSendWindow(ist("2026-11-13T18:00:00"), null).getTime() === ist("2026-11-16T09:00:00").getTime(),
  "Friday evening rolls to Monday 09:00",
);
assert(
  nextSendWindow(ist("2026-11-10T08:00:00"), null).getTime() === ist("2026-11-10T09:00:00").getTime(),
  "early morning rolls to 09:00 the same day",
);
assert(
  nextSendWindow(ist("2026-11-10T11:00:00"), null).getTime() === ist("2026-11-10T11:00:00").getTime(),
  "a moment inside the window stays put",
);
assert(
  nextSendWindow(ist("2026-11-10T17:00:00"), "+05:45").getTime() === ist("2026-11-11T08:45:00").getTime(),
  "a quarter-hour zone opens on its own 09:00",
);

// Step 3 offers only times inside 09:00-18:00 on their weekday.
{
  const slot = (start: Date) => ({ start, end: new Date(start.getTime() + 20 * MIN) });
  assert(slotInProspectHours(slot(ist("2026-11-10T10:00:00")), "Asia/Kolkata"), "10:00 IST suits an Indian prospect");
  assert(slotInProspectHours(slot(utc("2026-11-10T09:00:00")), "Europe/London"), "09:00 London counts");
  assert(!slotInProspectHours(slot(utc("2026-11-10T08:59:00")), "Europe/London"), "08:59 London doesn't");
  assert(slotInProspectHours(slot(utc("2026-11-10T17:40:00")), "Europe/London"), "a slot ending at 18:00 counts");
  assert(!slotInProspectHours(slot(utc("2026-11-10T17:50:00")), "Europe/London"), "one running past 18:00 doesn't");
  assert(!slotInProspectHours(slot(ist("2026-11-10T18:00:00")), "America/New_York"), "18:00 IST is 07:30 in New York");
  assert(!slotInProspectHours(slot(utc("2026-11-14T10:00:00")), "Europe/London"), "their Saturday doesn't");
  assert(slotInProspectHours(slot(ist("2026-11-10T10:00:00")), null), "unknown means IST");
}

// The zone from a Date header, named when it matches a US or Indian zone that day.
assert(zoneForHeaderOffset("-05:00", utc("2026-11-10T15:00:00")) === "America/New_York", "-0500 in November is US Eastern");
assert(zoneForHeaderOffset("-05:00", utc("2026-07-10T15:00:00")) === "America/Chicago", "-0500 in July is US Central");
assert(zoneForHeaderOffset("-07:00", utc("2026-07-10T15:00:00")) === "America/Los_Angeles", "-0700 in July is US Pacific");
assert(zoneForHeaderOffset("-07:00", utc("2026-11-10T15:00:00")) === "America/Denver", "-0700 in November is US Mountain");
assert(zoneForHeaderOffset("-10:00", utc("2026-11-10T15:00:00")) === "Pacific/Honolulu", "-1000 is Hawaii");
assert(zoneForHeaderOffset("+05:30", utc("2026-11-10T15:00:00")) === "Asia/Kolkata", "+0530 is India");
assert(zoneForHeaderOffset("-04:00", utc("2026-11-10T15:00:00")) === "-04:00", "an offset no zone matches stays an offset");

// The lookup order.
{
  const header = (offset: string, at = utc("2026-11-05T15:00:00")) => ({ offset, at });
  const pacific = { zone: "America/Los_Angeles", basis: "signature" as const };
  const hq = { zone: "America/Los_Angeles", basis: "company" as const };
  assert(chooseProspectZone(header("-08:00"), undefined).zone === "America/Los_Angeles", "(a) their Date header comes first");
  assert(chooseProspectZone(header("-08:00"), undefined).source === "email", "and says so");
  assert(chooseProspectZone(header("-05:00"), pacific).zone === "America/New_York", "a header beats a signature that disagrees");
  assert(chooseProspectZone(header("-07:00"), { zone: "America/Phoenix", basis: "signature" }).zone === "America/Phoenix", "a signature that agrees names the zone");
  assert(chooseProspectZone(undefined, pacific).zone === "America/Los_Angeles" && chooseProspectZone(undefined, pacific).source === "signature", "(b) a signature next");
  assert(chooseProspectZone(undefined, hq).source === "company", "(c) the company's location next");
  const none = chooseProspectZone(undefined, undefined);
  assert(none.zone === "Asia/Kolkata" && none.source === "default", "(d) IST by default");
  assert(chooseProspectZone(header("+00:00"), undefined).zone === "+00:00", "+0000 alone is taken literally");
  assert(chooseProspectZone(header("+00:00"), pacific).zone === "America/Los_Angeles", "a place they name beats +0000, often a server's clock");
}
assert(parseLocationGuess('{"timezone":"America/New_York","basis":"signature"}')?.zone === "America/New_York", "a location answer parses");
assert(parseLocationGuess('{"timezone":"","basis":"none"}') === undefined, "no answer is no location");
assert(parseLocationGuess('{"timezone":"Mars/Base","basis":"company"}') === undefined, "an invalid zone is ignored");
assert(parseLocationGuess('{"timezone":"-05:00","basis":"company"}') === undefined, "the model must name a zone, not an offset");
assert(parseLocationGuess("New York") === undefined, "prose is ignored");

// What he says, as a zone.
for (const [words, zone] of [
  ["Pacific", "America/Los_Angeles"],
  ["US Pacific time", "America/Los_Angeles"],
  ["PST", "America/Los_Angeles"],
  ["San Francisco", "America/Los_Angeles"],
  ["New York", "America/New_York"],
  ["Eastern", "America/New_York"],
  ["ET", "America/New_York"],
  ["Central", "America/Chicago"],
  ["Austin", "America/Chicago"],
  ["Mountain", "America/Denver"],
  ["Arizona", "America/Phoenix"],
  ["Alaska", "America/Anchorage"],
  ["Hawaii", "Pacific/Honolulu"],
  ["IST", "Asia/Kolkata"],
  ["Bangalore", "Asia/Kolkata"],
  ["London", "Europe/London"],
  ["America/Chicago", "America/Chicago"],
  ["Europe/Berlin", "Europe/Berlin"],
  ["UTC-5", "-05:00"],
  ["GMT+5:30", "+05:30"],
  ["UTC", "+00:00"],
] as const) {
  assert(zoneFromWords(words) === zone, `"${words}" is ${zone}, got ${zoneFromWords(words)}`);
}
assert(zoneFromWords("Atlantis") === undefined && zoneFromWords("") === undefined, "an unknown place is no zone");
assert(zoneLabel("+00:00") === "UTC" && zoneLabel("-05:00") === "UTC-05:00", "offsets are labelled as UTC offsets");
assert(zoneLabel("Europe/London") === "London" && zoneLabel("America/Sao_Paulo") === "Sao Paulo", "other zones show their city");
assert(zoneDisplay("America/Los_Angeles", "company") === "US Pacific (from company HQ)", "a company guess says so");
assert(zoneDisplay("Asia/Kolkata", "default") === "India (default)", "the default says so");
assert(zoneDisplay("America/Los_Angeles", "owner") === "US Pacific", "his own setting is plain");
assert(zoneDisplay(null, null) === "time zone not checked yet", "an unchecked zone says so");

// ======== sorting inbound mail (pure) ========
function inbound(overrides: Partial<InboundFact> = {}): InboundFact {
  return {
    id: "x",
    threadId: "t",
    from: "priya@acme.com",
    subject: "Re: pitch",
    autoSubmitted: "",
    autoReplyHeader: false,
    precedence: "",
    listUnsubscribe: false,
    body: "Sounds good",
    at: Date.parse("2026-11-10T06:00:00Z"),
    ...overrides,
  };
}
assert(classifyInbound(inbound()) === "reply", "a plain reply is a reply");
assert(classifyInbound(inbound({ subject: "Automatic reply: pitch" })) === "out_of_office", "an auto-reply subject is out-of-office");
assert(classifyInbound(inbound({ subject: "Out of Office: pitch" })) === "out_of_office", "an OOO subject is out-of-office");
assert(classifyInbound(inbound({ autoSubmitted: "auto-replied" })) === "out_of_office", "the auto-reply header is out-of-office");
assert(classifyInbound(inbound({ body: "I'm away until Monday but keen, call me." })) === "reply", "a person saying they're away is a reply");
assert(classifyInbound(inbound({ subject: "Automatic reply", body: "Priya no longer works here." })) === "reply", "an auto-reply about leaving stops it");
assert(classifyInbound(inbound({ from: "mailer-daemon@googlemail.com" })) === "bounce", "a daemon is a bounce");
assert(classifyInbound(inbound({ from: "postmaster@acme.com" })) === "bounce", "a postmaster is a bounce");
for (const body of ["Not interested, thanks.", "Please remove me from this.", "unsubscribe", "Stop emailing me."]) {
  assert(classifyInbound(inbound({ body })) === "do_not_contact", `${body} marks do-not-contact`);
}
assert(
  classifyInbound(inbound({ body: "Tuesday 3pm works\n\nOn Tue, Vishnu wrote:\n> reply not interested to unsubscribe" })) === "reply",
  "quoted text can't mark do-not-contact",
);
assert(
  classifyInbound(inbound({ body: "Our newsletter. Click to unsubscribe.", listUnsubscribe: true })) === "reply",
  "a bulk footer doesn't mark do-not-contact",
);
assert(topReplyText("New text\n\nOn Mon, X wrote:\n> old").trim() === "New text", "the top of a reply is kept");

const sentAt = Date.parse("2026-11-10T06:00:00Z");
assert(
  outOfOfficeUntil({ body: "I am out of office until 20 November 2026.", at: sentAt }, null).toISOString() ===
    new Date(`2026-11-20T10:00:00+05:30`).toISOString(),
  "a stated return date is used, at 10:00 their time",
);
assert(
  outOfOfficeUntil({ body: "I am on leave with limited access.", at: sentAt }, null).getTime() === sentAt + 3 * DAY,
  "no stated date means 3 days",
);
assert(
  outOfOfficeUntil({ body: "Back on 1 January 2031.", at: sentAt }, null).getTime() === sentAt + 90 * DAY,
  "an absurd date is capped",
);

const stopBase = {
  now: new Date(sentAt),
  threadId: "t",
  timezone: null,
  blockedParty: false,
  doNotContact: false,
  bounced: false,
  inbound: [] as InboundFact[],
  meeting: false,
  ownSends: [],
  colleagueOnThread: false,
};
assert(evaluateStopRules(stopBase).action === "none", "nothing happened, nothing changes");
{
  const away = evaluateStopRules({ ...stopBase, inbound: [inbound({ subject: "Automatic reply: x", body: "Away." })] });
  assert(away.action === "postpone", "out-of-office postpones and doesn't stop");
  const both = evaluateStopRules({
    ...stopBase,
    inbound: [inbound({ subject: "Automatic reply: x", body: "Away." }), inbound({ body: "Let's talk" })],
  });
  assert(both.action === "stop" && both.reason === "replied", "a real reply still stops after an out-of-office");
}

// ======== who may be stopped by name (pure) ========
{
  const rows = [
    { id: 1, prospect_email: "rajan@alpha.com", prospect_domain: "alpha.com", prospect_name: "Rajan Mehta", prospect_company: "Alpha" },
    { id: 2, prospect_email: "r.iyer@beta.com", prospect_domain: "beta.com", prospect_name: "Rajan Iyer", prospect_company: "Beta" },
    { id: 3, prospect_email: "priya@talkdesk.com", prospect_domain: "talkdesk.com", prospect_name: "Priya Shah", prospect_company: "Talkdesk" },
  ];
  assert(matchSequencesForStop(rows, "Talkdesk").rows[0]?.id === 3, "by company");
  assert(matchSequencesForStop(rows, "talk desk").rows[0]?.id === 3, "company with a space");
  assert(matchSequencesForStop(rows, "talkdesk.com").rows[0]?.id === 3, "by domain");
  assert(matchSequencesForStop(rows, "priya@talkdesk.com").rows[0]?.id === 3, "by address");
  assert(matchSequencesForStop(rows, "Priya").kind === "one", "by first name");
  assert(matchSequencesForStop(rows, "Rajan").kind === "ambiguous", "two people named the same is ambiguous");
  assert(matchSequencesForStop(rows, "Raj").kind === "none", "part of a name is no match");
  for (const phrase of ["all", "all follow-ups", "ALL followups", "everyone", "all sequences"]) {
    const match = matchSequencesForStop(rows, phrase);
    assert(match.kind === "all" && match.rows.length === 3, `${phrase} means all`);
  }
  assert(matchSequencesForStop(rows, "").kind === "none", "an empty target stops nothing");
}

// ======== the address gate ========
function gateInput(overrides: Partial<SequenceSendGateInput> = {}): SequenceSendGateInput {
  return {
    enabled: true,
    accountId: "work",
    fromAddress: ME,
    sequence: {
      id: 7,
      status: "active",
      account: "work",
      prospect_email: "priya@acme.com",
      current_step: 1,
      steps_sent: 0,
      manual_followups: 0,
      prospect_timezone: null,
    },
    openSequenceId: 7,
    stepNo: 1,
    step: {
      status: "planned",
      draft_text: "Hello",
      sent_message_id: null,
    },
    to: "Priya <priya@acme.com>",
    cc: undefined,
    bcc: undefined,
    body: "Hello",
    inReplyTo: "<a@b>",
    threadId: "t",
    sequenceThreadId: "t",
    blockedDomains: new Set(["epicode.in", "pinnacle.in"]),
    selfAddresses: new Set([ME, "me@gmail.com"]),
    doNotContact: false,
    sendsToday: 0,
    dailyCap: 15,
    minutesSinceLastSend: undefined,
    minSpacingMinutes: 3,
    now: ist("2026-11-10T11:00:00"),
    ...overrides,
  };
}
assert(evaluateSequenceSendGate(gateInput()).ok, "a clean send passes");
const sequenceWith = (patch: object) => ({ ...gateInput().sequence!, ...patch });
const stepWith = (patch: object) => ({ ...gateInput().step!, ...patch });
const refusals: Array<[string, Partial<SequenceSendGateInput>, string]> = [
  ["kill switch", { enabled: false }, "disabled"],
  ["personal account", { accountId: "personal" }, "not_work_account"],
  ["personal sender", { fromAddress: "me@gmail.com" }, "not_work_sender"],
  ["other recipient", { to: "x@acme.com" }, "recipient_mismatch"],
  ["two recipients", { to: "priya@acme.com, x@acme.com" }, "recipient_mismatch"],
  ["extra address in a name", { to: "\"x@evil.com\" <priya@acme.com>" }, "recipient_mismatch"],
  ["no recipient", { to: "" }, "recipient_mismatch"],
  ["Cc", { cc: "x@acme.com" }, "cc_not_allowed"],
  ["Bcc", { bcc: "x@acme.com" }, "bcc_not_allowed"],
  ["partner", { sequence: sequenceWith({ prospect_email: "a@pinnacle.in" }), to: "a@pinnacle.in" }, "blocked_recipient"],
  ["partner subdomain", { sequence: sequenceWith({ prospect_email: "a@mail.pinnacle.in" }), to: "a@mail.pinnacle.in" }, "blocked_recipient"],
  ["epicode", { sequence: sequenceWith({ prospect_email: "sam@epicode.in" }), to: "sam@epicode.in" }, "blocked_recipient"],
  ["self", { sequence: sequenceWith({ prospect_email: "me@gmail.com" }), to: "me@gmail.com" }, "blocked_recipient"],
  ["do not contact", { doNotContact: true }, "do_not_contact"],
  ["stopped", { sequence: sequenceWith({ status: "stopped" }) }, "sequence_not_active"],
  ["no row", { sequence: undefined }, "sequence_not_active"],
  ["wrong thread", { sequenceThreadId: "other" }, "wrong_thread"],
  ["another open for this person", { openSequenceId: 8 }, "prospect_has_other_sequence"],
  ["already claimed", { step: stepWith({ status: "sending" }) }, "step_not_ready"],
  ["already sent", { step: stepWith({ sent_message_id: "m" }) }, "step_not_ready"],
  ["wrong step", { stepNo: 2 }, "step_not_ready"],
  ["manual bump used it", { sequence: sequenceWith({ manual_followups: 1 }) }, "step_used_by_manual_followup"],
  ["all four used", { stepNo: 4, sequence: sequenceWith({ current_step: 4, manual_followups: 1, steps_sent: 3 }) }, "followups_used_up"],
  ["different body", { body: "Something else" }, "body_not_the_written_draft"],
  ["empty body", { body: " " }, "body_not_the_written_draft"],
  ["no thread header", { inReplyTo: "" }, "no_thread_headers"],
  ["weekend", { now: ist("2026-11-14T11:00:00") }, "outside_window"],
  ["after hours", { now: ist("2026-11-10T18:00:00") }, "outside_window"],
  ["their night", { now: ist("2026-11-10T11:00:00"), sequence: sequenceWith({ prospect_timezone: "America/Los_Angeles" }) }, "outside_window"],
  ["daily cap", { sendsToday: 15 }, "daily_cap"],
  ["spacing", { minutesSinceLastSend: 2.9 }, "spacing"],
];
for (const [label, overrides, reason] of refusals) {
  const gate = evaluateSequenceSendGate(gateInput(overrides));
  assert(!gate.ok && gate.reason === reason, `${label}: expected ${reason}, got ${JSON.stringify(gate)}`);
}
assert(
  evaluateSequenceSendGate(gateInput({ now: ist("2026-11-10T21:00:00"), sequence: sequenceWith({ prospect_timezone: "America/New_York" }) })).ok,
  "21:00 IST passes for New York: their 10:30",
);
assert(
  evaluateSequenceSendGate(gateInput({ step: stepWith({ check_result: null }) } as never)).ok,
  "a written draft needs no check result",
);

// ======== the send function refuses before touching Gmail ========
{
  nextScenario();
  const item = enrol();
  const prepared = await prepareSequenceStep(item.id, { now: clock });
  assert(prepared.kind === "ready", "the step is ready");
  const body = prepared.kind === "ready" ? prepared.body : "";
  const params = {
    sequenceId: item.id,
    stepNo: 1,
    account: workAccount,
    fromAddress: ME,
    threadId: item.threadId,
    to: `Priya Shah <${item.email}>`,
    subject: "Re: x",
    inReplyTo: item.pitch.messageId,
    references: "",
    body,
    selfAddresses: new Set([ME]),
    now: clock,
  };
  const refused = async (overrides: object, reason: string): Promise<void> => {
    const before = sends.length;
    let caught = "";
    try {
      await sendSequenceStep({ ...params, ...overrides });
    } catch (error) {
      caught = error instanceof SequenceSendRefusedError ? error.reason : "other";
    }
    assert(caught === reason, `expected ${reason}, got ${caught}`);
    assert(sends.length === before, `${reason} reached Gmail`);
    assert(getSalesSequenceStep(item.id, 1)!.status === "planned", `${reason} claimed the step`);
  };
  await refused({ to: "other@elsewhere.example" }, "recipient_mismatch");
  await refused({ cc: "other@elsewhere.example" }, "cc_not_allowed");
  await refused({ bcc: "other@elsewhere.example" }, "bcc_not_allowed");
  await refused({ account: personalAccount }, "not_work_account");
  await refused({ fromAddress: "me@gmail.com" }, "not_work_sender");
  await refused({ body: "Changed after it was written" }, "body_not_the_written_draft");
  await refused({ threadId: "another-thread" }, "wrong_thread");
  settings.sequencesEnabled = false;
  await refused({}, "disabled");
  assert((await runSequenceTick(api, { now: clock })).scanned === 0, "the kill switch stops the whole tick");
  assert(registerSequenceSend(api) === undefined, "the kill switch registers no job");
  assert(formatHealthReport(clock).includes("sequence-send: off"), "/health shows it off");
  settings.sequencesEnabled = true;
  assert((HEALTH_JOBS as readonly string[]).includes("sequence-send"), "sequence-send is on /health");
  assert(!formatHealthReport(clock).includes("sequence-send: off"), "/health shows it on");

  await sendSequenceStep(params);
  assert(sends.length === 1, "the written draft goes out");
  let repeat = "";
  await sendSequenceStep({ ...params, now: new Date(clock.getTime() + HOUR) }).catch((error: unknown) => {
    repeat = error instanceof SequenceSendRefusedError ? error.reason : "other";
  });
  assert(repeat === "step_not_ready", `the same step can't go twice, got ${repeat}`);
  assert(sends.length === 1, "a repeat doesn't reach Gmail");
}

// ======== a whole sequence: threading, timing, silence, no checker ========
{
  nextScenario();
  const before = sends.length;
  const item = enrol();
  const result = await tick();
  assert(result.sent === 1, "the due step is sent");
  const first = sends[before]!;
  assert(first.threadId === item.threadId, "it stays in the thread");
  assert(first.parsed.headers.to === `Priya Shah <${item.email}>`, "To is the enrolled prospect");
  assert(first.parsed.headers.cc === undefined, "no Cc header");
  assert(first.parsed.headers.bcc === undefined, "no Bcc header");
  assert(first.parsed.headers["in-reply-to"] === item.pitch.messageId, "In-Reply-To is the live Message-ID");
  assert(first.parsed.headers.references === item.pitch.messageId, "References starts the chain");
  assert(first.parsed.headers.subject!.startsWith("Re: "), "the subject is a reply");
  assert(first.parsed.plain.includes("Vishnu Rajan"), "the signature is on it");
  const step1 = getSalesSequenceStep(item.id, 1)!;
  assert(step1.status === "sent" && step1.sent_message_id === first.id, "sent_message_id is recorded");
  const row = getSalesSequence(item.id)!;
  assert(row.current_step === 2 && row.steps_sent === 1, "the sequence moves on");
  assert(new Date(row.next_step_at!).getTime() === clock.getTime() + 2 * DAY, "step 2 is due 2 days after the send");
  const dueAt = new Date(row.next_step_at!);

  assert(!modelCalls.some((call) => call.task === "sequence_check"), "no second check runs");
  assert(row.prospect_timezone === "Asia/Kolkata" && row.prospect_timezone_source === "default", "with nothing to go on the zone is IST");

  assert((await tick(after(MIN))).sent === 0, "nothing is due yet");
  assert((await tick(new Date(dueAt.getTime() - MIN))).sent === 0, "still nothing a minute before it's due");

  const second = await tick(whenDue(item.id));
  assert(second.sent === 1, "step 2 goes out on time");
  const two = sends[before + 1]!;
  const firstMessage = allMessages().find((message) => message.id === first.id)!;
  assert(two.parsed.headers["in-reply-to"] === firstMessage.messageId, "step 2 replies to the live step 1 Message-ID");
  assert(
    two.parsed.headers.references === `${item.pitch.messageId} ${firstMessage.messageId}`,
    "References carries the chain",
  );

  await tick(whenDue(item.id));
  await tick(whenDue(item.id));
  assert(sends.length === before + 4, `all four went out, got ${sends.length - before}`);
  const three = sends[before + 2]!;
  assert(/\d{1,2}:\d{2} [AP]M IST/.test(three.parsed.plain), "step 3 carries real times");
  assert(!three.parsed.plain.includes(SLOTS_TOKEN), "the token is replaced");
  assert(getSalesSequence(item.id)!.status === "completed", "the sequence completes");
  assert((await tick(after(3 * DAY))).sent === 0, "a finished sequence never sends a fifth");
  assert(telegram.sent.length === 0, "no per-send messages and no digest");
}

// A manual bump before enrolment uses up a step.
{
  nextScenario();
  const before = sends.length;
  const item = enrol({ manual: 1 });
  assert(getSalesSequence(item.id)!.current_step === 2, "one bump starts at step 2");
  await tick();
  await tick(whenDue(item.id));
  await tick(whenDue(item.id));
  await tick(after(10 * DAY));
  assert(sends.length === before + 3, `one bump leaves 3, got ${sends.length - before}`);
  assert(getSalesSequence(item.id)!.status === "completed", "and it completes");
}

// A send-time recount catches a thread that already holds all four.
{
  nextScenario();
  const before = sends.length;
  const item = enrol({ manual: 3 });
  push({
    threadId: item.threadId,
    from: `Vishnu Rajan <${ME}>`,
    to: `Priya Shah <${item.email}>`,
    subject: "Re: x",
    at: clock.getTime() - 2 * DAY,
    sent: true,
    body: "One more nudge",
  });
  await tick();
  assert(sends.length === before, "a fifth email is never sent");
  assert(getSalesSequence(item.id)!.stop_reason === "followups_used_up", "the recount stops it");
}

// ======== timezone read at Start and used for the window and the slots ========
function proposeWithHistory(options: { email: string; first: string; dateHeader?: string }): number {
  enrolCounter += 1;
  const threadId = `tz-${enrolCounter}`;
  if (options.dateHeader) {
    push({
      threadId: `old-${enrolCounter}`,
      from: `${options.first} Lee <${options.email}>`,
      to: ME,
      subject: "Old mail",
      at: Date.now() - 4 * DAY,
      sent: false,
      body: `Hello from ${options.first}`,
      extra: { Date: options.dateHeader },
    });
  }
  const pitch = push({
    threadId,
    from: `Vishnu Rajan <${ME}>`,
    to: `${options.first} Lee <${options.email}>`,
    subject: "IraVoice for Us",
    // Start stamps real time, so this thread has to be in the real past.
    at: Date.now() - 3 * DAY,
    sent: true,
    body: `Hi ${options.first},\n\nEpicode builds IraVoice. Would you be open to a short demo?`,
  });
  return createProposedSalesSequence({
    threadId,
    prospectEmail: options.email,
    prospectDomain: options.email.split("@")[1]!,
    prospectKey: options.email,
    prospectName: `${options.first} Lee`,
    prospectCompany: "Us",
    subject: "IraVoice for Us",
    originalMessageId: pitch.id,
    originalSentAt: new Date(pitch.at).toISOString(),
    manualFollowups: 0,
    classifierConfidence: 0.9,
    classifierReason: "pitch",
  })!.id;
}

async function tapStart(id: number): Promise<string> {
  let text = "";
  await handleSequenceCallback({
    callbackQuery: { data: `seq:start:${id}` },
    answerCallbackQuery: async () => true,
    editMessageText: async (value: string) => {
      text = value;
      return true;
    },
    editMessageReplyMarkup: async () => true,
    reply: async () => ({}),
  } as unknown as Context);
  return text;
}

{
  nextScenario();
  const before = sends.length;
  const id = proposeWithHistory({
    email: `sam@us${enrolCounter + 1}.example`,
    first: "Sam",
    dateHeader: new Date(Date.now() - 4 * DAY).toUTCString().replace("GMT", "-0500"),
  });
  const reply = await tapStart(id);
  const started = getSalesSequence(id)!;
  assert(started.status === "active", "Start activates it");
  const expected = zoneForHeaderOffset("-05:00", new Date(Date.now() - 4 * DAY));
  assert(started.prospect_timezone === expected && started.prospect_timezone_source === "email", `the header's zone is stored, got ${started.prospect_timezone}`);
  assert(reply.includes(`Their time zone: ${zoneLabel(expected)}`), `Start says where they are: ${reply}`);
  assert(reply.includes("Mon-Fri 9am-5pm their time"), "and when mail goes out");
  assert(!reply.includes("Nothing will go out"), "a US prospect is never held for the IST floor");
  assert(startedReplyHasNoAddress(reply), "the hint names them, not a placeholder");

  // Their 09:00 is India's evening: it goes out then.
  setSalesSequenceTimezone(id, "America/New_York", "email");
  const morningIst = clock; // 06:00 UTC
  assert((await tick(morningIst)).sent === 0, "01:00 New York is out of the window though it's morning in India");
  const nineEastern = nextSendWindow(morningIst, "America/New_York");
  assert(localHour(nineEastern, "America/New_York") === 9, "the next window is 09:00 their time");
  assert((await tick(nineEastern)).sent === 1, "it goes out at 09:00 New York, evening in India");
  assert(sends.length === before + 1, "one email");
  const panel = sequencesPanel(nineEastern).text;
  assert(panel.includes("Sam Lee, Us - US Eastern"), `/sequences shows their zone: ${panel}`);
  assert(/\(9:00 am US Eastern\)/i.test(panel), `and the next send in their time: ${panel}`);
}

function startedReplyHasNoAddress(text: string): boolean {
  return text.includes('"Sam is in New York"');
}

function localHour(at: Date, zone: string): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", hourCycle: "h23" }).format(at));
}

// (b)-(d): a signature, the company, or IST when nothing says.
{
  nextScenario();
  locationAnswer = '{"timezone":"America/Los_Angeles","basis":"signature"}';
  const sig = proposeWithHistory({ email: `jeff@west${enrolCounter + 1}.example`, first: "Jeff" });
  await tapStart(sig);
  assert(getSalesSequence(sig)!.prospect_timezone === "America/Los_Angeles", "a signature place is used");
  assert(getSalesSequence(sig)!.prospect_timezone_source === "signature", "and recorded as such");
  const location = modelCalls.find((call) => (call.system as { cacheable?: string }).cacheable === LOCATION_SYSTEM)!;
  const content = String((location.messages[0] as { content: unknown }).content);
  assert(content.includes("<<<UNTRUSTED_THREAD>>>") && content.includes("Would you be open to a short demo?"), "the location reader sees the thread, marked untrusted");

  locationAnswer = '{"timezone":"America/Los_Angeles","basis":"company"}';
  const hq = proposeWithHistory({ email: `munil@talk${enrolCounter + 1}.example`, first: "Munil" });
  await tapStart(hq);
  assert(getSalesSequence(hq)!.prospect_timezone_source === "company", "a company HQ guess is recorded as a guess");
  assert(sequencesPanel(clock).text.includes("Munil Lee, Us - US Pacific (from company HQ)"), "and /sequences says it's a guess");

  locationAnswer = NO_LOCATION;
  const plain = proposeWithHistory({ email: `ravi@in${enrolCounter + 1}.example`, first: "Ravi" });
  await tapStart(plain);
  assert(getSalesSequence(plain)!.prospect_timezone === "Asia/Kolkata", "nothing to go on means IST");
  assert(sequencesPanel(clock).text.includes("Ravi Lee, Us - India (default)"), "shown as the default");

  // +0000 from a mail server loses to a place they name.
  locationAnswer = '{"timezone":"America/New_York","basis":"signature"}';
  const server = proposeWithHistory({
    email: `kim@east${enrolCounter + 1}.example`,
    first: "Kim",
    dateHeader: new Date(Date.now() - 4 * DAY).toUTCString().replace("GMT", "+0000"),
  });
  await tapStart(server);
  assert(getSalesSequence(server)!.prospect_timezone === "America/New_York", "a named place beats a +0000 header");
  locationAnswer = NO_LOCATION;
  const literal = proposeWithHistory({
    email: `lee@utc${enrolCounter + 1}.example`,
    first: "Lee",
    dateHeader: new Date(Date.now() - 4 * DAY).toUTCString().replace("GMT", "+0000"),
  });
  await tapStart(literal);
  assert(getSalesSequence(literal)!.prospect_timezone === "+00:00", "+0000 alone is taken literally");
}

// A failed lookup is never stored as IST: the runner tries again before sending.
{
  nextScenario();
  const before = sends.length;
  const item = enrol();
  setCompleteForTests(async (params: CompleteParams) => {
    if ((params.system as { cacheable?: string }).cacheable === LOCATION_SYSTEM) {
      throw new Error("model down");
    }
    return answer('{"ask":"demo"}');
  });
  await tick();
  assert(getSalesSequence(item.id)!.prospect_timezone === null, "nothing is stored on a failed lookup");
  assert(sends.length === before, "and nothing is sent until it's known");
  restoreModels();
  await tick(after(5 * MIN));
  assert(getSalesSequence(item.id)!.prospect_timezone === "Asia/Kolkata", "the next tick looks it up");
  assert(sends.length === before + 1, "and sends");
}

// The send gate holds their window on its own, whatever the runner did.
{
  nextScenario();
  const item = enrol({ timezone: "America/Los_Angeles" });
  const prepared = await prepareSequenceStep(item.id, { now: clock });
  assert(prepared.kind === "ready", "the step is ready");
  const count = sends.length;
  let refused = "";
  try {
    await sendSequenceStep({
      sequenceId: item.id,
      stepNo: 1,
      account: workAccount,
      fromAddress: ME,
      threadId: item.threadId,
      to: `Priya Shah <${item.email}>`,
      subject: "Re: x",
      inReplyTo: item.pitch.messageId,
      references: "",
      body: prepared.kind === "ready" ? prepared.body : "",
      selfAddresses: new Set([ME]),
      now: clock, // 11:30 IST is the middle of the night in California
    });
  } catch (error) {
    refused = error instanceof SequenceSendRefusedError ? error.reason : "other";
  }
  assert(refused === "outside_window", `the gate refuses their night, got ${refused}`);
  assert(sends.length === count, "and nothing reaches Gmail");
  assert(getSalesSequenceStep(item.id, 1)!.status === "planned", "and the step isn't claimed");
}

// ======== step 3: times that suit both sides, or ask for one ========
{
  nextScenario();
  const item = enrol({ manual: 2, timezone: "America/Los_Angeles" });
  const at = nextSendWindow(clock, "America/Los_Angeles");
  assert((await offerSlots(at, "America/Los_Angeles")).length === 0, "none of his hours fall in 09:00-18:00 Pacific");
  const count = sends.length;
  await tick(at);
  assert(sends.length === count + 1, "step 3 still goes out on its own, with no card");
  const plain = sends[count]!.parsed.plain;
  assert(!/\d{1,2}:\d{2} [AP]M IST/.test(plain), "with no times in it");
  const prompt = String((modelCalls.filter((call) => (call.system as { cacheable?: string }).cacheable === WRITER_SYSTEM).at(-1)!.messages[0] as { content: unknown }).content);
  assert(/a day and time that suits them/.test(prompt), "the writer asked them for a time");
  assert(telegram.sent.length === 0, "and no card was posted");
}
{
  nextScenario();
  const item = enrol({ manual: 2, timezone: "Europe/London" });
  const at = nextSendWindow(clock, "Europe/London");
  const lines = await offerSlots(at, "Europe/London");
  assert(lines.length >= 1 && lines.length <= 3, `London overlaps his afternoon, got ${lines.length}`);
  const count = sends.length;
  await tick(at);
  assert(sends.length === count + 1, "step 3 goes out");
  assert(lines.every((line) => sends[count]!.parsed.plain.includes(line.slice(2))), "with the times that suit both");
  void item;
}
{
  nextScenario();
  const item = enrol({ manual: 2, timezone: "+04:00" });
  const count = sends.length;
  await tick();
  assert(sends.length === count + 1, "step 3 goes out in their window");
  assert(sends[count]!.parsed.plain.includes("GMT+4"), "the slots show their time as well as IST");
  assert(getSalesSequenceStep(item.id, 3)!.status === "sent", "without a card");
}

// ======== rolling forward, cap, spacing ========
{
  nextScenario();
  const before = sends.length;
  enrol();
  const start = clock;
  const saturday = new Date(start);
  while (saturday.getUTCDay() !== 6) {
    saturday.setTime(saturday.getTime() + DAY);
  }
  assert((await tick(saturday)).sent === 0, "nothing on a Saturday");
  const sunday = new Date(saturday.getTime() + DAY);
  assert((await tick(sunday)).sent === 0, "nothing on a Sunday");
  const lateMonday = new Date(sunday.getTime() + DAY);
  lateMonday.setUTCHours(12, 0, 0, 0);
  assert((await tick(lateMonday)).sent === 0, "nothing after 17:00 IST");
  assert(sends.length === before, "no send outside the window");
  const tuesday = new Date(lateMonday.getTime() + DAY);
  tuesday.setUTCHours(6, 0, 0, 0);
  assert((await tick(tuesday)).sent === 1, "the next window sends it");
}

{
  nextScenario();
  settings.sequenceDailySendCap = 2;
  const before = sends.length;
  enrol({ first: "Aru" });
  enrol({ first: "Bala" });
  enrol({ first: "Chitra" });
  const start = clock;
  assert((await tick(start)).sent === 1, "one send a tick");
  assert((await tick(new Date(start.getTime() + 2 * MIN))).sent === 0, "2 minutes later is too soon");
  assert((await tick(new Date(start.getTime() + 3 * MIN))).sent === 1, "3 minutes later is fine");
  assert((await tick(new Date(start.getTime() + 60 * MIN))).sent === 0, "the daily cap holds");
  assert(sends.length === before + 2, "two today");
  const tomorrow = new Date(start.getTime() + DAY);
  if (tomorrow.getUTCDay() >= 1 && tomorrow.getUTCDay() <= 5) {
    assert((await tick(tomorrow)).sent === 1, "the cap resets the next IST day");
  }
  settings.sequenceDailySendCap = 15;
}

// ======== SEQUENCE_TEST_RECIPIENTS gate removed ========
{
  nextScenario();
  const before = sends.length;
  const first = enrol({ first: "Lata" });
  const second = enrol({ first: "Omar" });
  const result = await tick();
  assert(result.sent >= 1 && sends.length > before, "real prospects can receive without a test allowlist");
  const recipients = sends.slice(before).map((send) => send.parsed.headers.to ?? "");
  assert(
    recipients.some((to) => to.includes(first.email)) ||
      recipients.some((to) => to.includes(second.email)),
    "an enrolled prospect is eligible to send",
  );
  const pitch = evaluatePitchExclusion(
    {
      to: [{ name: "Omar", email: second.email }],
      cc: [],
      threadSenders: [],
      earlierRecipients: [],
      manualFollowups: 0,
      isCalendarOrAutomated: false,
      noReplyOrIgnored: false,
    },
    {
      selfAddresses: new Set([ME]),
      blockedDomains: new Set(),
      personalDomains: PERSONAL_DOMAINS,
      isAccountEmail: () => false,
      isDoNotContact: () => false,
      threadHasSequence: false,
      prospectHasOpenSequence: () => false,
      threadInMeetingFlow: false,
    },
  );
  assert(pitch === null, "pitch exclusion no longer has a test-recipient gate");
}

// ======== several people at one company ========
{
  nextScenario();
  const before = sends.length;
  const ana = enrol({ first: "Ana", email: "ana@samecorp.example" });
  const ben = enrol({ first: "Ben", email: "ben@samecorp.example" });
  assert(getSalesSequence(ana.id)!.status === "active" && getSalesSequence(ben.id)!.status === "active", "two open sequences at one company");
  const start = clock;
  await tick(start);
  await tick(new Date(start.getTime() + 3 * MIN));
  assert(sends.length === before + 2, "both colleagues get their follow-up");
  const recipients = sends.slice(before).map((send) => send.parsed.headers.to ?? "");
  assert(recipients.some((to) => to.includes(ana.email)) && recipients.some((to) => to.includes(ben.email)), "each to their own address");
  assert(getSalesSequence(ana.id)!.steps_sent === 1 && getSalesSequence(ben.id)!.steps_sent === 1, "each moves on");
}

// ======== every stop rule ========
async function expectStop(
  label: string,
  setup: (item: Enrolled) => void | Promise<void>,
  reason: string,
  options: Parameters<typeof enrol>[0] = {},
): Promise<Enrolled> {
  nextScenario();
  const before = sends.length;
  const item = enrol(options);
  await setup(item);
  await tick();
  const row = getSalesSequence(item.id)!;
  assert(row.status === "stopped", `${label}: expected stopped, got ${row.status}`);
  assert(row.stop_reason === reason, `${label}: expected ${reason}, got ${row.stop_reason}`);
  assert(sends.length === before, `${label}: nothing is sent`);
  return item;
}

await expectStop("reply on the thread", (item) => void reply(item, "Sure, let's talk"), "replied");
await expectStop(
  "reply on another thread",
  (item) => void reply(item, "Saw your note", { threadId: `other-${item.id}` }),
  "replied",
);
await expectStop(
  "a colleague at the domain",
  (item) => void reply(item, "I handle this", { from: `Raj <raj@${item.domain}>` }),
  "replied",
);
await expectStop(
  "a subdomain of the company",
  (item) => void reply(item, "I handle this", { from: `Raj <raj@mail.${item.domain}>` }),
  "replied",
);
await expectStop(
  "a free-mail prospect by exact address",
  (item) => void reply(item, "Sure"),
  "replied",
  { email: "priya.only@gmail.com", first: "Priya" },
);
{
  nextScenario();
  const before = sends.length;
  const item = enrol({ email: "priya.free@gmail.com" });
  push({
    threadId: `stranger-${item.id}`,
    from: "Someone <stranger@gmail.com>",
    to: ME,
    subject: "Unrelated",
    at: clock.getTime() - HOUR,
    sent: false,
    body: "Hello",
  });
  await tick();
  assert(getSalesSequence(item.id)!.status === "active", "a stranger on the same free-mail domain doesn't stop it");
  assert(sends.length === before + 1, "and the step goes out");
}
await expectStop(
  "a calendar event",
  (item) => void calendar.push({ email: item.email }),
  "meeting_booked",
);
await expectStop(
  "an open meeting offer",
  (item) => {
    createMeetingProposal({
      threadId: `offer-${item.id}`,
      sentMessageId: `offer-sent-${item.id}`,
      recipientEmail: item.email,
      recipientName: "Priya",
      ccEmails: [],
      slots: [{ start: clock.toISOString(), end: clock.toISOString() }],
      durationMinutes: 30,
      senderTimezone: null,
    });
  },
  "meeting_booked",
);
await expectStop(
  "an event card waiting for a tap",
  (item) => {
    createPendingEventAction({
      title: "Call",
      startIso: clock.toISOString(),
      endIso: clock.toISOString(),
      attendees: [item.email],
    });
  },
  "meeting_booked",
);
await expectStop(
  "a bounce",
  (item) => {
    push({
      threadId: item.threadId,
      from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
      to: ME,
      subject: "Delivery Status Notification (Failure)",
      at: clock.getTime() - HOUR,
      sent: false,
      body: `Address not found: ${item.email}`,
    });
  },
  "bounced",
);
for (const phrase of ["Not interested", "remove me please", "unsubscribe", "Please stop emailing me"]) {
  const item = await expectStop(`"${phrase}"`, (target) => void reply(target, phrase), "do_not_contact");
  assert(isSalesDoNotContact(item.email), `"${phrase}" marks them do-not-contact`);
}
{
  const item = await expectStop(
    "a colleague refusing",
    (target) => void reply(target, "Not interested", { from: `Raj <raj@${target.domain}>` }),
    "do_not_contact",
  );
  assert(isSalesDoNotContact(item.email) && isSalesDoNotContact(`raj@${item.domain}`), "both are marked");
}
await expectStop(
  "marked do-not-contact from a card",
  (item) => void addSalesDoNotContact(item.email, "owner_card"),
  "do_not_contact",
);
await expectStop(
  "becomes a partner",
  (item) => {
    createAccount({
      name: `Partner ${item.id}`,
      relationship: "partner",
      emailDomains: JSON.stringify([item.domain]),
    } as Parameters<typeof createAccount>[0]);
  },
  "partner_domain",
);
await expectStop(
  "becomes an end client",
  (item) => {
    createAccount({
      name: `Client ${item.id}`,
      relationship: "end_client",
      emailDomains: JSON.stringify([item.domain]),
    } as Parameters<typeof createAccount>[0]);
  },
  "partner_domain",
);
{
  const original = [...config.partnerDomains];
  await expectStop(
    "added to PARTNER_DOMAINS",
    (item) => {
      settings.partnerDomains = [...original, item.domain];
    },
    "partner_domain",
  );
  settings.partnerDomains = original;
}

// He emailed them himself: stop and say so in one line.
{
  const item = await expectStop(
    "own email on another thread",
    (target) => {
      push({
        threadId: `mine-${target.id}`,
        from: `Vishnu Rajan <${ME}>`,
        to: target.email,
        subject: "Separate note",
        at: clock.getTime() - HOUR,
        sent: true,
        body: "A separate note",
      });
    },
    "own_email",
  );
  assert(telegram.sent.length === 1, "one line to Vishnu");
  assert(telegram.sent[0]!.includes("Priya Shah") && telegram.sent[0]!.includes("yourself"), "it says why");
  assert(!telegram.sent[0]!.includes("\n"), "exactly one line");
  void item;
}
await expectStop(
  "own email on Cc",
  (target) => {
    push({
      threadId: `mine-${target.id}`,
      from: `Vishnu Rajan <${ME}>`,
      to: "someone@elsewhere.example",
      cc: target.email,
      subject: "Note",
      at: clock.getTime() - HOUR,
      sent: true,
      body: "A note",
    });
  },
  "own_email",
);

// A colleague on the thread after enrolment takes it over.
{
  const item = await expectStop(
    "a colleague writes to the prospect on the thread",
    (target) => {
      push({
        threadId: target.threadId,
        from: `Sam Iyer <sam@epicode.in>`,
        to: target.email,
        cc: ME,
        subject: "Re: x",
        at: clock.getTime() - HOUR,
        sent: false,
        body: "Happy to take this one",
      });
    },
    "colleague_on_thread",
  );
  assert(telegram.sent.length === 1 && telegram.sent[0]!.includes("colleague"), "one line says why");
  assert(!telegram.sent[0]!.includes("\n"), "exactly one line");
  void item;
}
await expectStop(
  "a colleague writes only to him on the thread",
  (target) => {
    push({
      threadId: target.threadId,
      from: `Sam Iyer <sam@epicode.in>`,
      to: ME,
      subject: "Re: x",
      at: clock.getTime() - HOUR,
      sent: false,
      body: "Want me to chase this?",
    });
  },
  "colleague_on_thread",
);
{
  const quiet = async (label: string, add: (target: Enrolled) => void): Promise<void> => {
    nextScenario();
    const target = enrol();
    add(target);
    const count = sends.length;
    await tick();
    assert(getSalesSequence(target.id)!.status === "active", `${label}: still active`);
    assert(sends.length === count + 1, `${label}: it still sends`);
  };
  await quiet("a colleague on another thread", (target) => {
    push({ threadId: `other-${target.id}`, from: "Sam Iyer <sam@epicode.in>", to: ME, subject: "Elsewhere", at: clock.getTime() - HOUR, sent: false, body: "Unrelated" });
  });
  await quiet("a colleague before enrolment", (target) => {
    push({ threadId: target.threadId, from: "Sam Iyer <sam@epicode.in>", to: ME, subject: "Re: x", at: new Date(getSalesSequence(target.id)!.enrolled_at!).getTime() - DAY, sent: false, body: "Earlier" });
  });
  await quiet("his own alias on the thread, to himself", (target) => {
    push({ threadId: target.threadId, from: "Vishnu <vishnu@epicode.in>", to: ME, subject: "Re: x", at: clock.getTime() - HOUR, sent: true, body: "Note to self" });
  });
}

// Protected partner domains: never enrolled, never sent, subdomains included.
for (const domain of ["supertronindia.com", "mail.supertronindia.com", "supertroninfotech.com", "pinnacle.in"]) {
  assert(domainInSet(domain, blockedAutoSendDomains()), `${domain} is blocked by default`);

  // Tapping Start on a pitch to them is refused.
  nextScenario();
  enrolCounter += 1;
  const email = `sujoy@${domain}`;
  const threadId = `protected-${enrolCounter}`;
  const pitch = push({
    threadId,
    from: `Vishnu Rajan <${ME}>`,
    to: `Sujoy <${email}>`,
    subject: "IraVoice",
    at: Date.now() - 3 * DAY,
    sent: true,
    body: "Hi Sujoy,\n\nEpicode builds IraVoice. Would you be open to a short demo?",
  });
  const proposed = createProposedSalesSequence({
    threadId,
    prospectEmail: email,
    prospectDomain: domain,
    prospectKey: email,
    prospectName: "Sujoy",
    prospectCompany: "Partner",
    subject: "IraVoice",
    originalMessageId: pitch.id,
    originalSentAt: new Date(pitch.at).toISOString(),
    manualFollowups: 0,
    classifierConfidence: 0.9,
    classifierReason: "pitch",
  })!;
  let startReply = "";
  await handleSequenceCallback({
    callbackQuery: { data: `seq:start:${proposed.id}` },
    answerCallbackQuery: async () => true,
    editMessageText: async (text: string) => {
      startReply = text;
      return true;
    },
    editMessageReplyMarkup: async () => true,
    reply: async () => ({}),
  } as unknown as Context);
  assert(getSalesSequence(proposed.id)!.status === "stopped", `${domain}: Start doesn't enrol it`);
  assert(startReply.startsWith("Not started"), `${domain}: and says so`);

  // An enrolled row can't get there either: the send gate and the scan both refuse.
  nextScenario();
  const item = enrol({ email });
  const prepared = await prepareSequenceStep(item.id, { now: clock });
  assert(prepared.kind === "ready", `${domain}: the step is ready`);
  const count = sends.length;
  let refused = "";
  try {
    await sendSequenceStep({
      sequenceId: item.id,
      stepNo: 1,
      account: workAccount,
      fromAddress: ME,
      threadId: item.threadId,
      to: email,
      subject: "Re: IraVoice",
      inReplyTo: item.pitch.messageId,
      references: "",
      body: prepared.kind === "ready" ? prepared.body : "",
      selfAddresses: new Set([ME]),
      now: clock,
    });
  } catch (error) {
    refused = error instanceof SequenceSendRefusedError ? error.reason : "other";
  }
  assert(refused === "blocked_recipient", `${domain}: the gate refuses, got ${refused}`);
  await tick();
  assert(getSalesSequence(item.id)!.stop_reason === "partner_domain", `${domain}: the scan stops it`);
  assert(sends.length === count, `${domain}: nothing reaches Gmail`);
}

// Out-of-office postpones, before the reply stop.
{
  nextScenario();
  const before = sends.length;
  const item = enrol();
  const back = new Date(clock.getTime() + 10 * DAY);
  const label = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(back);
  reply(item, `I am out of the office until ${label} and will reply when I return.`, {
    subject: "Automatic reply: IraVoice",
    extra: { "Auto-Submitted": "auto-replied" },
  });
  const result = await tick();
  assert(result.postponed === 1, "it postpones");
  assert(sends.length === before, "nothing is sent");
  const row = getSalesSequence(item.id)!;
  assert(row.status === "active", "and it isn't stopped");
  const expected = Date.UTC(back.getUTCFullYear(), back.getUTCMonth(), back.getUTCDate(), 10) - 330 * MIN;
  assert(new Date(row.next_step_at!).getTime() === expected, "the next step moves to the return date");
  await tick(after(HOUR));
  assert(new Date(getSalesSequence(item.id)!.next_step_at!).getTime() === expected, "scanning again changes nothing");

  reply(item, "Actually, I saw this - call me", { at: clock.getTime() });
  await tick(after(HOUR));
  assert(getSalesSequence(item.id)!.stop_reason === "replied", "a real reply after it still stops");
}
{
  nextScenario();
  const item = enrol();
  const message = reply(item, "I am away with limited access.", { subject: "Out of office" });
  await tick();
  const row = getSalesSequence(item.id)!;
  assert(new Date(row.next_step_at!).getTime() === message.at + 3 * DAY, "no stated date means 3 days");
  const count = sends.length;
  await tick(new Date(message.at + 3 * DAY + HOUR));
  assert(sends.length === count + 1 || !inSendWindow(new Date(message.at + 3 * DAY + HOUR), null), "and it resumes after that");
}

// A rule that fires between writing and sending still stops the send.
{
  nextScenario();
  const before = sends.length;
  const item = enrol();
  duringWrite = () => {
    duringWrite = undefined;
    reply(item, "Yes please", { at: clock.getTime() });
  };
  await tick();
  assert(sends.length === before, "the check right before the send catches it");
  assert(getSalesSequence(item.id)!.stop_reason === "replied", "and stops the sequence");
}

// A failed scan means no send this tick.
{
  nextScenario();
  const before = sends.length;
  const item = enrol();
  setSequenceRunnerTestHooks({
    calendarEvents: async () => {
      throw new Error("calendar down");
    },
  });
  const result = await tick();
  assert(result.sent === 0 && sends.length === before, "no check, no send");
  assert(getSalesSequence(item.id)!.status === "active", "and it stays active for the next tick");
  setSequenceRunnerTestHooks({
    calendarEvents: async (email) =>
      calendar.filter((entry) => entry.email === email).map((entry) => ({ attendees: [{ email: entry.email }] })),
  });
}

// Writer unavailable: wait an hour, never send.
{
  nextScenario();
  const before = sends.length;
  const item = enrol();
  setCompleteForTests(async (params: CompleteParams) => {
    const system = (params.system as { cacheable?: string }).cacheable ?? "";
    if (system === WRITER_SYSTEM) {
      throw new Error("model down");
    }
    if (system === LOCATION_SYSTEM) {
      return answer(NO_LOCATION);
    }
    return answer('{"ask":"demo"}');
  });
  const result = await tick();
  assert(result.sent === 0 && sends.length === before, "no email, no send");
  const row = getSalesSequence(item.id)!;
  assert(row.status === "active", "the sequence waits");
  assert(new Date(row.next_step_at!).getTime() === clock.getTime() + HOUR, "and retries in an hour");
  restoreModels();
}

// ======== "Tuesday 3pm works" stops it and reaches auto-scheduling ========
{
  nextScenario();
  const before = sends.length;
  const item = enrol();
  const message = reply(item, "Tuesday 3pm works", { at: clock.getTime() - MIN, subject: "Re: IraVoice" });
  await tick();
  assert(sends.length === before, "no more follow-ups");
  assert(getSalesSequence(item.id)!.stop_reason === "replied", "the sequence stops as replied");
  let schedulingSends = 0;
  setMeetingTestHooks({
    detect: async () => ({
      kind: "proposes_times",
      proposed_times: [new Date(clock.getTime() + 3 * DAY).toISOString()],
      window_hint: null,
      duration_minutes: 30,
      sender_timezone: null,
      sender_type: "prospect_enquiry",
      confidence: 0.97,
    }),
    loadBusy: async () => [],
    slotIsFree: async () => true,
    openingLine: async () => "Thanks for getting back to me.",
    signatureHtml: "<div>Vishnu Rajan</div>",
    sendImpl: async () => {
      schedulingSends += 1;
      return { messageId: `sched-${schedulingSends}` };
    },
  });
  await processInboundMeetingMessage(api, workAccount, toGmail(message), clock);
  assert(getMeetingThread(item.threadId) !== undefined, "the reply reaches the meeting flow");
  assert(schedulingSends === 1, `the existing auto-scheduling path answers it, got ${schedulingSends}`);
  setMeetingTestHooks({ loadBusy: async () => busy });
}

// ======== the six collisions ========
// 1. No duplicate follow-up nudge.
{
  nextScenario();
  const item = enrol();
  const control = push({
    threadId: `control-${item.id}`,
    from: `Vishnu Rajan <${ME}>`,
    to: "Lena <lena@control.example>",
    subject: "Pricing",
    at: clock.getTime() - DAY,
    sent: true,
    body: "Waiting on you",
  });
  const candidates = await collectCandidates(gmail, ME, "work", new Set([ME]));
  assert(candidates.some((candidate) => candidate.threadId === control.threadId), "another thread is still tracked");
  assert(!candidates.some((candidate) => candidate.threadId === item.threadId), "the sequence thread is not");
  const tracked = createFollowup({
    threadId: item.threadId,
    recipient: item.email,
    subject: "x",
    tag: "work",
    lastSentAt: clock.toISOString(),
    nextCheckAt: new Date(clock.getTime() - HOUR).toISOString(),
    googleAccount: "work",
    importance: "high",
  });
  assert(!dueFollowupsNow(clock).some((row) => row.id === tracked.id), "a thread tracked earlier gets no nudge");
  assert(!activeFollowups().some((row) => row.id === tracked.id), "and isn't on the panel");
  let refused = false;
  await createFollowupDraftForApproval(tracked.id, false).catch(() => {
    refused = true;
  });
  assert(refused, "and an old Draft button can't make a second email");
  stopActiveSalesSequence(item.id, "owner_stop");
  assert(activeFollowups().some((row) => row.id === tracked.id), "the tracker comes back once the sequence stops");

  nextScenario();
  const finished = enrol({ manual: 3 });
  await tick();
  assert(getSalesSequence(finished.id)!.status === "completed", "a sequence finishes");
  const later = await collectCandidates(gmail, ME, "work", new Set([ME]));
  assert(!later.some((candidate) => candidate.threadId === finished.threadId), "the scan doesn't start nudging after its last note");
}

// 2. The promise scan skips what the sequence sent.
{
  nextScenario();
  const item = enrol();
  await tick();
  const stepId = getSalesSequenceStep(item.id, 1)!.sent_message_id!;
  const message = allMessages().find((entry) => entry.id === stepId)!;
  message.body = "I will send you the deck by Friday.";
  const mine = push({
    threadId: `promise-${item.id}`,
    from: `Vishnu Rajan <${ME}>`,
    to: "Lena <lena@control.example>",
    subject: "Deck",
    at: clock.getTime() - HOUR,
    sent: true,
    body: "I will send you the deck by Friday.",
  });
  await runPromiseScan(api);
  assert(getPromiseByMessageId(mine.id) !== undefined, "his own promise is tracked");
  assert(getPromiseByMessageId(stepId) === undefined, "a sequence email is not");
}

// 3. No blocked cards: whatever the writer wrote goes as written, and the
// sequence's own send isn't taken for his own email.
{
  nextScenario();
  const before = sends.length;
  const item = enrol();
  writerBody = "Hi Priya,\n\nIt starts at $500 a month with a 20% discount, and we guarantee go-live in 2 weeks. Deck attached.";
  await tick();
  assert(sends.length === before + 1, "a draft the old checks would have blocked goes out");
  assert(sends[before]!.parsed.plain.includes("$500 a month with a 20% discount"), "exactly as written");
  assert(telegram.sent.length === 0, "with no card");
  const result = await tick(after(10 * MIN));
  assert(result.stopped === 0 && getSalesSequence(item.id)!.status === "active", "its own send isn't taken for his own email");
}

// 4. Crash handling: never a second send.
{
  nextScenario();
  const before = sends.length;
  const item = enrol();
  sendMode = "deliver_then_throw";
  await tick();
  assert(sends.length === before + 1, "Gmail took the message before the crash");
  assert(getSalesSequenceStep(item.id, 1)!.status === "sending", "the claim stays");
  assert(getSalesSequenceStep(item.id, 1)!.sent_message_id === null, "nothing was recorded");
  sendMode = "ok";
  telegram.sent.length = 0;
  await tick(after(5 * MIN));
  assert(sends.length === before + 1, "no second send");
  const row = getSalesSequence(item.id)!;
  assert(row.status === "stopped" && row.stop_reason === "send_recovered", "the self-email check sees it and stops");
  const recovered = getSalesSequenceStep(item.id, 1)!;
  assert(recovered.status === "sent" && Boolean(recovered.sent_message_id), "the found message is recorded");
  assert(telegram.sent.length === 1 && telegram.sent[0]!.includes("double send"), "one line says so");
  await tick(after(5 * MIN));
  assert(sends.length === before + 1, "and never again");
}
{
  nextScenario();
  const before = sends.length;
  const item = enrol();
  sendMode = "throw_no_deliver";
  await tick();
  assert(getSalesSequenceStep(item.id, 1)!.status === "sending", "an unknown result keeps the claim");
  sendMode = "ok";
  await tick(after(10 * MIN));
  assert(sends.length === before, "it isn't retried");
  assert(getSalesSequence(item.id)!.status === "active", "and waits to see whether it shows up");
  telegram.sent.length = 0;
  await tick(after(30 * MIN));
  assert(sends.length === before, "still no send");
  assert(getSalesSequence(item.id)!.stop_reason === "send_unconfirmed", "after 30 minutes it stops");
  assert(telegram.sent[0]!.includes("won't resend"), "and he's told");
}
{
  nextScenario();
  const before = sends.length;
  const item = enrol();
  sendMode = "reject_403";
  await tick();
  assert(getSalesSequenceStep(item.id, 1)!.status === "planned", "a definite refusal releases the claim");
  assert(new Date(getSalesSequence(item.id)!.next_step_at!).getTime() === clock.getTime() + HOUR, "and retries in an hour");
  sendMode = "ok";
  await tick(after(HOUR));
  assert(sends.length === before + 1, "the retry sends it once");
}
{
  nextScenario();
  const item = enrol();
  sendMode = "reject_400";
  await tick();
  assert(getSalesSequence(item.id)!.stop_reason === "send_rejected", "an invalid email stops rather than loops");
}

// ======== stop_sequence and /sequences ========
{
  nextScenario();
  const rajanA = enrol({ first: "Rajan", company: "Alpha" });
  const rajanB = enrol({ first: "Rajan", company: "Beta", email: `rajan@beta${enrolCounter}.example` });
  const talk = enrol({ first: "Priya", company: "Talkdesk" });
  const meera = enrol({ first: "Meera", company: "Gamma" });

  const handler = tools.stop_sequence!.handler as (input: unknown, turn: unknown) => Promise<string>;
  assert((TOOL_ORDER as readonly string[]).includes("stop_sequence"), "the tool is registered");
  assert(!(FORWARDED_TOOLS as readonly string[]).includes("stop_sequence"), "it isn't offered on forwarded messages");
  const description = String(tools.stop_sequence!.definition.description);
  for (const phrase of ["stop following up with", "don't email", "pause all follow-ups"]) {
    assert(description.includes(phrase), `the tool description names "${phrase}"`);
  }

  let forwardedThrew = false;
  await handler({ target: "all" }, {}).catch(() => {
    forwardedThrew = true;
  });
  assert(forwardedThrew, "with no owner confirmation it refuses");
  assert(listActiveSalesSequences().length === 4, "and stops nothing");

  const ambiguous = await handler({ target: "Rajan" }, { confirmation });
  assert(ambiguous.startsWith("Nothing stopped yet"), "an ambiguous name asks first");
  assert(ambiguous.includes(rajanA.email) && ambiguous.includes(rajanB.email), "and lists who");
  assert(listActiveSalesSequences().length === 4, "stopping nothing");

  const none = await handler({ target: "Nobody" }, { confirmation });
  assert(none.startsWith("Nothing stopped"), "no match stops nothing");

  const company = await handler({ target: "Talkdesk" }, { confirmation });
  assert(company.includes(talk.email) && company.startsWith("Stopped"), "by company, saying exactly what stopped");
  assert(getSalesSequence(talk.id)!.stop_reason === "owner_stop", "it is stopped");

  const byName = await handler({ target: "Meera" }, { confirmation });
  assert(byName.startsWith("Stopped") && byName.includes(meera.email), "by name, saying exactly what stopped");
  assert(getSalesSequence(meera.id)!.status === "stopped", "it is stopped");
  assert(getSalesSequence(rajanA.id)!.status === "active", "and nobody else is");

  const panel = sequencesPanel(clock);
  assert(panel.text.includes("step 1 of 4"), "/sequences shows the step");
  assert(panel.text.includes("next "), "and the next send time");
  const buttons = panel.keyboard!.inline_keyboard.flat() as Array<{ callback_data?: string; text: string }>;
  assert(buttons.every((button) => button.text.startsWith("Stop ") && button.callback_data?.startsWith("seq:stop:")), "with a Stop button each");

  const replies: string[] = [];
  await handleSequencesCommand({
    message: { forward_origin: { type: "user" } },
    reply: async (text: string) => {
      replies.push(text);
      return {};
    },
  } as unknown as Context);
  assert(replies[0]!.includes("forwarded"), "a forwarded /sequences is refused");

  const edited: string[] = [];
  await handleSequenceStopCallback({
    callbackQuery: { data: `seq:stop:${rajanA.id}` },
    answerCallbackQuery: async () => true,
    editMessageText: async (text: string) => {
      edited.push(text);
      return true;
    },
    reply: async () => ({}),
  } as unknown as Context);
  assert(getSalesSequence(rajanA.id)!.stop_reason === "owner_stop", "the button stops it");
  assert(edited[0]!.startsWith("Stopped:") && edited[0]!.includes(rajanA.email), "and says what stopped");

  const all = await stopSequenceFromTool("all follow-ups", { confirmation });
  assert(all.startsWith("Stopped"), `"all" stops the rest, got ${all}`);
  assert(listActiveSalesSequences().length === 0, "nothing is left");
  const empty = await handler({ target: "all" }, { confirmation });
  assert(empty.startsWith("Nothing stopped"), "stopping again says so");
  assert(sequencesPanel(clock).keyboard === undefined, "an empty list has no buttons");
}

// ======== correcting a prospect's time zone by text or voice ========
{
  nextScenario();
  const munil = enrol({ first: "Munil", company: "Talkdesk" });
  const jeffA = enrol({ first: "Jeff", company: "Alpha" });
  const jeffB = enrol({ first: "Jeff", company: "Beta", email: `jeff@beta${enrolCounter}.example` });
  setSalesSequenceTimezone(munil.id, "America/Los_Angeles", "company");
  const handler = tools.set_sequence_timezone!.handler as (input: unknown, turn: unknown) => string;
  assert((TOOL_ORDER as readonly string[]).includes("set_sequence_timezone"), "the tool is registered");
  assert(!(FORWARDED_TOOLS as readonly string[]).includes("set_sequence_timezone"), "it isn't offered on forwarded messages");
  const description = String(tools.set_sequence_timezone!.definition.description);
  assert(description.includes("Munil is in New York") && description.includes("set Jeff's timezone to Pacific"), "the description names both phrasings");
  let threw = false;
  try {
    handler({ target: "Munil", timezone: "New York" }, {});
  } catch {
    threw = true;
  }
  assert(threw, "with no owner confirmation it refuses");
  assert(getSalesSequence(munil.id)!.prospect_timezone === "America/Los_Angeles", "and changes nothing");

  const set = handler({ target: "Munil", timezone: "New York" }, { confirmation });
  assert(set.startsWith("Set: Munil Shah, Talkdesk - US Eastern"), `it says what changed: ${set}`);
  const row = getSalesSequence(munil.id)!;
  assert(row.prospect_timezone === "America/New_York" && row.prospect_timezone_source === "owner", "the zone is his now");
  assert(setSequenceTimezoneFromTool({ target: "Munil", timezone: "America/Chicago" }, { confirmation }).includes("US Central"), "an IANA name works");

  const ambiguous = handler({ target: "Jeff", timezone: "Pacific" }, { confirmation });
  assert(ambiguous.startsWith("Nothing changed yet") && ambiguous.includes("Jeff Shah, Alpha") && ambiguous.includes("Jeff Shah, Beta"), "two Jeffs: it asks which");
  assert(handler({ target: "Jeff Beta", timezone: "Pacific" }, { confirmation }).startsWith("Nothing changed"), "a name it can't match changes nothing");
  assert(handler({ target: "Beta", timezone: "Pacific" }, { confirmation }).includes("Jeff Shah, Beta - US Pacific"), "by company it's one");
  assert(getSalesSequence(jeffA.id)!.prospect_timezone === null, "the other Jeff is untouched");
  assert(handler({ target: "Munil", timezone: "Atlantis" }, { confirmation }).startsWith("Nothing changed"), "an unknown place changes nothing");
  assert(handler({ target: "all", timezone: "Pacific" }, { confirmation }).startsWith("Nothing changed yet"), "\"all\" isn't a way to set every zone");

  // His setting is never looked up again, and the window follows it.
  locationAnswer = '{"timezone":"Asia/Kolkata","basis":"signature"}';
  await tick();
  assert(getSalesSequence(munil.id)!.prospect_timezone === "America/Chicago", "a tick doesn't overwrite his correction");
  assert(getSalesSequence(munil.id)!.steps_sent === 0, "11:30 IST is Chicago's night, so nothing went to Munil");
  const panel = sequencesPanel(clock).text;
  assert(panel.includes("- Munil Shah, Talkdesk - US Central\n  step 1 of 4, next "), `/sequences shows each prospect's zone: ${panel}`);
  assert(/US Central\)/.test(panel), "with the next send in their time");
  assert(panel.includes("Jeff Shah, Beta - US Pacific"), "Jeff's correction shows too");
  void jeffB;
}

// Start stays owner-only too.
{
  const start = tools.start_sequence!.handler as (input: unknown, turn: unknown) => Promise<string>;
  let threw = false;
  await start({ prospect: "anyone" }, { userText: "start a sequence for anyone" }).catch(() => {
    threw = true;
  });
  assert(threw, "a turn with no owner confirmation can't start one");
}

log("test-sequence-send: ok");
process.exit(0);
