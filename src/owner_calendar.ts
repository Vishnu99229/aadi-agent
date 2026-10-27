import { google, type calendar_v3 } from "googleapis";
import { loadGoogleAccounts, type GoogleAccountId } from "./google/auth.js";
import { istInclusiveRange } from "./tools/list_events.js";
import { allowOwnerChatDeleteEvent } from "./security/send_approval.js";
import { assertTestSeam } from "./test_seam.js";

const TIME_ZONE = "Asia/Kolkata";

export interface OwnerCalendarEvent {
  accountId: GoogleAccountId;
  eventId: string;
  title: string;
  start: string;
  attendeeCount: number;
}

interface OwnerCalendarHooks {
  list?: (query: {
    title: string;
    date?: string;
  }) => Promise<OwnerCalendarEvent[]>;
  delete?: (event: OwnerCalendarEvent) => Promise<void>;
}

let testHooks: OwnerCalendarHooks = {};

export function setOwnerCalendarTestHooks(hooks: OwnerCalendarHooks): void {
  assertTestSeam("setOwnerCalendarTestHooks");
  testHooks = hooks;
}

export function resetOwnerCalendarTestHooks(): void {
  testHooks = {};
}

function istYmd(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function addIstDays(ymd: string, days: number): string {
  const [year, month, day] = ymd.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  const yyyy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function searchRange(date: string | undefined): { timeMin: string; timeMax: string } {
  if (date) {
    return istInclusiveRange(date, date);
  }
  const today = istYmd(new Date());
  return istInclusiveRange(addIstDays(today, -7), addIstDays(today, 60));
}

function titleMatches(query: string, summary: string): boolean {
  const needle = query.trim().toLowerCase();
  const hay = summary.trim().toLowerCase();
  return hay === needle || hay.includes(needle);
}

function formatEventDate(start: string): string {
  const instant = start.includes("T")
    ? new Date(start)
    : new Date(`${start}T00:00:00+05:30`);
  if (!Number.isFinite(instant.getTime())) {
    return start;
  }
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(instant);
}

function formatMatch(event: OwnerCalendarEvent, index: number): string {
  return `${index + 1}. [${event.accountId}] ${event.title} — ${formatEventDate(event.start)} (${event.start})`;
}

function startOfEvent(event: calendar_v3.Schema$Event): string {
  return event.start?.dateTime ?? event.start?.date ?? "";
}

async function listMatchingEvents(
  title: string,
  date: string | undefined,
): Promise<OwnerCalendarEvent[]> {
  if (testHooks.list) {
    return testHooks.list({ title, date });
  }
  const range = searchRange(date);
  const found: OwnerCalendarEvent[] = [];
  for (const account of await loadGoogleAccounts()) {
    const calendar = google.calendar({ version: "v3", auth: account.client });
    const listed = await calendar.events.list({
      calendarId: "primary",
      timeMin: range.timeMin,
      timeMax: range.timeMax,
      timeZone: TIME_ZONE,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 50,
      q: title,
    });
    for (const event of listed.data.items ?? []) {
      if (event.status === "cancelled" || !event.id) {
        continue;
      }
      const summary = event.summary ?? "(Untitled event)";
      if (!titleMatches(title, summary)) {
        continue;
      }
      const attendees = (event.attendees ?? []).filter(
        (person) => person.self !== true && person.email,
      );
      found.push({
        accountId: account.id,
        eventId: event.id,
        title: summary,
        start: startOfEvent(event),
        attendeeCount: attendees.length,
      });
    }
  }
  return found;
}

async function deleteEvent(event: OwnerCalendarEvent): Promise<void> {
  if (testHooks.delete) {
    await testHooks.delete(event);
    return;
  }
  const accounts = await loadGoogleAccounts();
  const account = accounts.find((item) => item.id === event.accountId);
  if (!account) {
    throw new Error(`No ${event.accountId} Google account is connected.`);
  }
  const calendar = google.calendar({ version: "v3", auth: account.client });
  await calendar.events.delete({
    calendarId: "primary",
    eventId: event.eventId,
    sendUpdates: event.attendeeCount > 0 ? "all" : "none",
  });
}

export async function deleteOwnerCalendarEvent(input: {
  eventTitle: string;
  date?: string;
  confirmation: { chatId: number; messageId: number } | undefined;
}): Promise<string> {
  try {
    allowOwnerChatDeleteEvent(input.confirmation);
  } catch {
    return "Not deleted: only Vishnu's own chat message can delete a calendar event.";
  }

  const title = input.eventTitle.trim();
  if (!title) {
    return "Not deleted: I need the event title.";
  }
  if (input.date && !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    return "Not deleted: date must be YYYY-MM-DD.";
  }

  let matches: OwnerCalendarEvent[];
  try {
    matches = await listMatchingEvents(title, input.date);
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.log(`delete_calendar_event: list failed (${errorType})`);
    return "Not deleted: I could not search the calendars. Try again.";
  }

  if (matches.length === 0) {
    return `Not deleted: no matching event named "${title}".`;
  }
  if (matches.length > 1) {
    const lines = matches.map((event, index) => formatMatch(event, index));
    return `Not deleted: several matches — which one?\n${lines.join("\n")}`;
  }

  const event = matches[0]!;
  try {
    await deleteEvent(event);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const forbidden = /403|insufficient|insufficientPermissions/i.test(message);
    if (forbidden && event.accountId === "personal") {
      return "Not deleted: the personal calendar is read-only. Delete it in Google Calendar, or add calendar.events to personal (needs re-auth).";
    }
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.log(`delete_calendar_event: delete failed (${errorType})`);
    return "Not deleted: Google Calendar refused the delete. Nothing was changed.";
  }
  return `Deleted event: ${event.title} on ${formatEventDate(event.start)}.`;
}
