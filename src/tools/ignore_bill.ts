import type { LlmTool } from "../llm.js";
import {
  createBill,
  searchUpcomingBills,
  transitionBillStatus,
  type BillRecord,
} from "../db.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "ignore_bill",
  description:
    "Skip a bill for the current month. Does not mark it as paid. It will return next month. Use this whenever Vishnu says to ignore, dismiss, drop, skip, or clear a bill (e.g., 'ignore the X bill', 'drop Y', 'skip Z'). Do not ask for permission, just execute.",
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

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function addOneMonthYmd(ymd: string): string {
  const match = DATE_RE.exec(ymd);
  if (!match) {
    throw new Error(`Invalid due_date on bill: ${ymd}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const daysInNextMonth = new Date(Date.UTC(nextYear, nextMonth, 0)).getUTCDate();
  const nextDay = Math.min(day, daysInNextMonth);
  return `${nextYear.toString().padStart(4, "0")}-${nextMonth
    .toString()
    .padStart(2, "0")}-${nextDay.toString().padStart(2, "0")}`;
}

function formatMatchList(bills: BillRecord[]): string {
  return bills
    .map((b) => {
      const amount =
        b.amount == null ? "" : ` ${b.currency} ${b.amount}`;
      return `- ${b.biller}${amount}, due ${b.due_date} (id ${b.id})`;
    })
    .join("\n");
}

export function handler(input: unknown): string {
  try {
    const values = input as { query?: unknown };
    if (typeof values.query !== "string" || !values.query.trim()) {
      throw new Error("query must be a non-empty string.");
    }

    const matches = searchUpcomingBills(values.query);
    if (matches.length === 0) {
      return "No active bills found matching that description.";
    }
    if (matches.length > 1) {
      return (
        `Found ${matches.length} matching bills — which one should I skip?\n` +
        formatMatchList(matches)
      );
    }

    const bill = matches[0]!;
    if (!transitionBillStatus(bill.id, "upcoming", "ignored")) {
      throw new Error(`Bill ${bill.id} could not be skipped.`);
    }
    console.log(`Bill ${bill.id}: status -> ignored (skip cycle)`);

    const nextDue = addOneMonthYmd(bill.due_date);
    const nextBill = createBill(
      bill.biller,
      bill.amount,
      bill.currency,
      nextDue,
      bill.thread_id,
      bill.source_text,
      null,
    );

    if (!nextBill) {
      // Next-cycle row already exists (unique index on biller+due_date+amount+currency).
      console.log(
        `Bill ${bill.id}: next-cycle row for ${bill.biller} on ${nextDue} already exists; skip only.`,
      );
      return (
        `Skipped ${bill.biller} for this month. It is not marked paid; ` +
        `the next cycle (${nextDue}) is already tracked.`
      );
    }

    console.log(
      `Bill ${bill.id}: next cycle created as bill ${nextBill.id} due ${nextDue}.`,
    );
    return (
      `Skipped ${bill.biller} for this month. ` +
      `It will appear again on ${nextDue}. ` +
      `This does not mark it as paid.`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ignore_bill handler failed: ${message}`);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    throw error;
  }
}
