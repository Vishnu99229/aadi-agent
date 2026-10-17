import "dotenv/config";
import {
  createMeetingPendingBooking,
  createMeetingProposal,
  getMeetingPendingBooking,
  getMeetingProposal,
  listDueMeetingPendingBookings,
  setMeetingProposalStatus,
  transitionMeetingPendingBooking,
} from "../src/db.ts";
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

const stamp = Date.now();
const proposal = createMeetingProposal({
  threadId: `stage12-test-${stamp}`,
  sentMessageId: `stage12-msg-${stamp}`,
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

const future = createMeetingPendingBooking({
  proposalId: proposal.id,
  eventId: `stage12-event-future-${stamp}`,
  slotIndex: 0,
  sendAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
});
const dueNow = listDueMeetingPendingBookings(new Date().toISOString());
assert(
  !dueNow.some((row) => row.id === future.id),
  "future send_at is not due yet (restart-safe SQLite row)",
);

let sentBodies: string[] = [];
const skipped = await processDuePendingBookings({
  now: new Date(),
  eventExists: async () => true,
  patchInvite: async () => {
    throw new Error("invite must not send before send_at");
  },
  confirmSend: async (body) => {
    sentBodies.push(body);
    return { messageId: "x" };
  },
  notify: async () => undefined,
});
assert(skipped === 0, "due processor leaves future bookings untouched");
assert(sentBodies.length === 0, "undo window does not send email");

assert(
  transitionMeetingPendingBooking(future.id, "pending", "cancelled"),
  "undo cancels the pending row",
);
setMeetingProposalStatus(proposal.id, "open");
const afterUndo = await processDuePendingBookings({
  now: new Date(Date.now() + 15 * 60 * 1000),
  eventExists: async () => true,
  patchInvite: async () => {
    throw new Error("undone booking must not patch");
  },
  confirmSend: async (body) => {
    sentBodies.push(body);
    return { messageId: "x" };
  },
  notify: async () => undefined,
});
assert(afterUndo === 0, "cancelled booking is not sent after send_at");
assert(getMeetingPendingBooking(future.id)?.status === "cancelled", "cancelled status persists");
assert(getMeetingProposal(proposal.id)?.status === "open", "proposal reopens on undo");

const due = createMeetingPendingBooking({
  proposalId: proposal.id,
  eventId: `stage12-event-due-${stamp}`,
  slotIndex: 0,
  sendAt: new Date(Date.now() - 60 * 1000).toISOString(),
});
sentBodies = [];
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

console.log("Stage 12 checks passed.");
