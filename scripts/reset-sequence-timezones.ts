/**
 * Clear stale sequence timezone caches and resolve them again.
 *
 * sales_sequences.prospect_timezone is the cached IANA zone.
 * sales_sequences.prospect_timezone_source records how it was chosen
 * (email, signature, thread, company, owner, default).
 * sales_sequences.prospect_company is the company name. There is no column
 * for company location or market, and no needsTimezoneRefresh flag. A
 * pre-fix company guess (NiCE HQ) was stored in prospect_timezone, which
 * stops the runner from calling the new resolver.
 *
 * Jeff Comstock and Dorothy Copeland were enrolled that way, with
 * Asia/Jerusalem cached. This script clears that cache and asks
 * chooseProspectZone again. A global company with no person-level place
 * is US Pacific (America/Los_Angeles).
 *
 *   DOTENV_CONFIG_PATH=.env AADI_DB_PATH=/path/to/aadi.db tsx scripts/reset-sequence-timezones.ts
 *   DOTENV_CONFIG_PATH=.env AADI_DB_PATH=/path/to/aadi.db tsx scripts/reset-sequence-timezones.ts --dry-run
 *
 * Prints names, addresses, and zones only. Never prints email bodies.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  clearSalesSequenceTimezone,
  getSalesSequence,
  listActiveSalesSequences,
  setSalesSequenceTimezone,
  type SalesSequenceRecord,
} from "../src/db.js";
import {
  chooseProspectZone,
  isUsZone,
  needsTimezoneRefresh,
  validZone,
  type TimezoneSource,
} from "../src/sequence_timezone.js";

const PERSON_LEVEL = new Set(["email", "signature", "thread"]);

export function isStaleTimezoneTarget(
  row: Pick<SalesSequenceRecord, "prospect_email" | "prospect_name">,
): boolean {
  const email = row.prospect_email.trim().toLowerCase();
  const local = email.split("@")[0] ?? "";
  const name = row.prospect_name.trim().toLowerCase().replace(/\s+/g, " ");
  return (
    local.includes("jeff") ||
    local.includes("dorothy") ||
    name.includes("jeff comstock") ||
    name.includes("dorothy copeland")
  );
}

/** Cached company HQ for these people. A zone taken from their own mail, or
 *  an owner correction, stays. Asia/Jerusalem with no person-level source is
 *  the pre-fix NiCE HQ cache. */
export function hasStaleTimezoneCache(
  row: Pick<SalesSequenceRecord, "prospect_timezone" | "prospect_timezone_source">,
): boolean {
  const source = row.prospect_timezone_source;
  if (source === "owner" || PERSON_LEVEL.has(source ?? "")) {
    return false;
  }
  const zone = row.prospect_timezone;
  if (!zone) {
    return false;
  }
  if (zone === "Asia/Jerusalem") {
    return true;
  }
  return needsTimezoneRefresh(zone, source);
}

/** Company HQ outside the US is not the person's zone. market "global"
 *  (NiCE) resolves to America/Los_Angeles inside chooseProspectZone. */
export function reresolveStaleTimezone(cachedZone: string | null): {
  zone: string;
  source: TimezoneSource;
} {
  const hq = validZone(cachedZone);
  const locationZone = hq && !isUsZone(hq) ? hq : "Asia/Jerusalem";
  return chooseProspectZone(undefined, {
    zone: locationZone,
    basis: "company",
    market: "global",
  });
}

export interface TimezoneReset {
  id: number;
  prospect_email: string;
  prospect_name: string;
  prospect_company: string;
  previous_timezone: string | null;
  previous_source: string | null;
  timezone: string | null;
  source: string | null;
  action: "reset" | "unchanged";
}

export function resetStaleSequenceTimezones(options?: {
  dryRun?: boolean;
  log?: (line: string) => void;
}): TimezoneReset[] {
  const dryRun = options?.dryRun === true;
  const log = options?.log ?? console.log;
  const results: TimezoneReset[] = [];
  if (dryRun) {
    log("DRY-RUN (no DB writes)");
  }

  for (const row of listActiveSalesSequences()) {
    if (!isStaleTimezoneTarget(row)) {
      continue;
    }
    if (!hasStaleTimezoneCache(row)) {
      log(
        `Sequence ${row.id}: ${row.prospect_name} <${row.prospect_email}> left at ${row.prospect_timezone ?? "unset"} (${row.prospect_timezone_source ?? "none"})`,
      );
      results.push({
        id: row.id,
        prospect_email: row.prospect_email,
        prospect_name: row.prospect_name,
        prospect_company: row.prospect_company,
        previous_timezone: row.prospect_timezone,
        previous_source: row.prospect_timezone_source,
        timezone: row.prospect_timezone,
        source: row.prospect_timezone_source,
        action: "unchanged",
      });
      continue;
    }

    const previous = row.prospect_timezone;
    const previousSource = row.prospect_timezone_source;
    if (!dryRun) {
      clearSalesSequenceTimezone(row.id);
    }
    const resolved = reresolveStaleTimezone(previous);
    if (!dryRun) {
      setSalesSequenceTimezone(row.id, resolved.zone, resolved.source);
    }
    const stored = dryRun ? resolved.zone : getSalesSequence(row.id)?.prospect_timezone ?? null;
    log(
      `Sequence ${row.id}: ${row.prospect_name} <${row.prospect_email}> company=${row.prospect_company || "-"} cleared ${previous} (${previousSource ?? "none"}) -> ${stored} (${resolved.source})`,
    );
    results.push({
      id: row.id,
      prospect_email: row.prospect_email,
      prospect_name: row.prospect_name,
      prospect_company: row.prospect_company,
      previous_timezone: previous,
      previous_source: previousSource,
      timezone: stored,
      source: resolved.source,
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
  const results = resetStaleSequenceTimezones({
    dryRun: process.argv.includes("--dry-run"),
  });
  const reset = results.filter((row) => row.action === "reset");
  console.log(
    reset.length === 0
      ? "No active Jeff/Dorothy sequences had a stale timezone cache."
      : `Resolved ${reset.length} sequence${reset.length === 1 ? "" : "s"}.`,
  );
}
