import "dotenv/config";

process.env.AADI_DB_PATH ??= ":memory:";
process.env.LLM_PROVIDER ??= "claude";
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.OWNER_TELEGRAM_ID ??= "1";
process.env.CLAUDE_MODEL ??= "claude-haiku-5-5";
process.env.ANTHROPIC_API_KEY ??= "test-key";
process.env.BRIEF_TIME ??= "08:00";

import assert from "node:assert/strict";
import { canonicalBiller, billersMatch } from "../src/bill_aliases.ts";
import { classifyBillMail } from "../src/bill_status.ts";
import { trackPayableBill } from "../src/bills.ts";
import { getBill, getBills } from "../src/db.ts";

{
  assert.equal(
    classifyBillMail({
      subject: "Confirm your payment to Anthropic, PBC",
      snippet: "Confirm your payment to Anthropic, PBC for USD 23.60",
    }),
    "invoice",
    "amount wins over confirm-your-payment wording",
  );
  assert.equal(
    classifyBillMail({
      subject: "Your subscription access has been paused",
      snippet:
        "Your most recent payment was unsuccessful, and your access has been paused.",
    }),
    "actionable_status",
    "failed payment without amount is actionable status",
  );
  assert.equal(
    classifyBillMail({
      subject: "Confirm your renewal",
      snippet:
        "Your Claude Pro renewal needs a quick confirmation from your bank.",
    }),
    "noise_status",
    "bank confirmation without amount is noise",
  );
  assert.equal(
    classifyBillMail({
      subject: "Confirm your payment",
      snippet: "Confirm your payment",
      amount: 23.6,
    }),
    "invoice",
    "LLM amount forces invoice",
  );
  console.log("status vs invoice classification: ok");
}

{
  assert.equal(canonicalBiller("Anthropic (Claude)"), "Anthropic");
  assert.equal(canonicalBiller("Anthropic, PBC"), "Anthropic");
  assert.equal(canonicalBiller("Anthropic"), "Anthropic");
  assert.ok(billersMatch("Anthropic (Claude)", "Anthropic, PBC"));
  console.log("biller aliases: ok");
}

{
  const first = trackPayableBill({
    biller: "Anthropic (Claude)",
    amount: null,
    currency: "USD",
    dueDate: "2026-11-02",
    threadId: "thread-a",
    snippet: "amount unknown invoice",
  });
  assert.equal(first.action, "created");
  if (first.action !== "created") {
    throw new Error("expected created");
  }
  assert.equal(first.bill.amount, null);

  const second = trackPayableBill({
    biller: "Anthropic, PBC",
    amount: 23.6,
    currency: "USD",
    dueDate: "2026-11-02",
    threadId: "thread-b",
    snippet: "Confirm your payment USD 23.6",
  });
  assert.equal(second.action, "updated", "amount fills the unknown row");
  assert.ok(second.action === "updated");
  if (second.action === "updated") {
    assert.equal(second.bill.amount, 23.6);
    assert.equal(second.bill.biller, "Anthropic");
    assert.equal(getBill(second.bill.id)?.amount, 23.6);
  }
  assert.equal(getBills().filter((b) => b.status === "upcoming").length, 1);

  const third = trackPayableBill({
    biller: "Anthropic",
    amount: 23.6,
    currency: "USD",
    dueDate: "2026-11-02",
    threadId: "thread-c",
    snippet: "another alias",
  });
  assert.equal(third.action, "kept", "second amount does not create another row");
  assert.equal(getBills().filter((b) => b.status === "upcoming").length, 1);
  console.log("merge amount-unknown → amount + alias: ok");
}

{
  const failed = classifyBillMail({
    subject: "Payment failed",
    snippet: "payment was unsuccessful",
  });
  assert.equal(failed, "actionable_status");
  // No payable bill created for status — trackPayableBill is only for invoices.
  assert.equal(getBills().length, 1, "status path must not add rows here");
  console.log("payment-failed creates no payable bill: ok");
}

console.log("test-bill-dedupe: all passed");
