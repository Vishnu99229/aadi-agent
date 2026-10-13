import type { LlmTool } from "../llm.js";
import {
  getImportantDate,
  getImportantDates,
  removeImportantDate,
} from "../db.js";
import { matchesDateQuery } from "./list_dates.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "remove_date",
  description:
    "Remove a saved important date. Prefer query like \"Amma birthday\" so it works no matter how far away the date is. You can also pass a numeric id from list_dates. If several match, nothing is deleted and the matches are returned.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "Numeric id from list_dates." },
      query: {
        type: "string",
        description:
          'Person or description, e.g. "Amma birthday" or "14 March".',
      },
    },
    required: [],
  },
};

function formatDate(record: {
  id: number;
  month_day: string;
  person: string;
  type: string;
  relation: string;
}): string {
  return `#${record.id} ${record.month_day} — ${record.person} (${record.type})${record.relation ? `, ${record.relation}` : ""}`;
}

export function handler(input: unknown): string {
  const values = input as { id?: unknown; query?: unknown };
  const all = getImportantDates();

  if (
    typeof values.id === "number" &&
    Number.isSafeInteger(values.id) &&
    values.id > 0
  ) {
    if (!getImportantDate(values.id)) {
      return JSON.stringify({
        removed: false,
        reason: "not_found",
        found: all.map(formatDate),
      });
    }
    removeImportantDate(values.id);
    console.log(`Important date ${values.id}: removed`);
    return JSON.stringify({ id: values.id, removed: true });
  }

  const query = typeof values.query === "string" ? values.query.trim() : "";
  if (!query) {
    throw new Error('Provide query (e.g. "Amma birthday") or a numeric id.');
  }

  const matches = all.filter((record) => matchesDateQuery(record, query));
  if (matches.length === 0) {
    return JSON.stringify({
      removed: false,
      reason: "not_found",
      query,
      found: all.map(formatDate),
    });
  }
  const first = matches[0]!;
  const sameEvent = matches.every(
    (record) =>
      record.person.toLowerCase() === first.person.toLowerCase() &&
      record.type === first.type &&
      record.month_day === first.month_day,
  );
  if (matches.length > 1 && !sameEvent) {
    return JSON.stringify({
      removed: false,
      reason: "ambiguous",
      query,
      found: matches.map(formatDate),
    });
  }
  const ids = matches.map((record) => record.id);
  for (const id of ids) {
    removeImportantDate(id);
    console.log(`Important date ${id}: removed`);
  }
  return JSON.stringify({
    id: first.id,
    ids,
    person: first.person,
    month_day: first.month_day,
    type: first.type,
    removed: true,
  });
}
