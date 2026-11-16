import assert from "node:assert/strict";
import { createBill, getBill, getBills, listActiveIgnoreRules } from "../src/db.ts";
import {
  addOneMonthYmd,
  handler as ignoreBill,
} from "../src/tools/ignore_bill.ts";
import { billIsIgnored } from "../src/ignore.ts";

if (process.env.AADI_DB_PATH !== ":memory:") {
  console.error(
    "test-ignore-bill.ts must run with AADI_DB_PATH=:memory: to avoid writing to the live db.",
  );
  process.exit(1);
}

const ownerTurn = (userText: string) => ({
  iteration: 1,
  calledTools: [] as string[],
  userText,
  confirmation: { chatId: 1, messageId: 1 },
});

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

const yt = createBill("YouTube Premium", 189, "INR", "2026-11-15", "thr-yt")!;
const netflix = createBill("Netflix", 649, "INR", "2026-11-20", "thr-nf")!;
const jio = createBill("Jio Fiber", 999, "INR", "2026-11-25", "thr-jio")!;
const jio2 = createBill("Jio Postpaid", 349, "INR", "2026-12-01", "thr-jio2")!;
assert(yt && netflix && jio && jio2, "seed bills failed");

{
  const refused = ignoreBill({ query: "youtube" });
  assert.match(
    refused,
    /own chat or voice message/i,
    `background ignore_bill must refuse, got: ${refused}`,
  );
}

{
  const result = ignoreBill({ query: "youtube" }, ownerTurn("Ignore YouTube bills permanently"));
  assert.match(
    result,
    /stop tracking YouTube Premium bills/i,
    `got: ${result}`,
  );
  assert.equal(getBill(yt.id)!.status, "upcoming", "yt stays upcoming, not paid");
  assert.equal(billIsIgnored(getBill(yt.id)!), true, "yt is ignored via registry");
  const next = getBills().find(
    (b) => b.biller === "YouTube Premium" && b.due_date === "2026-12-15",
  );
  assert.equal(next, undefined, "permanent ignore does not create next month");
}

{
  const result = ignoreBill({ query: "NETFLIX" }, ownerTurn("Ignore Netflix"));
  assert.match(result, /Netflix bills/i, `got: ${result}`);
  assert.equal(getBill(netflix.id)!.status, "upcoming");
  assert.equal(billIsIgnored(getBill(netflix.id)!), true);
}

{
  const before = {
    jio: getBill(jio.id)!.status,
    jio2: getBill(jio2.id)!.status,
  };
  const result = ignoreBill({ query: "jio" }, ownerTurn("Ignore jio"));
  assert.match(result, /^Found 2 matching bills/, `got: ${result}`);
  assert.match(result, /Jio Fiber/, "list includes Jio Fiber");
  assert.match(result, /Jio Postpaid/, "list includes Jio Postpaid");
  assert.equal(getBill(jio.id)!.status, before.jio, "ambiguous → no mutation");
  assert.equal(getBill(jio2.id)!.status, before.jio2, "ambiguous → no mutation");
}

{
  const before = listActiveIgnoreRules().length;
  const result = ignoreBill({ query: "verizon" }, ownerTurn("Ignore verizon bills"));
  assert.match(result, /stop tracking/i, `unknown biller still stores a source rule, got: ${result}`);
  assert.equal(listActiveIgnoreRules().length, before + 1, "future verizon bills are suppressed");
}

{
  const result = ignoreBill({ query: "youtube" }, ownerTurn("Ignore youtube"));
  assert.match(result, /Already ignoring/i, `repeat ignore is idempotent, got: ${result}`);
}

{
  const airtel = createBill("Airtel", 599, "INR", "2026-11-18", "thr-airtel")!;
  const result = ignoreBill(
    { query: "airtel", skip_cycle: true },
    ownerTurn("Skip Airtel this month"),
  );
  assert.match(result, /^Skipped Airtel for this month\./, `got: ${result}`);
  assert.equal(getBill(airtel.id)!.status, "ignored");
  const next = getBills().find(
    (b) => b.biller === "Airtel" && b.due_date === "2026-12-18",
  );
  assert(next, "cycle skip still creates next month");
  assert.equal(next!.status, "upcoming");
}

assert.throws(() => ignoreBill({}), /query must be a non-empty string/);
assert.throws(() => ignoreBill({ query: "   " }), /query must be a non-empty string/);

console.log("ignore_bill checks passed.");
