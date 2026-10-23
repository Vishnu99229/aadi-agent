import { parseNaturalDate } from "./promise_dates.js";

export type BillCurrency = "INR" | "USD" | "EUR" | "GBP";

export interface ExtractedBill {
  biller: string;
  amount: number;
  currency: BillCurrency;
  due_date: string; // YYYY-MM-DD
}

/** Matches both symbol-first ("₹1,249.00", "$49") and code-first
 *  ("INR 1249", "USD 49.00") amounts. Captures the currency token in
 *  group 1 and the numeric value in group 2. */
// Note: no trailing \b on "Rs\.?" - a word boundary after `.` fails when
// the next char is whitespace (both non-word), so "Rs. 999" would miss.
// The comma-separated alternative requires AT LEAST one comma group so
// "1249.50" is not mis-matched as "124" by greedy {1,3}.
const AMOUNT_RE =
  /(₹|£|€|\$|\bRs\.?|\bINR\b|\bUSD\b|\bEUR\b|\bGBP\b)\s*([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)/i;

const CURRENCY_MAP: Record<string, BillCurrency> = {
  "₹": "INR",
  rs: "INR",
  "rs.": "INR",
  inr: "INR",
  $: "USD",
  usd: "USD",
  "€": "EUR",
  eur: "EUR",
  "£": "GBP",
  gbp: "GBP",
};

export function extractAmount(
  text: string,
): { amount: number; currency: BillCurrency } | null {
  const match = text.match(AMOUNT_RE);
  if (!match) return null;
  const currency = CURRENCY_MAP[match[1].toLowerCase()];
  if (!currency) return null;
  const amount = Number(match[2].replace(/,/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { amount, currency };
}

/** Match a labelled due-date phrase and return the raw matched date text.
 *  Handles YYYY-MM-DD, dd/mm/yyyy, dd-mm-yyyy, "25 Nov 2026", "Nov 25, 2026". */
const DUE_RE =
  /\b(?:due(?:\s+(?:on|by|date))?|payable\s+by|pay\s+by|payment\s+due)\s*[:\-]?\s*(\d{4}-\d{2}-\d{2}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{1,2}\s+[A-Za-z]{3,}\s+\d{2,4}|[A-Za-z]{3,}\s+\d{1,2}(?:,\s*)?\s*\d{2,4})/i;

/** Convert any of the matched shapes to YYYY-MM-DD. Indian default for
 *  dd/mm/yyyy. chrono-node handles the natural-language shapes. */
export function normaliseDueDate(
  raw: string,
  instant: Date = new Date(),
): string | null {
  const trimmed = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const slash = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (slash) {
    const [, d, m, y] = slash;
    const year = y.length === 2 ? 2000 + Number(y) : Number(y);
    const month = m.padStart(2, "0");
    const day = d.padStart(2, "0");
    const iso = `${year}-${month}-${day}`;
    return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
  }
  // "25 Nov 2026" / "Nov 25, 2026". parseNaturalDate rejects past dates,
  // which is correct for a bill scan.
  return parseNaturalDate(trimmed, instant);
}

export function extractDueDate(
  text: string,
  instant: Date = new Date(),
): string | null {
  const match = text.match(DUE_RE);
  if (!match) return null;
  return normaliseDueDate(match[1], instant);
}

/** Biller: prefer the From display name; fall back to a "Your <X> bill"
 *  pattern in the subject; otherwise the local part of the From address. */
export function extractBiller(fromHeader: string, subject: string): string {
  const named = fromHeader.match(/^\s*"?([^"<@]+?)"?\s*</);
  if (named && named[1].trim()) return named[1].trim();
  const subjMatch = subject.match(
    /^(?:your\s+)?([A-Z][A-Za-z0-9&. ]{2,40})\s+(?:bill|invoice|statement|renewal|premium)/i,
  );
  if (subjMatch) return subjMatch[1].trim();
  const local = fromHeader.split("@")[0]?.trim();
  return local || "Unknown";
}

/** Try to pull a full bill out of (subject, snippet, from) alone. Returns
 *  null if ANY of amount / currency / due_date fails to parse — the caller
 *  then falls back to the existing DeepSeek classifier. */
export function extractBillDeterministic(input: {
  fromHeader: string;
  subject: string;
  snippet: string;
  instant?: Date;
}): ExtractedBill | null {
  const haystack = `${input.subject}\n${input.snippet}`;
  const amount = extractAmount(haystack);
  if (!amount) return null;
  const due = extractDueDate(haystack, input.instant ?? new Date());
  if (!due) return null;
  const biller = extractBiller(input.fromHeader, input.subject);
  if (!biller) return null;
  return {
    biller,
    amount: amount.amount,
    currency: amount.currency,
    due_date: due,
  };
}
