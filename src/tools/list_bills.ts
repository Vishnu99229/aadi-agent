import type { LlmTool } from "../llm.js";
import { getBills, type BillStatus } from "../db.js";

const TIME_ZONE = "Asia/Kolkata";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "list_bills",
  description:
    "List tracked bills. Default filter is all (every saved bill, including ignored and paid in past months). Other filters: upcoming, overdue, paid, paid_this_month, ignored. Use all when looking something up to mark paid or ignore it.",
  inputSchema: {
    type: "object",
    properties: {
      filter: {
        type: "string",
        enum: [
          "all",
          "upcoming",
          "overdue",
          "paid",
          "paid_this_month",
          "ignored",
        ],
        description: "Which bills to list. Default all.",
      },
    },
    required: [],
  },
};

function todayYmd(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function handler(input: unknown): string {
  const values = input as { filter?: unknown };
  const filter = values.filter ?? "all";
  if (
    filter !== "all" &&
    filter !== "upcoming" &&
    filter !== "overdue" &&
    filter !== "paid" &&
    filter !== "paid_this_month" &&
    filter !== "ignored"
  ) {
    throw new Error(
      'filter must be "all", "upcoming", "overdue", "paid", "paid_this_month", or "ignored".',
    );
  }
  const today = todayYmd();
  const month = today.slice(0, 7);
  const bills = getBills().filter((bill) => {
    if (filter === "all") {
      return true;
    }
    if (filter === "upcoming") {
      return bill.status === "upcoming" && bill.due_date >= today;
    }
    if (filter === "overdue") {
      return bill.status === "upcoming" && bill.due_date < today;
    }
    if (filter === "paid") {
      return bill.status === "paid";
    }
    if (filter === "ignored") {
      return bill.status === "ignored";
    }
    return bill.status === "paid" && bill.created_at.startsWith(month);
  });
  if (bills.length === 0) {
    return "No matching bills.";
  }
  return JSON.stringify(
    bills.map((bill) => ({
      id: bill.id,
      biller: bill.biller,
      amount: bill.amount,
      currency: bill.currency,
      due_date: bill.due_date,
      status: bill.status as BillStatus,
    })),
  );
}
