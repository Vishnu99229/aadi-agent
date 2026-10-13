import type { LlmTool } from "../llm.js";
import {
  createImportantDate,
  type ImportantDateType,
} from "../db.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "add_date",
  description:
    'Add an important date (birthday, anniversary, or other). Use month_day as MM-DD in Asia/Kolkata, e.g. 03-14 for 14 March. Resolve natural language dates before calling.',
  inputSchema: {
    type: "object",
    properties: {
      person: { type: "string" },
      relation: { type: "string" },
      month_day: { type: "string", description: "MM-DD format." },
      year: { type: ["number", "null"] },
      type: {
        type: "string",
        enum: ["birthday", "anniversary", "other"],
      },
      note: { type: "string" },
    },
    required: ["person", "month_day", "type"],
  },
};

export function handler(input: unknown): string {
  const values = input as {
    person?: unknown;
    relation?: unknown;
    month_day?: unknown;
    year?: unknown;
    type?: unknown;
    note?: unknown;
  };
  if (typeof values.person !== "string" || !values.person.trim()) {
    throw new Error("person is required.");
  }
  if (
    typeof values.month_day !== "string" ||
    !/^\d{2}-\d{2}$/.test(values.month_day)
  ) {
    throw new Error("month_day must be MM-DD.");
  }
  if (
    values.type !== "birthday" &&
    values.type !== "anniversary" &&
    values.type !== "other"
  ) {
    throw new Error('type must be "birthday", "anniversary", or "other".');
  }
  const year =
    values.year === null || values.year === undefined
      ? null
      : Number(values.year);
  if (year !== null && (!Number.isInteger(year) || year < 1900)) {
    throw new Error("year must be a valid integer or null.");
  }
  const record = createImportantDate(
    values.person.trim(),
    typeof values.relation === "string" ? values.relation.trim() : "",
    values.month_day,
    year,
    values.type as ImportantDateType,
    typeof values.note === "string" ? values.note.trim() : "",
  );
  console.log(`Important date ${record.id}: stored`);
  return JSON.stringify({
    id: record.id,
    person: record.person,
    month_day: record.month_day,
    type: record.type,
  });
}
