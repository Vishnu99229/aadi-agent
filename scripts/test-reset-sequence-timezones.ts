/**
 * NiCE / Jeff / Dorothy timezone caches null and resolve to US Pacific.
 * Other companies and owner corrections stay. Runs only in :memory:.
 */
import "dotenv/config";
import {
  activateSalesSequence,
  createProposedSalesSequence,
  db,
  getSalesSequence,
  setSalesSequenceTimezone,
  stopActiveSalesSequence,
} from "../src/db.ts";
import { US_PACIFIC_ZONE } from "../src/sequence_timezone.ts";
import {
  classifyNiceTimezone,
  listNiceTimezoneResetTargets,
  nullNiceTimezoneCaches,
  resetNiceSequenceTimezones,
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
    assert(
      activateSalesSequence(row.id, {
        nextStepAt: new Date().toISOString(),
        enrolledAt: new Date().toISOString(),
        manualFollowups: 0,
      }),
      "Start enrols the sequence",
    );
  }
  if (input.timezone) {
    setSalesSequenceTimezone(row.id, input.timezone, input.source ?? "company");
  }
  return row.id;
}

assert(db.name === ":memory:" || process.env.AADI_DB_PATH === ":memory:", "the script uses the db.ts connection");
assert(classifyNiceTimezone().zone === US_PACIFIC_ZONE, "the NiCE classifier result is US Pacific");

const dorothy = enrol({
  email: "dorothy.copeland@nice.com",
  name: "Dorothy Copeland",
  timezone: "Asia/Jerusalem",
  source: "company",
});
const jeff = enrol({
  email: "jeff.comstock@nice.com",
  name: "Jeff Comstock",
  company: "Nice",
  timezone: "Asia/Kolkata",
  source: "default",
});
const byName = enrol({
  email: "d.copeland@nice.com",
  name: "Dorothy Copeland",
  timezone: "Asia/Jerusalem",
  source: "company_non_us",
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
const stopped = enrol({
  email: "dorothy.stopped@nice.com",
  name: "Dorothy Stopped",
  timezone: "Asia/Jerusalem",
  source: "company",
});
assert(stopActiveSalesSequence(stopped, "manual"), "a stopped row is no longer active");

const targets = listNiceTimezoneResetTargets();
assert(
  targets.some((row) => row.id === jeff) && targets.some((row) => row.id === dorothy),
  "Jeff and Dorothy are selected",
);
assert(
  !targets.some((row) => row.id === munil) && !targets.some((row) => row.id === ownerJeff),
  "Talkdesk and owner corrections are not selected",
);

const nulled = nullNiceTimezoneCaches();
assert(nulled >= 3, `the UPDATE nulls NiCE caches, got ${nulled}`);
assert(getSalesSequence(jeff)!.prospect_timezone === null, "Jeff's IST default is cleared");
assert(getSalesSequence(dorothy)!.prospect_timezone === null, "Dorothy's Jerusalem cache is cleared");
assert(getSalesSequence(munil)!.prospect_timezone === "Asia/Jerusalem", "Talkdesk is not in the UPDATE");
assert(getSalesSequence(ownerJeff)!.prospect_timezone === "America/Chicago", "an owner correction is not in the UPDATE");
assert(getSalesSequence(stopped)!.prospect_timezone === "Asia/Jerusalem", "a stopped sequence is not rewritten");

setSalesSequenceTimezone(jeff, "Asia/Kolkata", "default");
setSalesSequenceTimezone(dorothy, "Asia/Jerusalem", "company");
setSalesSequenceTimezone(byName, "Asia/Jerusalem", "company_non_us");

const lines: string[] = [];
const applied = await resetNiceSequenceTimezones({
  resolve: classifyNiceTimezone,
  log: (line) => lines.push(line),
});

for (const id of [dorothy, jeff, byName]) {
  const row = getSalesSequence(id)!;
  assert(row.prospect_timezone === US_PACIFIC_ZONE, `${row.prospect_name} is America/Los_Angeles, got ${row.prospect_timezone}`);
}
assert(
  applied.filter((row) => row.action === "reset").every((row) => row.timezone === US_PACIFIC_ZONE),
  "every reset row stores Pacific",
);
assert(lines.some((line) => line.includes("Jeff Comstock") && line.includes("America/Los_Angeles")), "Jeff's line names the new zone");
assert(lines.some((line) => line.includes("Dorothy Copeland") && line.includes("America/Los_Angeles")), "Dorothy's line names the new zone");
assert(getSalesSequence(munil)!.prospect_timezone === "Asia/Jerusalem", "Munil stays");
assert(getSalesSequence(ownerJeff)!.prospect_timezone === "America/Chicago", "owner stays");
assert(!lines.some((line) => line.includes("Would you be open") || line.includes("Partnership")), "logs do not include message text");

console.log("reset-sequence-timezones: ok");
