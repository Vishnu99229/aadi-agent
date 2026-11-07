import { bookMeetingFromTool } from "../command_email.js";
import type { LlmTool } from "../llm.js";
import type { ToolTurn } from "./index.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "book_meeting",
  description:
    "Book a meeting with someone now, with no card: creates the event on the work calendar with a Meet link and emails them the invite. Use when he tells you to book, schedule or set up a meeting or call with a person. It finds their address, so pass the names as he said them, never an address you found. With no start_time it offers free slots and creates nothing. If it says to ask him, ask, and never pick an address yourself.",
  inputSchema: {
    type: "object",
    properties: {
      attendees: {
        type: "array",
        items: { type: "string" },
        description: "Who to invite, in his own words: a name, or name and company, or an address.",
      },
      title: { type: "string", description: "Event title, as he said it. Omit for 'Vishnu <> name'." },
      start_time: {
        type: "string",
        description: "Start as ISO 8601 with offset, for example 2026-10-28T16:00:00+05:30.",
      },
      end_time: { type: "string", description: "End as ISO 8601 with offset. Omit to use duration." },
      duration_minutes: { type: "number", description: "Length in minutes. Defaults to 30." },
    },
    required: ["attendees"],
  },
};

export function handler(input: unknown, turn: ToolTurn): Promise<string> {
  return bookMeetingFromTool(input, turn);
}
