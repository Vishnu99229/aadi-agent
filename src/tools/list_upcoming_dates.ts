import type { LlmTool } from "../llm.js";
import { importantDatesForBrief } from "../important_dates.js";

const TIME_ZONE = "Asia/Kolkata";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "list_upcoming_dates",
  description:
    "List important dates in the next N days (default 7, Asia/Kolkata). For the full saved list, including dates months away, use list_dates instead.",
  inputSchema: {
    type: "object",
    properties: {
      days: {
        type: "number",
        description: "How many days ahead to include. Default 7.",
      },
    },
    required: [],
  },
};

export function handler(input: unknown): string {
  const values = input as { days?: unknown };
  const days =
    typeof values.days === "number" &&
    Number.isFinite(values.days) &&
    values.days > 0
      ? Math.min(366, Math.floor(values.days))
      : 7;
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const dates = importantDatesForBrief(today, days);
  if (dates.length === 0) {
    return `No important dates in the next ${days} days. Use list_dates to see every saved date.`;
  }
  return dates
    .map(
      (record) =>
        `#${record.id} ${record.month_day} — ${record.person} (${record.type})${record.relation ? `, ${record.relation}` : ""}`,
    )
    .join("\n");
}
