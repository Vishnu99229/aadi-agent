import { randomUUID } from "node:crypto";
import { google, type calendar_v3, type gmail_v1 } from "googleapis";
import { config } from "./config.js";
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
