import { randomUUID } from "node:crypto";
import { google, type calendar_v3, type gmail_v1 } from "googleapis";
import { config } from "./config.js";
import {
  claimCommandSend,
  markCommandSendUnconfirmed,
  recordCommandSendSent,
  releaseCommandSend,
} from "./db.js";
import { parseAddressList, type ParsedMailbox } from "./followup_logic.js";
import { getGoogleAccount, loadGoogleAccounts } from "./google/auth.js";
import { gmailClient } from "./google/mail.js";
import {
  findSlots,
  formatSlotIst,
  type BusyInterval,
} from "./meeting_slots.js";
import { isSelfEmail } from "./mom_logic.js";
import { allowOwnerChatCreateEvent } from "./security/send_approval.js";
import { assertTestSeam } from "./test_seam.js";

const TIME_ZONE = "Asia/Kolkata";
const WORK_SEARCH = "-in:chats";

export interface OwnerMeetingInput {
  person: string;
  title?: string;
  startTime?: string;
  endTime?: string;
  durationMinutes?: number;
  confirmation: { chatId: number; messageId: number } | undefined;
}

export interface OwnerMeetingInsert {
  title: string;
  startIso: string;
  endIso: string;
  attendeeEmail: string;
  attendeeName: string;
  sendUpdates: "all";
  guestsCanSeeOtherGuests: true;
}

export type OwnerMeetingLookup =
  | { kind: "one"; mailbox: ParsedMailbox }
  | { kind: "several"; mailboxes: ParsedMailbox[] }
  | { kind: "none" };

interface OwnerMeetingHooks {
  lookup?: (person: string) => Promise<OwnerMeetingLookup>;
  loadBusy?: (timeMin: Date, timeMax: Date) => Promise<BusyInterval[]>;
  insert?: (event: OwnerMeetingInsert) => Promise<{
    hangoutLink?: string;
    htmlLink?: string;
  }>;
  insertCommand?: (event: CommandEventInsert) => Promise<{
    id?: string;
    hangoutLink?: string;
    htmlLink?: string;
  }>;
}

let testHooks: OwnerMeetingHooks = {};

export function setOwnerMeetingTestHooks(hooks: OwnerMeetingHooks): void {
  assertTestSeam("setOwnerMeetingTestHooks");
  testHooks = hooks;
}

export function resetOwnerMeetingTestHooks(): void {
  testHooks = {};
}

function isValidIso(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function nameTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

export function mailboxMatchesName(
  query: string,
  mailbox: ParsedMailbox,
): boolean {
  const tokens = nameTokens(query);
  if (tokens.length === 0) {
    return false;
  }
  const hay = `${mailbox.name} ${mailbox.email} ${mailbox.email.split("@")[0]}`.toLowerCase();
  return tokens.every((token) => hay.includes(token));
}

function collectMailboxes(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
): ParsedMailbox[] {
  const names = ["From", "To", "Cc"];
  const found: ParsedMailbox[] = [];
  for (const name of names) {
    const value =
      headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())
        ?.value ?? "";
    found.push(...parseAddressList(value));
  }
  return found;
}

async function lookupPerson(person: string): Promise<OwnerMeetingLookup> {
  if (testHooks.lookup) {
    return testHooks.lookup(person);
  }
  const trimmed = person.trim();
  if (trimmed.includes("@")) {
    const parsed = parseAddressList(trimmed);
    const mailbox = parsed[0];
    if (!mailbox || isSelfEmail(mailbox.email)) {
      return { kind: "none" };
    }
    return { kind: "one", mailbox };
  }
  const account = await getGoogleAccount("work");
  const gmail = gmailClient(account);
  const quoted = trimmed.replace(/"/g, "");
  const query = `{from:"${quoted}" to:"${quoted}" cc:"${quoted}"} ${WORK_SEARCH}`;
  const listed = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: 20,
  });
  const unique = new Map<string, ParsedMailbox>();
  for (const message of listed.data.messages ?? []) {
    if (!message.id) {
      continue;
    }
    const full = await gmail.users.messages.get({
      userId: "me",
      id: message.id,
      format: "metadata",
      metadataHeaders: ["From", "To", "Cc"],
    });
    for (const mailbox of collectMailboxes(full.data.payload?.headers)) {
      if (isSelfEmail(mailbox.email)) {
        continue;
      }
      if (!mailboxMatchesName(trimmed, mailbox)) {
        continue;
      }
      unique.set(mailbox.email, mailbox);
    }
  }
  const mailboxes = [...unique.values()];
  if (mailboxes.length === 0) {
    return { kind: "none" };
  }
  if (mailboxes.length === 1) {
    return { kind: "one", mailbox: mailboxes[0]! };
  }
  return { kind: "several", mailboxes };
}

function formatMailboxOption(item: ParsedMailbox): string {
  return item.name && item.name.toLowerCase() !== item.email
    ? `${item.name} <${item.email}>`
    : item.email;
}

function defaultTitle(person: string, mailbox: ParsedMailbox): string {
  const name = mailbox.name.trim() || person.trim();
  const display =
    name && !name.includes("@")
      ? name
      : person.trim() || mailbox.email.split("@")[0] || mailbox.email;
  return `Vishnu <> ${display}`;
}

function slotClash(
  start: Date,
  end: Date,
  busy: BusyInterval[],
): boolean {
  return busy.some((item) => start < item.end && end > item.start);
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
        timeZone: TIME_ZONE,
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

function offerSlots(now: Date, busy: BusyInterval[], durationMinutes: number): string {
  const slots = findSlots({
    now,
    busy,
    durationMinutes,
    hours: config.meetingHours,
    breakMinutes: config.meetingBreak,
    bufferMinutes: config.meetingBufferMinutes,
    minNoticeHours: config.meetingMinNoticeHours,
    horizonDays: config.meetingHorizonDays,
    slotsToOffer: config.meetingSlotsToOffer,
    timezone: config.meetingTimezone,
  });
  if (slots.length === 0) {
    return "No free 30-minute slots on either calendar in the next week. Give me a time.";
  }
  const lines = slots.map((slot) => formatSlotIst(slot));
  return `I have not created anything. Free slots: ${lines.join("; ")}. Which one?`;
}

function meetLinkFromEvent(event: calendar_v3.Schema$Event): string | undefined {
  if (event.hangoutLink) {
    return event.hangoutLink;
  }
  const video = event.conferenceData?.entryPoints?.find(
    (entry) => entry.entryPointType === "video" && entry.uri,
  );
  return video?.uri ?? undefined;
}

async function insertWorkMeeting(
  event: OwnerMeetingInsert,
): Promise<{ hangoutLink?: string; htmlLink?: string }> {
  if (testHooks.insert) {
    return testHooks.insert(event);
  }
  const account = await getGoogleAccount("work");
  const calendar = google.calendar({ version: "v3", auth: account.client });
  const created = await calendar.events.insert({
    calendarId: "primary",
    conferenceDataVersion: 1,
    sendUpdates: event.sendUpdates,
    requestBody: {
      summary: event.title,
      start: { dateTime: event.startIso, timeZone: TIME_ZONE },
      end: { dateTime: event.endIso, timeZone: TIME_ZONE },
      attendees: [{ email: event.attendeeEmail, displayName: event.attendeeName }],
      guestsCanSeeOtherGuests: true,
      conferenceData: {
        createRequest: {
          requestId: randomUUID(),
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      },
    },
  });
  return {
    hangoutLink: meetLinkFromEvent(created.data),
    htmlLink: created.data.htmlLink ?? undefined,
  };
}

function formatWhen(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const day = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(start);
  const clock = (iso: Date) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TIME_ZONE,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(iso);
  return `${day}, ${clock(start)}–${clock(end)} IST`;
}

export async function createOwnerMeeting(
  input: OwnerMeetingInput,
): Promise<string> {
  try {
    allowOwnerChatCreateEvent(input.confirmation);
  } catch {
    return "Not created: only Vishnu's own chat message can create a meeting.";
  }

  const person = input.person.trim();
  if (!person) {
    return "Not created: I need the person's name or email.";
  }

  const lookup = await lookupPerson(person);
  if (lookup.kind === "none") {
    return `Not created: no work-mail From/To/Cc match for "${person}". Paste their email.`;
  }
  if (lookup.kind === "several") {
    const options = lookup.mailboxes.map(formatMailboxOption).join(" or ");
    return `Not created: several matches — ${options}?`;
  }

  const mailbox = lookup.mailbox;
  const duration =
    typeof input.durationMinutes === "number" &&
    Number.isFinite(input.durationMinutes) &&
    input.durationMinutes > 0
      ? Math.round(input.durationMinutes)
      : config.meetingDefaultMinutes;
  const title = input.title?.trim() || defaultTitle(person, mailbox);
  const startIso = input.startTime?.trim() ?? "";
  const endIso = input.endTime?.trim() ?? "";

  if (!startIso) {
    const now = new Date();
    const horizon = new Date(
      now.getTime() + config.meetingHorizonDays * 24 * 60 * 60 * 1000,
    );
    const busy = await loadBusy(now, horizon);
    return offerSlots(now, busy, duration);
  }

  if (!isValidIso(startIso)) {
    return "Not created: start_time must be ISO 8601 with a +05:30 offset.";
  }
  const start = new Date(startIso);
  const end = endIso && isValidIso(endIso)
    ? new Date(endIso)
    : new Date(start.getTime() + duration * 60_000);
  if (!(end.getTime() > start.getTime())) {
    return "Not created: end_time must be after start_time.";
  }

  const busy = await loadBusy(
    new Date(start.getTime() - 60_000),
    new Date(end.getTime() + 60_000),
  );
  if (slotClash(start, end, busy)) {
    const now = new Date();
    const horizon = new Date(
      now.getTime() + config.meetingHorizonDays * 24 * 60 * 60 * 1000,
    );
    const weekBusy = await loadBusy(now, horizon);
    return `Not created: that time clashes with an existing event. ${offerSlots(now, weekBusy, duration)}`;
  }

  const insert: OwnerMeetingInsert = {
    title,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    attendeeEmail: mailbox.email,
    attendeeName: mailbox.name || person,
    sendUpdates: "all",
    guestsCanSeeOtherGuests: true,
  };
  const created = await insertWorkMeeting(insert);
  const when = formatWhen(start.toISOString(), end.toISOString());
  const attendee = formatMailboxOption(mailbox);
  const lines = [
    `Created: ${title}`,
    `When: ${when}`,
    `Attendee: ${attendee}`,
  ];
  if (created.hangoutLink) {
    lines.push(`Meet: ${created.hangoutLink}`);
  } else {
    lines.push("No Meet link came back from Google.");
  }
  lines.push("Invite emailed to the attendee.");
  return lines.join("\n");
}

// ---- Calendar on command, while SEND_ON_COMMAND_ENABLED is on. No card. ----

export interface CommandEventInsert {
  title: string;
  startIso?: string;
  endIso?: string;
  /** An all-day event: YYYY-MM-DD, with the end day exclusive. */
  startDate?: string;
  endDate?: string;
  attendees: ParsedMailbox[];
}

const PAST_GRACE_MS = 5 * 60 * 1000;

/** Delivery safety only: the toggle, and an invite can reach only addresses resolved
 *  from what Vishnu named. */
export function evaluateCommandEventGate(input: {
  enabled: boolean;
  attendees: readonly ParsedMailbox[];
  resolved: ReadonlySet<string>;
}): { ok: true } | { ok: false; reason: string } {
  if (!input.enabled) {
    return { ok: false, reason: "disabled" };
  }
  for (const attendee of input.attendees) {
    const email = attendee.email.toLowerCase();
    if (!input.resolved.has(email)) {
      return { ok: false, reason: "attendee_not_resolved" };
    }
    if (isSelfEmail(email)) {
      return { ok: false, reason: "attendee_is_self" };
    }
  }
  return { ok: true };
}

/** Exact start and end from what the model passed, or why it can't be used. */
export function parseCommandTimes(input: {
  startTime?: string;
  endTime?: string;
  durationMinutes?: number;
  now: Date;
}): { startIso: string; endIso: string } | { problem: string } {
  const startIso = input.startTime?.trim() ?? "";
  if (!isValidIso(startIso)) {
    return { problem: "start_time must be ISO 8601 with a +05:30 offset." };
  }
  const start = new Date(startIso);
  if (start.getTime() < input.now.getTime() - PAST_GRACE_MS) {
    return { problem: "that time has already passed." };
  }
  const duration =
    typeof input.durationMinutes === "number" && input.durationMinutes > 0
      ? Math.round(input.durationMinutes)
      : config.meetingDefaultMinutes;
  const endIso = input.endTime?.trim() ?? "";
  const end =
    endIso && isValidIso(endIso)
      ? new Date(endIso)
      : new Date(start.getTime() + duration * 60_000);
  if (end.getTime() <= start.getTime()) {
    return { problem: "end_time must be after start_time." };
  }
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

export async function freeSlotsText(durationMinutes: number | undefined, now: Date): Promise<string> {
  const duration =
    typeof durationMinutes === "number" && durationMinutes > 0
      ? Math.round(durationMinutes)
      : config.meetingDefaultMinutes;
  const horizon = new Date(now.getTime() + config.meetingHorizonDays * 24 * 60 * 60 * 1000);
  return offerSlots(now, await loadBusy(now, horizon), duration);
}

async function insertCommandEvent(
  event: CommandEventInsert,
): Promise<{ id?: string; hangoutLink?: string; htmlLink?: string }> {
  if (testHooks.insertCommand) {
    return testHooks.insertCommand(event);
  }
  const account = await getGoogleAccount("work");
  const calendar = google.calendar({ version: "v3", auth: account.client });
  const invites = event.attendees.length > 0;
  const created = await calendar.events.insert({
    calendarId: "primary",
    sendUpdates: invites ? "all" : "none",
    ...(invites ? { conferenceDataVersion: 1 } : {}),
    requestBody: {
      summary: event.title,
      start: event.startDate
        ? { date: event.startDate }
        : { dateTime: event.startIso, timeZone: TIME_ZONE },
      end: event.endDate
        ? { date: event.endDate }
        : { dateTime: event.endIso, timeZone: TIME_ZONE },
      ...(invites
        ? {
            attendees: event.attendees.map((item) => ({
              email: item.email,
              displayName: item.name || undefined,
            })),
            guestsCanSeeOtherGuests: true,
            conferenceData: {
              createRequest: {
                requestId: randomUUID(),
                conferenceSolutionKey: { type: "hangoutsMeet" },
              },
            },
          }
        : {}),
    },
  });
  return {
    id: created.data.id ?? undefined,
    hangoutLink: meetLinkFromEvent(created.data),
    htmlLink: created.data.htmlLink ?? undefined,
  };
}

function httpStatus(error: unknown): number | undefined {
  const record = error as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  for (const value of [record?.response?.status, record?.status, record?.code]) {
    const status = Number(value);
    if (Number.isInteger(status) && status >= 100 && status < 600) {
      return status;
    }
  }
  return undefined;
}

/** Said alongside the event, because a clash doesn't stop it. A failed lookup just
 *  means no warning. */
async function clashNote(startIso: string | undefined, endIso: string | undefined): Promise<string[]> {
  if (!startIso || !endIso) {
    return [];
  }
  const start = new Date(startIso);
  const end = new Date(endIso);
  try {
    const busy = await loadBusy(new Date(start.getTime() - 60_000), new Date(end.getTime() + 60_000));
    return slotClash(start, end, busy) ? ["Heads up: this overlaps something already on your calendar."] : [];
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.log(`Command event: clash check failed (${errorType})`);
    return [];
  }
}

/** The gated call behind create_event and book_meeting. Own message, then the gate,
 *  then the claim, then Calendar. The claim means a repeat can't invite twice. */
export async function createCommandEvent(input: {
  key: string;
  confirmation: { chatId: number; messageId: number } | undefined;
  event: CommandEventInsert;
  /** The addresses resolved from what he named. */
  resolved: ReadonlySet<string>;
}): Promise<
  | { ok: true; hangoutLink?: string; clash: string[] }
  | { ok: false; text: string }
> {
  try {
    allowOwnerChatCreateEvent(input.confirmation);
  } catch {
    return { ok: false, text: "only Vishnu's own message can do that." };
  }
  const gate = evaluateCommandEventGate({
    enabled: config.sendOnCommandEnabled,
    attendees: input.event.attendees,
    resolved: input.resolved,
  });
  if (!gate.ok) {
    return { ok: false, text: `a delivery check refused it (${gate.reason}).` };
  }
  if (!claimCommandSend({ key: input.key, account: "work", threadId: null })) {
    return { ok: false, text: "this command was already handled." };
  }
  const clash = await clashNote(input.event.startIso, input.event.endIso);
  let created: { id?: string; hangoutLink?: string };
  try {
    created = await insertCommandEvent(input.event);
  } catch (error) {
    const status = httpStatus(error);
    if (status !== undefined && status >= 400 && status < 500 && status !== 408) {
      releaseCommandSend(input.key);
      console.error(`Command event: provider=calendar status=rejected code=${status}`);
      return { ok: false, text: `Google Calendar refused it (${status}).` };
    }
    markCommandSendUnconfirmed(input.key);
    console.error("Command event: provider=calendar status=unconfirmed");
    return {
      ok: false,
      text: "Google Calendar didn't answer, so it may or may not exist. I won't try again. Check your calendar.",
    };
  }
  recordCommandSendSent(input.key, created.id ?? "unknown");
  console.log("Command event: provider=calendar status=created");
  return { ok: true, hangoutLink: created.hangoutLink, clash };
}

/** Calendar only: nobody is invited or emailed. */
export async function createOwnerCalendarEvent(input: {
  title: string;
  startTime?: string;
  endTime?: string;
  durationMinutes?: number;
  date?: string;
  confirmation: { chatId: number; messageId: number } | undefined;
  now: Date;
}): Promise<string> {
  const title = input.title.trim();
  if (!title) {
    return "Not created: I need a title.";
  }
  let event: CommandEventInsert;
  let when: string;
  const date = input.date?.trim() ?? "";
  if (date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return "Not created: date must be YYYY-MM-DD.";
    }
    const next = new Date(`${date}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    event = { title, startDate: date, endDate: next.toISOString().slice(0, 10), attendees: [] };
    when = `${date}, all day`;
  } else {
    if (!input.startTime?.trim()) {
      return "Not created: I need a time. Ask Vishnu when.";
    }
    const times = parseCommandTimes({ ...input, now: input.now });
    if ("problem" in times) {
      return `Not created: ${times.problem}`;
    }
    event = { title, startIso: times.startIso, endIso: times.endIso, attendees: [] };
    when = formatWhen(times.startIso, times.endIso);
  }
  const chat = input.confirmation;
  const result = await createCommandEvent({
    key: `event:${chat?.chatId}:${chat?.messageId}:${title}:${event.startIso ?? event.startDate}`,
    confirmation: input.confirmation,
    event,
    resolved: new Set(),
  });
  if (!result.ok) {
    return `Not created: ${result.text}`;
  }
  return [`Created: ${title}`, `When: ${when}`, "Nobody was invited.", ...result.clash].join("\n");
}

/** Called only once every attendee is resolved to exactly one address. */
export async function bookResolvedMeeting(input: {
  key: string;
  confirmation: { chatId: number; messageId: number } | undefined;
  title?: string;
  fallbackName: string;
  startIso: string;
  endIso: string;
  attendees: ParsedMailbox[];
  now: Date;
}): Promise<{ text: string; booked: boolean }> {
  if (new Date(input.startIso).getTime() < input.now.getTime() - PAST_GRACE_MS) {
    return { text: "Not booked: that time has already passed.", booked: false };
  }
  const title =
    input.title?.trim() ||
    defaultTitle(input.fallbackName, input.attendees[0] ?? { email: "", name: "" });
  const result = await createCommandEvent({
    key: `${input.key}:${input.startIso}`,
    confirmation: input.confirmation,
    event: { title, startIso: input.startIso, endIso: input.endIso, attendees: input.attendees },
    resolved: new Set(input.attendees.map((item) => item.email.toLowerCase())),
  });
  if (!result.ok) {
    return { text: `Not booked: ${result.text}`, booked: false };
  }
  return {
    text: [
      `Booked: ${title}`,
      `When: ${formatWhen(input.startIso, input.endIso)}`,
      `Attendees: ${input.attendees.map(formatMailboxOption).join(", ")}`,
      result.hangoutLink ? `Meet: ${result.hangoutLink}` : "No Meet link came back from Google.",
      "Invite emailed.",
      ...result.clash,
    ].join("\n"),
    booked: true,
  };
}
