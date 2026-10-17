import "dotenv/config";
import type { Api } from "grammy";
import type { gmail_v1 } from "googleapis";
import {
  DB_PATH,
  createMeetingPendingBooking,
  createMeetingProposal,
  getJobRun,
  getMeetingPendingBooking,
  getMeetingThread,
} from "../src/db.ts";
import {
  everyMs,
  formatHealthReport,
  shouldCatchUpClockJob,
  withTimeout,
} from "../src/scheduler.ts";
import {
  inboundSkipReason,
  processDuePendingBookings,
  processInboundMeetingMessage,
  resetMeetingTestHooks,
  setMeetingTestHooks,
} from "../src/meeting_book.ts";
import {
  parseMeetingDetection,
  parseMeetingReplyMapping,
  MEETING_DETECT_SCHEMA,
  MEETING_REPLY_SCHEMA,
} from "../src/meeting_detect.ts";
import {
  findSlots,
  formatIstDate,
  formatOfferSlot,
  istDateTime,
  parseWindowHint,
} from "../src/meeting_slots.ts";
import type { LoadedGoogleAccount } from "../src/google/auth.ts";
import {
  FALLBACK_OPENING,
  PLAIN_SIGNATURE,
  TELEGRAM_ONLY_LABELS,
  containsForbiddenInternal,
  extraToCcAddresses,
  htmlFromSchedulingBody,
  openingLineOrFallback,
  renderBookingConfirmBody,
  renderClarifyBody,
  renderProposalBody,
  sendSchedulingEmail,
  validateOpeningLine,
} from "../src/security/auto_book.ts";

function ensureTestEnv(): void {
  process.env.LLM_PROVIDER ??= "claude";
  process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
  process.env.OWNER_TELEGRAM_ID ??= "1";
  process.env.CLAUDE_MODEL ??= "claude-haiku-4-5";
  process.env.ANTHROPIC_API_KEY ??= "test-key";
  process.env.BRIEF_TIME ??= "08:00";
}

ensureTestEnv();

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

assert(
  DB_PATH === ":memory:",
  "test:stage12 must use AADI_DB_PATH=:memory:, never aadi.db",
);

const SLOT_OPTS = {
  durationMinutes: 30,
  hours: { startMinutes: 10 * 60, endMinutes: 18 * 60 + 30 },
  breakMinutes: { startMinutes: 13 * 60, endMinutes: 14 * 60 },
  bufferMinutes: 15,
  minNoticeHours: 4,
  horizonDays: 7,
  slotsToOffer: 3,
  timezone: "Asia/Kolkata",
};

const mondayMorning = istDateTime("2026-10-19", "06:00");

const weekdaySlots = findSlots({
  ...SLOT_OPTS,
  now: mondayMorning,
  busy: [],
});
assert(weekdaySlots.length === 3, "offers three slots");
assert(
  weekdaySlots.every((slot) => {
    const date = new Date(`${formatIstDate(slot.start)}T12:00:00+05:30`);
    const weekday = date.getUTCDay();
    return weekday !== 0 && weekday !== 6;
  }),
  "slots are weekdays in IST",
);
assert(
  weekdaySlots[0]!.start.toISOString() === istDateTime("2026-10-19", "10:00").toISOString(),
  "first slot is 10:00 IST",
);
assert(
  weekdaySlots[0]!.start.toISOString() === "2026-10-19T04:30:00.000Z",
  "IST has no DST: 10:00 IST is 04:30Z",
);
const days = new Set(weekdaySlots.map((slot) => formatIstDate(slot.start)));
assert(days.size === 3, "slots spread across different days");
const clocks = new Set(
  weekdaySlots.map((slot) => {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(slot.start);
    return parts;
  }),
);
assert(clocks.size > 1, "offered slots are not all the same clock time");
assert(
  formatOfferSlot(weekdaySlots[0]!).includes("IST"),
  "offer slot format includes IST",
);

const weekendNow = istDateTime("2026-10-16", "16:00");
const afterWeekend = findSlots({
  ...SLOT_OPTS,
  now: weekendNow,
  busy: [],
});
assert(
  afterWeekend.every((slot) => formatIstDate(slot.start) >= "2026-10-19"),
  "weekends are skipped",
);

function istStartMinutes(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  return hour * 60 + minute;
}

const withBreak = findSlots({
  ...SLOT_OPTS,
  now: mondayMorning,
  busy: [],
  slotsToOffer: 20,
  offset: 0,
});
assert(
  withBreak.every((slot) => {
    const startMin = istStartMinutes(slot.start);
    const endMin = istStartMinutes(slot.end);
    return endMin <= 13 * 60 || startMin >= 14 * 60;
  }),
  "no slot overlaps the lunch break",
);

const busy = [
  {
    start: istDateTime("2026-10-19", "11:00"),
    end: istDateTime("2026-10-19", "12:00"),
  },
];
const buffered = findSlots({
  ...SLOT_OPTS,
  now: mondayMorning,
  busy,
  slotsToOffer: 12,
  horizonDays: 1,
});
const mondayOnly = buffered.filter((slot) => formatIstDate(slot.start) === "2026-10-19");
assert(
  mondayOnly.every((slot) => {
    const start = slot.start.getTime();
    const blockedStart = istDateTime("2026-10-19", "10:45").getTime();
    const blockedEnd = istDateTime("2026-10-19", "12:15").getTime();
    return slot.end.getTime() <= blockedStart || start >= blockedEnd;
  }),
  "15-minute buffers around busy time are respected",
);

const lateMorning = findSlots({
  ...SLOT_OPTS,
  now: istDateTime("2026-10-19", "09:00"),
  busy: [],
  slotsToOffer: 1,
  horizonDays: 1,
});
assert(
  lateMorning[0]!.start.toISOString() === istDateTime("2026-10-19", "14:00").toISOString(),
  "min notice plus lunch break pushes the first slot to 14:00",
);

const nextWeek = parseWindowHint("next week", istDateTime("2026-10-16", "12:00"));
assert(nextWeek !== undefined, "next week parses");
assert(formatIstDate(nextWeek!.start) === "2026-10-19", "next week starts Monday");
assert(formatIstDate(nextWeek!.end) === "2026-10-25", "next week ends Sunday");

const parsed = parseMeetingDetection({
  kind: "asks_availability",
  proposed_times: [],
  window_hint: "next week",
  duration_minutes: 30,
  sender_timezone: "America/New_York",
  sender_type: "prospect_enquiry",
  confidence: 0.9,
});
assert(parsed?.sender_type === "prospect_enquiry", "detection keeps sender_type");
assert(parsed?.kind === "asks_availability", "detection schema accepts a valid object");
assert(
  parseMeetingDetection({ kind: "nope" }) === undefined,
  "detection schema rejects unknown kind",
);
assert(
  (MEETING_DETECT_SCHEMA as { additionalProperties: boolean }).additionalProperties === false,
  "detection schema is closed",
);
assert(
  (MEETING_REPLY_SCHEMA as { additionalProperties: boolean }).additionalProperties === false,
  "reply schema is closed",
);
const reply = parseMeetingReplyMapping({
  verdict: "one",
  slot_index: 1,
  confidence: 0.9,
});
assert(reply?.slot_index === 1, "reply mapping keeps the slot index");
assert(
  parseMeetingReplyMapping({ verdict: "maybe", slot_index: 0, confidence: 1 }) === undefined,
  "reply mapping rejects unknown verdict",
);

assert(
  inboundSkipReason({
    fromEmail: "ada@epicode.in",
    headers: [],
    subject: "sync?",
  }) === "internal",
  "epicode senders are skipped",
);
assert(
  inboundSkipReason({
    fromEmail: "vishnu.rajan294@gmail.com",
    headers: [],
    subject: "call next week",
  }) === "internal",
  "personal gmail is skipped as self by default",
);
assert(
  inboundSkipReason({
    fromEmail: "vishnu.rajan294@gmail.com",
    headers: [],
    subject: "call next week",
    testSenders: ["vishnu.rajan294@gmail.com"],
  }) === undefined,
  "listed MEETING_TEST_SENDERS are treated as external prospects",
);
assert(
  inboundSkipReason({
    fromEmail: "vishnu.rajan@epicode.in",
    headers: [],
    subject: "call next week",
    testSenders: ["vishnu.rajan@epicode.in", "vishnu.rajan294@gmail.com"],
  }) === "internal",
  "work address is still skipped even if listed as a test sender",
);
assert(
  inboundSkipReason({
    fromEmail: "alerts@acme.com",
    headers: [{ name: "List-Unsubscribe", value: "<mailto:x>" }],
    subject: "hello",
  }) === "list",
  "mailing lists are skipped",
);
assert(
  inboundSkipReason({
    fromEmail: "ada@acme.com",
    headers: [{ name: "Auto-Submitted", value: "auto-replied" }],
    subject: "Out of Office",
  }) === "auto_reply",
  "silent auto-replies are skipped",
);
assert(
  extraToCcAddresses(
    ["ada@acme.com", "new@other.com"],
    ["ada@acme.com"],
  ).includes("new@other.com"),
  "new Cc addresses are detected",
);

const template = renderBookingConfirmBody({
  firstName: "Ada",
  dayDate: "Tuesday, 21 Oct",
  startTime: "11:00",
  endTime: "11:30",
  otherZone: "01:30 EDT",
});
assert(template.startsWith("Hi Ada,"), "confirm template greeting");
assert(template.includes("calendar invite for Tuesday, 21 Oct, 11:00–11:30 IST (01:30 EDT)"), "confirm template time");
assert(template.includes(PLAIN_SIGNATURE), "confirm template signature");
assert(!containsForbiddenInternal(template), "confirm body has no internal labels");
assert(
  htmlFromSchedulingBody(template, "<div>SIG</div>").includes("<div>SIG</div>"),
  "HTML signature is present",
);

const proposal = createMeetingProposal({
  threadId: "stage12-isolated-thread",
  sentMessageId: "stage12-isolated-msg",
  recipientEmail: "ada@acme.com",
  recipientName: "Ada",
  ccEmails: [],
  slots: [
    {
      start: istDateTime("2026-10-21", "11:00").toISOString(),
      end: istDateTime("2026-10-21", "11:30").toISOString(),
    },
  ],
  durationMinutes: 30,
  senderTimezone: null,
});
const due = createMeetingPendingBooking({
  proposalId: proposal.id,
  eventId: "stage12-isolated-event",
  slotIndex: 0,
  sendAt: new Date(Date.now() - 60 * 1000).toISOString(),
});
const sentBodies: string[] = [];
const sent = await processDuePendingBookings({
  now: new Date(),
  eventExists: async () => true,
  patchInvite: async () => undefined,
  confirmSend: async (body) => {
    sentBodies.push(body);
    return { messageId: "sent-1" };
  },
  notify: async () => undefined,
});
assert(sent === 1, "due pending booking sends after the window");
assert(sentBodies.length === 1, "exactly one confirmation send");
assert(
  sentBodies[0] ===
    renderBookingConfirmBody({
      firstName: "Ada",
      dayDate: "Wednesday, 21 Oct",
      startTime: "11:00",
      endTime: "11:30",
      otherZone: null,
    }),
  "sent body is the fixed template",
);
assert(getMeetingPendingBooking(due.id)?.status === "sent", "booking marked sent");

const missedTickProposal = createMeetingProposal({
  threadId: "stage12-missed-tick-thread",
  sentMessageId: "stage12-missed-tick-msg",
  recipientEmail: "ada@acme.com",
  recipientName: "Ada",
  ccEmails: [],
  slots: [
    {
      start: istDateTime("2026-10-21", "15:00").toISOString(),
      end: istDateTime("2026-10-21", "15:30").toISOString(),
    },
  ],
  durationMinutes: 30,
  senderTimezone: null,
});
const missedTick = createMeetingPendingBooking({
  proposalId: missedTickProposal.id,
  eventId: "stage12-missed-tick-event",
  slotIndex: 0,
  sendAt: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
});
assert(
  getMeetingPendingBooking(missedTick.id)?.status === "pending",
  "booking stays pending across a missed tick",
);
const sentAfterMiss = await processDuePendingBookings({
  now: new Date(),
  eventExists: async () => true,
  patchInvite: async () => undefined,
  confirmSend: async () => ({ messageId: "sent-missed" }),
  notify: async () => undefined,
});
assert(sentAfterMiss === 1, "pending-booking processor sends a due booking after a missed tick");
assert(
  getMeetingPendingBooking(missedTick.id)?.status === "sent",
  "missed-tick booking marked sent",
);

assert(
  validateOpeningLine("Thanks, see https://evil.test for details") === undefined,
  "opening line with a URL is rejected",
);
assert(validateOpeningLine("Call me on 123") === undefined, "opening line with digits is rejected");
assert(
  validateOpeningLine("Email me at ada@acme.com please") === undefined,
  "opening line with an email is rejected",
);
assert(
  validateOpeningLine(`${"word ".repeat(41).trim()}`) === undefined,
  "opening line over 40 words is rejected",
);
assert(
  openingLineOrFallback("Meet at https://x.test") === FALLBACK_OPENING,
  "invalid opening line falls back",
);

const proposalVars = {
  firstName: "Ada",
  openingLine: FALLBACK_OPENING,
  durationMinutes: 30,
  slots: ["Mon 19 Oct, 10:00 AM IST", "Tue 20 Oct, 2:30 PM IST", "Wed 21 Oct, 11:00 AM IST"],
};
const proposalBody = renderProposalBody(proposalVars);
assert(!containsForbiddenInternal(proposalBody), "proposal body has no internal labels");
for (const label of TELEGRAM_ONLY_LABELS) {
  assert(!proposalBody.includes(label), "proposal body excludes telegram-only labels");
}
assert(!/^subject\s*:/im.test(proposalBody), "proposal body has no subject line");
assert(proposalBody.includes(PLAIN_SIGNATURE), "proposal body has the plain signature");
assert(
  htmlFromSchedulingBody(proposalBody, "<b>Vishnu</b>").includes("<b>Vishnu</b>"),
  "proposal HTML includes the signature",
);

let badOpeningSent = 0;
await sendSchedulingEmail({
  kind: "proposal",
  gate: {
    autoBook: true,
    fromEmail: "ada@acme.com",
    recipientEmail: "ada@acme.com",
    incomingToCc: [],
    proposalEmails: ["ada@acme.com"],
    dailyCount: 0,
    dailyCap: 5,
    dailySendCount: 0,
    dailySendCap: 15,
  },
  body: renderProposalBody({
    ...proposalVars,
    openingLine: "Thanks see https://x.test",
  }),
  proposal: {
    ...proposalVars,
    openingLine: "Thanks see https://x.test",
  },
  sendImpl: async (body) => {
    assert(body.includes(FALLBACK_OPENING), "invalid opening is replaced before send");
    assert(!body.includes("https://"), "URL opening must not be sent");
    badOpeningSent += 1;
    return { messageId: "fallback-1" };
  },
});
assert(badOpeningSent === 1, "fallback opening may send");

function silentApi(): Api {
  return { sendMessage: async () => ({ message_id: 1 }) } as unknown as Api;
}
function fakeWork(): LoadedGoogleAccount {
  return {
    id: "work",
    tag: "work",
    label: "work",
    tokenPath: "",
    tokenFile: "",
    client: {} as LoadedGoogleAccount["client"],
  };
}
function fakeInbound(input: {
  messageId: string;
  threadId: string;
  from: string;
  subject: string;
  body: string;
  labels?: string[];
  internalDate?: string;
}): gmail_v1.Schema$Message {
  return {
    id: input.messageId,
    threadId: input.threadId,
    labelIds: input.labels,
    internalDate: input.internalDate ?? String(Date.now()),
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: input.from },
        { name: "To", value: "vishnu.rajan@epicode.in" },
        { name: "Subject", value: input.subject },
        { name: "Message-ID", value: `<${input.messageId}@mail>` },
      ],
      body: { data: Buffer.from(input.body, "utf8").toString("base64url") },
    },
  };
}

let vendorSends = 0;
setMeetingTestHooks({
  detect: async () => ({
    kind: "asks_availability",
    proposed_times: [],
    window_hint: "next week",
    duration_minutes: 30,
    sender_timezone: null,
    sender_type: "vendor_or_sales_pitch",
    confidence: 0.99,
  }),
  sendImpl: async () => {
    vendorSends += 1;
    return { messageId: "vendor" };
  },
  loadBusy: async () => [],
  slotIsFree: async () => true,
});
await processInboundMeetingMessage(
  silentApi(),
  fakeWork(),
  fakeInbound({
    messageId: "vendor-1",
    threadId: "thread-vendor",
    from: "Sales <sales@vendor.com>",
    subject: "Quick call?",
    body: "Can we hop on a call about our CRM?",
  }),
  new Date(),
);
assert(vendorSends === 0, "vendor_or_sales_pitch must not get an auto-reply");
resetMeetingTestHooks();

let recruiterSends = 0;
setMeetingTestHooks({
  detect: async () => ({
    kind: "asks_availability",
    proposed_times: [],
    window_hint: null,
    duration_minutes: 30,
    sender_timezone: null,
    sender_type: "recruiter",
    confidence: 0.99,
  }),
  sendImpl: async () => {
    recruiterSends += 1;
    return { messageId: "recruiter" };
  },
  loadBusy: async () => [],
});
await processInboundMeetingMessage(
  silentApi(),
  fakeWork(),
  fakeInbound({
    messageId: "recruiter-1",
    threadId: "thread-recruiter",
    from: "Recruiter <r@hire.com>",
    subject: "Role",
    body: "15 minutes to chat?",
  }),
  new Date(),
);
assert(recruiterSends === 0, "recruiter must not get an auto-reply");
resetMeetingTestHooks();

const autoBodies: string[] = [];
let replyKind: "pick_one" | "own_time" | "vague" | "other" = "vague";
setMeetingTestHooks({
  detect: async () => ({
    kind: "asks_availability",
    proposed_times: [],
    window_hint: "next week",
    duration_minutes: 30,
    sender_timezone: null,
    sender_type: "prospect_enquiry",
    confidence: 0.95,
  }),
  mapReply: async () => ({
    reply_kind: replyKind,
    verdict: replyKind === "pick_one" ? "one" : replyKind === "vague" ? "ambiguous" : "none",
    slot_index: replyKind === "pick_one" ? 0 : null,
    own_time: null,
    confidence: 0.95,
  }),
  openingLine: async () => FALLBACK_OPENING,
  signatureHtml: "<div>SIG</div>",
  sendImpl: async (body) => {
    autoBodies.push(body);
    return { messageId: `auto-${autoBodies.length}` };
  },
  loadBusy: async () => [],
  slotIsFree: async () => true,
  insertEvent: async () => "evt-auto",
});
await processInboundMeetingMessage(
  silentApi(),
  fakeWork(),
  fakeInbound({
    messageId: "prospect-1",
    threadId: "thread-auto",
    from: "Ada <ada@acme.com>",
    subject: "Telephony platform",
    body: "Can we set up a call about your telephony platform?",
  }),
  new Date(),
);
assert(autoBodies.length === 1, "prospect gets a proposal email");
assert(autoBodies[0]!.includes("Would any of these work"), "first email is a proposal");
assert(getMeetingThread("thread-auto")?.status === "proposed", "thread status is proposed");

replyKind = "vague";
await processInboundMeetingMessage(
  silentApi(),
  fakeWork(),
  fakeInbound({
    messageId: "prospect-2",
    threadId: "thread-auto",
    from: "Ada <ada@acme.com>",
    subject: "Re: Telephony platform",
    body: "sounds good",
    internalDate: String(Date.now() + 60_000),
  }),
  new Date(Date.now() + 60_000),
);
assert(autoBodies.length === 2, "vague reply sends CLARIFY");
assert(autoBodies[1]!.includes("Which of these suits you best?"), "second email is clarify");
assert(getMeetingThread("thread-auto")?.status === "clarified", "thread status is clarified");

replyKind = "vague";
await processInboundMeetingMessage(
  silentApi(),
  fakeWork(),
  fakeInbound({
    messageId: "prospect-3",
    threadId: "thread-auto",
    from: "Ada <ada@acme.com>",
    subject: "Re: Telephony platform",
    body: "yeah whatever works",
    internalDate: String(Date.now() + 120_000),
  }),
  new Date(Date.now() + 120_000),
);
assert(autoBodies.length === 2, "a third auto email is not sent before booking");
assert(getMeetingThread("thread-auto")?.status === "handed_over", "still-vague hands over");
resetMeetingTestHooks();

const clarify = renderClarifyBody({
  firstName: "Ada",
  slots: proposalVars.slots,
});
assert(clarify.includes(PLAIN_SIGNATURE), "clarify has signature");
assert(!containsForbiddenInternal(clarify), "clarify has no internal labels");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const hungStarted = Date.now();
try {
  await withTimeout(new Promise(() => undefined), 40, "hung-google");
  throw new Error("hung Google call should time out");
} catch (error) {
  assert(
    error instanceof Error && error.message === "hung-google",
    "hung Google call times out",
  );
}
assert(Date.now() - hungStarted < 500, "timeout returns promptly");

let hangCalls = 0;
const hangJob = everyMs(
  "hang-google",
  50,
  async () => {
    hangCalls += 1;
    if (hangCalls === 1) {
      await new Promise(() => undefined);
    }
  },
  { jobTimeoutMs: 40, runImmediately: true },
);
await sleep(180);
hangJob.stop();
assert(hangCalls >= 2, "next tick still runs after a hung Google call times out");
assert(hangJob.stats.failures >= 1, "timed-out tick is recorded as failure");
assert(hangJob.stats.succeeded >= 1, "later tick succeeds after timeout");

let overlapCalls = 0;
const overlapJob = everyMs(
  "overlap-job",
  40,
  async () => {
    overlapCalls += 1;
    await sleep(160);
  },
  { jobTimeoutMs: 400, runImmediately: true },
);
await sleep(120);
overlapJob.stop();
assert(overlapJob.stats.overlaps >= 1, "overlap is skipped");
assert(overlapCalls === 1, "in-flight job is not started twice");
assert(getJobRun("overlap-job")?.last_status === "overlap", "overlap status is recorded");

const justAfterBrief = new Date("2026-10-17T02:40:00.000Z");
assert(
  shouldCatchUpClockJob(8, 0, justAfterBrief),
  "clock job is caught up within the last hour",
);
assert(
  !shouldCatchUpClockJob(8, 0, new Date("2026-10-17T10:00:00.000Z")),
  "clock job is not caught up after an hour",
);

const health = formatHealthReport();
assert(health.includes("meeting-pending: last ran"), "health lists meeting-pending");
assert(health.includes("meeting-poll: last ran"), "health lists meeting-poll");
assert(health.startsWith("Aadi health"), "health report title");

console.log("Stage 12 checks passed.");
