/**
 * Read-only pitch detection report over work Sent mail.
 * Never sends mail, creates drafts or posts to Telegram, and writes no sequence rows.
 * Point AADI_DB_PATH at a copy of the database: model calls still log usage rows.
 * Prints domains and subjects only: no recipient addresses and no bodies.
 */
import { config } from "../src/config.js";
import { DB_PATH } from "../src/db.js";
import { PERSONAL_DOMAINS } from "../src/meeting_book.js";
import { prospectKey } from "../src/sequence_logic.js";
import { detectPitches } from "../src/sequences.js";

const LOOKBACK_DAYS = 21;

if (DB_PATH === ":memory:" || DB_PATH.endsWith("/aadi.db") || DB_PATH === "./aadi.db") {
  console.error("Refusing to run: set AADI_DB_PATH to a copy of the live database.");
  process.exit(1);
}

function cell(text: string, max = 60): string {
  const clean = text.replace(/\s+/g, " ").replace(/\|/g, "/").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function ymd(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

const rows = await detectPitches({
  lookbackDays: LOOKBACK_DAYS,
  classifyExcluded: true,
});
rows.sort((left, right) => right.sentAt.getTime() - left.sentAt.getTime());

console.log(
  "| date | recipient domain | subject | is_sales_pitch | confidence | excluded? + reason | classifier reason |",
);
console.log("| --- | --- | --- | --- | --- | --- | --- |");
for (const row of rows) {
  const verdict = row.classification;
  console.log(
    [
      "",
      ymd(row.sentAt),
      row.recipientDomain || "-",
      cell(row.subject),
      verdict ? String(verdict.is_sales_pitch) : "-",
      verdict ? verdict.confidence.toFixed(2) : "-",
      row.exclusion ?? "no",
      verdict ? cell(verdict.reason, 90) : "-",
      "",
    ].join(" | ").trim(),
  );
}

const classified = rows.filter((row) => row.classification);
const pitches = classified.filter((row) => row.classification!.is_sales_pitch);
const cards = new Set(
  pitches
    .filter(
      (row) =>
        !row.exclusion &&
        row.prospect &&
        row.classification!.confidence >= config.sequencePitchMinConfidence,
    )
    .map((row) => prospectKey(row.prospect!.email, PERSONAL_DOMAINS)),
);
console.log(
  `\nthreads=${rows.length} classified=${classified.length} pitches=${pitches.length} cards=${cards.size}`,
);
