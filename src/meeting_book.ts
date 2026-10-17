import { randomUUID } from "node:crypto";
import { InlineKeyboard, type Api, type Context } from "grammy";
import { everyMs, type IntervalJob } from "./scheduler.js";
import { google, type gmail_v1 } from "googleapis";
import { queueDraftApproval } from "./approvals.js";
import { config } from "./config.js";
import {
  countMeetingAutoSendsToday,
  createMeetingPendingBooking,
  createMeetingProposal,
  deleteMeetingCardState,
  deleteMeetingDraftIntent,
  getMeetingCardState,
  getMeetingDraftIntent,
  getMeetingInbound,
  getMeetingPendingBooking,
  getMeetingProposal,
  getLatestMeetingProposalByThread,
  getMeetingThread,
  getOpenMeetingProposalByThread,
  insertMeetingInbound,
  listDueMeetingPendingBookings,
  listMeetingAutoSendIds,
  listMeetingPendingBookings,
  listMeetingThreads,
  listOpenMeetingProposals,
  recordMeetingAutoSend,
  setMeetingCardState,
  setMeetingInboundProcessedAs,
  setMeetingProposalHolds,
  setMeetingProposalSlots,
  setMeetingProposalStatus,
  transitionMeetingPendingBooking,
  upsertMeetingDraftIntent,
  upsertMeetingThread,
  type MeetingProposalRecord,
  type MeetingThreadStatus,
} from "./db.js";
import {
  AUTO_HANDLE_SENDER_TYPES,
  detectMeetingRequest,
  draftOpeningLine,
  mapReplyToSlot,
  type MeetingDetection,
  type MeetingKind,
  type MeetingReplyMapping,
  type SenderType,
} from "./meeting_detect.js";
import {
  findSlots,
  fitsWorkingHours,
  formatConfirmClock,
  formatConfirmDayDate,
  formatOfferSlot,
  formatOtherZoneRange,
  formatSlotIst,
  parseWindowHint,
  type BusyInterval,
  type TimeSlot,
} from "./meeting_slots.js";
import {
  getGoogleAccount,
  loadGoogleAccounts,
  type LoadedGoogleAccount,
} from "./google/auth.js";
import { createNewEmailDraft, createThreadReplyDraft, gmailClient } from "./google/mail.js";
import { messageHeader, senderDisplay } from "./gmail_attachments.js";
import { isSelfEmail } from "./mom_logic.js";
import {
  DEFAULT_SIGNATURE_HTML,
  TELEGRAM_ONLY_LABELS,
  containsForbiddenInternal,
  evaluateAutoBookChecks,
  extraToCcAddresses,
  htmlFromSchedulingBody,
  normalizeEmail,
  openingLineOrFallback,
  renderBookingConfirmBody,
  renderClarifyBody,
  renderProposalBody,
  sendSchedulingEmail,
  type AutoBookGateInput,
  type SchedulingSendGateInput,
} from "./security/auto_book.js";

export interface MeetingTestHooks {
  detect?: (input: { subject: string; body: string }) => Promise<MeetingDetection>;
  mapReply?: (input: {
    slotCount: number;
    body: string;
  }) => Promise<MeetingReplyMapping>;
  insertEvent?: (
    slot: TimeSlot,
    proposal: MeetingProposalRecord,
  ) => Promise<string>;
  loadBusy?: (timeMin: Date, timeMax: Date) => Promise<BusyInterval[]>;
  slotIsFree?: (slot: TimeSlot) => Promise<boolean>;
  openingLine?: (input: { subject: string; body: string }) => Promise<string>;
  signatureHtml?: string;
  sendImpl?: (body: string) => Promise<{ messageId: string }>;
  clashTitle?: (slot: TimeSlot) => Promise<string>;
}

let testHooks: MeetingTestHooks = {};

export function setMeetingTestHooks(hooks: MeetingTestHooks): void {
  testHooks = hooks;
}

export function resetMeetingTestHooks(): void {
  testHooks = {};
}

const TIME_ZONE = "Asia/Kolkata";
const INBOX_QUERY = "in:inbox newer_than:1d -category:promotions -category:social";
const WORK_EMAIL = "vishnu.rajan@epicode.in";
const PERSONAL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "icloud.com",
  "me.com",
]);

interface CardPayload {
  fromEmail: string;
  fromName: string;
  subject: string;
  ccEmails: string[];
  kind: MeetingKind;
  windowHint: string | null;
  durationMinutes: number;
  senderTimezone: string | null;
  calendlyUrl: string | null;
  slotOffset: number;
  messageId: string;
  threadId: string;
  inReplyTo: string;
  references: string;
  proposedTimes: string[];
}

interface SlotJson {
  start: string;
  end: string;
}

export interface DueBookingHooks {
  eventExists?: (eventId: string) => Promise<boolean>;
  patchInvite?: (eventId: string) => Promise<void>;
  confirmSend?: (body: string) => Promise<{ messageId: string }>;
  notify?: (text: string) => Promise<void>;
  api?: Api;
  now?: Date;
}

function header(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string {
  return (
    headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())
      ?.value ?? ""
  );
}

function decodeBody(data: string | null | undefined): string {
  return data ? Buffer.from(data, "base64url").toString("utf8") : "";
}

function collectPlain(part: gmail_v1.Schema$MessagePart | undefined): string {
  if (!part) {
    return "";
  }
  if (part.mimeType?.toLowerCase() === "text/plain" && part.body?.data) {
    return decodeBody(part.body.data);
  }
  return (part.parts ?? []).map((child) => collectPlain(child)).filter(Boolean).join("\n");
}

export function parseAddressList(value: string): string[] {
  const matches = value.toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g);
  return [...new Set(matches ?? [])];
}

export function inboundSkipReason(input: {
  fromEmail: string;
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined;
  subject: string;
  mimeType?: string | null;
  testSenders?: readonly string[];
}): string | undefined {
  const from = normalizeEmail(input.fromEmail);
  if (!from) {
    return "no_from";
  }
  const testSenders = new Set(
    (input.testSenders ?? []).map((item) => normalizeEmail(item)),
  );
  if (from === WORK_EMAIL) {
    return "internal";
  }
  if (from.endsWith("@epicode.in") && !testSenders.has(from)) {
    return "internal";
  }
  if (isSelfEmail(from) && !testSenders.has(from)) {
    return "internal";
  }
  if (/(?:^|[._-])(?:no-?reply|do-?not-?reply|mailer-daemon)(?:[._-]|@)/i.test(from)) {
    return "noreply";
  }
  if (header(input.headers, "List-Unsubscribe")) {
    return "list";
  }
  const autoSubmitted = header(input.headers, "Auto-Submitted").toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") {
    return "auto_reply";
  }
  const precedence = header(input.headers, "Precedence").toLowerCase();
  if (precedence === "bulk" || precedence === "auto" || precedence === "junk") {
    return "auto_reply";
  }
  if (
    header(input.headers, "X-Autoreply") ||
    header(input.headers, "X-Autorespond") ||
    /auto-?submitted/i.test(header(input.headers, "X-Auto-Response-Suppress"))
  ) {
    return "auto_reply";
  }
  const subject = input.subject.trim();
  if (
    /^(?:auto:|automatic reply|out of office|ooo:)/i.test(subject) ||
    /\bout of office\b/i.test(subject)
  ) {
    return "auto_reply";
  }
  const contentType = header(input.headers, "Content-Type");
  if (
    input.mimeType === "text/calendar" ||
    /text\/calendar/i.test(contentType) ||
    /^(?:accepted|declined|tentative|canceled|updated invitation):/i.test(subject) ||
    /\bcalendar invitation\b/i.test(subject)
  ) {
    return "calendar";
  }
  return undefined;
}

function companyFromEmail(email: string): string {
  const domain = (email.split("@")[1] ?? "").toLowerCase();
  if (!domain || PERSONAL_DOMAINS.has(domain)) {
    return "personal";
  }
  const base = domain.split(".")[0] ?? domain;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function firstNameFrom(name: string, email: string): string {
  const token = name.trim().split(/\s+/)[0]?.replace(/[^\p{L}\p{N}'-]/gu, "");
  if (token) {
    return token;
  }
  const local = email.split("@")[0] ?? "there";
  return local.split(/[._-]/)[0] || "there";
}

function sanitizeLabel(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
}

function eventTitle(name: string, email: string): string {
  const who = sanitizeLabel(name) || sanitizeLabel(email.split("@")[0] ?? "guest");
  const company = sanitizeLabel(companyFromEmail(email));
  return `Vishnu <> ${who} (${company})`;
}

function finderOptions(now: Date, busy: BusyInterval[], extra: {
  durationMinutes: number;
  windowHint?: string | null;
  offset?: number;
}) {
  return {
    now,
    busy,
    durationMinutes: extra.durationMinutes,
    hours: config.meetingHours,
    breakMinutes: config.meetingBreak,
    bufferMinutes: config.meetingBufferMinutes,
    minNoticeHours: config.meetingMinNoticeHours,
    horizonDays: config.meetingHorizonDays,
    slotsToOffer: config.meetingSlotsToOffer,
    timezone: config.meetingTimezone,
    window: parseWindowHint(extra.windowHint, now, config.meetingTimezone),
    offset: extra.offset,
  };
}

async function loadBusy(timeMin: Date, timeMax: Date): Promise<BusyInterval[]> {
  if (testHooks.loadBusy) {
    return testHooks.loadBusy(timeMin, timeMax);
  }
  const accounts = await loadGoogleAccounts();
  const busy: BusyInterval[] = [];
  for (const account of accounts) {
    const calendar = google.calendar({ version: "v3", auth: account.client });
    const response = await calendar.freebusy.query({
      requestBody: {
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        timeZone: config.meetingTimezone,
        items: [{ id: "primary" }],
      },
    });
    for (const period of response.data.calendars?.primary?.busy ?? []) {
      if (period.start && period.end) {
        busy.push({ start: new Date(period.start), end: new Date(period.end) });
      }
    }
  }
  return busy;
}

async function slotIsFree(slot: TimeSlot): Promise<boolean> {
  if (testHooks.slotIsFree) {
    return testHooks.slotIsFree(slot);
  }
  const bufferMs = config.meetingBufferMinutes * 60 * 1000;
  const busy = await loadBusy(
    new Date(slot.start.getTime() - bufferMs),
    new Date(slot.end.getTime() + bufferMs),
  );
  return !busy.some(
    (item) => item.start.getTime() < slot.end.getTime() && slot.start.getTime() < item.end.getTime(),
  );
}

function parseSlots(raw: string): TimeSlot[] {
  const parsed = JSON.parse(raw) as SlotJson[];
  return parsed.map((item) => ({
    start: new Date(item.start),
    end: new Date(item.end),
  }));
}

function toSlotJson(slots: TimeSlot[]): SlotJson[] {
  return slots.map((slot) => ({
    start: slot.start.toISOString(),
    end: slot.end.toISOString(),
  }));
}

function parseCard(raw: string | undefined): CardPayload | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as CardPayload;
  } catch {
    return undefined;
  }
}

let cachedSignature:
  | { html: string; fetchedAt: number }
  | undefined;

export function gmailThreadUrl(threadId: string): string {
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(WORK_EMAIL)}#all/${threadId}`;
}

async function workSignatureHtml(): Promise<string> {
  if (testHooks.signatureHtml) {
    return testHooks.signatureHtml;
  }
  if (process.env.AADI_DB_PATH === ":memory:") {
    return DEFAULT_SIGNATURE_HTML;
  }
  const now = Date.now();
  if (cachedSignature && now - cachedSignature.fetchedAt < 60 * 60 * 1000) {
    return cachedSignature.html;
  }
  try {
    const account = await workAccount();
    if (!account) {
      return DEFAULT_SIGNATURE_HTML;
    }
    const gmail = gmailClient(account);
    const sendAs = await gmail.users.settings.sendAs.get({
      userId: "me",
      sendAsEmail: WORK_EMAIL,
    });
    const html = sendAs.data.signature?.trim() || DEFAULT_SIGNATURE_HTML;
    cachedSignature = { html, fetchedAt: now };
    return html;
  } catch {
    return DEFAULT_SIGNATURE_HTML;
  }
}

function countAutoBooksToday(now: Date): number {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return listMeetingPendingBookings().filter((row) => {
    if (row.status !== "pending" && row.status !== "sent") {
      return false;
    }
    const created = new Date(row.created_at.includes("T") ? row.created_at : `${row.created_at}Z`);
    const day = new Intl.DateTimeFormat("en-CA", {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(created);
    return day === today;
  }).length;
}

function proposalEmails(proposal: MeetingProposalRecord): string[] {
  const cc = JSON.parse(proposal.cc_emails) as string[];
  return [proposal.recipient_email, ...cc];
}

function calendlyUrl(body: string): string | null {
  const match = body.match(
    /https?:\/\/[^\s<>"]+(?:calendly|hubspot|chilipiper|savvycal)[^\s<>"]*/i,
  );
  return match?.[0] ?? null;
}

function proposalDraftBody(card: CardPayload, slots: TimeSlot[]): string {
  const first = firstNameFrom(card.fromName, card.fromEmail);
  const listed = slots
    .map((slot) => formatSlotIst(slot, card.senderTimezone))
    .join(", ");
  return [
    `Hi ${first},`,
    "",
    `Would ${listed} work for a ${card.durationMinutes}-minute call?`,
    "",
    "Happy to find another time if none of these suit.",
    "",
    "Vishnu",
  ].join("\n");
}

function acceptDraftBody(card: CardPayload, slot: TimeSlot): string {
  const first = firstNameFrom(card.fromName, card.fromEmail);
  return [
    `Hi ${first},`,
    "",
    `${formatSlotIst(slot, card.senderTimezone)} works. I'll send an invite.`,
    "",
    "Vishnu",
  ].join("\n");
}

function cardKeyboard(inboundId: number, slots: TimeSlot[], kind: MeetingKind): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (kind === "proposes_times" && slots.length === 1) {
    keyboard.text("Accept this time", `meet:accept:${inboundId}:0`).row();
  }
  if (kind !== "calendly_link") {
    keyboard.text("Draft reply with these", `meet:draft:${inboundId}`);
  } else {
    keyboard.text("Draft reply with these", `meet:draft:${inboundId}`);
  }
  keyboard.text("Pick different slots", `meet:next:${inboundId}`).row();
  keyboard.text("Ignore", `meet:ignore:${inboundId}`);
  return keyboard;
}

function askKeyboard(proposalId: number, slotCount: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (let index = 0; index < slotCount && index < 3; index += 1) {
    keyboard.text(`Book slot ${index + 1}`, `meet:book:${proposalId}:${index}`);
  }
  keyboard
    .row()
    .text("Draft reply", `meet:pdraft:${proposalId}`)
    .text("Ignore", `meet:pignore:${proposalId}`);
  return keyboard;
}

function vendorFyiKeyboard(inboundId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("Reply with slots", `meet:autoslots:${inboundId}`)
    .text("Ignore", `meet:ignore:${inboundId}`);
}

function handoverKeyboard(
  proposalId: number,
  slots: TimeSlot[],
  threadId: string,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (let index = 0; index < slots.length && index < 3; index += 1) {
    keyboard
      .text(formatOfferSlot(slots[index]!).replace(" IST", ""), `meet:book:${proposalId}:${index}`)
      .row();
  }
  keyboard.url("Open thread", gmailThreadUrl(threadId)).text("Ignore", `meet:pignore:${proposalId}`);
  return keyboard;
}

function bookedKeyboard(bookingId: number, threadId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("Undo", `meet:undo:${bookingId}`)
    .url("Open thread", gmailThreadUrl(threadId));
}

async function sendOwner(api: Api, text: string, markup?: InlineKeyboard): Promise<void> {
  await api.sendMessage(config.ownerTelegramId, text, markup ? { reply_markup: markup } : {});
}

async function workAccount(): Promise<LoadedGoogleAccount | undefined> {
  const accounts = await loadGoogleAccounts();
  return accounts.find((account) => account.id === "work");
}

async function computeSlots(card: CardPayload, now = new Date()): Promise<TimeSlot[]> {
  const horizonEnd = new Date(
    now.getTime() + config.meetingHorizonDays * 24 * 60 * 60 * 1000,
  );
  const window = parseWindowHint(card.windowHint, now, config.meetingTimezone);
  const busy = await loadBusy(now, window?.end ?? horizonEnd);
  if (card.kind === "proposes_times") {
    const offered: TimeSlot[] = [];
    for (const raw of card.proposedTimes) {
      const start = new Date(raw);
      if (Number.isNaN(start.getTime())) {
        continue;
      }
      const end = new Date(start.getTime() + card.durationMinutes * 60 * 1000);
      const slot = { start, end };
      if (await slotIsFree(slot)) {
        offered.push(slot);
      }
    }
    if (offered.length > 0) {
      return offered.slice(0, config.meetingSlotsToOffer);
    }
  }
  return findSlots(
    finderOptions(now, busy, {
      durationMinutes: card.durationMinutes,
      windowHint: card.windowHint,
      offset: card.slotOffset,
    }),
  );
}

function cardText(card: CardPayload, slots: TimeSlot[]): string {
  const company = companyFromEmail(card.fromEmail);
  const window = card.windowHint ? card.windowHint : "soon";
  const lines = [
    `📅 ${card.fromName} (${company}) wants to meet ${window}.`,
  ];
  if (card.kind === "calendly_link" && card.calendlyUrl) {
    lines.push(`Their link: ${card.calendlyUrl}`);
  }
  if (slots.length === 0) {
    lines.push("No free slots in that window.");
  } else {
    lines.push(`Free: ${slots.map((slot) => formatSlotIst(slot, card.senderTimezone)).join("; ")}`);
  }
  return lines.join("\n");
}

async function sendMeetingCard(api: Api, inboundId: number, card: CardPayload): Promise<void> {
  const slots = await computeSlots(card);
  setMeetingCardState(inboundId, JSON.stringify(card));
  await sendOwner(api, cardText(card, slots), cardKeyboard(inboundId, slots, card.kind));
  console.log(`Meeting card sent: inbound=${inboundId} kind=${card.kind} slots=${slots.length}`);
}

function snippet(text: string, limit = 200): string {
  return text.replace(/\s+/g, " ").trim().slice(0, limit);
}

async function sendVendorFyi(
  api: Api,
  inboundId: number,
  card: CardPayload,
  senderType: SenderType,
): Promise<void> {
  setMeetingCardState(inboundId, JSON.stringify(card));
  upsertMeetingThread({
    threadId: card.threadId,
    recipientEmail: card.fromEmail,
    recipientName: card.fromName,
    company: companyFromEmail(card.fromEmail),
    senderType,
    status: "handed_over",
    subject: card.subject,
  });
  await sendOwner(
    api,
    `${card.fromName} asked for a call (${senderType}). Not replying.`,
    vendorFyiKeyboard(inboundId),
  );
  console.log(`Meeting fyi: inbound=${inboundId} sender_type=${senderType}`);
}

async function handOverThread(input: {
  api: Api;
  proposal: MeetingProposalRecord;
  reason: string;
  snippetText?: string;
  status?: MeetingThreadStatus;
}): Promise<void> {
  const slots = parseSlots(input.proposal.slots);
  const existing = getMeetingThread(input.proposal.thread_id);
  upsertMeetingThread({
    threadId: input.proposal.thread_id,
    recipientEmail: input.proposal.recipient_email,
    recipientName: input.proposal.recipient_name,
    company: companyFromEmail(input.proposal.recipient_email),
    senderType: existing?.sender_type ?? "other",
    status: input.status ?? "handed_over",
    autoEmailsSent: existing?.auto_emails_sent ?? 0,
    lastKind: existing?.last_kind,
    subject: existing?.subject ?? "",
    proposalId: input.proposal.id,
  });
  const quote = input.snippetText
    ? `'${snippet(input.snippetText)}'`
    : input.reason;
  await sendOwner(
    input.api,
    `${input.proposal.recipient_name} replied, needs you: ${quote}`,
    handoverKeyboard(input.proposal.id, slots, input.proposal.thread_id),
  );
  console.log(
    `Meeting handover: proposal=${input.proposal.id} reason=${input.reason}`,
  );
}

async function sendAutoEmail(input: {
  kind: "proposal" | "clarify";
  api: Api;
  card: CardPayload;
  slots: TimeSlot[];
  bodySource: { subject: string; body: string };
  now: Date;
  threadStatus: MeetingThreadStatus;
}): Promise<MeetingProposalRecord | undefined> {
  const thread = getMeetingThread(input.card.threadId);
  const already = thread?.auto_emails_sent ?? 0;
  if (already >= 2) {
    return undefined;
  }
  if (countMeetingAutoSendsToday(input.now) >= config.autoSendDailyCap) {
    return undefined;
  }
  const opening =
    input.kind === "proposal"
      ? await resolveOpeningLine(input.bodySource.subject, input.bodySource.body)
      : "";
  const slotLines = offerSlotLines(input.slots, input.card.senderTimezone);
  const template =
    input.kind === "proposal"
      ? {
          firstName: firstNameFrom(input.card.fromName, input.card.fromEmail),
          openingLine: opening,
          durationMinutes: input.card.durationMinutes,
          slots: slotLines,
        }
      : undefined;
  const clarify =
    input.kind === "clarify"
      ? {
          firstName: firstNameFrom(input.card.fromName, input.card.fromEmail),
          slots: slotLines,
        }
      : undefined;
  const body =
    input.kind === "proposal" && template
      ? renderProposalBody(template)
      : renderClarifyBody(clarify!);
  if (containsForbiddenInternal(body) || TELEGRAM_ONLY_LABELS.some((label) => body.includes(label))) {
    throw new Error("internal_label");
  }
  const signatureHtml = await workSignatureHtml();
  const html = htmlFromSchedulingBody(body, signatureHtml);
  const dummyProposal = {
    recipient_email: input.card.fromEmail,
    recipient_name: input.card.fromName,
    cc_emails: JSON.stringify(input.card.ccEmails),
    id: 0,
    thread_id: input.card.threadId,
    sent_message_id: "",
    slots: JSON.stringify(toSlotJson(input.slots)),
    duration_minutes: input.card.durationMinutes,
    sender_timezone: input.card.senderTimezone,
    hold_event_ids: "[]",
    status: "open" as const,
    created_at: input.now.toISOString(),
  };
  const sendImpl =
    testHooks.sendImpl ??
    (process.env.AADI_DB_PATH === ":memory:"
      ? async () => ({ messageId: `mem-${randomUUID()}` })
      : undefined);
  const sent = await sendSchedulingEmail({
    kind: input.kind,
    gate: sendGateFromProposal(
      dummyProposal,
      input.card.fromEmail,
      input.card.ccEmails,
      input.now,
    ),
    body,
    html,
    signatureHtml,
    proposal: template,
    clarify,
    sendImpl,
    account: sendImpl ? undefined : await workAccount(),
    threadId: input.card.threadId,
    to: input.card.fromEmail,
    subject: input.card.subject,
    inReplyTo: input.card.inReplyTo || `<${input.card.messageId}@mail>`,
    references: input.card.references,
  });
  const proposal = createMeetingProposal({
    threadId: input.card.threadId,
    sentMessageId: sent.messageId,
    recipientEmail: input.card.fromEmail,
    recipientName: input.card.fromName,
    ccEmails: input.card.ccEmails,
    slots: toSlotJson(input.slots),
    durationMinutes: input.card.durationMinutes,
    senderTimezone: input.card.senderTimezone,
  });
  recordMeetingAutoSend({
    threadId: input.card.threadId,
    kind: input.kind,
    messageId: sent.messageId,
  });
  upsertMeetingThread({
    threadId: input.card.threadId,
    recipientEmail: input.card.fromEmail,
    recipientName: input.card.fromName,
    company: companyFromEmail(input.card.fromEmail),
    senderType: thread?.sender_type ?? "prospect_enquiry",
    status: input.threadStatus,
    autoEmailsSent: already + 1,
    lastKind: input.kind,
    subject: input.card.subject,
    proposalId: proposal.id,
  });
  await createHolds(proposal);
  console.log(
    `Meeting auto-send: kind=${input.kind} proposal=${proposal.id} thread=${input.card.threadId}`,
  );
  return proposal;
}

function gateFromProposal(
  proposal: MeetingProposalRecord,
  fromEmail: string,
  incomingToCc: string[],
  now: Date,
): AutoBookGateInput {
  return {
    autoBook: config.autoBook,
    fromEmail,
    recipientEmail: proposal.recipient_email,
    incomingToCc,
    proposalEmails: proposalEmails(proposal),
    dailyCount: countAutoBooksToday(now),
    dailyCap: config.autoBookDailyCap,
  };
}

function sendGateFromProposal(
  proposal: MeetingProposalRecord,
  fromEmail: string,
  incomingToCc: string[],
  now: Date,
): SchedulingSendGateInput {
  return {
    ...gateFromProposal(proposal, fromEmail, incomingToCc, now),
    dailySendCount: countMeetingAutoSendsToday(now),
    dailySendCap: config.autoSendDailyCap,
  };
}

function offerSlotLines(slots: TimeSlot[], timeZone: string | null): string[] {
  return slots.map((slot) => formatOfferSlot(slot, timeZone));
}

async function resolveOpeningLine(subject: string, body: string): Promise<string> {
  const raw = testHooks.openingLine
    ? await testHooks.openingLine({ subject, body })
    : await draftOpeningLine({ subject, body });
  return openingLineOrFallback(raw);
}

async function createHolds(proposal: MeetingProposalRecord): Promise<void> {
  if (!config.meetingHoldsOnPropose) {
    return;
  }
  const account = await workAccount();
  if (!account) {
    return;
  }
  const calendar = google.calendar({ version: "v3", auth: account.client });
  const slots = parseSlots(proposal.slots);
  const ids: string[] = [];
  for (const slot of slots) {
    const created = await calendar.events.insert({
      calendarId: "primary",
      sendUpdates: "none",
      requestBody: {
        summary: `HOLD: ${sanitizeLabel(proposal.recipient_name)}`,
        start: { dateTime: slot.start.toISOString(), timeZone: config.meetingTimezone },
        end: { dateTime: slot.end.toISOString(), timeZone: config.meetingTimezone },
        status: "tentative",
      },
    });
    if (created.data.id) {
      ids.push(created.data.id);
    }
  }
  setMeetingProposalHolds(proposal.id, ids);
}

async function removeHolds(proposal: MeetingProposalRecord): Promise<void> {
  const ids = JSON.parse(proposal.hold_event_ids || "[]") as string[];
  if (ids.length === 0) {
    return;
  }
  const account = await workAccount();
  if (!account) {
    return;
  }
  const calendar = google.calendar({ version: "v3", auth: account.client });
  for (const eventId of ids) {
    try {
      await calendar.events.delete({
        calendarId: "primary",
        eventId,
        sendUpdates: "none",
      });
    } catch {
      console.log(`Meeting hold delete skipped: proposal=${proposal.id}`);
    }
  }
  setMeetingProposalHolds(proposal.id, []);
}

export function expireOpenProposals(now = new Date()): number {
  let expired = 0;
  for (const proposal of listOpenMeetingProposals()) {
    const slots = parseSlots(proposal.slots);
    if (slots.length > 0 && slots.every((slot) => slot.end.getTime() < now.getTime())) {
      setMeetingProposalStatus(proposal.id, "expired");
      void removeHolds(proposal);
      expired += 1;
      console.log(`Meeting proposal expired: id=${proposal.id}`);
    }
  }
  return expired;
}

export async function onMeetingDraftSent(
  draftId: string,
  sentMessageId: string,
): Promise<void> {
  const intent = getMeetingDraftIntent(draftId);
  if (!intent) {
    return;
  }
  if (!sentMessageId) {
    console.log("Meeting proposal skipped: send returned no message id");
    return;
  }
  const proposal = createMeetingProposal({
    threadId: intent.thread_id,
    sentMessageId,
    recipientEmail: intent.recipient_email,
    recipientName: intent.recipient_name,
    ccEmails: JSON.parse(intent.cc_emails) as string[],
    slots: JSON.parse(intent.slots) as SlotJson[],
    durationMinutes: intent.duration_minutes,
    senderTimezone: intent.sender_timezone,
  });
  deleteMeetingDraftIntent(draftId);
  await createHolds(proposal);
  console.log(`Meeting proposal stored: id=${proposal.id} status=open`);
}

async function queueProposalDraft(
  card: CardPayload,
  slots: TimeSlot[],
  body: string,
): Promise<void> {
  const account = await getGoogleAccount("work");
  const isManual = card.threadId.startsWith("manual:");
  let draftId: string;
  let threadId = card.threadId;
  if (isManual) {
    const created = await createNewEmailDraft({
      account,
      to: [card.fromEmail],
      subject: card.subject || "Time to talk",
      body,
    });
    draftId = created.draftId;
    threadId = created.threadId;
  } else {
    const created = await createThreadReplyDraft({
      account,
      threadId: card.threadId,
      to: card.fromEmail,
      subject: /^re\s*:/i.test(card.subject) ? card.subject : `Re: ${card.subject}`,
      inReplyTo: card.inReplyTo,
      references: card.references,
      body,
    });
    draftId = created.draftId;
  }
  upsertMeetingDraftIntent({
    draftId,
    threadId,
    recipientEmail: card.fromEmail,
    recipientName: card.fromName,
    ccEmails: card.ccEmails,
    slots: toSlotJson(slots),
    durationMinutes: card.durationMinutes,
    senderTimezone: card.senderTimezone,
  });
  await queueDraftApproval({
    draftId,
    threadId,
    to: card.fromEmail,
    subject: card.subject,
    body,
    googleAccount: "work",
    extraLines: ["Meeting proposal — Send stores the offered slots."],
  });
}

async function insertWorkEvent(slot: TimeSlot, proposal: MeetingProposalRecord): Promise<string> {
  if (testHooks.insertEvent) {
    return testHooks.insertEvent(slot, proposal);
  }
  const account = await getGoogleAccount("work");
  const calendar = google.calendar({ version: "v3", auth: account.client });
  const created = await calendar.events.insert({
    calendarId: "primary",
    conferenceDataVersion: 1,
    sendUpdates: "none",
    requestBody: {
      summary: eventTitle(proposal.recipient_name, proposal.recipient_email),
      start: { dateTime: slot.start.toISOString(), timeZone: config.meetingTimezone },
      end: { dateTime: slot.end.toISOString(), timeZone: config.meetingTimezone },
      attendees: [
        { email: WORK_EMAIL },
        { email: proposal.recipient_email },
      ],
      conferenceData: {
        createRequest: {
          requestId: randomUUID(),
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      },
    },
  });
  const eventId = created.data.id;
  if (!eventId) {
    throw new Error("calendar insert returned no event id");
  }
  return eventId;
}

function cancelKeyboard(bookingId: number): InlineKeyboard {
  return new InlineKeyboard().text("Cancel meeting", `meet:cancel:${bookingId}`);
}

function confirmCancelKeyboard(bookingId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("Yes, cancel", `meet:cancelok:${bookingId}`)
    .text("Keep it", `meet:keep:${bookingId}`);
}

function draftAfterUndoKeyboard(proposalId: number): InlineKeyboard {
  return new InlineKeyboard().text("Draft a reply", `meet:pdraft:${proposalId}`);
}

async function notifyBooked(
  api: Api,
  proposal: MeetingProposalRecord,
  slot: TimeSlot,
  bookingId: number,
  sendAt: Date,
): Promise<void> {
  const when = formatOfferSlot(slot, proposal.sender_timezone);
  const sendTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(sendAt);
  const company = companyFromEmail(proposal.recipient_email);
  await sendOwner(
    api,
    `📅 Booked: ${proposal.recipient_name} (${company}), ${when}. Invite + confirmation go out at ${sendTime}.`,
    bookedKeyboard(bookingId, proposal.thread_id),
  );
}

export async function bookSelectedSlot(input: {
  proposal: MeetingProposalRecord;
  slotIndex: number;
  api: Api;
  now?: Date;
  skipConfirm?: boolean;
}): Promise<number | undefined> {
  const now = input.now ?? new Date();
  const slots = parseSlots(input.proposal.slots);
  const slot = slots[input.slotIndex];
  if (!slot) {
    await sendOwner(input.api, "That slot is no longer available.");
    return undefined;
  }
  const eventId = await insertWorkEvent(slot, input.proposal);
  const sendAt = new Date(now.getTime() + config.autoBookDelayMinutes * 60 * 1000);
  const booking = createMeetingPendingBooking({
    proposalId: input.proposal.id,
    eventId,
    slotIndex: input.slotIndex,
    sendAt: sendAt.toISOString(),
    skipConfirm: input.skipConfirm,
  });
  setMeetingProposalStatus(input.proposal.id, "booked");
  const thread = getMeetingThread(input.proposal.thread_id);
  upsertMeetingThread({
    threadId: input.proposal.thread_id,
    recipientEmail: input.proposal.recipient_email,
    recipientName: input.proposal.recipient_name,
    company: companyFromEmail(input.proposal.recipient_email),
    senderType: thread?.sender_type ?? "prospect_enquiry",
    status: "booked",
    autoEmailsSent: thread?.auto_emails_sent ?? 0,
    lastKind: thread?.last_kind,
    subject: thread?.subject ?? "",
    proposalId: input.proposal.id,
  });
  await removeHolds(input.proposal);
  await notifyBooked(input.api, input.proposal, slot, booking.id, sendAt);
  console.log(`Meeting pending booking: id=${booking.id} proposal=${input.proposal.id}`);
  if (config.autoBookDelayMinutes === 0) {
    await processDuePendingBookings({ now: sendAt, api: input.api });
  }
  return booking.id;
}

function cardFromProposal(
  proposal: MeetingProposalRecord,
  extra: Partial<CardPayload> = {},
): CardPayload {
  return {
    fromEmail: proposal.recipient_email,
    fromName: proposal.recipient_name,
    subject: extra.subject ?? "Meeting",
    ccEmails: extra.ccEmails ?? (JSON.parse(proposal.cc_emails) as string[]),
    kind: extra.kind ?? "asks_availability",
    windowHint: extra.windowHint ?? null,
    durationMinutes: proposal.duration_minutes,
    senderTimezone: proposal.sender_timezone,
    calendlyUrl: null,
    slotOffset: extra.slotOffset ?? 0,
    messageId: extra.messageId ?? proposal.sent_message_id,
    threadId: proposal.thread_id,
    inReplyTo: extra.inReplyTo ?? "",
    references: extra.references ?? "",
    proposedTimes: extra.proposedTimes ?? [],
  };
}

function ownTimeSlot(
  raw: string | null,
  durationMinutes: number,
): TimeSlot | undefined {
  if (!raw) {
    return undefined;
  }
  const start = new Date(raw);
  if (Number.isNaN(start.getTime())) {
    return undefined;
  }
  return {
    start,
    end: new Date(start.getTime() + durationMinutes * 60 * 1000),
  };
}

async function processReplyOnProposal(input: {
  api: Api;
  proposal: MeetingProposalRecord;
  message: gmail_v1.Schema$Message;
  fromEmail: string;
  now: Date;
}): Promise<void> {
  const toCc = [
    ...parseAddressList(messageHeader(input.message, "To")),
    ...parseAddressList(messageHeader(input.message, "Cc")),
  ];
  const extras = extraToCcAddresses(toCc, proposalEmails(input.proposal));
  if (extras.length > 0) {
    await handOverThread({
      api: input.api,
      proposal: input.proposal,
      reason: "new_cc",
      snippetText: collectPlain(input.message.payload),
    });
    return;
  }
  const body = collectPlain(input.message.payload);
  const mapping = await (testHooks.mapReply ?? mapReplyToSlot)({
    slotCount: parseSlots(input.proposal.slots).length,
    body,
  });
  const slots = parseSlots(input.proposal.slots);
  if (config.meetingMode !== "auto") {
    const slot = mapping.slot_index !== null ? slots[mapping.slot_index] : undefined;
    const stillFree = slot ? await slotIsFree(slot) : false;
    const decision = evaluateAutoBookChecks({
      ...gateFromProposal(input.proposal, input.fromEmail, toCc, input.now),
      slotIndex: mapping.slot_index,
      verdict: mapping.verdict,
      confidence: mapping.confidence,
      minConfidence: config.autoBookMinConfidence,
      slotCount: slots.length,
      slotStart: slot?.start ?? null,
      now: input.now,
      slotStillFree: stillFree,
    });
    if (!decision.ok) {
      console.log(`Auto-book skipped: proposal=${input.proposal.id} reason=${decision.reason}`);
      await sendOwner(
        input.api,
        `${input.proposal.recipient_name} replied to your proposed slots, but I'm not sure which one they picked.`,
        askKeyboard(input.proposal.id, slots.length),
      );
      return;
    }
    await bookSelectedSlot({
      proposal: input.proposal,
      slotIndex: decision.slotIndex,
      api: input.api,
      now: input.now,
    });
    return;
  }

  const thread = getMeetingThread(input.proposal.thread_id);
  const autoSent = thread?.auto_emails_sent ?? 0;
  const sendCapHit = countMeetingAutoSendsToday(input.now) >= config.autoSendDailyCap;
  const bookCapHit = countAutoBooksToday(input.now) >= config.autoBookDailyCap;

  if (mapping.reply_kind === "pick_one" && mapping.slot_index !== null) {
    const slot = slots[mapping.slot_index];
    if (!slot || mapping.confidence < config.autoBookMinConfidence) {
      await handOverThread({
        api: input.api,
        proposal: input.proposal,
        reason: "low_confidence",
        snippetText: body,
      });
      return;
    }
    if (bookCapHit) {
      await handOverThread({
        api: input.api,
        proposal: input.proposal,
        reason: "daily_cap",
        snippetText: body,
      });
      return;
    }
    const free = await slotIsFree(slot);
    if (!free) {
      await handOverThread({
        api: input.api,
        proposal: input.proposal,
        reason: "busy",
        snippetText: body,
      });
      return;
    }
    await bookSelectedSlot({
      proposal: input.proposal,
      slotIndex: mapping.slot_index,
      api: input.api,
      now: input.now,
    });
    return;
  }

  if (mapping.reply_kind === "own_time") {
    const custom = ownTimeSlot(mapping.own_time, input.proposal.duration_minutes);
    if (
      custom &&
      fitsWorkingHours(custom, config.meetingHours, config.meetingBreak) &&
      (await slotIsFree(custom))
    ) {
      if (bookCapHit) {
        await handOverThread({
          api: input.api,
          proposal: input.proposal,
          reason: "daily_cap",
          snippetText: body,
        });
        return;
      }
      setMeetingProposalSlots(input.proposal.id, toSlotJson([custom]));
      const updated = getMeetingProposal(input.proposal.id) ?? input.proposal;
      await bookSelectedSlot({
        proposal: updated,
        slotIndex: 0,
        api: input.api,
        now: input.now,
      });
      return;
    }
    if (autoSent >= 2 || sendCapHit) {
      await handOverThread({
        api: input.api,
        proposal: input.proposal,
        reason: sendCapHit ? "send_cap" : "max_auto_emails",
        snippetText: body,
      });
      return;
    }
    const nearHint = custom ? formatIstDateSafe(custom.start) : null;
    const card = cardFromProposal(input.proposal, {
      subject: messageHeader(input.message, "Subject") || "Meeting",
      messageId: input.message.id ?? input.proposal.sent_message_id,
      inReplyTo: messageHeader(input.message, "Message-ID"),
      references: messageHeader(input.message, "References"),
      windowHint: nearHint,
    });
    const nextSlots = await computeSlots(card);
    if (nextSlots.length === 0) {
      await handOverThread({
        api: input.api,
        proposal: input.proposal,
        reason: "no_slots",
        snippetText: body,
      });
      return;
    }
    setMeetingProposalStatus(input.proposal.id, "cancelled");
    const created = await sendAutoEmail({
      kind: "proposal",
      api: input.api,
      card,
      slots: nextSlots,
      bodySource: { subject: card.subject, body },
      now: input.now,
      threadStatus: "proposed",
    });
    if (!created) {
      await handOverThread({
        api: input.api,
        proposal: input.proposal,
        reason: "send_cap",
        snippetText: body,
      });
    }
    return;
  }

  if (mapping.reply_kind === "vague") {
    if (thread?.last_kind === "clarify" || autoSent >= 2 || sendCapHit) {
      await handOverThread({
        api: input.api,
        proposal: input.proposal,
        reason: autoSent >= 2 ? "max_auto_emails" : "still_vague",
        snippetText: body,
      });
      return;
    }
    const card = cardFromProposal(input.proposal, {
      subject: messageHeader(input.message, "Subject") || "Meeting",
      messageId: input.message.id ?? input.proposal.sent_message_id,
      inReplyTo: messageHeader(input.message, "Message-ID"),
      references: messageHeader(input.message, "References"),
    });
    const created = await sendAutoEmail({
      kind: "clarify",
      api: input.api,
      card,
      slots,
      bodySource: { subject: card.subject, body },
      now: input.now,
      threadStatus: "clarified",
    });
    if (!created) {
      await handOverThread({
        api: input.api,
        proposal: input.proposal,
        reason: "send_cap",
        snippetText: body,
      });
    }
    return;
  }

  await handOverThread({
    api: input.api,
    proposal: input.proposal,
    reason: "other",
    snippetText: body,
  });
}

function formatIstDateSafe(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

async function clashTitleFor(slot: TimeSlot): Promise<string> {
  if (testHooks.clashTitle) {
    return testHooks.clashTitle(slot);
  }
  try {
    const account = await getGoogleAccount("work");
    const calendar = google.calendar({ version: "v3", auth: account.client });
    const listed = await calendar.events.list({
      calendarId: "primary",
      timeMin: slot.start.toISOString(),
      timeMax: slot.end.toISOString(),
      singleEvents: true,
      maxResults: 3,
    });
    const summary = listed.data.items?.find((item) => item.summary)?.summary;
    return summary?.trim() || "an existing event";
  } catch {
    return "an existing event";
  }
}

async function processOwnerSentReply(input: {
  api: Api;
  proposal: MeetingProposalRecord;
  message: gmail_v1.Schema$Message;
  now: Date;
}): Promise<void> {
  const body = collectPlain(input.message.payload);
  const mapping = await (testHooks.mapReply ?? mapReplyToSlot)({
    slotCount: parseSlots(input.proposal.slots).length,
    body,
  });
  const slots = parseSlots(input.proposal.slots);
  if (mapping.reply_kind === "pick_one" && mapping.slot_index !== null) {
    const slot = slots[mapping.slot_index];
    if (slot && (await slotIsFree(slot))) {
      await bookSelectedSlot({
        proposal: input.proposal,
        slotIndex: mapping.slot_index,
        api: input.api,
        now: input.now,
        skipConfirm: true,
      });
      return;
    }
    const title = slot ? await clashTitleFor(slot) : "an existing event";
    await sendOwner(input.api, `⚠️ clashes with ${title}`);
    return;
  }
  if (mapping.reply_kind === "own_time") {
    const custom = ownTimeSlot(mapping.own_time, input.proposal.duration_minutes);
    if (
      custom &&
      fitsWorkingHours(custom, config.meetingHours, config.meetingBreak) &&
      (await slotIsFree(custom))
    ) {
      setMeetingProposalSlots(input.proposal.id, toSlotJson([custom]));
      const updated = getMeetingProposal(input.proposal.id) ?? input.proposal;
      await bookSelectedSlot({
        proposal: updated,
        slotIndex: 0,
        api: input.api,
        now: input.now,
        skipConfirm: true,
      });
      return;
    }
    const title = custom ? await clashTitleFor(custom) : "an existing event";
    await sendOwner(input.api, `⚠️ clashes with ${title}`);
  }
}

export async function processInboundMeetingMessage(
  api: Api,
  work: LoadedGoogleAccount,
  message: gmail_v1.Schema$Message,
  now: Date,
): Promise<void> {
  const messageId = message.id;
  const threadId = message.threadId;
  if (!messageId || !threadId) {
    return;
  }
  const inbound = insertMeetingInbound({
    googleAccount: "work",
    messageId,
    threadId,
  });
  if (!inbound) {
    console.log(`Meeting inbound: message=${messageId} status=dup`);
    return;
  }
  const fromHeader = messageHeader(message, "From");
  const fromEmail = parseAddressList(fromHeader)[0] ?? "";
  const subject = messageHeader(message, "Subject");
  const labels = message.labelIds ?? [];
  const isOwnerSent =
    normalizeEmail(fromEmail) === WORK_EMAIL &&
    labels.includes("SENT") &&
    !labels.includes("DRAFT");
  if (isOwnerSent) {
    const proposal = getOpenMeetingProposalByThread(threadId);
    if (
      proposal &&
      message.id !== proposal.sent_message_id &&
      !listMeetingAutoSendIds(threadId).includes(messageId)
    ) {
      setMeetingInboundProcessedAs(inbound.id, "autobook");
      console.log(
        `Meeting inbound: message=${messageId} inbound=${inbound.id} skip=- kind=owner_sent proposal=${proposal.id}`,
      );
      await processOwnerSentReply({
        api,
        proposal,
        message,
        now,
      });
      return;
    }
    setMeetingInboundProcessedAs(inbound.id, "skip");
    console.log(
      `Meeting inbound: message=${messageId} inbound=${inbound.id} skip=internal`,
    );
    return;
  }
  const skipped = inboundSkipReason({
    fromEmail,
    headers: message.payload?.headers,
    subject,
    mimeType: message.payload?.mimeType,
    testSenders: config.meetingTestSenders,
  });
  if (skipped) {
    setMeetingInboundProcessedAs(inbound.id, "skip");
    console.log(
      `Meeting inbound: message=${messageId} inbound=${inbound.id} skip=${skipped}`,
    );
    return;
  }
  const proposal = getOpenMeetingProposalByThread(threadId);
  if (proposal) {
    const proposalCreated = Date.parse(
      proposal.created_at.includes("T")
        ? proposal.created_at
        : `${proposal.created_at.replace(" ", "T")}Z`,
    );
    const messageTime = Number(message.internalDate);
    if (
      message.id === proposal.sent_message_id ||
      (Number.isFinite(messageTime) &&
        Number.isFinite(proposalCreated) &&
        messageTime <= proposalCreated)
    ) {
      setMeetingInboundProcessedAs(inbound.id, "skip");
      return;
    }
    setMeetingInboundProcessedAs(inbound.id, "autobook");
    console.log(
      `Meeting inbound: message=${messageId} inbound=${inbound.id} skip=- kind=autobook proposal=${proposal.id}`,
    );
    await processReplyOnProposal({
      api,
      proposal,
      message,
      fromEmail,
      now,
    });
    return;
  }
  const closed = getLatestMeetingProposalByThread(threadId);
  if (
    closed &&
    (closed.status === "booked" ||
      closed.status === "expired" ||
      closed.status === "cancelled")
  ) {
    setMeetingInboundProcessedAs(inbound.id, "skip");
    console.log(
      `Meeting inbound: message=${messageId} inbound=${inbound.id} skip=proposal_${closed.status}`,
    );
    return;
  }
  const bodyText = collectPlain(message.payload);
  const detection = await (testHooks.detect ?? detectMeetingRequest)({
    subject,
    body: bodyText,
  });
  setMeetingInboundProcessedAs(inbound.id, "detect");
  console.log(
    `Meeting inbound: message=${messageId} inbound=${inbound.id} skip=- kind=${detection.kind} sender_type=${detection.sender_type} confidence=${detection.confidence}`,
  );
  if (detection.kind === "none") {
    return;
  }
  const card: CardPayload = {
    fromEmail,
    fromName: senderDisplay(fromHeader),
    subject,
    ccEmails: parseAddressList(messageHeader(message, "Cc")),
    kind: detection.kind,
    windowHint: detection.window_hint,
    durationMinutes: detection.duration_minutes ?? config.meetingDefaultMinutes,
    senderTimezone: detection.sender_timezone,
    calendlyUrl: calendlyUrl(bodyText),
    slotOffset: 0,
    messageId,
    threadId,
    inReplyTo: messageHeader(message, "Message-ID"),
    references: messageHeader(message, "References"),
    proposedTimes: detection.proposed_times,
  };
  const autoHandle =
    config.meetingMode === "auto" &&
    AUTO_HANDLE_SENDER_TYPES.has(detection.sender_type) &&
    detection.confidence >= config.autoBookMinConfidence &&
    detection.kind !== "calendly_link";
  if (config.meetingMode === "auto" && !autoHandle) {
    setMeetingInboundProcessedAs(inbound.id, "ask");
    await sendVendorFyi(api, inbound.id, card, detection.sender_type);
    return;
  }
  if (autoHandle) {
    if (countMeetingAutoSendsToday(now) >= config.autoSendDailyCap) {
      setMeetingInboundProcessedAs(inbound.id, "ask");
      await sendVendorFyi(api, inbound.id, card, detection.sender_type);
      return;
    }
    const slots = await computeSlots(card);
    if (slots.length === 0) {
      setMeetingInboundProcessedAs(inbound.id, "ask");
      await sendVendorFyi(api, inbound.id, card, detection.sender_type);
      return;
    }
    setMeetingInboundProcessedAs(inbound.id, "card");
    const created = await sendAutoEmail({
      kind: "proposal",
      api,
      card,
      slots,
      bodySource: { subject, body: bodyText },
      now,
      threadStatus: "proposed",
    });
    if (!created) {
      await sendVendorFyi(api, inbound.id, card, detection.sender_type);
    }
    return;
  }
  setMeetingInboundProcessedAs(inbound.id, "card");
  await sendMeetingCard(api, inbound.id, card);
}

export async function runMeetingInboxScan(api: Api, now = new Date()): Promise<number> {
  console.log("Meeting inbox scan start");
  const work = await workAccount();
  if (!work) {
    console.log("Meeting inbox scan skipped: no_work_account");
    return 0;
  }
  const gmail = gmailClient(work);
  const listed = await gmail.users.messages.list({
    userId: "me",
    q: INBOX_QUERY,
    maxResults: 25,
  });
  let seen = 0;
  for (const item of listed.data.messages ?? []) {
    if (!item.id) {
      continue;
    }
    const response = await gmail.users.messages.get({
      userId: "me",
      id: item.id,
      format: "full",
    });
    await processInboundMeetingMessage(api, work, response.data, now);
    seen += 1;
  }
  console.log(`Meeting inbox scan: listed=${seen}`);
  return seen;
}

export async function runMeetingProposalPoll(api: Api, now = new Date()): Promise<void> {
  expireOpenProposals(now);
  const work = await workAccount();
  if (!work) {
    return;
  }
  const gmail = gmailClient(work);
  for (const proposal of listOpenMeetingProposals()) {
    try {
      const thread = await gmail.users.threads.get({
        userId: "me",
        id: proposal.thread_id,
        format: "full",
      });
      for (const message of thread.data.messages ?? []) {
        if (!message.id || message.labelIds?.includes("DRAFT")) {
          continue;
        }
        if (message.id === proposal.sent_message_id) {
          continue;
        }
        await processInboundMeetingMessage(api, work, message, now);
      }
    } catch {
      console.log(`Meeting proposal poll skipped: id=${proposal.id}`);
    }
  }
}

async function defaultEventExists(eventId: string): Promise<boolean> {
  try {
    const account = await getGoogleAccount("work");
    const calendar = google.calendar({ version: "v3", auth: account.client });
    const event = await calendar.events.get({ calendarId: "primary", eventId });
    return Boolean(event.data.id) && event.data.status !== "cancelled";
  } catch {
    return false;
  }
}

async function defaultPatchInvite(eventId: string): Promise<void> {
  const account = await getGoogleAccount("work");
  const calendar = google.calendar({ version: "v3", auth: account.client });
  await calendar.events.patch({
    calendarId: "primary",
    eventId,
    sendUpdates: "all",
    requestBody: { status: "confirmed" },
  });
}

async function latestThreadHeaders(threadId: string): Promise<{
  inReplyTo: string;
  references: string;
  subject: string;
  to: string;
}> {
  const account = await getGoogleAccount("work");
  const gmail = gmailClient(account);
  const thread = await gmail.users.threads.get({
    userId: "me",
    id: threadId,
    format: "metadata",
    metadataHeaders: ["Message-ID", "References", "Subject", "From"],
  });
  const last = [...(thread.data.messages ?? [])].at(-1);
  const headers = last?.payload?.headers;
  return {
    inReplyTo: header(headers, "Message-ID"),
    references: header(headers, "References"),
    subject: header(headers, "Subject"),
    to: header(headers, "From"),
  };
}

export async function processDuePendingBookings(
  hooks: DueBookingHooks = {},
): Promise<number> {
  const now = hooks.now ?? new Date();
  const due = listDueMeetingPendingBookings(now.toISOString());
  let sent = 0;
  for (const booking of due) {
    if (booking.status !== "pending") {
      continue;
    }
    const proposal = getMeetingProposal(booking.proposal_id);
    if (!proposal) {
      continue;
    }
    const exists = await (hooks.eventExists ?? defaultEventExists)(booking.event_id);
    if (!exists) {
      transitionMeetingPendingBooking(booking.id, "pending", "cancelled");
      console.log(`Pending booking skipped: id=${booking.id} reason=missing_event`);
      continue;
    }
    const slots = parseSlots(proposal.slots);
    const slot = slots[booking.slot_index];
    if (!slot) {
      continue;
    }
    const template = {
      firstName: firstNameFrom(proposal.recipient_name, proposal.recipient_email),
      dayDate: formatConfirmDayDate(slot.start),
      startTime: formatConfirmClock(slot.start),
      endTime: formatConfirmClock(slot.end),
      otherZone: formatOtherZoneRange(slot, proposal.sender_timezone),
    };
    const body = renderBookingConfirmBody(template);
    try {
      await (hooks.patchInvite ?? defaultPatchInvite)(booking.event_id);
      if (!booking.skip_confirm) {
        const headers = hooks.confirmSend
          ? {
              inReplyTo: "<mock>",
              references: "",
              subject: "Re: meeting",
              to: proposal.recipient_email,
            }
          : await latestThreadHeaders(proposal.thread_id);
        const signatureHtml = await workSignatureHtml();
        await sendSchedulingEmail({
          kind: "confirm",
          gate: sendGateFromProposal(
            proposal,
            proposal.recipient_email,
            JSON.parse(proposal.cc_emails) as string[],
            now,
          ),
          body,
          confirm: template,
          signatureHtml,
          sendImpl: hooks.confirmSend ?? testHooks.sendImpl,
          account: hooks.confirmSend || testHooks.sendImpl ? undefined : await workAccount(),
          threadId: proposal.thread_id,
          to: headers.to || proposal.recipient_email,
          subject: headers.subject,
          inReplyTo: headers.inReplyTo,
          references: headers.references,
        });
        recordMeetingAutoSend({
          threadId: proposal.thread_id,
          kind: "confirm",
          messageId: `confirm:${booking.id}`,
        });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "send_failed";
      console.log(`Pending booking send failed: id=${booking.id} reason=${reason}`);
      continue;
    }
    if (!transitionMeetingPendingBooking(booking.id, "pending", "sent")) {
      continue;
    }
    setMeetingProposalStatus(proposal.id, "booked");
    sent += 1;
    const text = `✉️ Invite sent to ${proposal.recipient_name}.`;
    if (hooks.notify) {
      await hooks.notify(text);
    } else if (hooks.api) {
      await sendOwner(hooks.api, text);
    } else {
      await sendOwnerTelegram(text);
    }
    console.log(`Pending booking sent: id=${booking.id} proposal=${proposal.id}`);
  }
  return sent;
}

async function sendOwnerTelegram(text: string, markup?: InlineKeyboard): Promise<void> {
  const { Api } = await import("grammy");
  const api = new Api(config.telegramBotToken);
  await api.sendMessage(
    config.ownerTelegramId,
    text,
    markup ? { reply_markup: markup } : {},
  );
}

async function deleteWorkEvent(eventId: string, sendUpdates: "none" | "all"): Promise<void> {
  const account = await getGoogleAccount("work");
  const calendar = google.calendar({ version: "v3", auth: account.client });
  await calendar.events.delete({
    calendarId: "primary",
    eventId,
    sendUpdates,
  });
}

export async function handleMeetingBookCallback(
  ctx: Context,
  data: string,
): Promise<boolean> {
  const undo = /^meet:undo:(\d+)$/.exec(data);
  if (undo) {
    await undoBooking(ctx, Number(undo[1]), new Date());
    return true;
  }
  const cancel = /^meet:cancel:(\d+)$/.exec(data);
  if (cancel) {
    await ctx.answerCallbackQuery();
    await ctx.reply("Cancel this meeting and notify them?", {
      reply_markup: confirmCancelKeyboard(Number(cancel[1])),
    });
    return true;
  }
  const cancelOk = /^meet:cancelok:(\d+)$/.exec(data);
  if (cancelOk) {
    await cancelSentBooking(ctx, Number(cancelOk[1]));
    return true;
  }
  const keep = /^meet:keep:(\d+)$/.exec(data);
  if (keep) {
    await ctx.answerCallbackQuery("Kept.");
    return true;
  }
  const autoSlots = /^meet:autoslots:(\d+)$/.exec(data);
  if (autoSlots) {
    const inboundId = Number(autoSlots[1]);
    const card = parseCard(getMeetingCardState(inboundId));
    if (!card) {
      await ctx.answerCallbackQuery("That card expired.");
      return true;
    }
    const slots = await computeSlots(card);
    if (slots.length === 0) {
      await ctx.answerCallbackQuery("No free slots.");
      return true;
    }
    await sendAutoEmail({
      kind: "proposal",
      api: ctx.api,
      card,
      slots,
      bodySource: { subject: card.subject, body: "" },
      now: new Date(),
      threadStatus: "proposed",
    });
    await ctx.answerCallbackQuery("Slots sent.");
    return true;
  }
  const ignore = /^meet:ignore:(\d+)$/.exec(data);
  if (ignore) {
    setMeetingInboundProcessedAs(Number(ignore[1]), "ignore");
    deleteMeetingCardState(Number(ignore[1]));
    await ctx.editMessageReplyMarkup().catch(() => undefined);
    await ctx.answerCallbackQuery("Ignored.");
    return true;
  }
  const next = /^meet:next:(\d+)$/.exec(data);
  if (next) {
    const inboundId = Number(next[1]);
    const card = parseCard(getMeetingCardState(inboundId));
    if (!card) {
      await ctx.answerCallbackQuery("That card expired.");
      return true;
    }
    card.slotOffset += config.meetingSlotsToOffer;
    const slots = await computeSlots(card);
    setMeetingCardState(inboundId, JSON.stringify(card));
    await ctx.editMessageText(cardText(card, slots), {
      reply_markup: cardKeyboard(inboundId, slots, card.kind),
    }).catch(() => undefined);
    await ctx.answerCallbackQuery("Next slots.");
    return true;
  }
  const draft = /^meet:draft:(\d+)$/.exec(data);
  if (draft) {
    const inboundId = Number(draft[1]);
    const card = parseCard(getMeetingCardState(inboundId));
    if (!card) {
      await ctx.answerCallbackQuery("That card expired.");
      return true;
    }
    const slots = await computeSlots(card);
    if (slots.length === 0) {
      await ctx.answerCallbackQuery("No free slots.");
      return true;
    }
    await queueProposalDraft(card, slots, proposalDraftBody(card, slots));
    await ctx.answerCallbackQuery("Draft ready.");
    return true;
  }
  const accept = /^meet:accept:(\d+):(\d+)$/.exec(data);
  if (accept) {
    const inboundId = Number(accept[1]);
    const slotIndex = Number(accept[2]);
    const card = parseCard(getMeetingCardState(inboundId));
    if (!card) {
      await ctx.answerCallbackQuery("That card expired.");
      return true;
    }
    const slots = await computeSlots(card);
    const slot = slots[slotIndex];
    if (!slot) {
      await ctx.answerCallbackQuery("That slot is gone.");
      return true;
    }
    await queueProposalDraft(card, [slot], acceptDraftBody(card, slot));
    await ctx.answerCallbackQuery("Draft ready.");
    return true;
  }
  const book = /^meet:book:(\d+):(\d+)$/.exec(data);
  if (book) {
    const proposal = getMeetingProposal(Number(book[1]));
    if (!proposal) {
      await ctx.answerCallbackQuery("Proposal gone.");
      return true;
    }
    await bookSelectedSlot({
      proposal,
      slotIndex: Number(book[2]),
      api: ctx.api,
    });
    await ctx.answerCallbackQuery("Booking.");
    return true;
  }
  const pignore = /^meet:pignore:(\d+)$/.exec(data);
  if (pignore) {
    await ctx.editMessageReplyMarkup().catch(() => undefined);
    await ctx.answerCallbackQuery("Ignored.");
    return true;
  }
  const pdraft = /^meet:pdraft:(\d+)$/.exec(data);
  if (pdraft) {
    const proposal = getMeetingProposal(Number(pdraft[1]));
    if (!proposal) {
      await ctx.answerCallbackQuery("Proposal gone.");
      return true;
    }
    const card: CardPayload = {
      fromEmail: proposal.recipient_email,
      fromName: proposal.recipient_name,
      subject: "Meeting",
      ccEmails: JSON.parse(proposal.cc_emails) as string[],
      kind: "asks_availability",
      windowHint: null,
      durationMinutes: proposal.duration_minutes,
      senderTimezone: proposal.sender_timezone,
      calendlyUrl: null,
      slotOffset: 0,
      messageId: proposal.sent_message_id,
      threadId: proposal.thread_id,
      inReplyTo: "",
      references: "",
      proposedTimes: [],
    };
    const work = await workAccount();
    if (work && !proposal.thread_id.startsWith("manual:")) {
      const gmail = gmailClient(work);
      const thread = await gmail.users.threads.get({
        userId: "me",
        id: proposal.thread_id,
        format: "metadata",
        metadataHeaders: ["Message-ID", "References", "Subject"],
      });
      const last = [...(thread.data.messages ?? [])].at(-1);
      card.inReplyTo = header(last?.payload?.headers, "Message-ID");
      card.references = header(last?.payload?.headers, "References");
      card.subject = header(last?.payload?.headers, "Subject") || card.subject;
    }
    await queueProposalDraft(card, parseSlots(proposal.slots), proposalDraftBody(card, parseSlots(proposal.slots)));
    await ctx.answerCallbackQuery("Draft ready.");
    return true;
  }
  return false;
}

async function undoBooking(ctx: Context, bookingId: number, now: Date): Promise<void> {
  const booking = getMeetingPendingBooking(bookingId);
  if (!booking) {
    await ctx.answerCallbackQuery("Nothing to undo.");
    return;
  }
  const proposal = getMeetingProposal(booking.proposal_id);
  if (booking.status !== "pending" || new Date(booking.send_at).getTime() <= now.getTime()) {
    await ctx.answerCallbackQuery();
    await ctx.reply("The invite may already be going out.", {
      reply_markup: cancelKeyboard(bookingId),
    });
    return;
  }
  try {
    await deleteWorkEvent(booking.event_id, "none");
  } catch {
    console.log(`Undo delete skipped: id=${bookingId}`);
  }
  transitionMeetingPendingBooking(bookingId, "pending", "cancelled");
  if (proposal) {
    setMeetingProposalStatus(proposal.id, "open");
  }
  await ctx.answerCallbackQuery("Undone.");
  await ctx.reply(
    `Undone. Nothing was sent to ${proposal?.recipient_name ?? "them"}.`,
    proposal ? { reply_markup: draftAfterUndoKeyboard(proposal.id) } : {},
  );
  console.log(`Pending booking undone: id=${bookingId}`);
}

async function cancelSentBooking(ctx: Context, bookingId: number): Promise<void> {
  const booking = getMeetingPendingBooking(bookingId);
  if (!booking) {
    await ctx.answerCallbackQuery("Already gone.");
    return;
  }
  try {
    await deleteWorkEvent(booking.event_id, "all");
  } catch {
    console.log(`Cancel delete failed: id=${bookingId}`);
  }
  if (booking.status === "pending") {
    transitionMeetingPendingBooking(bookingId, "pending", "cancelled");
  }
  const proposal = getMeetingProposal(booking.proposal_id);
  if (proposal) {
    setMeetingProposalStatus(proposal.id, "cancelled");
  }
  await ctx.answerCallbackQuery("Cancelled.");
  await ctx.reply("Meeting cancelled.");
}

export async function tryHandleMeetingChat(
  ctx: Context,
  text: string,
): Promise<boolean> {
  const propose = text.match(/^propose slots to\s+(\S+@\S+)/i);
  const find = text.match(
    /^find\s+(\d+)\s*min(?:utes)?\s+with\s+(\S+@\S+)(?:\s+(.+))?$/i,
  );
  if (!propose && !find) {
    return false;
  }
  const email = normalizeEmail(propose?.[1] ?? find?.[2] ?? "");
  if (!email) {
    return false;
  }
  const duration = find ? Number(find[1]) : config.meetingDefaultMinutes;
  const windowHint = find?.[3]?.trim() || "next week";
  const inbound = insertMeetingInbound({
    messageId: `manual:${randomUUID()}`,
    threadId: `manual:${randomUUID()}`,
    processedAs: "card",
  });
  if (!inbound) {
    await ctx.reply("Could not start that meeting card.");
    return true;
  }
  const card: CardPayload = {
    fromEmail: email,
    fromName: firstNameFrom("", email),
    subject: "Time to talk",
    ccEmails: [],
    kind: "asks_availability",
    windowHint,
    durationMinutes: Number.isFinite(duration) ? duration : config.meetingDefaultMinutes,
    senderTimezone: null,
    calendlyUrl: null,
    slotOffset: 0,
    messageId: inbound.message_id,
    threadId: inbound.thread_id,
    inReplyTo: "",
    references: "",
    proposedTimes: [],
  };
  await sendMeetingCard(ctx.api, inbound.id, card);
  return true;
}

export function formatMeetingsReport(now = new Date()): string {
  const threads = listMeetingThreads();
  const startOfToday = new Date(
    `${new Intl.DateTimeFormat("en-CA", {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now)}T00:00:00+05:30`,
  );
  const rows = threads.filter((row) => {
    const updated = new Date(
      row.updated_at.includes("T") ? row.updated_at : `${row.updated_at}Z`,
    );
    return updated.getTime() >= startOfToday.getTime() - 7 * 24 * 60 * 60 * 1000;
  });
  if (rows.length === 0) {
    return "No auto-handled meeting threads yet.";
  }
  const lines = ["Meetings"];
  for (const row of rows) {
    lines.push(
      `${row.recipient_name} — ${row.status} — ${row.auto_emails_sent} auto email(s)${
        row.last_kind ? ` — last ${row.last_kind}` : ""
      }`,
    );
  }
  return lines.join("\n");
}

export function registerMeetingBookingJobs(api: Api): {
  inbox: IntervalJob;
  poll: IntervalJob;
  pending: IntervalJob;
} {
  const inbox = everyMs(
    "meeting-inbox",
    10 * 60 * 1000,
    async () => {
      await runMeetingInboxScan(api);
    },
    { runImmediately: true },
  );
  const poll = everyMs(
    "meeting-poll",
    2 * 60 * 1000,
    () => runMeetingProposalPoll(api),
    { runImmediately: true },
  );
  const pending = everyMs(
    "meeting-pending",
    60 * 1000,
    async () => {
      expireOpenProposals();
      await processDuePendingBookings();
    },
    { runImmediately: true },
  );
  console.log(
    `Meeting inbox every 10 min, proposals every 2 min, bookings every 1 min (${TIME_ZONE}).`,
  );
  return { inbox, poll, pending };
}

export type { MeetingDetection };