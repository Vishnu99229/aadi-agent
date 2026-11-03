/**
 * Payment-STATUS notices vs payable INVOICE/charges.
 *
 * Order: a parseable amount always wins → invoice. Status patterns apply
 * only to amountless mail, split into actionable (FYI) vs noise (suppress).
 */

import { extractAmount } from "./bill_extract.js";

export type BillMailKind = "invoice" | "actionable_status" | "noise_status";

/**
 * Actionable status — Vishnu may need to fix payment / restore access.
 * Easy to edit: add or remove patterns here.
 */
export const ACTIONABLE_STATUS_PATTERNS: RegExp[] = [
  /\bpayment\s+(?:was\s+|is\s+)?(?:unsuccessful|failed|declined|not\s+successful)\b/i,
  /\b(?:most\s+recent\s+)?payment\s+unsuccessful\b/i,
  /\baccess\s+(?:has\s+been\s+|is\s+)?(?:paused|suspended|restricted)\b/i,
  /\bcard\s+(?:was\s+|has\s+been\s+)?(?:declined|expired|rejected)\b/i,
  /\bretry\s+(?:the\s+)?payment\b/i,
  /\bdunning\b|\bcollection\s+notice\b/i,
  /\boutstanding\s+invoice\b/i,
  /\bto\s+restore\s+access\b/i,
];

/**
 * Noise status — SCA / bank confirm / card-update; no Telegram.
 * Easy to edit: add or remove patterns here.
 */
export const NOISE_STATUS_PATTERNS: RegExp[] = [
  /\bconfirm\s+your\s+(?:renewal|payment)\b/i,
  /\bneeds?\s+a\s+quick\s+confirmation\s+from\s+your\s+bank\b/i,
  /\bsecurity\s+step\s+required\b/i,
  /\bstrong\s+customer\s+authentication\b|\bSCA\b/i,
  /\b3(?:[\s-]?d[\s-]?secure|ds2?)\b/i,
  /\bauthentication\s+(?:required|failed|needed)\b/i,
  /\bupdate\s+(?:your\s+)?(?:card|payment\s+method)\b/i,
  /\bverify\s+(?:this\s+)?(?:charge|payment|purchase)\b/i,
];

export function mailHasParseableAmount(input: {
  subject: string;
  snippet: string;
}): boolean {
  return extractAmount(`${input.subject}\n${input.snippet}`) !== null;
}

/**
 * Amount-first: any parseable amount → invoice.
 * Else actionable patterns → actionable_status.
 * Else noise patterns → noise_status.
 * Else invoice (downstream may still reject).
 */
export function classifyBillMail(input: {
  subject: string;
  snippet: string;
  /** When set (e.g. LLM returned an amount), forces invoice. */
  amount?: number | null;
}): BillMailKind {
  if (
    (typeof input.amount === "number" && Number.isFinite(input.amount)) ||
    mailHasParseableAmount(input)
  ) {
    return "invoice";
  }
  const haystack = `${input.subject}\n${input.snippet}`;
  for (const pattern of ACTIONABLE_STATUS_PATTERNS) {
    if (pattern.test(haystack)) {
      return "actionable_status";
    }
  }
  for (const pattern of NOISE_STATUS_PATTERNS) {
    if (pattern.test(haystack)) {
      return "noise_status";
    }
  }
  return "invoice";
}

export function isPaymentStatusNotice(input: {
  subject: string;
  snippet: string;
  amount?: number | null;
}): boolean {
  const kind = classifyBillMail(input);
  return kind === "actionable_status" || kind === "noise_status";
}

/** Short FYI line for actionable status (no buttons). */
export function paymentStatusFyiLine(input: {
  subject: string;
  fromHeader?: string;
}): string {
  const who =
    input.fromHeader?.match(/^\s*"?([^"<@]+?)"?\s*</)?.[1]?.trim() ||
    input.fromHeader?.split("@")[0]?.trim() ||
    "a biller";
  const subject = input.subject.trim().slice(0, 80) || "(no subject)";
  return `Payment notice: ${who} — ${subject}`;
}
