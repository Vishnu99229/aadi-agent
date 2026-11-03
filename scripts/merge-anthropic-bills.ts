/**
 * ONE-TIME cleanup for Anthropic duplicate bills (#25/#26/#27).
 *
 * Dry run (default — change nothing):
 *   AADI_DB_PATH=/path/to/aadi.db tsx scripts/merge-anthropic-bills.ts
 *   AADI_DB_PATH=/path/to/aadi.db tsx scripts/merge-anthropic-bills.ts --dry-run
 *
 * Apply (only after Vishnu confirms a backup + dry-run output):
 *   AADI_DB_PATH=/path/to/aadi.db tsx scripts/merge-anthropic-bills.ts --apply
 */
import {
  cancelPendingRemindersForBill,
  getBill,
  transitionBillStatus,
  updateBillDetails,
} from "../src/db.js";
import { canonicalBiller } from "../src/bill_aliases.js";

const KEEP_ID = 27;
const DROP_IDS = [25, 26] as const;

const apply = process.argv.includes("--apply");
const dryRun = !apply;

function main(): void {
  const keep = getBill(KEEP_ID);
  if (!keep) {
    throw new Error(`Bill ${KEEP_ID} not found`);
  }
  if (keep.amount === null) {
    throw new Error(`Bill ${KEEP_ID} has no amount to keep`);
  }

  const canonical = canonicalBiller(keep.biller);
  console.log(dryRun ? "DRY-RUN (no DB writes)" : "APPLY (writing DB)");
  console.log(
    `KEEP #${KEEP_ID}: biller="${keep.biller}" → canonical="${canonical}", ` +
      `amount=${keep.currency} ${keep.amount}, due=${keep.due_date}, ` +
      `status=${keep.status}, thread=${keep.thread_id}`,
  );
  if (canonical !== keep.biller) {
    console.log(
      `  would UPDATE #${KEEP_ID} biller "${keep.biller}" → "${canonical}"`,
    );
  } else {
    console.log(`  biller already canonical; no rename needed`);
  }

  for (const id of DROP_IDS) {
    const row = getBill(id);
    if (!row) {
      console.log(`DROP #${id}: missing — skip`);
      continue;
    }
    console.log(
      `DROP #${id}: biller="${row.biller}", amount=${row.amount === null ? "null" : `${row.currency} ${row.amount}`}, ` +
        `due=${row.due_date}, status=${row.status}, thread=${row.thread_id}`,
    );
    console.log(
      `  would cancel pending reminders for #${id}, then status → ignored`,
    );
  }

  if (dryRun) {
    console.log("Dry run complete — DB unchanged.");
    return;
  }

  const updated = updateBillDetails(KEEP_ID, {
    biller: canonical,
    amount: keep.amount,
    currency: keep.currency,
  });
  console.log(
    `Updated #${KEEP_ID}: ${updated?.biller} ${updated?.currency} ${updated?.amount} due ${updated?.due_date}`,
  );
  for (const id of DROP_IDS) {
    const row = getBill(id);
    if (!row) {
      continue;
    }
    const cancelled = cancelPendingRemindersForBill(id);
    transitionBillStatus(id, ["upcoming", "paid"], "ignored");
    console.log(
      `Ignored #${id} (${row.biller}, amount=${row.amount}); cancelled reminders=${cancelled}`,
    );
  }
}

main();
