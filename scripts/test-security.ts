import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Api } from "grammy";
import type { gmail_v1 } from "googleapis";
import {
  AutoBookRefusedError,
  PLAIN_SIGNATURE,
  autoBookConfirm,
  evaluateAutoBookChecks,
  extraToCcAddresses,
  renderBookingConfirmBody,
  sendSchedulingEmail,
} from "../src/security/auto_book.ts";
import {
  DB_PATH,
  countQaBankEntries,
  createAttachmentAlert,
  createMeetingPendingBooking,
  createMeetingProposal,
  createQaBankEntry,
  getMeetingPendingBooking,
  getMeetingProposal,
  listDueMeetingPendingBookings,
  listMeetingPendingBookings,
  parseThresholdsSent,
  recordMeetingBrief,
  recordMeetingBriefThreshold,
  searchQaBank,
  setMeetingProposalStatus,
  transitionMeetingPendingBooking,
} from "../src/db.ts";
import type { LoadedGoogleAccount } from "../src/google/auth.ts";
import {
  processDuePendingBookings,
  processInboundMeetingMessage,
  resetMeetingTestHooks,
  setMeetingTestHooks,
} from "../src/meeting_book.ts";
import { istDateTime } from "../src/meeting_slots.ts";
import {
  isOwner,
  isOwnerTelegramId,
  isOwnerWhatsApp,
  ownerOnly,
} from "../src/security/owner_lock.ts";
import {
  SendNotApprovedError,
  allowSendDraft,
  parseSendApprovalCallback,
} from "../src/security/send_approval.ts";
import {
  missingRequiredEnv,
  parseOwnerTelegramId,
  redactSecrets,
} from "../src/security/env_guard.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

assert(
  DB_PATH === ":memory:",
  "test:security must use AADI_DB_PATH=:memory:, never aadi.db",
);

function assertThrows(run: () => void, message: string): void {
  try {
    run();
  } catch (error) {
    if (error instanceof SendNotApprovedError) {
      return;
    }
    throw error;
  }
  throw new Error(message);
}

const ownerId = 111;
assert(isOwnerTelegramId(ownerId, ownerId), "owner telegram id matches");
assert(!isOwnerTelegramId(1, ownerId), "stranger telegram id is rejected");
assert(!isOwnerTelegramId(undefined, ownerId), "missing telegram id is rejected");
assert(
  isOwnerWhatsApp("+91 98765 43210", "919876543210"),
  "owner whatsapp matches",
);
assert(
  !isOwnerWhatsApp("911111111111", "919876543210"),
  "stranger whatsapp is rejected",
);
assert(
  isOwner({ telegramUserId: ownerId, ownerTelegramId: ownerId }),
  "isOwner accepts telegram",
);
assert(
  !isOwner({ telegramUserId: 99, ownerTelegramId: ownerId }),
  "isOwner rejects other telegram",
);

let continued = false;
const middleware = ownerOnly(ownerId);
await middleware(
  { from: { id: 99 } } as never,
  async () => {
    continued = true;
  },
);
assert(!continued, "non-owner update is not handled");

continued = false;
await middleware(
  { from: { id: ownerId } } as never,
  async () => {
    continued = true;
  },
);
assert(continued, "owner update is handled");

assert(parseSendApprovalCallback("approval:send:12") === 12, "send callback");
assert(
  parseSendApprovalCallback("approval:discard:12") === undefined,
  "discard is not send",
);
assert(
  parseSendApprovalCallback("approval:edit:12") === undefined,
  "edit is not send",
);

allowSendDraft({
  callbackData: "approval:send:7",
  actionId: 7,
  actionStatus: "pending",
});

assertThrows(
  () =>
    allowSendDraft({
      callbackData: undefined,
      actionId: 7,
      actionStatus: "pending",
    }),
  "send without approval callback must fail",
);
assertThrows(
  () =>
    allowSendDraft({
      callbackData: "approval:send:7",
      actionId: 7,
      actionStatus: "sent",
    }),
  "already-sent action must not send again",
);
assertThrows(
  () =>
    allowSendDraft({
      callbackData: "approval:discard:7",
      actionId: 7,
      actionStatus: "pending",
    }),
  "discard callback must not send",
);
assertThrows(
  () =>
    allowSendDraft({
      callbackData: "approval:send:8",
      actionId: 7,
      actionStatus: "pending",
    }),
  "mismatched action id must not send",
);

assert(
  missingRequiredEnv(["TELEGRAM_BOT_TOKEN", "MISSING_FAKE_VAR"]).includes(
    "MISSING_FAKE_VAR",
  ),
  "env guard reports missing names",
);
assert(parseOwnerTelegramId("0") === undefined, "owner id must be positive");
assert(parseOwnerTelegramId("12") === 12, "owner id parses");
assert(
  redactSecrets("Bearer abc and sk-ant-example and crsr_abc").includes(
    "[redacted]",
  ),
  "secrets are redacted",
);
assert(
  !redactSecrets("sk-ant-example-value").includes("sk-ant-example"),
  "redacted text drops secret payload",
);
assert(
  redactSecrets("key=sk-0123456789abcdef0123456789abcdef").includes(
    "[redacted]",
  ),
  "deepseek-style keys are redacted",
);

const root = process.cwd();
const botSrc = await readFile(join(root, "src/bot.ts"), "utf8");
assert(
  botSrc.includes('from "./security/owner_lock.js"'),
  "bot.ts must import the owner lock",
);
assert(/bot\.use\(\s*ownerOnly\(/.test(botSrc), "bot.ts must install ownerOnly");
assert(
  !botSrc.includes("ctx.from?.id !== config.ownerTelegramId"),
  "owner lock must not live inline in bot.ts",
);

const approvalsSrc = await readFile(join(root, "src/approvals.ts"), "utf8");
assert(
  approvalsSrc.includes('from "./security/send_approval.js"'),
  "approvals.ts must import the send gate",
);
const sendFnStart = approvalsSrc.indexOf("async function sendDraft");
const sendFnEnd = approvalsSrc.indexOf("async function fetchDraftRecipientLabel");
assert(sendFnStart >= 0 && sendFnEnd > sendFnStart, "sendDraft is present");
const sendFn = approvalsSrc.slice(sendFnStart, sendFnEnd);
assert(sendFn.includes("allowSendDraft"), "sendDraft must call allowSendDraft");
assert(
  sendFn.includes("performDraftSend"),
  "sendDraft must delegate to performDraftSend",
);
assert(
  sendFn.indexOf("allowSendDraft") < sendFn.indexOf("performDraftSend"),
  "send gate must run before performDraftSend",
);

const performStart = approvalsSrc.indexOf("async function performDraftSend");
const performEnd = approvalsSrc.indexOf("async function sendDraft");
assert(
  performStart >= 0 && performEnd > performStart,
  "performDraftSend is present and precedes sendDraft",
);
const performFn = approvalsSrc.slice(performStart, performEnd);
assert(performFn.includes("drafts.send"), "performDraftSend still sends the draft");

const textSendStart = approvalsSrc.indexOf("export async function sendPendingDraftByText");
assert(textSendStart >= 0, "sendPendingDraftByText entrypoint exists");
const textSendEnd = approvalsSrc.indexOf("async function discardDraft");
const textSendFn = approvalsSrc.slice(textSendStart, textSendEnd);
assert(
  !textSendFn.includes("drafts.send"),
  "sendPendingDraftByText must not call drafts.send directly; it must go through performDraftSend",
);
assert(
  textSendFn.includes("performDraftSend"),
  "sendPendingDraftByText must delegate to performDraftSend",
);

const configSrc = await readFile(join(root, "src/config.ts"), "utf8");
assert(
  configSrc.includes('from "./security/env_guard.js"'),
  "config.ts must use the env guard",
);

const template = renderBookingConfirmBody({
  firstName: "Ada",
  dayDate: "Tuesday, 21 Oct",
  startTime: "11:00",
  endTime: "11:30",
  otherZone: null,
});
const gate = {
  autoBook: true,
  fromEmail: "ada@acme.com",
  recipientEmail: "ada@acme.com",
  incomingToCc: ["ada@acme.com"],
  proposalEmails: ["ada@acme.com"],
  dailyCount: 0,
  dailyCap: 5,
};
const slotStart = new Date(Date.now() + 2 * 60 * 60 * 1000);
const autoOk = evaluateAutoBookChecks({
  ...gate,
  slotIndex: 0,
  verdict: "one",
  confidence: 0.9,
  minConfidence: 0.85,
  slotCount: 3,
  slotStart,
  now: new Date(),
  slotStillFree: true,
});
assert(autoOk.ok, "passing auto-book checks succeed");

assert(
  !evaluateAutoBookChecks({
    ...gate,
    fromEmail: "other@acme.com",
    slotIndex: 0,
    verdict: "one",
    confidence: 0.9,
    minConfidence: 0.85,
    slotCount: 3,
    slotStart,
    now: new Date(),
    slotStillFree: true,
  }).ok,
  "different From must not auto-book",
);
assert(
  !evaluateAutoBookChecks({
    ...gate,
    slotIndex: 0,
    verdict: "one",
    confidence: 0.9,
    minConfidence: 0.85,
    slotCount: 3,
    slotStart,
    now: new Date(),
    slotStillFree: true,
    incomingToCc: ["ada@acme.com", "new@other.com"],
  }).ok,
  "new Cc must not auto-book",
);
assert(
  extraToCcAddresses(["ada@acme.com", "new@other.com"], ["ada@acme.com"]).length > 0,
  "new Cc is detected as extra",
);
assert(
  !evaluateAutoBookChecks({
    ...gate,
    autoBook: false,
    slotIndex: 0,
    verdict: "one",
    confidence: 0.9,
    minConfidence: 0.85,
    slotCount: 3,
    slotStart,
    now: new Date(),
    slotStillFree: true,
  }).ok,
  "AUTO_BOOK=false must not auto-book",
);
assert(
  !evaluateAutoBookChecks({
    ...gate,
    dailyCount: 5,
    dailyCap: 5,
    slotIndex: 0,
    verdict: "one",
    confidence: 0.9,
    minConfidence: 0.85,
    slotCount: 3,
    slotStart,
    now: new Date(),
    slotStillFree: true,
  }).ok,
  "daily cap must block auto-book",
);
assert(
  !evaluateAutoBookChecks({
    ...gate,
    slotIndex: 0,
    verdict: "ambiguous",
    confidence: 0.99,
    minConfidence: 0.85,
    slotCount: 3,
    slotStart,
    now: new Date(),
    slotStillFree: true,
  }).ok,
  "ambiguous reply must not auto-book",
);
assert(
  !evaluateAutoBookChecks({
    ...gate,
    slotIndex: 0,
    verdict: "one",
    confidence: 0.5,
    minConfidence: 0.85,
    slotCount: 3,
    slotStart,
    now: new Date(),
    slotStillFree: true,
  }).ok,
  "low confidence must not auto-book",
);

let sent = 0;
try {
  await autoBookConfirm({
    gate,
    body: "Hi Ada,\n\nSee you then.\n\nVishnu",
    template: {
      firstName: "Ada",
      dayDate: "Tuesday, 21 Oct",
      startTime: "11:00",
      endTime: "11:30",
      otherZone: null,
    },
    sendImpl: async () => {
      sent += 1;
      return { messageId: "x" };
    },
  });
  throw new Error("mismatched template must not send");
} catch (error) {
  assert(error instanceof AutoBookRefusedError, "template mismatch is refused");
}
assert(sent === 0, "autoBookConfirm must not send a non-template body");

await autoBookConfirm({
  gate,
  body: template,
  template: {
    firstName: "Ada",
    dayDate: "Tuesday, 21 Oct",
    startTime: "11:00",
    endTime: "11:30",
    otherZone: null,
  },
  sendImpl: async (body) => {
    assert(body === template, "confirm send is the rendered template");
    sent += 1;
    return { messageId: "ok" };
  },
});
assert(sent === 1, "matching template may send");
assert(template.includes(PLAIN_SIGNATURE), "confirm uses the plain signature");

let capSent = 0;
try {
  await sendSchedulingEmail({
    kind: "confirm",
    gate: {
      ...gate,
      dailySendCount: 15,
      dailySendCap: 15,
    },
    body: template,
    confirm: {
      firstName: "Ada",
      dayDate: "Tuesday, 21 Oct",
      startTime: "11:00",
      endTime: "11:30",
      otherZone: null,
    },
    sendImpl: async () => {
      capSent += 1;
      return { messageId: "cap" };
    },
  });
  throw new Error("send cap must refuse");
} catch (error) {
  assert(error instanceof AutoBookRefusedError, "send cap is refused");
}
assert(capSent === 0, "caps must not send");

async function listTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTsFiles(path)));
    } else if (entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

const srcFiles = await listTsFiles(join(root, "src"));
const toolFiles = srcFiles.filter((path) => path.includes("/src/tools/"));
for (const file of toolFiles) {
  const src = await readFile(file, "utf8");
  assert(!src.includes("messages.send"), `${file} must not send mail`);
  assert(!src.includes("drafts.send"), `${file} must not send drafts`);
  assert(!src.includes("events.insert"), `${file} must not insert calendar events`);
  assert(!src.includes("events.patch"), `${file} must not patch calendar events`);
  assert(!src.includes("events.delete"), `${file} must not delete calendar events`);
}

const messageSendFiles: string[] = [];
const draftSendFiles: string[] = [];
for (const file of srcFiles) {
  if (file.endsWith("/google/test.ts")) {
    continue;
  }
  const src = await readFile(file, "utf8");
  if (src.includes("messages.send") || src.includes("users.messages.send")) {
    messageSendFiles.push(file);
  }
  if (src.includes("drafts.send") || src.includes("users.drafts.send")) {
    draftSendFiles.push(file);
  }
}
assert(
  messageSendFiles.length === 1 && messageSendFiles[0]!.endsWith("/security/auto_book.ts"),
  `messages.send only allowed in auto_book.ts, found ${messageSendFiles.join(", ") || "none"}`,
);
assert(
  draftSendFiles.length === 1 && draftSendFiles[0]!.endsWith("/approvals.ts"),
  `drafts.send only allowed in approvals.ts, found ${draftSendFiles.join(", ") || "none"}`,
);

const meetingBookSrc = await readFile(join(root, "src/meeting_book.ts"), "utf8");
assert(
  meetingBookSrc.includes("getOpenMeetingProposalByThread"),
  "auto-book path requires an open proposal",
);
assert(
  meetingBookSrc.includes("sendSchedulingEmail"),
  "confirmation send must go through sendSchedulingEmail",
);
assert(
  !meetingBookSrc.includes("messages.send"),
  "meeting_book must not send mail itself",
);
assert(
  meetingBookSrc.includes("status !== \"pending\"") ||
    meetingBookSrc.includes('booking.status !== "pending"'),
  "due processor must skip undone bookings",
);

const toolsIndex = await readFile(join(root, "src/tools/index.ts"), "utf8");
assert(!/book_meeting|send_email|create_event/.test(toolsIndex), "no model send/book tools");
assert(!/sendSchedulingEmail|messages.send/.test(toolsIndex), "model tools have no send");
assert(!/calendar\.events/.test(toolsIndex), "model tools have no calendar write");

function fakeWorkAccount(): LoadedGoogleAccount {
  return {
    id: "work",
    tag: "work",
    label: "work",
    tokenPath: "",
    tokenFile: "",
    client: {} as LoadedGoogleAccount["client"],
  };
}

function silentApi(): Api {
  return {
    sendMessage: async () => ({ message_id: 1 }),
  } as unknown as Api;
}

function fakeInbound(input: {
  messageId: string;
  threadId: string;
  from: string;
  to?: string;
  cc?: string;
  subject: string;
  body: string;
  internalDate?: string;
}): gmail_v1.Schema$Message {
  return {
    id: input.messageId,
    threadId: input.threadId,
    internalDate: input.internalDate ?? String(Date.now()),
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: input.from },
        { name: "To", value: input.to ?? "vishnu.rajan@epicode.in" },
        ...(input.cc ? [{ name: "Cc", value: input.cc }] : []),
        { name: "Subject", value: input.subject },
        { name: "Message-ID", value: `<${input.messageId}@mail>` },
      ],
      body: {
        data: Buffer.from(input.body, "utf8").toString("base64url"),
      },
    },
  };
}

const work = fakeWorkAccount();
let calendarInserts = 0;
let mailSends = 0;
setMeetingTestHooks({
  detect: async () => ({
    kind: "proposes_times",
    proposed_times: ["2026-10-21T11:00:00+05:30"],
    window_hint: null,
    duration_minutes: 30,
    sender_timezone: null,
    sender_type: "other",
    confidence: 0.95,
  }),
  mapReply: async () => ({
    reply_kind: "pick_one",
    verdict: "one",
    slot_index: 0,
    own_time: null,
    confidence: 0.99,
  }),
  insertEvent: async () => {
    calendarInserts += 1;
    return "should-not-insert";
  },
  loadBusy: async () => [],
  slotIsFree: async () => true,
  sendImpl: async () => {
    mailSends += 1;
    return { messageId: "should-not-send" };
  },
});

calendarInserts = 0;
mailSends = 0;
await processInboundMeetingMessage(
  silentApi(),
  work,
  fakeInbound({
    messageId: "forged-confirm-1",
    threadId: "thread-no-proposal",
    from: "Eve <eve@other.com>",
    subject: "Re: call",
    body: "I confirm Tuesday 11am",
  }),
  new Date(),
);
assert(calendarInserts === 0, "forged confirm with no proposal must not insert a calendar event");
assert(mailSends === 0, "forged confirm with no proposal must not send mail");
assert(
  listMeetingPendingBookings().length === 0,
  "forged confirm with no proposal must not create a pending_booking",
);

const closedSlots = [
  {
    start: istDateTime("2026-10-21", "11:00").toISOString(),
    end: istDateTime("2026-10-21", "11:30").toISOString(),
  },
];
const bookedProposal = createMeetingProposal({
  threadId: "thread-already-booked",
  sentMessageId: "sent-booked-1",
  recipientEmail: "ada@acme.com",
  recipientName: "Ada",
  ccEmails: [],
  slots: closedSlots,
  durationMinutes: 30,
  senderTimezone: null,
});
setMeetingProposalStatus(bookedProposal.id, "booked");
const expiredProposal = createMeetingProposal({
  threadId: "thread-already-expired",
  sentMessageId: "sent-expired-1",
  recipientEmail: "ada@acme.com",
  recipientName: "Ada",
  ccEmails: [],
  slots: closedSlots,
  durationMinutes: 30,
  senderTimezone: null,
});
setMeetingProposalStatus(expiredProposal.id, "expired");

for (const row of [
  { threadId: "thread-already-booked", label: "booked" },
  { threadId: "thread-already-expired", label: "expired" },
]) {
  calendarInserts = 0;
  const before = listMeetingPendingBookings().length;
  await processInboundMeetingMessage(
    silentApi(),
    work,
    fakeInbound({
      messageId: `reply-${row.label}`,
      threadId: row.threadId,
      from: "Ada <ada@acme.com>",
      subject: "Re: call",
      body: "Tuesday 11am works",
      internalDate: String(Date.now() + 60_000),
    }),
    new Date(),
  );
  assert(
    calendarInserts === 0,
    `reply on ${row.label} proposal must not insert a calendar event`,
  );
  assert(
    listMeetingPendingBookings().length === before,
    `reply on ${row.label} proposal must not create a pending_booking`,
  );
}

const forgedOwnerSends = { calendar: 0, mail: 0 };
setMeetingTestHooks({
  detect: async () => ({
    kind: "asks_availability",
    proposed_times: [],
    window_hint: null,
    duration_minutes: 30,
    sender_timezone: null,
    sender_type: "prospect_enquiry",
    confidence: 0.95,
  }),
  mapReply: async () => ({
    reply_kind: "pick_one",
    verdict: "one",
    slot_index: 0,
    own_time: null,
    confidence: 0.99,
  }),
  insertEvent: async () => {
    forgedOwnerSends.calendar += 1;
    return "forged-event";
  },
  loadBusy: async () => [],
  slotIsFree: async () => true,
  sendImpl: async () => {
    forgedOwnerSends.mail += 1;
    return { messageId: "should-not-send" };
  },
});
createMeetingProposal({
  threadId: "thread-forged-owner",
  sentMessageId: "sent-owner-1",
  recipientEmail: "ada@acme.com",
  recipientName: "Ada",
  ccEmails: [],
  slots: closedSlots,
  durationMinutes: 30,
  senderTimezone: null,
});
await processInboundMeetingMessage(
  silentApi(),
  work,
  fakeInbound({
    messageId: "forged-work-from",
    threadId: "thread-forged-owner",
    from: "Vishnu <vishnu.rajan@epicode.in>",
    subject: "Re: call",
    body: "Tuesday 11am confirmed",
    internalDate: String(Date.now() + 60_000),
  }),
  new Date(),
);
assert(forgedOwnerSends.calendar === 0, "forged work From without SENT must not book");
assert(forgedOwnerSends.mail === 0, "forged work From without SENT must not send");

resetMeetingTestHooks();

const undoProposal = createMeetingProposal({
  threadId: "thread-undo",
  sentMessageId: "sent-undo-1",
  recipientEmail: "ada@acme.com",
  recipientName: "Ada",
  ccEmails: [],
  slots: closedSlots,
  durationMinutes: 30,
  senderTimezone: null,
});
const future = createMeetingPendingBooking({
  proposalId: undoProposal.id,
  eventId: "event-undo-future",
  slotIndex: 0,
  sendAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
});
assert(
  !listDueMeetingPendingBookings(new Date().toISOString()).some(
    (row) => row.id === future.id,
  ),
  "undo: future send_at is not due yet",
);
const undoSends: string[] = [];
const skippedDue = await processDuePendingBookings({
  now: new Date(),
  eventExists: async () => true,
  patchInvite: async () => {
    throw new Error("undo window must not patch invite");
  },
  confirmSend: async (body) => {
    undoSends.push(body);
    mailSends += 1;
    return { messageId: "x" };
  },
  notify: async () => undefined,
});
assert(skippedDue === 0, "undo: due processor leaves future bookings untouched");
assert(undoSends.length === 0, "undo before send_at must not send email");
assert(
  transitionMeetingPendingBooking(future.id, "pending", "cancelled"),
  "undo cancels the pending row",
);
setMeetingProposalStatus(undoProposal.id, "open");
const afterUndo = await processDuePendingBookings({
  now: new Date(Date.now() + 15 * 60 * 1000),
  eventExists: async () => true,
  patchInvite: async () => {
    throw new Error("undone booking must not patch");
  },
  confirmSend: async (body) => {
    undoSends.push(body);
    mailSends += 1;
    return { messageId: "x" };
  },
  notify: async () => undefined,
});
assert(afterUndo === 0, "undo: cancelled booking is not sent after send_at");
assert(getMeetingPendingBooking(future.id)?.status === "cancelled", "undo: cancelled status persists");
assert(getMeetingProposal(undoProposal.id)?.status === "open", "undo: proposal reopens");
assert(mailSends === 0, "undo before send_at must not call messages.send");

// Attachment alert dedup: INSERT OR IGNORE on UNIQUE
// (google_account, message_id, attachment_id) must return the row the
// first time and undefined on every repeat. The scanner relies on this
// to avoid spamming Telegram when the email stays in the inbox.
const firstAlert = createAttachmentAlert({
  messageId: "m-dedup-1",
  googleAccount: "work",
  attachmentId: "att-1",
  fileName: "msa.pdf",
  mimeType: "application/pdf",
  sender: "Ada",
  subject: "MSA v2",
  guessedType: "Contract",
});
assert(!!firstAlert, "first attachment alert insert returns a row");
const dupAlert = createAttachmentAlert({
  messageId: "m-dedup-1",
  googleAccount: "work",
  attachmentId: "att-1",
  fileName: "msa.pdf",
  mimeType: "application/pdf",
  sender: "Ada",
  subject: "MSA v2",
  guessedType: "Contract",
});
assert(
  dupAlert === undefined,
  "duplicate attachment alert insert returns undefined",
);
const sameMsgDifferentAttachment = createAttachmentAlert({
  messageId: "m-dedup-1",
  googleAccount: "work",
  attachmentId: "att-2",
  fileName: "annex.pdf",
  mimeType: "application/pdf",
  sender: "Ada",
  subject: "MSA v2",
  guessedType: "Contract",
});
assert(
  !!sameMsgDifferentAttachment,
  "different attachment on same message inserts a new row",
);

// Pre-meeting brief threshold tracking: each threshold fires once per
// (event, start). Second fire of the same threshold must no-op.
const briefRow = recordMeetingBrief({
  eventId: "evt-threshold-1",
  startAt: "2026-10-25T10:00:00.000Z",
  endAt: "2026-10-25T10:30:00.000Z",
  title: "Threshold check",
  attendeesJson: "[]",
  nudgeAt: "2026-10-25T10:30:00.000Z",
});
assert(
  parseThresholdsSent(briefRow.thresholds_sent).length === 0,
  "new brief row has no thresholds fired",
);
assert(
  recordMeetingBriefThreshold(briefRow.id, 15) === true,
  "first 15-min threshold records",
);
assert(
  recordMeetingBriefThreshold(briefRow.id, 15) === false,
  "second 15-min threshold is a no-op",
);
assert(
  recordMeetingBriefThreshold(briefRow.id, 10) === true,
  "10-min threshold records independently",
);

// Q&A bank: create, FTS search by keyword, empty-query returns recents.
assert(countQaBankEntries() === 0, "qa_bank starts empty");
const qa1 = createQaBankEntry({
  question: "What is your SOC 2 compliance status?",
  answer: "We completed SOC 2 Type II audit in Q2 2026 (auditor: Prescient Security).",
  sourceDoc: "acme-security-review-2026.pdf",
});
assert(qa1.id > 0 && qa1.answer.includes("Type II"), "qa_bank entry created");
createQaBankEntry({
  question: "Do you support SAML single sign-on?",
  answer: "Yes, Epicode supports SAML 2.0 SSO via Okta, Azure AD and Google Workspace.",
  sourceDoc: "acme-security-review-2026.pdf",
});
createQaBankEntry({
  question: "Where is customer data hosted?",
  answer: "Customer data is hosted on AWS Mumbai (ap-south-1).",
  sourceDoc: "bigco-rfp-sept-2026.pdf",
});
assert(countQaBankEntries() === 3, "qa_bank has three entries");

const soc2Hits = searchQaBank("SOC 2 compliance", 3);
assert(soc2Hits.length >= 1, "SOC 2 search returns a hit");
assert(soc2Hits[0]!.question.includes("SOC 2"), "top hit matches on question");

const ssoHits = searchQaBank("single sign on");
assert(ssoHits.some((row) => row.question.includes("SAML")), "SSO query matches SAML question");

const recent = searchQaBank("", 10);
assert(recent.length === 3, "empty query returns everything");

const missHits = searchQaBank("quantum teleportation uplink");
assert(missHits.length === 0, "no match returns empty");

console.log("Security gate checks passed.");
