import assert from "node:assert/strict";
import { createBill, getBill } from "../src/db.ts";
import { handler as ignoreBill } from "../src/tools/ignore_bill.ts";

if (process.env.AADI_DB_PATH !== ":memory:") {
  console.error(
    "test-ignore-bill.ts must run with AADI_DB_PATH=:memory: to avoid writing to the live db.",
  );
  process.exit(1);
}

// Seed a few upcoming bills.
const yt = createBill("YouTube Premium", 189, "INR", "2099-01-15", "thr-yt")!;
const netflix = createBill("Netflix", 649, "INR", "2099-02-10", "thr-nf")!;
const jio = createBill("Jio Fiber", 999, "INR", "2099-03-05", "thr-jio")!;
assert(yt && netflix && jio, "seed bills failed");

// Case 1: fuzzy fragment "youtube" matches exactly one bill.
{
  const result = ignoreBill({ query: "youtube" });
  assert.equal(result, "Ignored bill: YouTube Premium", `got: ${result}`);
  assert.equal(getBill(yt.id)!.status, "ignored", "yt should flip to ignored");
  assert.equal(getBill(netflix.id)!.status, "upcoming", "netflix untouched");
}

// Case 2: a stricter fragment ("premium") now matches nothing because
// YouTube Premium is already ignored, and the handler only looks at
// upcoming bills.
{
  const result = ignoreBill({ query: "premium" });
  assert.equal(
    result,
    "No active bills found matching that description.",
    `got: ${result}`,
  );
}

// Case 3: full biller name "Netflix" (case-insensitive).
{
  const result = ignoreBill({ query: "NETFLIX" });
  assert.equal(result, "Ignored bill: Netflix", `got: ${result}`);
  assert.equal(getBill(netflix.id)!.status, "ignored", "netflix flipped");
}

// Case 4: query that would match multiple upcoming bills ignores them all
// and returns a list. Reseed a couple of upcoming entries first.
const jio2 = createBill("Jio Postpaid", 349, "INR", "2099-04-01", "thr-jio2")!;
assert(jio2, "jio2 seed failed");
{
  const result = ignoreBill({ query: "jio" });
  assert.match(result, /^Ignored 2 bills:/, `got: ${result}`);
  assert.match(result, /Jio Fiber/, "list includes Jio Fiber");
  assert.match(result, /Jio Postpaid/, "list includes Jio Postpaid");
  assert.equal(getBill(jio.id)!.status, "ignored");
  assert.equal(getBill(jio2.id)!.status, "ignored");
}

// Case 5: no match on an unknown fragment.
{
  const result = ignoreBill({ query: "verizon" });
  assert.equal(
    result,
    "No active bills found matching that description.",
    `got: ${result}`,
  );
}

// Case 6: invalid input raises.
assert.throws(() => ignoreBill({}), /query must be a non-empty string/);
assert.throws(() => ignoreBill({ query: "   " }), /query must be a non-empty string/);

console.log("ignore_bill checks passed.");
