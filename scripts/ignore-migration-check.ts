/**
 * Two-step check for the ignore-rule index migration.
 * `seed` rewrites a fresh database back to the old unique index.
 * `check` opens that file, migrates it, and proves the old rows survived.
 */
import { db, insertIgnoreRule } from "../src/db.ts";

const mode = process.argv[2];

if (mode === "seed") {
  db.exec(`
    DROP INDEX IF EXISTS idx_ignore_rules_active_record;
    DROP INDEX IF EXISTS idx_ignore_rules_active_record_key;
    DROP INDEX IF EXISTS idx_ignore_rules_active_source;
    CREATE UNIQUE INDEX idx_ignore_rules_active_key
      ON ignore_rules (entity_type, match_key, match_scope, tag)
      WHERE status = 'active';
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
  console.log(`SEEDED record=${record.id} source=${source.id}`);
  process.exit(0);
}

if (mode === "check") {
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
