/**
 * Startup migration clears cached Asia/Jerusalem for NiCE sequences so the
 * runner calls chooseProspectZone on the next tick. A global company with no
 * person-level place is US Pacific. Other companies and other zones stay.
 * Runs only against the in-memory database.
 */
import "dotenv/config";
import {
  activateSalesSequence,
  clearStaleNiceJerusalemTimezones,
  createProposedSalesSequence,
  deleteSetting,
  getSalesSequence,
  getSetting,
  migrateStaleNiceJerusalemTimezones,
  setSalesSequenceTimezone,
  STALE_NICE_JERUSALEM_TZ_KEY,
  stopActiveSalesSequence,
} from "../src/db.ts";
import { chooseProspectZone } from "../src/sequence_timezone.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

if (process.env.AADI_DB_PATH !== ":memory:") {
  throw new Error("test-stale-timezone-migration.ts must run with AADI_DB_PATH=:memory:");
}

assert(
  getSetting(STALE_NICE_JERUSALEM_TZ_KEY) === "1",
  "opening the database runs the one-shot migration",
);

{
  const direct = chooseProspectZone(undefined, {
    zone: "Asia/Jerusalem",
    basis: "company",
    market: "global",
  });
  assert(direct.zone === "America/Los_Angeles", "an empty cache for a global company is US Pacific");
  assert(direct.source === "company", "and the source stays company");
}

let thread = 0;

function enrol(input: {
  email: string;
  name: string;
  company?: string;
  timezone?: string | null;
  source?: string;
  status?: "active" | "proposed" | "stopped";
}): number {
  thread += 1;
  const domain = input.email.split("@")[1] ?? "example.com";
  const row = createProposedSalesSequence({
    threadId: `tz-migrate-${thread}`,
    prospectEmail: input.email,
    prospectDomain: domain,
    prospectKey: input.email.trim().toLowerCase(),
    prospectName: input.name,
    prospectCompany: input.company ?? "NiCE",
    subject: "Partnership",
    originalMessageId: `tz-migrate-msg-${thread}`,
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
  if (input.status === "stopped") {
    assert(stopActiveSalesSequence(row.id, "manual"), "a stopped row is no longer active");
  }
  if (input.timezone) {
    setSalesSequenceTimezone(row.id, input.timezone, input.source ?? "company");
  }
  return row.id;
}

const dorothy = enrol({
  email: "dorothy.copeland@nice.com",
  name: "Dorothy Copeland",
  company: "NiCE",
  timezone: "Asia/Jerusalem",
  source: "company",
});
const jeff = enrol({
  email: "jeff.comstock@nice.com",
  name: "Jeff Comstock",
  company: "Nice",
  timezone: "Asia/Jerusalem",
  source: "company_non_us",
});
const niceSystems = enrol({
  email: "a.patel@nice.com",
  name: "A Patel",
  company: "NICE Systems",
  timezone: "Asia/Jerusalem",
  source: "company",
  status: "proposed",
});
const stopped = enrol({
  email: "dorothy.stopped@nice.com",
  name: "Dorothy Stopped",
  company: "NiCE",
  timezone: "Asia/Jerusalem",
  source: "company",
  status: "stopped",
});
const pacific = enrol({
  email: "already.pacific@nice.com",
  name: "Already Pacific",
  company: "NiCE",
  timezone: "America/Los_Angeles",
  source: "company",
});
const owner = enrol({
  email: "owner.jerusalem@nice.com",
  name: "Owner Jerusalem",
  company: "NiCE",
  timezone: "Asia/Jerusalem",
  source: "owner",
});
const signature = enrol({
  email: "sig.jerusalem@nice.com",
  name: "Signature Jerusalem",
  company: "NiCE",
  timezone: "Asia/Jerusalem",
  source: "signature",
});
const munil = enrol({
  email: "munil@talkdesk.com",
  name: "Munil",
  company: "Talkdesk",
  timezone: "Asia/Jerusalem",
  source: "company",
});
const otherZone = enrol({
  email: "someone@nice.com",
  name: "Someone Else",
  company: "NiCE",
  timezone: "America/New_York",
  source: "email",
});

const cleared = clearStaleNiceJerusalemTimezones();
assert(cleared === 5, `clears NiCE Asia/Jerusalem caches except an owner correction, got ${cleared}`);

function expectCleared(id: number): void {
  const row = getSalesSequence(id)!;
  assert(row.prospect_timezone === null, `${row.prospect_email} timezone is cleared, got ${row.prospect_timezone}`);
  assert(row.prospect_timezone_source === null, `${row.prospect_email} source is cleared`);
}

expectCleared(dorothy);
expectCleared(jeff);
expectCleared(niceSystems);
expectCleared(stopped);
expectCleared(signature);
assert(getSalesSequence(owner)!.prospect_timezone === "Asia/Jerusalem", "an owner correction stays");
assert(getSalesSequence(owner)!.prospect_timezone_source === "owner", "owner source stays");

assert(getSalesSequence(pacific)!.prospect_timezone === "America/Los_Angeles", "US Pacific stays");
assert(getSalesSequence(pacific)!.prospect_timezone_source === "company", "Pacific source stays");
assert(getSalesSequence(munil)!.prospect_timezone === "Asia/Jerusalem", "another company keeps Jerusalem");
assert(getSalesSequence(munil)!.prospect_timezone_source === "company", "another company's source stays");
assert(getSalesSequence(otherZone)!.prospect_timezone === "America/New_York", "a NiCE contact on another zone stays");
assert(getSalesSequence(otherZone)!.prospect_timezone_source === "email", "their email source stays");

const again = clearStaleNiceJerusalemTimezones();
assert(again === 0, "a second run changes nothing");
expectCleared(dorothy);
assert(getSalesSequence(munil)!.prospect_timezone === "Asia/Jerusalem", "the second run still leaves Talkdesk");

setSalesSequenceTimezone(dorothy, "Asia/Jerusalem", "company");
assert(
  migrateStaleNiceJerusalemTimezones() === 0,
  "the one-shot flag skips the update after startup",
);
assert(
  getSalesSequence(dorothy)!.prospect_timezone === "Asia/Jerusalem",
  "a zone written after the migration is left in place",
);

deleteSetting(STALE_NICE_JERUSALEM_TZ_KEY);
const rerun = migrateStaleNiceJerusalemTimezones();
assert(rerun === 1, `running the migration again after the flag is removed clears the new cache, got ${rerun}`);
expectCleared(dorothy);
assert(getSetting(STALE_NICE_JERUSALEM_TZ_KEY) === "1", "the migration records that it ran");
assert(getSalesSequence(munil)!.prospect_timezone === "Asia/Jerusalem", "the guarded run still leaves other companies");

setSalesSequenceTimezone(jeff, "Asia/Jerusalem", "owner");
assert(migrateStaleNiceJerusalemTimezones() === 0, "a second guarded run does not clear again");
assert(
  getSalesSequence(jeff)!.prospect_timezone === "Asia/Jerusalem",
  "an owner correction after the one-shot migration stays",
);
assert(getSalesSequence(jeff)!.prospect_timezone_source === "owner", "owner source stays");

console.log("stale-timezone-migration: ok");
