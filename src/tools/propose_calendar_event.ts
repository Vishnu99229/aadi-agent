import type { LlmTool } from "../llm.js";
import { queueEventApproval } from "../approvals.js";
import type { GoogleAccountId } from "../db.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "propose_calendar_event",
  description:
    "Propose a calendar event for Vishnu to approve. Does NOT create the event; it queues a Telegram approval card with Create Event / Cancel buttons. Only Vishnu's tap creates the event.",
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Short event title. Required.",
      },
      start_time: {
        type: "string",
        description:
          "Event start as ISO 8601 with offset, for example 2026-10-25T15:30:00+05:30. Required.",
      },
      end_time: {
        type: "string",
        description:
          "Event end as ISO 8601 with offset, for example 2026-10-25T16:00:00+05:30. Required.",
      },
      attendees: {
        type: "array",
        description:
          "Email addresses to invite. Omit or empty array for a solo block.",
        items: { type: "string" },
      },
      description: {
        type: "string",
        description:
          "Optional meeting notes or agenda shown on the calendar event.",
      },
      google_account: {
        type: "string",
        description:
          'Which calendar to book on. Defaults to "work" (the only account with calendar.events scope).',
        enum: ["personal", "work"],
      },
    },
    required: ["title", "start_time", "end_time"],
  },
};

function isValidIso(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

export async function handler(input: unknown): Promise<string> {
  const values = input as {
    title?: unknown;
    start_time?: unknown;
    end_time?: unknown;
    attendees?: unknown;
    description?: unknown;
    google_account?: unknown;
  };
  const title =
    typeof values.title === "string" ? values.title.trim() : "";
  if (!title) {
    throw new Error("title is required.");
  }
  const startIso =
    typeof values.start_time === "string" ? values.start_time.trim() : "";
  const endIso =
    typeof values.end_time === "string" ? values.end_time.trim() : "";
  if (!isValidIso(startIso) || !isValidIso(endIso)) {
    throw new Error(
      "start_time and end_time must be ISO 8601 datetimes with offset.",
    );
  }
  if (Date.parse(endIso) <= Date.parse(startIso)) {
    throw new Error("end_time must be after start_time.");
  }
  const attendees = Array.isArray(values.attendees)
    ? values.attendees
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.includes("@"))
    : [];
  const description =
    typeof values.description === "string" ? values.description.trim() : "";
  const googleAccount: GoogleAccountId =
    values.google_account === "personal" ? "personal" : "work";

  const actionId = await queueEventApproval({
    title,
    startIso,
    endIso,
    attendees,
    description: description || undefined,
    googleAccount,
  });
  return `Event ${title} is waiting for Vishnu's Create Event tap (approval #${actionId}).`;
}
