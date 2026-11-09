/**
 * Stale Asia/Jerusalem caches for Jeff Comstock and Dorothy Copeland clear
 * and resolve to America/Los_Angeles. Other sequences are left alone.
 * Runs only against the in-memory database.
 */
import "dotenv/config";
import {
  activateSalesSequence,
  clearSalesSequenceTimezone,
  createProposedSalesSequence,
  getSalesSequence,
  setSalesSequenceTimezone,
  stopActiveSalesSequence,
} from "../src/db.ts";
import { chooseProspectZone } from "../src/sequence_timezone.ts";
import {
  hasStaleTimezoneCache,
  isStaleTimezoneTarget,
  reresolveStaleTimezone,
  resetStaleSequenceTimezones,
} from "./reset-sequence-timezones.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

if (process.env.AADI_DB_PATH !== ":memory:") {
  throw new Error("test-reset-sequence-timezones.ts must run with AADI_DB_PATH=:memory:");
}

let thread = 0;

function enrol(input: {
  email: string;
  name: string;
  company?: string;
  timezone?: string | null;
  source?: string;
  status?: "active" | "proposed";
}): number {
  thread += 1;
  const domain = input.email.split("@")[1] ?? "example.com";
  const row = createProposedSalesSequence({
    threadId: `tz-reset-${thread}`,
    prospectEmail: input.email,
    prospectDomain: domain,
    prospectKey: input.email.trim().toLowerCase(),
    prospectName: input.name,
    prospectCompany: input.company ?? "NiCE",
    subject: "Partnership",
    originalMessageId: `tz-reset-msg-${thread}`,
    originalSentAt: new Date().toISOString(),
    manualFollowups: 0,
    classifierConfidence: 0.9,
    classifierReason: "pitch",
  });
  if (!row) {
    throw new Error(`could not enrol ${input.email}`);
  }
  if (input.status !== "proposed") {
    const started = activateSalesSequence(row.id, {
      nextStepAt: new Date().toISOString(),
      enrolledAt: new Date().toISOString(),
      manualFollowups: 0,
    });
    assert(started, "Start enrols the sequence");
  }
  if (input.timezone) {
    setSalesSequenceTimezone(row.id, input.timezone, input.source ?? "company");
  }
  return row.id;
}

{
  const direct = chooseProspectZone(undefined, {
    zone: "Asia/Jerusalem",
    basis: "company",
    market: "global",
  });
  assert(direct.zone === "America/Los_Angeles", "a global company is US Pacific");
  assert(direct.source === "company", "and the source stays company");
  const again = reresolveStaleTimezone("Asia/Jerusalem");
  assert(
    again.zone === "America/Los_Angeles" && again.source === "company",
    `reresolve uses chooseProspectZone, got ${again.zone} (${again.source})`,
  );
  assert(isStaleTimezoneTarget({ prospect_email: "jeff.comstock@nice.com", prospect_name: "Jeff Comstock" }), "Jeff's address matches");
  assert(isStaleTimezoneTarget({ prospect_email: "dorothy.copeland@nice.com", prospect_name: "Dorothy Copeland" }), "Dorothy's address matches");
  assert(isStaleTimezoneTarget({ prospect_email: "d.copeland@nice.com", prospect_name: "Dorothy Copeland" }), "Dorothy's name matches when the address does not");
  assert(!isStaleTimezoneTarget({ prospect_email: "munil@talkdesk.com", prospect_name: "Munil" }), "someone else does not match");
  assert(
    hasStaleTimezoneCache({ prospect_timezone: "Asia/Jerusalem", prospect_timezone_source: "company" }),
    "Jerusalem cached from company HQ is stale",
  );
  assert(
    !hasStaleTimezoneCache({ prospect_timezone: "America/Chicago", prospect_timezone_source: "owner" }),
    "an owner correction is not stale",
  );
  assert(
    !hasStaleTimezoneCache({ prospect_timezone: "America/New_York", prospect_timezone_source: "email" }),
    "a US zone from their own mail is not stale",
  );
  assert(
    !hasStaleTimezoneCache({ prospect_timezone: "Asia/Jerusalem", prospect_timezone_source: "signature" }),
    "a place in their signature is not a stale HQ cache",
  );
}

const dorothy = enrol({
  email: "dorothy.copeland@nice.com",
  name: "Dorothy Copeland",
  timezone: "Asia/Jerusalem",
  source: "company",
});
const jeff = enrol({
  email: "jeff.comstock@nice.com",
  name: "Jeff Comstock",
  timezone: "Asia/Jerusalem",
  source: "company",
});
const byName = enrol({
  email: "d.copeland@nice.com",
  name: "Dorothy Copeland",
  timezone: "Asia/Jerusalem",
  source: "company",
});
const londonCompany = enrol({
  email: "jeff.other@nice.com",
  name: "Jeff Other",
  timezone: "Europe/London",
  source: "company",
});
const munil = enrol({
  email: "munil@talkdesk.com",
  name: "Munil",
  company: "Talkdesk",
  timezone: "Asia/Jerusalem",
  source: "company",
});
const ownerJeff = enrol({
  email: "jeff.owner@nice.com",
  name: "Jeff Owner",
  timezone: "America/Chicago",
  source: "owner",
});
const headerJeff = enrol({
  email: "jeff.header@nice.com",
  name: "Jeff Header",
  timezone: "America/New_York",
  source: "email",
});
const signatureDorothy = enrol({
  email: "dorothy.signature@nice.com",
  name: "Dorothy Signature",
  timezone: "Asia/Jerusalem",
  source: "signature",
});
const stopped = enrol({
  email: "dorothy.stopped@nice.com",
  name: "Dorothy Stopped",
  timezone: "Asia/Jerusalem",
  source: "company",
});
assert(stopActiveSalesSequence(stopped, "manual"), "a stopped row is no longer active");

{
  const cleared = enrol({
    email: "jeff.clear@nice.com",
    name: "Jeff Clear",
    timezone: "Asia/Jerusalem",
    source: "company",
  });
  clearSalesSequenceTimezone(cleared);
  const row = getSalesSequence(cleared)!;
  assert(row.prospect_timezone === null, "clear sets the cached zone to NULL");
  assert(row.prospect_timezone_source === null, "and clears the source");
}

const lines: string[] = [];
const preview = resetStaleSequenceTimezones({
  dryRun: true,
  log: (line) => lines.push(line),
});
assert(lines[0] === "DRY-RUN (no DB writes)", "dry-run says it writes nothing");
assert(getSalesSequence(dorothy)!.prospect_timezone === "Asia/Jerusalem", "dry-run leaves Dorothy cached");
assert(getSalesSequence(jeff)!.prospect_timezone === "Asia/Jerusalem", "dry-run leaves Jeff cached");
assert(preview.filter((row) => row.action === "reset").every((row) => row.timezone === "America/Los_Angeles"), "dry-run still reports Pacific");

lines.length = 0;
const applied = resetStaleSequenceTimezones({ log: (line) => lines.push(line) });
const byId = new Map(applied.map((row) => [row.id, row]));

for (const id of [dorothy, jeff, byName, londonCompany]) {
  const row = getSalesSequence(id)!;
  assert(row.prospect_timezone === "America/Los_Angeles", `${row.prospect_email} is America/Los_Angeles, got ${row.prospect_timezone}`);
  assert(row.prospect_timezone_source === "company", `${row.prospect_email} source is company`);
  assert(byId.get(id)?.action === "reset", `${row.prospect_email} was reset`);
}
assert(lines.some((line) => line.includes("America/Los_Angeles")), `the console shows the new zone: ${lines.join(" | ")}`);
assert(lines.some((line) => line.includes("Dorothy Copeland") && line.includes("America/Los_Angeles")), "Dorothy's line names the new zone");
assert(lines.some((line) => line.includes("Jeff Comstock") && line.includes("America/Los_Angeles")), "Jeff's line names the new zone");

assert(getSalesSequence(munil)!.prospect_timezone === "Asia/Jerusalem", "a different prospect keeps the old cache");
assert(getSalesSequence(ownerJeff)!.prospect_timezone === "America/Chicago", "an owner correction stays");
assert(getSalesSequence(ownerJeff)!.prospect_timezone_source === "owner", "owner source stays");
assert(getSalesSequence(headerJeff)!.prospect_timezone === "America/New_York", "a US header zone stays");
assert(getSalesSequence(signatureDorothy)!.prospect_timezone === "Asia/Jerusalem", "a signature place stays");
assert(getSalesSequence(signatureDorothy)!.prospect_timezone_source === "signature", "signature source stays");
assert(getSalesSequence(stopped)!.prospect_timezone === "Asia/Jerusalem", "a stopped sequence is not rewritten");
assert(byId.get(ownerJeff)?.action === "unchanged", "the owner row is reported unchanged");
assert(!lines.some((line) => line.includes("Would you be open") || line.includes("Partnership")), "logs do not include message text");

lines.length = 0;
const second = resetStaleSequenceTimezones({ log: (line) => lines.push(line) });
assert(second.every((row) => row.action === "unchanged"), "a second run does not rewrite Pacific");
assert(getSalesSequence(dorothy)!.prospect_timezone === "America/Los_Angeles", "Dorothy stays on Pacific");

console.log("reset-sequence-timezones: ok");
