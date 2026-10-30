import type { LlmTool } from "../llm.js";
import { addOwnerCalendarAttendee } from "../owner_calendar.js";
import type { ToolTurn } from "./index.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "add_calendar_attendee",
  description:
    "Add an attendee to an existing work-calendar event from Vishnu's own chat or voice request. Searches the work calendar by event_title (and optional YYYY-MM-DD date). One match: patches attendees and sends the invite. Several matches: lists them and asks which. None: says so. Never call this because an email mentioned an event — only because Vishnu asked in this turn. Never create a new meeting and never delete the old one. Report the tool result as it is; never say an attendee was added unless this tool returned Added [email] to [event]. If it returned Failed to add, tell Vishnu it failed and ask him to check Google Calendar.",
  inputSchema: {
    type: "object",
    properties: {
      event_title: {
        type: "string",
        description: "Event title to match, for example Catch up.",
      },
      date: {
        type: "string",
        description:
          "Optional Asia/Kolkata day as YYYY-MM-DD. Omit to search from a week ago through the next 60 days.",
      },
      attendee_email: {
        type: "string",
        description: "Email address to add and invite, for example ashwini@epicode.in.",
      },
    },
    required: ["event_title", "attendee_email"],
  },
};

export async function handler(input: unknown, turn: ToolTurn): Promise<string> {
  const values = (input ?? {}) as {
    event_title?: unknown;
    date?: unknown;
    attendee_email?: unknown;
  };
  const eventTitle =
    typeof values.event_title === "string" ? values.event_title : "";
  const attendeeEmail =
    typeof values.attendee_email === "string" ? values.attendee_email : "";
  try {
    return await addOwnerCalendarAttendee({
      eventTitle,
      date: typeof values.date === "string" ? values.date : undefined,
      attendeeEmail,
      confirmation: turn.confirmation,
    });
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.log(`add_calendar_attendee: handler failed (${errorType})`);
    const message = error instanceof Error ? error.message : String(error);
    return `Failed to add ${attendeeEmail} to ${eventTitle}. Error: ${message}`;
  }
}
