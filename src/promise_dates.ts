import * as chrono from "chrono-node";

const TIME_ZONE = "Asia/Kolkata";

/** Four explicit anchors chrono doesn't resolve on its own.
 *  Each resolver returns a Date (UTC-safe) relative to `sent`. */
const EXPLICIT_ANCHORS: Array<[RegExp, (sent: Date) => Date]> = [
  // "by EOD" / "end of day" / "COB" — same day as sent.
  [/\b(?:by\s+)?(?:eod|end\s+of\s+day|cob)\b/i, (sent) => sent],
  // "by EOW" / "end of week" — the coming Friday (or today if sent IS Friday).
  [/\b(?:by\s+)?(?:eow|end\s+of\s+week)\b/i, (sent) => comingWeekday(sent, 5)],
  // "next week" (no day named) — next Monday.
  [/\bnext\s+week\b(?!\s+(?:mon|tue|wed|thu|fri|sat|sun))/i, (sent) =>
    strictNextWeekday(sent, 1),
  ],
];

function comingWeekday(from: Date, target: 0 | 1 | 2 | 3 | 4 | 5 | 6): Date {
  const d = new Date(from);
  const delta = (target - d.getUTCDay() + 7) % 7;
  d.setUTCDate(d.getUTCDate() + delta);
  return d;
}

function strictNextWeekday(
  from: Date,
  target: 0 | 1 | 2 | 3 | 4 | 5 | 6,
): Date {
  const d = new Date(from);
  const delta = ((target - d.getUTCDay() + 7) % 7) || 7;
  d.setUTCDate(d.getUTCDate() + delta);
  return d;
}

/** YYYY-MM-DD in Asia/Kolkata for a given instant. */
export function kolkataYmd(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const g = (t: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === t)!.value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}

/** Pure deterministic wrapper around chrono-node.
 *
 *  - `instant` is the reference date for relative phrases ("Friday",
 *    "tomorrow", "next Tuesday"). Defaults to now.
 *  - Returns a YYYY-MM-DD string in Asia/Kolkata, or null if no usable
 *    future date is found.
 *  - If chrono picks a date that falls before `instant`'s calendar day
 *    and the YEAR was NOT explicitly stated by the writer (e.g. "25 Nov"
 *    without a year), shift forward one year so the deadline is in the
 *    future. If the year WAS explicit (e.g. "25 Nov 2024"), reject.
 *  - Never returns a past date. */
export function parseNaturalDate(
  text: string,
  instant: Date = new Date(),
): string | null {
  if (!text) return null;
  const instantYmd = kolkataYmd(instant);
  // forwardDate: true tells chrono to prefer the NEXT occurrence of an
  // ambiguous relative phrase ("Friday", "25 Nov"). The year-rollover
  // branch below only has to catch leftovers that chrono still placed
  // in the past (rare: usually when the writer under-specified a month).
  const results = chrono.casual.parse(text, instant, { forwardDate: true });
  for (const result of results) {
    const parsed = result.start.date();
    const parsedYmd = kolkataYmd(parsed);
    if (parsedYmd >= instantYmd) {
      return parsedYmd;
    }
    // Past match. Only roll it to next year when the writer did not
    // pin the year themselves — otherwise we'd override explicit intent.
    const yearPinned = result.start.isCertain("year");
    if (yearPinned) continue;
    const shifted = new Date(parsed);
    shifted.setUTCFullYear(shifted.getUTCFullYear() + 1);
    const shiftedYmd = kolkataYmd(shifted);
    if (shiftedYmd >= instantYmd) {
      return shiftedYmd;
    }
    // Even +1y didn't make it future (shouldn't happen, but be safe).
  }
  return null;
}

/** Full deadline extraction for a sent email body.
 *
 *  Resolution order:
 *   1. Explicit anchors we own (EOD / EOW / COB / "next week").
 *   2. chrono-node via parseNaturalDate on the full body.
 *
 *  Returns a YYYY-MM-DD in Asia/Kolkata, or null. */
export function extractDeadline(
  body: string,
  sentAtIso: string,
): string | null {
  if (!body) return null;
  const sent = new Date(sentAtIso);
  for (const [pattern, resolver] of EXPLICIT_ANCHORS) {
    if (pattern.test(body)) {
      const resolved = resolver(sent);
      const ymd = kolkataYmd(resolved);
      if (ymd >= kolkataYmd(sent)) return ymd;
    }
  }
  return parseNaturalDate(body, sent);
}
