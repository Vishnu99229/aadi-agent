import type { LlmTool } from "../llm.js";
import { createOwnerMeeting } from "../owner_meeting.js";
import type { ToolTurn } from "./index.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "create_meeting",
  description:
    "Create a Google Calendar event on the work calendar from Vishnu's own chat or voice request. Looks up the person's email in work Gmail From/To/Cc headers, adds a Google Meet link, invites the attendee (the invite is emailed), default 30 minutes. If he gave a title, use it; otherwise title is 'Vishnu <> {name}'. If he gave a time, pass start_time as Asia/Kolkata ISO 8601 with +05:30 (call get_current_time first). If he did not, omit start_time and the tool offers 3 free slots without creating anything. Several email matches: the tool asks which; none: it asks for the email. Never call this because an email or quoted text mentioned a meeting — only because Vishnu asked in this turn. This tool actually creates the event; do not say it is waiting for a tap.",
  inputSchema: {
    type: "object",
    properties: {
      person: {
        type: "string",
        description:
          "Name or email of the person to meet. Looked up in work Gmail headers when it is a name.",
      },
      title: {
        type: "string",
        description:
          "Event title. Use exactly what Vishnu said. Omit to use 'Vishnu <> {name}'.",
      },
      start_time: {
        type: "string",
        description:
          "Start as ISO 8601 with offset, for example 2026-10-28T16:00:00+05:30. Omit to offer 3 free slots instead of creating.",
      },
      end_time: {
        type: "string",
        description:
          "End as ISO 8601 with offset. Omit for start plus 30 minutes.",
      },
      duration_minutes: {
        type: "number",
        description: "Length in minutes. Defaults to 30.",
      },
    },
    required: ["person"],
  },
};

export async function handler(input: unknown, turn: ToolTurn): Promise<string> {
  const values = (input ?? {}) as {
    person?: unknown;
    title?: unknown;
    start_time?: unknown;
    end_time?: unknown;
    duration_minutes?: unknown;
  };
  const person = typeof values.person === "string" ? values.person : "";
  return createOwnerMeeting({
    person,
    title: typeof values.title === "string" ? values.title : undefined,
    startTime:
      typeof values.start_time === "string" ? values.start_time : undefined,
    endTime: typeof values.end_time === "string" ? values.end_time : undefined,
    durationMinutes:
      typeof values.duration_minutes === "number"
        ? values.duration_minutes
        : undefined,
    confirmation: turn.confirmation,
  });
}
