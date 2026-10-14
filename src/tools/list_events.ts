import { google } from "googleapis";
import type { LlmTool } from "../llm.js";
import {
  accountsForFilter,
  parseGoogleAccountFilter,
} from "../google/auth.js";

const TIME_ZONE = "Asia/Kolkata";
const INDIA_OFFSET = "+05:30";
const DAY_MS = 24 * 60 * 60 * 1000;

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "list_events",
  description:
    "List events from Vishnu's personal Gmail and Epicode work calendars using Asia/Kolkata dates. Each event is tagged personal or work by account. Use this for questions about today's, tomorrow's, or a date range's schedule. start_date and end_date are inclusive YYYY-MM-DD dates. Pass account to read one calendar; omit it to read both.",
  inputSchema: {
    type: "object",
    properties: {
      start_date: {
        type: "string",
        description: "First date to include, formatted YYYY-MM-DD.",
      },
      end_date: {
        type: "string",
        description: "Last date to include, formatted YYYY-MM-DD.",
      },
      account: {
        type: "string",
        enum: ["personal", "work"],
        description:
          "Optional calendar filter. Omit to list both connected accounts.",
      },
    },
    required: ["start_date", "end_date"],
  },
};

function startOfDate(value: unknown, field: string): Date {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    throw new Error(`${field} must be formatted YYYY-MM-DD.`);
  }

  const [year, month, day] = value.split("-").map(Number);
  const validationDate = new Date(Date.UTC(year, month - 1, day));
  if (
    validationDate.getUTCFullYear() !== year ||
    validationDate.getUTCMonth() !== month - 1 ||
    validationDate.getUTCDate() !== day
  ) {
    throw new Error(`${field} is not a valid date.`);
  }

  const date = new Date(`${value}T00:00:00${INDIA_OFFSET}`);
  return date;
}

export async function handler(input: unknown): Promise<string> {
  const values = input as {
    start_date?: unknown;
    end_date?: unknown;
    account?: unknown;
  };
  const start = startOfDate(values.start_date, "start_date");
  const end = startOfDate(values.end_date, "end_date");

  if (end < start) {
    throw new Error("end_date must be on or after start_date.");
  }

  const accounts = await accountsForFilter(
    parseGoogleAccountFilter(values.account),
  );
  const events: Array<{
    accountLabel: string;
    tag: string;
    summary: string;
    start: string;
    end: string;
    location: string;
    attendees: string;
    sortKey: string;
  }> = [];

  for (const account of accounts) {
    const calendar = google.calendar({ version: "v3", auth: account.client });
    let pageToken: string | undefined;
    do {
      const response = await calendar.events.list({
        calendarId: "primary",
        timeMin: start.toISOString(),
        timeMax: new Date(end.getTime() + DAY_MS).toISOString(),
        timeZone: TIME_ZONE,
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 2500,
        pageToken,
      });
      for (const event of response.data.items ?? []) {
        const attendees = (event.attendees ?? [])
          .map((attendee) => attendee.displayName ?? attendee.email)
          .filter((name): name is string => Boolean(name));
        const startValue = event.start?.dateTime ?? event.start?.date ?? "";
        events.push({
          accountLabel: account.label,
          tag: account.tag,
          summary: event.summary ?? "(Untitled event)",
          start: startValue,
          end: event.end?.dateTime ?? event.end?.date ?? "",
          location: event.location ?? "",
          attendees: attendees.join(", "),
          sortKey: startValue,
        });
      }
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);
  }

  events.sort((left, right) => left.sortKey.localeCompare(right.sortKey));

  if (events.length === 0) {
    return "No calendar events found in that date range.";
  }

  return events
    .map((event, index) =>
      [
        `${index + 1}. [${event.tag}] ${event.summary}`,
        `Account: ${event.accountLabel}`,
        `Start: ${event.start}`,
        `End: ${event.end}`,
        `Location: ${event.location}`,
        `Attendees: ${event.attendees}`,
      ].join("\n"),
    )
    .join("\n\n");
}
