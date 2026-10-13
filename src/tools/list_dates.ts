import type { LlmTool } from "../llm.js";
import {
  getImportantDates,
  type ImportantDateRecord,
  type ImportantDateType,
} from "../db.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "list_dates",
  description:
    "List ALL saved important dates (birthdays, anniversaries, other), not just the next 7 days. Use this to find a date before removing it. Optional query matches person, relation, type, note, or MM-DD. Optional type filter.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Optional text to match, e.g. Amma, birthday, 03-14.",
      },
      type: {
        type: "string",
        enum: ["birthday", "anniversary", "other"],
      },
    },
    required: [],
  },
};

export function matchesDateQuery(
  record: ImportantDateRecord,
  query: string,
): boolean {
  const haystack = [
    record.person,
    record.relation,
    record.type,
    record.note,
    record.month_day,
  ]
    .join(" ")
    .toLowerCase();
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  if (tokens.length === 0) {
    return haystack.includes(query.trim().toLowerCase());
  }
  return tokens.every((token) => haystack.includes(token));
}

function formatDate(record: ImportantDateRecord): string {
  return `#${record.id} ${record.month_day} — ${record.person} (${record.type})${record.relation ? `, ${record.relation}` : ""}${record.note ? ` — ${record.note}` : ""}`;
}

export function handler(input: unknown): string {
  const values = input as { query?: unknown; type?: unknown };
  if (
    values.type !== undefined &&
    values.type !== "birthday" &&
    values.type !== "anniversary" &&
    values.type !== "other"
  ) {
    throw new Error('type must be "birthday", "anniversary", or "other".');
  }
  const type = values.type as ImportantDateType | undefined;
  const query =
    typeof values.query === "string" ? values.query.trim() : "";
  const dates = getImportantDates().filter((record) => {
    if (type && record.type !== type) {
      return false;
    }
    if (query && !matchesDateQuery(record, query)) {
      return false;
    }
    return true;
  });
  if (dates.length === 0) {
    const all = getImportantDates();
    if (all.length === 0) {
      return "No important dates saved.";
    }
    return `No matches.${query ? ` Query: ${query}.` : ""} Saved dates:\n${all.map(formatDate).join("\n")}`;
  }
  return dates.map(formatDate).join("\n");
}
