import type { LlmTool } from "../llm.js";
import { searchNotes } from "../db.js";

const TIME_ZONE = "Asia/Kolkata";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "search_notes",
  description:
    "Search saved meeting notes. Omit query to list recent notes. Search all notes unless Vishnu asked for a time window.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Keywords in title, people, or content. Omit to list notes.",
      },
      since_days: {
        type: "number",
        description:
          "Only if Vishnu asked for a recency window. Days back from today in Asia/Kolkata.",
      },
    },
    required: [],
  },
};

function sinceIso(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - Math.max(0, Math.floor(days)));
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(date)
    .concat("T00:00:00.000Z");
}

export function handler(input: unknown): string {
  const values = input as { query?: unknown; since_days?: unknown };
  const query =
    typeof values.query === "string" ? values.query.trim() : "";
  let since: string | undefined;
  if (values.since_days !== undefined) {
    if (
      typeof values.since_days !== "number" ||
      !Number.isFinite(values.since_days)
    ) {
      throw new Error("since_days must be a number.");
    }
    since = sinceIso(values.since_days);
  }
  const notes = searchNotes(query, since);
  if (notes.length === 0) {
    return "No matching notes.";
  }
  return notes
    .map(
      (note) =>
        `#${note.id} (${note.tag}) ${note.title} — ${note.people}\n${note.created_at}\n${note.content}`,
    )
    .join("\n\n---\n\n");
}
