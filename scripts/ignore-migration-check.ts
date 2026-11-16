/**
 * Two-step check for the ignore-rule index migration and the bills
 * status_reason backfill.
 * `seed` rewrites a fresh database back to the old unique index and the old
 * bills table (no status_reason), with rows the old bill-card Ignore wrote.
 * `check` opens that file, migrates it, and proves the old rows survived.
 */
import {
  backfillLegacyBillIgnoreProvenance,
  db,
  getBill,
  insertIgnoreRule,
} from "../src/db.ts";
import { resumeIgnore } from "../src/ignore.ts";

const mode = process.argv[2];

type BillRow = { id: number; biller: string; due_date: string; status: string };

function legacyBills(): BillRow[] {
  return db
    .prepare(`SELECT id, biller, due_date, status FROM bills ORDER BY id`)
    .all() as BillRow[];
}

if (mode === "seed") {
  db.exec(`
    DROP INDEX IF EXISTS idx_ignore_rules_active_record;
    DROP INDEX IF EXISTS idx_ignore_rules_active_record_key;
    DROP INDEX IF EXISTS idx_ignore_rules_active_source;
    CREATE UNIQUE INDEX idx_ignore_rules_active_key
      ON ignore_rules (entity_type, match_key, match_scope, tag)
      WHERE status = 'active';
    ALTER TABLE bills DROP COLUMN status_reason;
  `);
  const record = insertIgnoreRule({
    tag: "personal",
    entityType: "bill",
    entityId: "101",
    matchKey: "linkedin",
    matchScope: "record",
    duration: "permanent",
    instruction: "ignore invoice 101",
    authRef: "owner_chat:migration",
  });
  const source = insertIgnoreRule({
    tag: "personal",
    entityType: "bill",
    matchKey: "aws",
    matchScope: "source",
    duration: "permanent",
    instruction: "ignore aws bills",
    authRef: "owner_chat:migration",
  });
  if (!record || !source) {
    throw new Error("seed failed to insert the pre-migration rules");
  }
  db.prepare(
    `INSERT INTO ignore_rule_events (rule_id, action, auth_ref, instruction, detail)
     VALUES (?, 'created', 'owner_chat:migration', 'ignore invoice 101', NULL)`,
  ).run(record.id);
  const insertBill = db.prepare(
    `INSERT INTO bills (biller, amount, currency, due_date, thread_id, status)
     VALUES (?, ?, 'INR', ?, ?, ?)`,
  );
  // The old card Ignore flipped this one. Nothing else touched it.
  const owned = Number(
    insertBill.run("Migr Broadband", 700, "2026-12-20", "migr-1", "ignored").lastInsertRowid,
  );
  // Skipped before the rule existed: the next cycle row is the evidence.
  const skipped = Number(
    insertBill.run("Migr Mobile", 499, "2026-11-28", "migr-2", "ignored").lastInsertRowid,
  );
  insertBill.run("Migr Mobile", 499, "2026-12-28", "migr-2", "upcoming");
  for (const [billId, biller] of [
    [owned, "Migr Broadband"],
    [skipped, "Migr Mobile"],
  ] as const) {
    const card = insertIgnoreRule({
      tag: "personal",
      entityType: "bill",
      entityId: String(billId),
      matchKey: biller.toLowerCase(),
      matchScope: "record",
      duration: "permanent",
      instruction: "telegram:bill-ignore",
      authRef: `telegram:callback:${billId}`,
    });
    if (!card) {
      throw new Error(`seed failed to insert the card rule for bill ${billId}`);
    }
  }
  db.prepare(
    `INSERT INTO reminders (text, tag, remind_at, recurrence, status, series_id, status_reason)
     VALUES ('Migr daily', 'personal', '2026-11-20T03:30:00.000Z', 'daily', 'cancelled', 777, 'user')`,
  ).run();
  console.log(`SEEDED record=${record.id} source=${source.id}`);
  process.exit(0);
}

if (mode === "check") {
  const activeAtOpen = db
    .prepare(`SELECT COUNT(*) AS n FROM ignore_rules WHERE status = 'active'`)
    .get() as { n: number };
  if (activeAtOpen.n !== 4) {
    throw new Error(`active rule count changed on migration: ${activeAtOpen.n}`);
  }
  const bills = legacyBills();
  const owned = bills.find((row) => row.biller === "Migr Broadband");
  const skipped = bills.find((row) => row.biller === "Migr Mobile" && row.status === "ignored");
  if (bills.length !== 3 || !owned || !skipped || owned.id !== 1 || skipped.id !== 2) {
    throw new Error(`bill rows or ids changed: ${JSON.stringify(bills)}`);
  }
  if (getBill(owned.id)?.status_reason !== "ignore" || getBill(owned.id)?.status !== "ignored") {
    throw new Error(`provable card Ignore was not marked: ${JSON.stringify(getBill(owned.id))}`);
  }
  if (getBill(skipped.id)?.status_reason !== null) {
    throw new Error(`ambiguous skipped row was marked: ${JSON.stringify(getBill(skipped.id))}`);
  }
  if (backfillLegacyBillIgnoreProvenance() !== 0) {
    throw new Error("backfill is not idempotent");
  }
  const reminder = db
    .prepare(`SELECT series_id, status, status_reason FROM reminders WHERE text = 'Migr daily'`)
    .get() as { series_id: number; status: string; status_reason: string } | undefined;
  if (
    reminder?.series_id !== 777 ||
    reminder.status !== "cancelled" ||
    reminder.status_reason !== "user"
  ) {
    throw new Error(`reminder provenance changed: ${JSON.stringify(reminder)}`);
  }
  const cardRules = db
    .prepare(
      `SELECT id, entity_id FROM ignore_rules
        WHERE instruction = 'telegram:bill-ignore' AND status = 'active'`,
    )
    .all() as Array<{ id: number; entity_id: string }>;
  for (const rule of cardRules) {
    resumeIgnore(rule.id, "owner_chat:migration", "resume after migration");
  }
  if (getBill(owned.id)?.status !== "upcoming") {
    throw new Error("Resume did not undo the provable card Ignore");
  }
  if (getBill(skipped.id)?.status !== "ignored") {
    throw new Error("Resume undid an ambiguous historical skip");
  }
  const names = (
    db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'index' AND tbl_name = 'ignore_rules'`,
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
  if (names.includes("idx_ignore_rules_active_key")) {
    throw new Error(`old unique index still present: ${names.join(",")}`);
  }
  if (!names.includes("idx_ignore_rules_active_record")) {
    throw new Error("record unique index missing");
  }
  if (!names.includes("idx_ignore_rules_active_source")) {
    throw new Error("source unique index missing");
  }
  const rules = db
    .prepare(
      `SELECT id, status, entity_id, match_key, match_scope
         FROM ignore_rules
        ORDER BY id`,
    )
    .all() as Array<{
    id: number;
    status: string;
    entity_id: string | null;
    match_key: string;
    match_scope: string;
  }>;
  const original = rules.find((row) => row.entity_id === "101");
  const source = rules.find((row) => row.match_scope === "source");
  if (!original || original.status !== "active" || original.id !== rules[0]?.id) {
    throw new Error(`original record rule was rewritten: ${JSON.stringify(rules)}`);
  }
  if (!source || source.status !== "active" || source.match_key !== "aws") {
    throw new Error(`source rule was rewritten: ${JSON.stringify(rules)}`);
  }
  const events = db
    .prepare(`SELECT COUNT(*) AS n FROM ignore_rule_events WHERE rule_id = ?`)
    .get(original.id) as { n: number };
  if (events.n < 1) {
    throw new Error("audit history was dropped");
  }
  const second = insertIgnoreRule({
    tag: "personal",
    entityType: "bill",
    entityId: "102",
    matchKey: "linkedin",
    matchScope: "record",
    duration: "permanent",
    instruction: "ignore invoice 102",
    authRef: "owner_chat:migration",
  });
  if (!second || second.id === original.id) {
    throw new Error("a second record rule with the same biller was rejected");
  }
  const sourceAgain = insertIgnoreRule({
    tag: "personal",
    entityType: "bill",
    matchKey: "aws",
    matchScope: "source",
    duration: "permanent",
    instruction: "ignore aws bills again",
    authRef: "owner_chat:migration",
  });
  if (sourceAgain) {
    throw new Error("source uniqueness was lost");
  }
  console.log("MIGRATION_OK");
  process.exit(0);
}

throw new Error("usage: ignore-migration-check.ts seed|check");
