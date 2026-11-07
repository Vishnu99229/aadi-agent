import { notAnEventCommand } from "../command_logic.js";
import { config } from "../config.js";
import type { LlmTool } from "../llm.js";
import { moveOwnerCalendarEvent } from "../owner_calendar.js";
import type { ToolTurn } from "./index.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "move_event",
  description:
    "Move a calendar event to a new time now, with no card, when he tells you to. Searches both calendars by title. One match moves it, keeping its length unless he gave an end, and tells any attendees. Several matches lists them so you can ask him.",
  inputSchema: {
    type: "object",
    properties: {
      event_title: { type: "string", description: "Event title to match." },
      date: { type: "string", description: "The event's current day as YYYY-MM-DD, if known." },
      new_start: {
        type: "string",
        description: "New start as ISO 8601 with offset, for example 2026-10-28T16:00:00+05:30.",
      },
      new_end: { type: "string", description: "New end as ISO 8601 with offset. Omit to keep its length." },
    },
    required: ["event_title", "new_start"],
  },
};

export async function handler(input: unknown, turn: ToolTurn): Promise<string> {
  if (!config.sendOnCommandEnabled) {
    return "Not moved: this is switched off.";
  }
  const reason = notAnEventCommand(turn.userText ?? "");
  if (reason) {
    return `Not moved: ${reason}. Ask him if he wants it moved now.`;
  }
  const values = (input ?? {}) as Record<string, unknown>;
  const text = (key: string) => (typeof values[key] === "string" ? (values[key] as string) : undefined);
  return moveOwnerCalendarEvent({
    eventTitle: text("event_title") ?? "",
    date: text("date"),
    newStart: text("new_start") ?? "",
    newEnd: text("new_end"),
    confirmation: turn.confirmation,
  });
}
