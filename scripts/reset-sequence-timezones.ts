/**
 * Clear cached timezones for NiCE (Jeff, Dorothy) and resolve them again.
 *
 * The live phone DB still has Jeff on Asia/Kolkata (default) and can leave
 * Dorothy on a foreign HQ cache. Termux has no sqlite3 CLI, so this script
 * uses the better-sqlite3 connection from src/db.ts, nulls the cache, then
 * runs the timezone classifier.
 *
 *   DOTENV_CONFIG_PATH=.env tsx scripts/reset-sequence-timezones.ts
 *
 * Prints names, companies, and zones only. Never prints email bodies.
 */
import "dotenv/config";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  db,
  getSalesSequence,
  setSalesSequenceTimezone,
  type SalesSequenceRecord,
} from "../src/db.ts";
import { workGmail } from "../src/sequences.ts";
import {
  chooseProspectZone,
  resolveProspectTimezone,
  US_PACIFIC_ZONE,
  type TimezoneSource,
} from "../src/sequence_timezone.ts";

const TARGET_SQL = `status = 'active'
  AND COALESCE(prospect_timezone_source, '') <> 'owner'
  AND (
    LOWER(prospect_company) LIKE '%nice%'
    OR LOWER(prospect_email) LIKE '%jeff.comstock%'
    OR LOWER(prospect_email) LIKE '%dorothy.copeland%'
    OR LOWER(prospect_name) LIKE '%jeff comstock%'
    OR LOWER(prospect_name) LIKE '%dorothy copeland%'
  )`;

export type TimezoneResetAction = "reset" | "unchanged";

export interface TimezoneReset {
  id: number;
  prospect_name: string;
  prospect_company: string;
  previous_timezone: string | null;
  previous_source: string | null;
  timezone: string | null;
  source: string | null;
  action: TimezoneResetAction;
}

export function listNiceTimezoneResetTargets(): SalesSequenceRecord[] {
  return db
    .prepare(`SELECT * FROM sales_sequences WHERE ${TARGET_SQL} ORDER BY id`)
    .all() as SalesSequenceRecord[];
}

/** Null the cached zone for NiCE / Jeff / Dorothy. Owner corrections stay. */
export function nullNiceTimezoneCaches(): number {
  return db
    .prepare(
      `UPDATE sales_sequences
       SET prospect_timezone = NULL,
           prospect_timezone_source = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE ${TARGET_SQL}`,
    )
    .run().changes;
}

export function classifyNiceTimezone(): { zone: string; source: TimezoneSource } {
  return chooseProspectZone(undefined, {
    zone: "Asia/Jerusalem",
    basis: "company",
    market: "global",
  });
}

export async function resetNiceSequenceTimezones(options?: {
  resolve?: (
    row: SalesSequenceRecord,
  ) => Promise<{ zone: string; source: TimezoneSource }> | { zone: string; source: TimezoneSource };
  log?: (line: string) => void;
}): Promise<TimezoneReset[]> {
  const log = options?.log ?? console.log;
  const resolveZone = options?.resolve ?? classifyNiceTimezone;
  const targets = listNiceTimezoneResetTargets();
  const results: TimezoneReset[] = [];

  const cleared = nullNiceTimezoneCaches();
  log(`Nulled ${cleared} NiCE/Jeff/Dorothy timezone cache${cleared === 1 ? "" : "s"}.`);

  for (const row of targets) {
    const found = await resolveZone(row);
    setSalesSequenceTimezone(row.id, found.zone, found.source);
    const stored = getSalesSequence(row.id);
    log(
      `${row.prospect_name} (${row.prospect_company || "-"}): ${row.prospect_timezone ?? "(none)"} (${row.prospect_timezone_source ?? "unset"}) -> ${stored?.prospect_timezone ?? "(none)"} (${stored?.prospect_timezone_source ?? "unset"})`,
    );
    results.push({
      id: row.id,
      prospect_name: row.prospect_name,
      prospect_company: row.prospect_company,
      previous_timezone: row.prospect_timezone,
      previous_source: row.prospect_timezone_source,
      timezone: stored?.prospect_timezone ?? null,
      source: stored?.prospect_timezone_source ?? null,
      action: "reset",
    });
  }
  return results;
}

function runningAsScript(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (runningAsScript()) {
  const { gmail } = await workGmail();
  const results = await resetNiceSequenceTimezones({
    resolve: async (row) => {
      try {
        return await resolveProspectTimezone(gmail, row);
      } catch (error) {
        const errorType = error instanceof Error ? error.name : "UnknownError";
        console.log(
          `${row.prospect_name}: classifier failed (${errorType}); storing ${US_PACIFIC_ZONE} (default)`,
        );
        return { zone: US_PACIFIC_ZONE, source: "default" };
      }
    },
  });
  const pacific = results.filter((row) => row.timezone === US_PACIFIC_ZONE).length;
  console.log(
    results.length === 0
      ? "No active NiCE/Jeff/Dorothy sequences to reset."
      : `Resolved ${results.length}; ${pacific} stored as ${US_PACIFIC_ZONE}.`,
  );
}
