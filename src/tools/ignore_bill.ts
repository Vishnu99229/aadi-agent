import type { LlmTool } from "../llm.js";
import {
  searchUpcomingBills,
  transitionBillStatus,
  type BillRecord,
} from "../db.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "ignore_bill",
  description:
    "Ignore, dismiss, delete, drop, or clear a bill. Use this whenever the user expresses intent to stop tracking or remove a bill from the upcoming list (e.g., 'ignore the X bill', 'drop Y', 'clear Z'). Do not ask for permission, just execute.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "A biller name or fragment to match case-insensitively against upcoming bills (e.g., 'youtube premium', 'jio', 'netflix').",
      },
    },
    required: ["query"],
  },
};

export function handler(input: unknown): string {
  const values = input as { query?: unknown };
  if (typeof values.query !== "string" || !values.query.trim()) {
    throw new Error("query must be a non-empty string.");
  }

  const matches = searchUpcomingBills(values.query);
  if (matches.length === 0) {
    return "No active bills found matching that description.";
  }

  const ignored: BillRecord[] = [];
  for (const bill of matches) {
    if (transitionBillStatus(bill.id, "upcoming", "ignored")) {
      console.log(`Bill ${bill.id}: status -> ignored`);
      ignored.push(bill);
    }
  }

  if (ignored.length === 0) {
    return "No active bills found matching that description.";
  }
  if (ignored.length === 1) {
    return `Ignored bill: ${ignored[0]!.biller}`;
  }
  const list = ignored.map((b) => `- ${b.biller} (id ${b.id})`).join("\n");
  return `Ignored ${ignored.length} bills:\n${list}`;
}
