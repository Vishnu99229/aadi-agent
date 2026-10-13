import type { LlmTool } from "../llm.js";
import { getBill, transitionBillStatus } from "../db.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "mark_bill_paid",
  description: "Mark an upcoming bill as paid using its numeric id from list_bills.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "Bill id." },
    },
    required: ["id"],
  },
};

export function handler(input: unknown): string {
  const values = input as { id?: unknown };
  if (
    typeof values.id !== "number" ||
    !Number.isSafeInteger(values.id) ||
    values.id <= 0
  ) {
    throw new Error("id must be a positive integer bill id.");
  }
  const bill = getBill(values.id);
  if (!bill) {
    throw new Error(`Bill ${values.id} was not found.`);
  }
  if (bill.status === "paid") {
    return JSON.stringify({ id: bill.id, status: "paid", already_paid: true });
  }
  if (!transitionBillStatus(bill.id, "upcoming", "paid")) {
    throw new Error(`Bill ${bill.id} could not be marked paid.`);
  }
  console.log(`Bill ${bill.id}: status -> paid`);
  return JSON.stringify({ id: bill.id, status: "paid" });
}
