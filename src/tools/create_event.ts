import { notAnEventCommand } from "../command_logic.js";
import { config } from "../config.js";
import type { LlmTool } from "../llm.js";
import { createOwnerCalendarEvent } from "../owner_meeting.js";
import type { ToolTurn } from "./index.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "create_event",
  description:
    "Put an event on Vishnu's work calendar now, with no card, when he tells you to: \"create an event\", \"block my calendar\", \"add X to my calendar\". Nobody is invited or emailed. If he names someone to meet with, use book_meeting.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Event title, as he said it." },
      start_time: {
        type: "string",
        description: "Start as ISO 8601 with offset, for example 2026-10-28T16:00:00+05:30.",
      },
      end_time: { type: "string", description: "End as ISO 8601 with offset. Omit to use duration." },
      duration_minutes: { type: "number", description: "Length in minutes. Defaults to 30." },
      date: {
        type: "string",
        description: "For an all-day event, the day as YYYY-MM-DD. Use instead of start_time.",
      },
    },
    required: ["title"],
  },
};

export async function handler(input: unknown, turn: ToolTurn): Promise<string> {
  if (!config.sendOnCommandEnabled) {
    return "Not created: this is switched off. Use propose_calendar_event.";
  }
  const reason = notAnEventCommand(turn.userText ?? "");
  if (reason) {
    return `Not created: ${reason}. Use the right tool, or ask him if he wants it created now.`;
  }
  const values = (input ?? {}) as Record<string, unknown>;
  const text = (key: string) => (typeof values[key] === "string" ? (values[key] as string) : undefined);
  return createOwnerCalendarEvent({
    title: text("title") ?? "",
    startTime: text("start_time"),
    endTime: text("end_time"),
    durationMinutes: typeof values.duration_minutes === "number" ? values.duration_minutes : undefined,
    date: text("date"),
    confirmation: turn.confirmation,
    now: new Date(),
  });
}
