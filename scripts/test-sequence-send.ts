import "dotenv/config";
import type { Api, Context } from "grammy";
import type { gmail_v1 } from "googleapis";
import {
  consumeDraftEdit,
  handleApprovalCallback,
  setApprovalsTestHooks,
  setDraftRefresher,
} from "../src/approvals.ts";
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
  getPendingActionForDraft,
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
import { MODEL_CHECK_SYSTEM } from "../src/sequence_check.ts";
import { domainInSet, evaluatePitchExclusion, prospectKey } from "../src/sequence_logic.ts";
import {
  classifyInbound,
  evaluateStopRules,
  inSendWindow,
  matchSequencesForStop,
  nextSendWindow,
  outOfOfficeUntil,
  parseDateHeaderOffset,
  slotsInProspectDay,
  slotDisplayZone,
  topReplyText,
  type InboundFact,
} from "../src/sequence_rules.ts";
import {
  handleSequencesCommand,
  handleSequenceStopCallback,
  refreshSequenceDraftSlots,
  registerSequenceSend,
  runSequenceTick,
  sequencesPanel,
  setSequenceRunnerTestHooks,
  stopSequenceFromTool,
} from "../src/sequence_runner.ts";
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
const FACTS = "scripts/fixtures/sales_facts_ready.md";
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
let checkAnswer = '{"pass":true,"reason":"ok"}';
let duringWrite: (() => void) | undefined;

function answer(text: string): CompleteResult {
  return {
    textParts: [text],
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "end_turn",
  } as CompleteResult;
}

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
        body: slots
          ? `Hi ${first},\n\nJust a quick follow-up on a short demo.\n\n${SLOTS_TOKEN}\n\nDo any of these suit you?`
          : `Hi ${first},\n\nJust a quick follow-up on my earlier note. IraVoice answers inbound support calls in Hindi and English.\n\nWould a short demo next week work?`,
      }),
    );
  }
  if (system === MODEL_CHECK_SYSTEM) {
    return answer(checkAnswer);
  }
  if (system === ASK_SYSTEM) {
    return answer('{"ask":"demo"}');
  }
  if (system.includes("has_promise")) {
    return answer('{"has_promise":true,"promise":"send the deck","confidence":"high"}');
  }
  return answer('{"needs_followup":true,"reason":"Asked for a demo","importance":"high"}');
});

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
  checkAnswer = '{"pass":true,"reason":"ok"}';
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
    prospectKey: prospectKey(email, PERSONAL_DOMAINS),
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
    setSalesSequenceTimezone(row.id, options.timezone);
  }
  return { id: row.id, threadId, email, domain, pitch, first };
}

function tick(at: Date = clock, factsPath: string | undefined = FACTS) {
  clock = at;
  return runSequenceTick(api, { now: at, factsPath });
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

function approvalCtx(data: string, notes: { edited: string[]; alerts: string[] } = { edited: [], alerts: [] }): Context {
  return {
    callbackQuery: { data, message: { text: "Draft waiting for approval" } },
    answerCallbackQuery: async (value: unknown) => {
      const text = typeof value === "string" ? value : (value as { text?: string } | undefined)?.text;
      if (text) {
        notes.alerts.push(text);
      }
      return true;
    },
    editMessageText: async (text: string) => {
      notes.edited.push(text);
      return true;
    },
    reply: async () => ({}),
  } as unknown as Context;
}

const confirmation = { chatId: 1, messageId: 42 };

// ======== timezones and the send window (pure) ========
assert(parseDateHeaderOffset("Thu, 5 Nov 2026 10:00:00 -0500") === "-05:00", "reads a negative offset");
assert(parseDateHeaderOffset("Thu, 5 Nov 2026 10:00:00 +0530 (IST)") === "+05:30", "reads an offset before a comment");
assert(parseDateHeaderOffset("Thu, 5 Nov 2026 10:00:00 +0000") === "+00:00", "+0000 is taken literally");
assert(parseDateHeaderOffset("Thu, 5 Nov 2026 10:00:00 -0000") === undefined, "-0000 is unknown by definition");
assert(parseDateHeaderOffset("Thu, 5 Nov 2026 10:00:00 GMT") === undefined, "a named zone is unknown");
assert(parseDateHeaderOffset("not a date") === undefined, "garbage is unknown");
assert(slotDisplayZone(null) === null && slotDisplayZone("+05:30") === null, "IST isn't shown twice");
assert(slotDisplayZone("-05:00") === "-05:00", "another zone is shown");

const ist = (value: string): Date => new Date(`${value}+05:30`);
assert(inSendWindow(ist("2026-11-10T10:00:00"), null), "10:00 IST Tuesday is in the window");
assert(!inSendWindow(ist("2026-11-10T09:59:00"), null), "09:59 is before it");
assert(inSendWindow(ist("2026-11-10T16:59:00"), null), "16:59 is in it");
assert(!inSendWindow(ist("2026-11-10T17:00:00"), null), "17:00 is after it");
assert(!inSendWindow(ist("2026-11-14T11:00:00"), null), "Saturday is out");
assert(!inSendWindow(ist("2026-11-15T11:00:00"), null), "Sunday is out");
assert(!inSendWindow(ist("2026-11-10T11:00:00"), "-05:00"), "11:00 IST is 00:30 in New York");
// The window has to satisfy their hours and 09:00-19:00 IST at once.
assert(!inSendWindow(ist("2026-11-10T21:00:00"), "-05:00"), "10:30 in New York is 21:00 IST, past the floor");
assert(!inSendWindow(ist("2026-11-10T15:29:00"), "+00:00"), "09:59 in London is before their window");
assert(inSendWindow(ist("2026-11-10T15:30:00"), "+00:00"), "10:00 in London is 15:30 IST");
assert(inSendWindow(ist("2026-11-10T18:59:00"), "+00:00"), "18:59 IST is inside the floor");
assert(!inSendWindow(ist("2026-11-10T19:00:00"), "+00:00"), "19:00 IST is out, though it's 13:30 in London");
assert(!inSendWindow(ist("2026-11-10T08:59:00"), "+08:00"), "08:59 IST is out, though it's 11:29 in Singapore");
assert(inSendWindow(ist("2026-11-10T09:00:00"), "+08:00"), "09:00 IST is in, at 11:30 in Singapore");
assert(inSendWindow(ist("2026-11-10T14:29:00"), "+08:00"), "16:59 in Singapore is in");
assert(!inSendWindow(ist("2026-11-10T14:30:00"), "+08:00"), "17:00 in Singapore is out");
assert(
  nextSendWindow(ist("2026-11-13T18:00:00"), null).getTime() === ist("2026-11-16T10:00:00").getTime(),
  "Friday evening rolls to Monday 10:00",
);
assert(
  nextSendWindow(ist("2026-11-14T12:00:00"), null).getTime() === ist("2026-11-16T10:00:00").getTime(),
  "Saturday rolls to Monday 10:00",
);
assert(
  nextSendWindow(ist("2026-11-10T08:00:00"), null).getTime() === ist("2026-11-10T10:00:00").getTime(),
  "early morning rolls to 10:00 the same day",
);
assert(
  nextSendWindow(ist("2026-11-10T11:00:00"), null).getTime() === ist("2026-11-10T11:00:00").getTime(),
  "a moment inside the window stays put",
);
assert(
  nextSendWindow(ist("2026-11-10T19:10:00"), "+00:00")?.getTime() === ist("2026-11-11T15:30:00").getTime(),
  "past the floor rolls to the next day's overlap",
);
assert(
  nextSendWindow(ist("2026-11-13T19:10:00"), "+00:00")?.getTime() === ist("2026-11-16T15:30:00").getTime(),
  "past the floor on a Friday rolls to Monday",
);
assert(
  nextSendWindow(ist("2026-11-10T14:30:00"), "+08:00")?.getTime() === ist("2026-11-11T09:00:00").getTime(),
  "the next Singapore window opens at the floor, not at 10:00 their time",
);
assert(
  nextSendWindow(ist("2026-11-10T11:00:00"), "-03:00")?.getTime() === ist("2026-11-10T18:30:00").getTime(),
  "-03:00 still has half an hour",
);
assert(nextSendWindow(ist("2026-11-10T11:00:00"), "-03:30") === undefined, "-03:30 never meets the floor");
assert(nextSendWindow(ist("2026-11-10T11:00:00"), "-05:00") === undefined, "New York never meets the floor");
assert(nextSendWindow(ist("2026-11-10T11:00:00"), "-08:00") === undefined, "nor does California");
// Offered slots against 08:00-20:00 their time.
{
  const slot = (start: string) => ({
    start: new Date(`${start}Z`),
    end: new Date(new Date(`${start}Z`).getTime() + 20 * 60_000),
  });
  const count = (start: string, timezone: string | null) => slotsInProspectDay([slot(start)], timezone);
  assert(count("2026-11-10T08:00:00", "+00:00") === 1, "08:00 their time counts");
  assert(count("2026-11-10T07:59:00", "+00:00") === 0, "07:59 doesn't");
  assert(count("2026-11-10T19:40:00", "+00:00") === 1, "a slot ending at 20:00 counts");
  assert(count("2026-11-10T19:50:00", "+00:00") === 0, "one running past 20:00 doesn't");
  assert(count("2026-11-10T04:30:00", "-05:00") === 0, "10:00 IST is 23:30 in New York");
  assert(count("2026-11-10T23:50:00", "+00:00") === 0, "one crossing midnight doesn't");
  assert(count("2026-11-10T04:30:00", null) === 1, "unknown means IST");
}
assert(
  nextSendWindow(ist("2026-11-10T11:00:00"), "+04:00")?.toISOString() === "2026-11-10T06:00:00.000Z",
  "rolling uses their 10:00",
);

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
  pausedOnCard: false,
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
    factsReady: true,
    testRecipients: [],
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
      check_result: JSON.stringify({ deterministic: [], model: { pass: true, reason: "ok" } }),
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
  ["TODO fact sheet", { factsReady: false }, "facts_not_ready"],
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
  ["test list", { testRecipients: ["other@acme.com"] }, "outside_test_list"],
  ["stopped", { sequence: sequenceWith({ status: "stopped" }) }, "sequence_not_active"],
  ["no row", { sequence: undefined }, "sequence_not_active"],
  ["wrong thread", { sequenceThreadId: "other" }, "wrong_thread"],
  ["another at the company", { openSequenceId: 8 }, "company_has_other_sequence"],
  ["already claimed", { step: stepWith({ status: "sending" }) }, "step_not_ready"],
  ["already sent", { step: stepWith({ sent_message_id: "m" }) }, "step_not_ready"],
  ["wrong step", { stepNo: 2 }, "step_not_ready"],
  ["manual bump used it", { sequence: sequenceWith({ manual_followups: 1 }) }, "step_used_by_manual_followup"],
  ["all four used", { stepNo: 4, sequence: sequenceWith({ current_step: 4, manual_followups: 1, steps_sent: 3 }) }, "followups_used_up"],
  ["different body", { body: "Something else" }, "body_not_the_checked_draft"],
  ["empty body", { body: " " }, "body_not_the_checked_draft"],
  ["never checked", { step: stepWith({ check_result: null }) }, "draft_not_checked"],
  ["failed model check", { step: stepWith({ check_result: JSON.stringify({ deterministic: [], model: { pass: false } }) }) }, "draft_not_checked"],
  ["failed fixed check", { step: stepWith({ check_result: JSON.stringify({ deterministic: ["price"], model: null }) }) }, "draft_not_checked"],
  ["no thread header", { inReplyTo: "" }, "no_thread_headers"],
  ["weekend", { now: ist("2026-11-14T11:00:00") }, "outside_window"],
  ["after hours", { now: ist("2026-11-10T18:00:00") }, "outside_window"],
  ["daily cap", { sendsToday: 15 }, "daily_cap"],
  ["spacing", { minutesSinceLastSend: 2.9 }, "spacing"],
];
for (const [label, overrides, reason] of refusals) {
  const gate = evaluateSequenceSendGate(gateInput(overrides));
  assert(!gate.ok && gate.reason === reason, `${label}: expected ${reason}, got ${JSON.stringify(gate)}`);
}

// ======== the send function refuses before touching Gmail ========
{
  nextScenario();
  const item = enrol();
  const prepared = await prepareSequenceStep(item.id, { now: clock, factsPath: FACTS });
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
    factsPath: FACTS,
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
  await refused({ body: "Changed after the check" }, "body_not_the_checked_draft");
  await refused({ factsPath: "docs/sales_facts.md" }, "facts_not_ready");
  await refused({ threadId: "another-thread" }, "wrong_thread");
  settings.sequencesEnabled = false;
  await refused({}, "disabled");
  assert((await runSequenceTick(api, { now: clock, factsPath: FACTS })).scanned === 0, "the kill switch stops the whole tick");
  assert(registerSequenceSend(api) === undefined, "the kill switch registers no job");
  assert(formatHealthReport(clock).includes("sequence-send: off"), "/health shows it off");
  settings.sequencesEnabled = true;
  assert((HEALTH_JOBS as readonly string[]).includes("sequence-send"), "sequence-send is on /health");
  assert(!formatHealthReport(clock).includes("sequence-send: off"), "/health shows it on");

  await sendSequenceStep(params);
  assert(sends.length === 1, "the checked draft goes out");
  let repeat = "";
  await sendSequenceStep({ ...params, now: new Date(clock.getTime() + HOUR) }).catch((error: unknown) => {
    repeat = error instanceof SequenceSendRefusedError ? error.reason : "other";
  });
  assert(repeat === "step_not_ready", `the same step can't go twice, got ${repeat}`);
  assert(sends.length === 1, "a repeat doesn't reach Gmail");
}

// ======== a whole sequence: threading, timing, silence, Sonnet ========
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

  const check = modelCalls.find((call) => (call.system as { cacheable?: string }).cacheable === MODEL_CHECK_SYSTEM)!;
  assert(check.backend === "claude", "the second check runs on Claude");
  assert(check.model === config.claudeModel, "on the configured Sonnet model");
  assert(check.noFallback === true, "with no fallback to another model");
  assert(check.effort === "high" && check.maxTokens! >= 4000, "with room to reason before its verdict");
  assert(check.task === "sequence_check", "and its cost is logged under its own task");

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
{
  nextScenario();
  const before = sends.length;
  enrolCounter += 1;
  const email = `sam@us${enrolCounter}.example`;
  const threadId = `tz-${enrolCounter}`;
  push({
    threadId: `old-${enrolCounter}`,
    from: `Sam Lee <${email}>`,
    to: ME,
    subject: "Old mail",
    at: Date.now() - 40 * DAY,
    sent: false,
    body: "Hello from long ago",
    extra: { Date: "Mon, 28 Sep 2026 09:00:00 -0500" },
  });
  const pitch = push({
    threadId,
    from: `Vishnu Rajan <${ME}>`,
    to: `Sam Lee <${email}>`,
    subject: "IraVoice for Us",
    // Start stamps real time, so this thread has to be in the real past.
    at: Date.now() - 3 * DAY,
    sent: true,
    body: "Hi Sam,\n\nEpicode builds IraVoice, which answers inbound support calls in Hindi and English. Would you be open to a short demo?",
  });
  const row = createProposedSalesSequence({
    threadId,
    prospectEmail: email,
    prospectDomain: email.split("@")[1]!,
    prospectKey: email.split("@")[1]!,
    prospectName: "Sam Lee",
    prospectCompany: "Us",
    subject: "IraVoice for Us",
    originalMessageId: pitch.id,
    originalSentAt: new Date(pitch.at).toISOString(),
    manualFollowups: 0,
    classifierConfidence: 0.9,
    classifierReason: "pitch",
  })!;
  let startedReply = "";
  await handleSequenceCallback({
    callbackQuery: { data: `seq:start:${row.id}` },
    answerCallbackQuery: async () => true,
    editMessageText: async (text: string) => {
      startedReply = text;
      return true;
    },
    editMessageReplyMarkup: async () => true,
    reply: async () => ({}),
  } as unknown as Context);
  const started = getSalesSequence(row.id)!;
  assert(started.status === "active", "Start activates it");
  assert(started.prospect_timezone === "-05:00", `the offset is stored, got ${started.prospect_timezone}`);
  assert(startedReply.includes("Nothing will go out") && startedReply.includes("-05:00"), "Start says this one can't send");

  // New York's working day never meets 09:00-19:00 IST, so it holds and says why.
  const morningIst = clock;
  assert((await tick(morningIst)).sent === 0, "01:00 their time is out of the window even though it's morning in India");
  assert((await tick(new Date(morningIst.getTime() + 9.5 * HOUR))).sent === 0, "10:30 their time is past the IST floor");
  assert(sends.length === before, "nothing goes out");
  assert(getSalesSequence(row.id)!.status === "active", "it stays active");
  assert(sequencesPanel(morningIst).text.includes("won't send"), "the list says it won't send");

  nextScenario();
  const away = enrol({ manual: 2, timezone: "+04:00" });
  assert(sequencesPanel(clock).text.includes("IST"), "the list shows the next send time");
  const count = sends.length;
  await tick();
  assert(sends.length === count + 1, "step 3 goes out in their window");
  assert(sends[count]!.parsed.plain.includes("GMT+4"), "the slots show their time as well as IST");
  assert(getSalesSequence(away.id)!.prospect_timezone === "+04:00", "the zone stays on the row");
}

// +0000 is taken literally, and the IST floor still applies.
{
  nextScenario();
  const item = enrol();
  push({
    threadId: `old-utc-${item.id}`,
    from: `Priya Shah <${item.email}>`,
    to: ME,
    subject: "Old",
    at: clock.getTime() - 30 * DAY,
    sent: false,
    body: "Old",
    extra: { Date: "Mon, 5 Oct 2026 09:00:00 +0000" },
  });
  await tick();
  assert(getSalesSequence(item.id)!.prospect_timezone === "+00:00", "+0000 is stored literally");
  assert(getSalesSequence(item.id)!.steps_sent === 0, "06:00 their time is out, though it's 11:30 IST");
  const start = clock;
  assert((await tick(new Date(start.getTime() + 8 * HOUR))).sent === 0, "19:30 IST is past the floor, though it's 14:00 their time");
  assert(getSalesSequenceStep(item.id, 1)!.status === "planned", "nothing was claimed");
  assert((await tick(new Date(start.getTime() + 22 * HOUR + 30 * 60_000))).sent === 0, "10:00 IST next day is 04:30 their time");
  assert((await tick(new Date(start.getTime() + 28 * HOUR))).sent === 1, "the next day's overlap sends it");
}

// The send gate holds the floor on its own, whatever the runner did.
{
  nextScenario();
  const item = enrol({ timezone: "+00:00" });
  const prepared = await prepareSequenceStep(item.id, { now: clock, factsPath: FACTS });
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
      now: new Date(clock.getTime() + 8 * HOUR), // 19:30 IST, 14:00 their time
      factsPath: FACTS,
    });
  } catch (error) {
    refused = error instanceof SequenceSendRefusedError ? error.reason : "other";
  }
  assert(refused === "outside_window", `the gate refuses past the floor, got ${refused}`);
  assert(sends.length === count, "and nothing reaches Gmail");
  assert(getSalesSequenceStep(item.id, 1)!.status === "planned", "and the step isn't claimed");
}

// ======== step 3 when the offered times fall outside their day ========
function afternoonsBusy(from: Date): Array<{ start: Date; end: Date }> {
  const out: Array<{ start: Date; end: Date }> = [];
  for (let day = -1; day < 60; day += 1) {
    const base = new Date(from.getTime() + day * DAY);
    base.setUTCHours(7, 30, 0, 0); // 13:00 IST
    out.push({ start: base, end: new Date(base.getTime() + 10 * HOUR) });
  }
  return out;
}

{
  nextScenario();
  const item = enrol({ manual: 2, timezone: "+00:00" });
  const at = new Date(clock.getTime() + 4.5 * HOUR); // 16:00 IST, 10:30 their time
  busy = afternoonsBusy(at);
  const offer = (await offerSlots(at, "+00:00"))!;
  assert(offer.inTheirDay < 2, `the only free times are their night, got ${offer.inTheirDay}`);
  const count = sends.length;
  const checksBefore = modelCalls.filter((call) => call.task === "sequence_check").length;
  await tick(at);
  const step = getSalesSequenceStep(item.id, 3)!;
  assert(sends.length === count, "nothing auto-sends");
  assert(step.status === "blocked", "step 3 goes to a card");
  assert(step.reason?.includes("slots_off_hours") === true, `the card says why, got ${step.reason}`);
  assert(JSON.parse(step.check_result!).deterministic.includes("slots_off_hours"), "the send gate would refuse it too");
  assert(modelCalls.filter((call) => call.task === "sequence_check").length === checksBefore, "the second check isn't spent on it");
  assert((await tick(new Date(at.getTime() + HOUR))).sent === 0, "it stays paused");

  // He removes a time he doesn't want, and it doesn't come back on Send.
  const stored = JSON.parse(step.slot_lines!) as string[];
  const action = getPendingActionForDraft(step.draft_id!)!;
  const kept = stored.slice(0, 1);
  const body = `Hi Priya,\n\nCould we find 15-20 minutes?\n${kept.join("\n")}`;
  const draft = drafts.get(step.draft_id!)!;
  drafts.set(step.draft_id!, {
    raw: Buffer.from(
      Buffer.from(draft.raw, "base64url").toString("utf8").replace(
        /Content-Type: text\/plain[^\r]*\r\nContent-Transfer-Encoding: base64\r\n\r\n[A-Za-z0-9+/=\r\n]+?(?=\r\n--)/,
        `Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(body, "utf8").toString("base64")}`,
      ),
    ).toString("base64url"),
    threadId: draft.threadId,
  });
  clock = new Date(clock.getTime() + 2 * DAY);
  busy = [];
  const drafted = draftSends.length;
  await handleApprovalCallback(approvalCtx(`approval:send:${action.id}`), "send", action.id);
  assert(draftSends.length === drafted + 1, "Send sends what he chose");
  const sentBody = draftSends[drafted]!.parsed.plain;
  assert(kept.every((line) => sentBody.includes(line)), "the time he kept went out");
  assert(stored.slice(1).every((line) => !sentBody.includes(line)), "the time he removed stays out");
  assert(getSalesSequenceStep(item.id, 3)!.status === "sent", "the step is recorded");
  assert(getSalesSequence(item.id)!.status === "active" && getSalesSequence(item.id)!.current_step === 4, "and the sequence carries on");
}
// Two or more in their day: no card, same as ever.
{
  nextScenario();
  const item = enrol({ manual: 2, timezone: "+04:00" });
  const offer = (await offerSlots(clock, "+04:00"))!;
  assert(offer.inTheirDay >= 2, `Dubai's day covers his hours, got ${offer.inTheirDay}`);
  const count = sends.length;
  await tick();
  assert(sends.length === count + 1, "step 3 goes out automatically");
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

// ======== the test allowlist ========
{
  nextScenario();
  const before = sends.length;
  const listed = enrol({ first: "Lata" });
  const other = enrol({ first: "Omar" });
  settings.sequenceTestRecipients = [listed.email];
  const result = await tick();
  assert(result.sent === 1 && sends.length === before + 1, "one email");
  assert(sends[before]!.parsed.headers.to!.includes(listed.email), "only the listed address gets it");
  assert((await tick(after(10 * MIN))).sent === 0, "the other stays unsent");
  assert(getSalesSequence(other.id)!.status === "active", "and isn't stopped");
  assert(getSalesSequence(other.id)!.steps_sent === 0, "and nothing went to it");
  const pitch = evaluatePitchExclusion(
    {
      to: [{ name: "Omar", email: other.email }],
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
      isOutsideTestList: () => true,
      threadHasSequence: false,
      prospectHasOpenSequence: () => false,
      threadInMeetingFlow: false,
    },
  );
  assert(pitch === "not_test_recipient", "and they get no card either");
  settings.sequenceTestRecipients = [];
}

// ======== the fact sheet ========
{
  nextScenario();
  const before = sends.length;
  const item = enrol();
  const replied = enrol({ first: "Ravi" });
  reply(replied, "Yes, tell me more");
  const result = await tick(clock, "docs/sales_facts.md");
  assert(result.sent === 0 && sends.length === before, "no send while sales_facts.md has TODO markers");
  assert(modelCalls.length === 0, "and no model is asked");
  assert(getSalesSequenceStep(item.id, 1)!.status === "planned", "the step waits");
  assert(getSalesSequence(replied.id)!.stop_reason === "replied", "stop rules still run");
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
    prospectKey: domain,
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
  const prepared = await prepareSequenceStep(item.id, { now: clock, factsPath: FACTS });
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
      factsPath: FACTS,
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

// Second check unavailable: wait, never fall back and never send.
{
  nextScenario();
  const before = sends.length;
  const item = enrol();
  setCompleteForTests(async (params: CompleteParams) => {
    const system = (params.system as { cacheable?: string }).cacheable ?? "";
    if (system === MODEL_CHECK_SYSTEM) {
      throw new Error("Anthropic down");
    }
    if (system === ASK_SYSTEM) {
      return answer('{"ask":"demo"}');
    }
    return answer(
      JSON.stringify({
        body: "Hi Priya,\n\nJust a quick follow-up. IraVoice answers inbound support calls in Hindi and English.\n\nWould a short demo next week work?",
      }),
    );
  });
  const result = await tick();
  assert(result.sent === 0 && sends.length === before, "no check, no send");
  const row = getSalesSequence(item.id)!;
  assert(row.status === "active", "the sequence waits");
  assert(new Date(row.next_step_at!).getTime() === clock.getTime() + HOUR, "and retries in an hour");
  restoreModels();
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
          body: slots
            ? `Hi ${first},\n\nJust a quick follow-up on a short demo.\n\n${SLOTS_TOKEN}\n\nDo any of these suit you?`
            : `Hi ${first},\n\nJust a quick follow-up on my earlier note. IraVoice answers inbound support calls in Hindi and English.\n\nWould a short demo next week work?`,
        }),
      );
    }
    if (system === MODEL_CHECK_SYSTEM) {
      return answer(checkAnswer);
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

// 3 and blocked steps: Send continues, Discard stops, and the sent card isn't "his own email".
{
  nextScenario();
  const before = sends.length;
  const item = enrol();
  checkAnswer = '{"pass":false,"reason":"Sounds like a promise"}';
  await tick();
  const step = getSalesSequenceStep(item.id, 1)!;
  assert(step.status === "blocked", "a failed check blocks the step");
  assert(sends.length === before, "nothing goes out on its own");
  assert(telegram.sent.at(-1)!.startsWith("Draft waiting for approval"), "it's the normal card");
  assert(getSalesSequence(item.id)!.next_step_at === null, "the sequence is paused");
  checkAnswer = '{"pass":true,"reason":"ok"}';
  await tick(after(10 * MIN));
  assert(sends.length === before, "a paused sequence stays paused");

  const action = getPendingActionForDraft(step.draft_id!)!;
  await handleApprovalCallback(approvalCtx(`approval:send:${action.id}`), "send", action.id);
  const done = getSalesSequenceStep(item.id, 1)!;
  assert(done.status === "sent" && Boolean(done.sent_message_id), "Send records the step");
  assert(getSalesSequence(item.id)!.current_step === 2, "and continues the sequence");
  const result = await tick(after(10 * MIN));
  assert(result.stopped === 0 && getSalesSequence(item.id)!.status === "active", "his approved step isn't taken for his own email");
}
{
  nextScenario();
  const item = enrol();
  checkAnswer = '{"pass":false,"reason":"No"}';
  await tick();
  const step = getSalesSequenceStep(item.id, 1)!;
  const action = getPendingActionForDraft(step.draft_id!)!;
  await handleApprovalCallback(approvalCtx(`approval:discard:${action.id}`), "discard", action.id);
  assert(getSalesSequence(item.id)!.stop_reason === "discarded", "Discard stops it");
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

// ======== blocked cards: fresh slots and the 5-day chase ========
setDraftRefresher((draftId) => refreshSequenceDraftSlots(draftId, clock));

function draftPlain(draftId: string): string {
  return parseRaw(drafts.get(draftId)!.raw).plain;
}

{
  nextScenario();
  const item = enrol({ manual: 2 });
  checkAnswer = '{"pass":false,"reason":"No"}';
  await tick();
  const step = getSalesSequenceStep(item.id, 3)!;
  assert(step.status === "blocked", "step 3 is blocked");
  const oldLines = JSON.parse(step.slot_lines!) as string[];
  assert(oldLines.length >= 2, "its times are remembered");
  assert(oldLines.every((line) => draftPlain(step.draft_id!).includes(line)), "and are in the draft");

  clock = new Date(clock.getTime() + 14 * DAY);
  const action = getPendingActionForDraft(step.draft_id!)!;
  const notes = { edited: [] as string[], alerts: [] as string[] };
  const beforeSend = draftSends.length;
  await handleApprovalCallback(approvalCtx(`approval:send:${action.id}`, notes), "send", action.id);
  assert(draftSends.length === beforeSend + 1, "Send sends it");
  const sentBody = draftSends[beforeSend]!.parsed.plain;
  assert(oldLines.every((line) => !sentBody.includes(line)), "the stale times are gone");
  const newLines = JSON.parse(getSalesSequenceStep(item.id, 3)!.slot_lines!) as string[];
  assert(newLines.length >= 2 && newLines.every((line) => sentBody.includes(line)), "the fresh times went out");
  assert(notes.edited[0]!.includes("Times refreshed before sending"), "the card shows the new times");
  assert(draftSends[beforeSend]!.parsed.headers["in-reply-to"]!.startsWith("<"), "threading survives the rewrite");
  assert(draftSends[beforeSend]!.parsed.headers.to!.includes(item.email), "and so does the recipient");
  assert(getSalesSequenceStep(item.id, 3)!.status === "sent", "the step is recorded");
}
// Edit refreshes too, and his own change is left alone.
{
  nextScenario();
  const item = enrol({ manual: 2 });
  checkAnswer = '{"pass":false,"reason":"No"}';
  await tick();
  const step = getSalesSequenceStep(item.id, 3)!;
  const oldLines = JSON.parse(step.slot_lines!) as string[];
  clock = new Date(clock.getTime() + 14 * DAY);
  const action = getPendingActionForDraft(step.draft_id!)!;
  await handleApprovalCallback(approvalCtx(`approval:edit:${action.id}`), "edit", action.id);
  const edit = await consumeDraftEdit(config.ownerTelegramId);
  assert(edit !== undefined, "the edit starts");
  assert(oldLines.every((line) => !edit!.body.includes(line)), "the body he edits has no stale times");
  const fresh = JSON.parse(getSalesSequenceStep(item.id, 3)!.slot_lines!) as string[];
  assert(fresh.every((line) => edit!.body.includes(line)), "it has the fresh ones");

  const own = "Hi Priya,\n\nWould Tue 8 Dec, 3:00 PM IST work for a short demo?";
  const draft = drafts.get(step.draft_id!)!;
  const replaced = Buffer.from(
    Buffer.from(draft.raw, "base64url").toString("utf8").replace(
      /Content-Type: text\/plain[^\r]*\r\nContent-Transfer-Encoding: base64\r\n\r\n[A-Za-z0-9+/=\r\n]+?(?=\r\n--)/,
      `Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(own, "utf8").toString("base64")}`,
    ),
  ).toString("base64url");
  drafts.set(step.draft_id!, { raw: replaced, threadId: draft.threadId });
  clock = new Date(clock.getTime() + 7 * DAY);
  const count = draftSends.length;
  await handleApprovalCallback(approvalCtx(`approval:send:${action.id}`), "send", action.id);
  assert(draftSends.length === count + 1, "Send sends his edit");
  assert(draftSends[count]!.parsed.plain.includes("3:00 PM IST"), "his own time stays");
}
// No free time means no send.
{
  nextScenario();
  const item = enrol({ manual: 2 });
  checkAnswer = '{"pass":false,"reason":"No"}';
  await tick();
  const step = getSalesSequenceStep(item.id, 3)!;
  clock = new Date(clock.getTime() + 14 * DAY);
  busy = [{ start: new Date(clock.getTime() - DAY), end: new Date(clock.getTime() + 400 * DAY) }];
  const action = getPendingActionForDraft(step.draft_id!)!;
  const notes = { edited: [] as string[], alerts: [] as string[] };
  const count = draftSends.length;
  await handleApprovalCallback(approvalCtx(`approval:send:${action.id}`, notes), "send", action.id);
  assert(draftSends.length === count, "stale times are never sent");
  assert(notes.alerts[0]!.startsWith("Not sent"), "he's told");
  assert(getPendingActionForDraft(step.draft_id!)?.status === "pending", "the card stays");
  busy = [];
}
// A Cc he added through Edit survives the refresh.
{
  nextScenario();
  const item = enrol({ manual: 2 });
  checkAnswer = '{"pass":false,"reason":"No"}';
  await tick();
  const step = getSalesSequenceStep(item.id, 3)!;
  const draft = drafts.get(step.draft_id!)!;
  const withCc = Buffer.from(
    Buffer.from(draft.raw, "base64url").toString("utf8").replace("Subject:", "Cc: sam@epicode.in\r\nSubject:"),
  ).toString("base64url");
  drafts.set(step.draft_id!, { raw: withCc, threadId: draft.threadId });
  clock = new Date(clock.getTime() + 14 * DAY);
  const note = await refreshSequenceDraftSlots(step.draft_id!, clock);
  assert(note !== undefined, "the times were refreshed");
  assert(parseRaw(drafts.get(step.draft_id!)!.raw).headers.cc === "sam@epicode.in", "his Cc is kept");
}

// A draft that isn't a blocked step is untouched.
assert((await refreshSequenceDraftSlots("no-such-draft", clock)) === undefined, "the refresher ignores other drafts");

// Five days paused: one ping, no send.
{
  nextScenario();
  const before = sends.length;
  const item = enrol();
  checkAnswer = '{"pass":false,"reason":"No"}';
  const start = clock;
  await tick(start);
  telegram.sent.length = 0;
  await tick(new Date(start.getTime() + 4.9 * DAY));
  assert(telegram.sent.length === 0, "no ping before 5 days");
  await tick(new Date(start.getTime() + 5 * DAY));
  assert(telegram.sent.length === 1, "one ping at 5 days");
  assert(
    telegram.sent[0] === "Follow-up to Priya Shah has been waiting for your tap for 5 days - Send, Edit or Discard?",
    `the exact words, got ${telegram.sent[0]}`,
  );
  await tick(new Date(start.getTime() + 6 * DAY));
  await tick(new Date(start.getTime() + 20 * DAY));
  assert(telegram.sent.length === 1, "only once");
  assert(sends.length === before, "and nothing is ever sent on its own");
  assert(getSalesSequence(item.id)!.status === "active", "it stays paused");
  assert(getSalesSequenceStep(item.id, 1)!.status === "blocked", "on the same card");
}

// A stop takes the waiting card with it.
{
  nextScenario();
  const item = enrol();
  checkAnswer = '{"pass":false,"reason":"No"}';
  await tick();
  const step = getSalesSequenceStep(item.id, 1)!;
  const action = getPendingActionForDraft(step.draft_id!)!;
  reply(item, "Yes, interested", { at: clock.getTime() });
  await tick(after(5 * MIN));
  assert(getSalesSequence(item.id)!.stop_reason === "replied", "the reply stops a paused sequence");
  assert(getPendingActionForDraft(step.draft_id!) === undefined, "the card is retired");
  assert(telegram.edited.some((text) => text.includes("expired")), "and shows that");
  const count = draftSends.length;
  const notes = { edited: [] as string[], alerts: [] as string[] };
  await handleApprovalCallback(approvalCtx(`approval:send:${action.id}`, notes), "send", action.id);
  assert(draftSends.length === count, "an old tap can't send it");
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
