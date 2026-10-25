import assert from "node:assert/strict";
import { createBill, getBill, getBills } from "../src/db.ts";
import {
  addOneMonthYmd,
  handler as ignoreBill,
} from "../src/tools/ignore_bill.ts";

if (process.env.AADI_DB_PATH !== ":memory:") {
  console.error(
    "test-ignore-bill.ts must run with AADI_DB_PATH=:memory: to avoid writing to the live db.",
  );
  process.exit(1);
}

// addOneMonthYmd edge cases ----
assert.equal(addOneMonthYmd("2026-11-15"), "2026-12-15", "simple +1 month");
assert.equal(addOneMonthYmd("2026-12-15"), "2027-01-15", "year rollover");
assert.equal(
  addOneMonthYmd("2026-01-31"),
  "2026-02-28",
  "clamp Jan 31 -> Feb 28 (non-leap)",
);
assert.equal(
  addOneMonthYmd("2028-01-31"),
  "2028-02-29",
  "clamp Jan 31 -> Feb 29 in leap year",
);
assert.equal(addOneMonthYmd("2026-03-30"), "2026-04-30", "month-end stable");

// Seed a few upcoming bills.
const yt = createBill("YouTube Premium", 189, "INR", "2026-11-15", "thr-yt")!;
const netflix = createBill("Netflix", 649, "INR", "2026-11-20", "thr-nf")!;
const jio = createBill("Jio Fiber", 999, "INR", "2026-11-25", "thr-jio")!;
const jio2 = createBill("Jio Postpaid", 349, "INR", "2026-12-01", "thr-jio2")!;
assert(yt && netflix && jio && jio2, "seed bills failed");

// Case 1: fuzzy fragment "youtube" skips exactly one bill and creates next month.
{
  const result = ignoreBill({ query: "youtube" });
  assert.match(
    result,
    /^Skipped YouTube Premium for this month\./,
    `got: ${result}`,
  );
  assert.match(
    result,
    /2026-12-15/,
    `confirmation should name next due date, got: ${result}`,
  );
  assert.match(
    result,
    /does not mark it as paid/i,
    `confirmation should state 'not paid', got: ${result}`,
  );
  assert.equal(getBill(yt.id)!.status, "ignored", "yt flipped to ignored");
  const next = getBills().find(
    (b) => b.biller === "YouTube Premium" && b.due_date === "2026-12-15",
  );
  assert(next, "next-month YouTube bill was created");
  assert.equal(next!.status, "upcoming", "next-month row starts upcoming");
}

// Case 2: case-insensitive full biller name on Netflix.
{
  const result = ignoreBill({ query: "NETFLIX" });
  assert.match(result, /^Skipped Netflix for this month\./, `got: ${result}`);
  assert.equal(getBill(netflix.id)!.status, "ignored");
  const next = getBills().find(
    (b) => b.biller === "Netflix" && b.due_date === "2026-12-20",
  );
  assert(next, "next-month Netflix bill was created at +1 month");
}

// Case 3: query matching multiple upcoming bills asks which one, no change made.
{
  const before = {
    jio: getBill(jio.id)!.status,
    jio2: getBill(jio2.id)!.status,
  };
  const result = ignoreBill({ query: "jio" });
  assert.match(result, /^Found 2 matching bills/, `got: ${result}`);
  assert.match(result, /Jio Fiber/, "list includes Jio Fiber");
  assert.match(result, /Jio Postpaid/, "list includes Jio Postpaid");
  assert.equal(getBill(jio.id)!.status, before.jio, "ambiguous → no mutation");
  assert.equal(getBill(jio2.id)!.status, before.jio2, "ambiguous → no mutation");
}

// Case 4: unknown fragment.
{
  const result = ignoreBill({ query: "verizon" });
  assert.equal(
    result,
    "No active bills found matching that description.",
    `got: ${result}`,
  );
}

// Case 5: a previously ignored bill no longer matches 'youtube' because
// searchUpcomingBills only looks at status='upcoming'; the new upcoming
// row for next month will match. Skipping it again should produce the
// following month's bill.
{
  const result = ignoreBill({ query: "youtube" });
  assert.match(result, /^Skipped YouTube Premium for this month\./);
  assert.match(result, /2027-01-15/, "second skip rolls to +2 months");
  const second = getBills().find(
    (b) => b.biller === "YouTube Premium" && b.due_date === "2027-01-15",
  );
  assert(second, "second-month YouTube row created");
}

// Case 6: invalid input raises.
assert.throws(() => ignoreBill({}), /query must be a non-empty string/);
assert.throws(() => ignoreBill({ query: "   " }), /query must be a non-empty string/);

console.log("ignore_bill checks passed.");
