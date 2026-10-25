import type { LlmTool } from "../llm.js";
import { getBill, getBills, transitionBillStatus } from "../db.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "ignore_bill",
  description:
    "Dismiss a tracked bill so it stops appearing in upcoming/overdue lists. Pass either its numeric id from list_bills, or a biller name/fragment (case-insensitive). Use this when Vishnu says to ignore, drop or remove a bill.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "Bill id from list_bills." },
      biller: {
        type: "string",
        description:
          "Biller name or fragment, matched case-insensitively against open bills. Use when the id isn't known.",
      },
    },
    required: [],
  },
};

function findByBiller(query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return getBills().filter(
    (bill) =>
      bill.status !== "ignored" &&
      bill.biller.toLowerCase().includes(needle),
  );
}

export function handler(input: unknown): string {
  const values = input as { id?: unknown; biller?: unknown };
  const hasId =
    typeof values.id === "number" &&
    Number.isSafeInteger(values.id) &&
    values.id > 0;
  const hasBiller = typeof values.biller === "string" && values.biller.trim();

  if (!hasId && !hasBiller) {
    throw new Error("Provide either id (bill id) or biller (name fragment).");
  }

  let bill = hasId ? getBill(values.id as number) : undefined;

  if (!bill && hasBiller) {
    const matches = findByBiller(values.biller as string);
    if (matches.length === 0) {
      throw new Error(
        `No open bill found matching "${values.biller}". Use list_bills to see what's there.`,
      );
    }
    if (matches.length > 1) {
      return JSON.stringify({
        ambiguous: true,
        matches: matches.map((b) => ({
          id: b.id,
          biller: b.biller,
          amount: b.amount,
          currency: b.currency,
          due_date: b.due_date,
          status: b.status,
        })),
      });
    }
    bill = matches[0];
  }

  if (!bill) {
    throw new Error(`Bill ${values.id} was not found.`);
  }

  if (bill.status === "ignored") {
    return JSON.stringify({
      id: bill.id,
      biller: bill.biller,
      status: "ignored",
      already_ignored: true,
    });
  }

  if (!transitionBillStatus(bill.id, ["upcoming", "paid"], "ignored")) {
    throw new Error(`Bill ${bill.id} could not be ignored.`);
  }

  console.log(`Bill ${bill.id}: status -> ignored`);
  return JSON.stringify({
    id: bill.id,
    biller: bill.biller,
    status: "ignored",
  });
}
