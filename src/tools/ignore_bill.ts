import type { LlmTool } from "../llm.js";
import {
  createBill,
  searchUpcomingBills,
  transitionBillStatus,
  type BillRecord,
} from "../db.js";
import {
  applyIgnore,
  confirmationForIgnore,
  looksLikeIgnoreInstruction,
  ownerMayChangeIgnore,
} from "../ignore.js";
import { canonicalBiller, normalizeBillerKey } from "../bill_aliases.js";
import type { IgnoreCandidate } from "../ignore.js";
import { ignoreCandidates, savePendingIgnoreQuestion } from "../ignore_pending.js";
import { addOneMonthYmd } from "../bill_cycle.js";
import type { ToolTurn } from "./index.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "ignore_bill",
  description:
    "Stop tracking a biller. Default is permanent: existing and future matching bills stay stored but drop out of reminders, briefs and weekly reviews until he asks to resume. Does not mark the bill paid. Only skip the current cycle (and create next month's row) when he clearly said this month or this cycle.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "A biller name or fragment to match case-insensitively (e.g. 'linkedin', 'youtube premium').",
      },
      skip_cycle: {
        type: "boolean",
        description:
          "True only when he asked to skip this month or this cycle, not to ignore the biller going forward.",
      },
      all_matches: {
        type: "boolean",
        description: "Ignore every biller the query matches in one go. Honoured only when his own words say all, every or both.",
      },
      bill_ids: {
        type: "array",
        items: { type: "number" },
        description: "Ids from a list you showed him, when he picked some of them: those billers are ignored in one go.",
      },
    },
    required: ["query"],
  },
};

export { addOneMonthYmd };

function formatMatchList(bills: BillRecord[]): string {
  return bills
    .map((b) => {
      const amount = b.amount == null ? "" : ` ${b.currency} ${b.amount}`;
      return `- ${b.biller}${amount}, due ${b.due_date} (id ${b.id})`;
    })
    .join("\n");
}

/** A shown bill, ready to ignore by its biller. */
function billCandidate(bill: BillRecord): IgnoreCandidate {
  const amount = bill.amount == null ? "" : ` ${bill.currency} ${bill.amount}`;
  return {
    label: `${bill.biller}${amount}, due ${bill.due_date} (id ${bill.id})`,
    names: bill.biller,
    confirmLabel: `${canonicalBiller(bill.biller)} bills`,
    input: { entityType: "bill", matchKey: normalizeBillerKey(canonicalBiller(bill.biller)), matchScope: "source", tag: "personal" },
  };
}

function wantsCycleSkip(query: string, skipCycle: boolean, userText: string): boolean {
  if (skipCycle) {
    return true;
  }
  const text = `${userText} ${query}`;
  return (
    /\b(?:this month|this cycle|just this(?:\s+one)?|for this month)\b/i.test(text) &&
    !/\bpermanent(?:ly)?\b/i.test(text)
  );
}

export function handler(input: unknown, turn: ToolTurn = { iteration: 1, calledTools: [] }): string {
  try {
    const values = input as { query?: unknown; skip_cycle?: unknown; all_matches?: unknown; bill_ids?: unknown };
    if (typeof values.query !== "string" || !values.query.trim()) {
      throw new Error("query must be a non-empty string.");
    }
    const query = values.query.trim();
    const userText = turn.userText?.trim() ?? "";
    if (!ownerMayChangeIgnore(turn)) {
      return "Ignore preferences can only be changed from Vishnu's own chat or voice message.";
    }
    if (wantsCycleSkip(query, values.skip_cycle === true, userText)) {
      return skipCurrentCycle(query);
    }
    if (
      userText &&
      !looksLikeIgnoreInstruction(userText) &&
      !/\b(?:ignore|skip|dismiss|drop|clear)\b/i.test(userText)
    ) {
      return "Ignore preferences can only be changed from Vishnu's own instruction in this turn.";
    }
    const matches = searchUpcomingBills(query);
    if (matches.length > 1) {
      const billers = new Set(matches.map((bill) => normalizeBillerKey(canonicalBiller(bill.biller))));
      if (billers.size > 1) {
        const authRef = turn.confirmation
          ? `owner_chat:${turn.confirmation.chatId}:${turn.confirmation.messageId}`
          : "owner_chat";
        const ids = Array.isArray(values.bill_ids) ? values.bill_ids.filter((id): id is number => typeof id === "number") : [];
        if (ids.length > 0) {
          const picked = matches.filter((bill) => ids.includes(bill.id));
          if (picked.length === 0) {
            return `None of those ids is in the matching bills. Which one should I ignore?\n${formatMatchList(matches)}`;
          }
          return ignoreCandidates(picked.map(billCandidate), userText || query, authRef, matches.length);
        }
        // Every matching biller at once, only when his own words say so.
        if (/\b(?:all|every|everything|both)\b/i.test(userText)) {
          return ignoreCandidates(matches.map(billCandidate), userText, authRef, matches.length);
        }
        // Ask, and remember exactly what was shown: his next message answers it.
        if (turn.confirmation) {
          savePendingIgnoreQuestion(turn.confirmation.chatId, userText || query, matches.map(billCandidate));
        }
        return (
          `Found ${matches.length} matching bills — which one should I ignore?\n` +
          formatMatchList(matches)
        );
      }
    }
    const source = matches[0]?.biller ?? query;
    const result = applyIgnore({
      entityType: "bill",
      matchKey: normalizeBillerKey(canonicalBiller(source)),
      matchScope: "source",
      tag: "personal",
      instruction: userText || query,
      authRef: turn.confirmation
        ? `owner_chat:${turn.confirmation.chatId}:${turn.confirmation.messageId}`
        : "owner_chat",
    });
    console.log(
      `Ignore rule ${result.rule.id}: ${result.duplicate ? "duplicate" : "created"} bill/${result.rule.match_key}`,
    );
    return confirmationForIgnore(result, `${canonicalBiller(source)} bills`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ignore_bill handler failed: ${message}`);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    throw error;
  }
}

function skipCurrentCycle(query: string): string {
  const matches = searchUpcomingBills(query);
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
  if (!transitionBillStatus(bill.id, "upcoming", "ignored", "skip_cycle")) {
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
}
