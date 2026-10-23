import assert from "node:assert/strict";
import {
  extractAmount,
  extractBiller,
  extractBillDeterministic,
  extractDueDate,
  normaliseDueDate,
} from "../src/bill_extract.ts";

// ---- extractAmount ----
assert.deepEqual(extractAmount("Your bill: ₹1,249.00 is due"), {
  amount: 1249,
  currency: "INR",
});
assert.deepEqual(extractAmount("Amount USD 1,249"), {
  amount: 1249,
  currency: "USD",
});
assert.deepEqual(extractAmount("Payable: $49.00"), {
  amount: 49,
  currency: "USD",
});
assert.deepEqual(extractAmount("Rs. 999 payable"), {
  amount: 999,
  currency: "INR",
});
assert.deepEqual(extractAmount("INR 1249.50 due"), {
  amount: 1249.5,
  currency: "INR",
});
assert.deepEqual(extractAmount("£99 billed"), {
  amount: 99,
  currency: "GBP",
});
assert.equal(extractAmount("No currency, just 1249 here"), null);
assert.equal(extractAmount("free trial"), null);

// ---- extractDueDate / normaliseDueDate ----
// Use an anchor well in the past so "2026-11-25" is unambiguously future.
const anchor = new Date("2026-10-23T10:00:00+05:30");
assert.equal(
  extractDueDate("Payment due: 25 Nov 2026", anchor),
  "2026-11-25",
);
assert.equal(extractDueDate("due on 2026-11-25", anchor), "2026-11-25");
assert.equal(extractDueDate("due 25/11/2026", anchor), "2026-11-25");
assert.equal(
  extractDueDate("Payable by Nov 25, 2026", anchor),
  "2026-11-25",
);
assert.equal(
  extractDueDate("No due phrase in this one", anchor),
  null,
);
assert.equal(normaliseDueDate("2026-11-25", anchor), "2026-11-25");
assert.equal(normaliseDueDate("25-11-2026", anchor), "2026-11-25");

// ---- extractBiller ----
assert.equal(
  extractBiller("\"ACME Power Co.\" <billing@acme.co>", "Your bill"),
  "ACME Power Co.",
);
assert.equal(
  extractBiller("<noreply@amazon.in>", "Your Amazon Prime renewal is coming"),
  "Amazon Prime",
);
assert.equal(
  extractBiller("billing@tatasky.com", "Your Tata Sky bill"),
  "Tata Sky",
);

// ---- extractBillDeterministic happy path ----
const bill = extractBillDeterministic({
  fromHeader: "\"ACME Power Co.\" <billing@acme.co>",
  subject: "Your ACME Power bill",
  snippet: "Amount: ₹1,249.00. Due: 25 Nov 2026.",
  instant: anchor,
});
assert.deepEqual(bill, {
  biller: "ACME Power Co.",
  amount: 1249,
  currency: "INR",
  due_date: "2026-11-25",
});

// Missing amount OR due date -> null (caller falls back to LLM).
assert.equal(
  extractBillDeterministic({
    fromHeader: "\"ACME\" <x@acme.co>",
    subject: "Your bill",
    snippet: "Please find the receipt attached.",
    instant: anchor,
  }),
  null,
);
assert.equal(
  extractBillDeterministic({
    fromHeader: "\"ACME\" <x@acme.co>",
    subject: "Your bill",
    snippet: "Amount: ₹999 (no due date mentioned here).",
    instant: anchor,
  }),
  null,
);

console.log("Bill extractor checks passed.");
