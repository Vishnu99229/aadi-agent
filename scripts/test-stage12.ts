import "dotenv/config";
import {
  DB_PATH,
  createMeetingPendingBooking,
  createMeetingProposal,
  getJobRun,
  getMeetingPendingBooking,
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
  istDateTime,
  parseWindowHint,
} from "../src/meeting_slots.ts";
import {
  extraToCcAddresses,
  renderBookingConfirmBody,
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
  confidence: 0.9,
});
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
assert(template.trim().endsWith("Vishnu"), "confirm template signature");

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
