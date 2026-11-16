import type { LlmTool } from "../llm.js";
import { getBills, type BillStatus } from "../db.js";
import { billIsIgnored } from "../ignore.js";

const TIME_ZONE = "Asia/Kolkata";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "list_bills",
  description:
    "List tracked bills. Default filter all. Other filters: upcoming, overdue, paid, paid_this_month, ignored.",
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
        description: "Which bills to list. Default all. upcoming and overdue omit ignored sources.",
      },
      include_ignored: {
        type: "boolean",
        description:
          "Include bills from ignored sources in upcoming/overdue/all. Default false.",
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
  const values = input as { filter?: unknown; include_ignored?: unknown };
  const filter = values.filter ?? "all";
  const includeIgnored = values.include_ignored === true;
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
    const suppressed = billIsIgnored(bill);
    if (filter === "ignored") {
      return bill.status === "ignored" || suppressed;
    }
    if (!includeIgnored && suppressed && bill.status !== "paid") {
      return false;
    }
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
