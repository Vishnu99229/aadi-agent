import assert from "node:assert/strict";
import {
  buildThreadTree,
  normaliseSubject,
  parseIdList,
  rootAndLatest,
} from "../src/email_threading.ts";
import {
  findNearDuplicate,
  shingle,
  signatureOf,
  similarity,
} from "../src/dedupe.ts";
import {
  evaluateDraft,
  resetEngineForTests,
} from "../src/rules_engine.ts";
import {
  findOptimalSlot,
  SchedulingTimeoutError,
  solveSync,
} from "../src/scheduling_csp.ts";

// ---- JWZ threading ----
assert.deepEqual(parseIdList("<a@x> <b@y>"), ["a@x", "b@y"]);
assert.deepEqual(parseIdList(""), []);
assert.equal(normaliseSubject("Re: Fwd: Fw: Hello"), "hello");
assert.equal(normaliseSubject("  weekly sync  "), "weekly sync");

// Three-message chain where the middle message has stripped headers.
// JWZ should still group them via subject.
const thread = buildThreadTree([
  {
    id: "g1",
    threadId: "t",
    internalDate: "1000",
    payload: {
      headers: [
        { name: "Message-ID", value: "<root@a>" },
        { name: "Subject", value: "Pricing discussion" },
      ],
    },
  },
  {
    id: "g2",
    threadId: "t",
    internalDate: "2000",
    payload: {
      headers: [
        { name: "Message-ID", value: "<reply1@b>" },
        // In-Reply-To / References intentionally missing (stripped).
        { name: "Subject", value: "Re: Pricing discussion" },
      ],
    },
  },
  {
    id: "g3",
    threadId: "t",
    internalDate: "3000",
    payload: {
      headers: [
        { name: "Message-ID", value: "<reply2@c>" },
        { name: "In-Reply-To", value: "<reply1@b>" },
        { name: "References", value: "<root@a> <reply1@b>" },
        { name: "Subject", value: "Re: Pricing discussion" },
      ],
    },
  },
]);
assert.equal(thread.roots.length, 1, "subject merge should produce one root");
const { root, latest } = rootAndLatest(
  thread.roots[0]
    ? [
        ...(function flatten(nodes: typeof thread.roots): typeof thread.roots {
          const out: typeof thread.roots = [];
          const walk = (n: (typeof thread.roots)[number]) => {
            out.push(n);
            for (const c of n.children) walk(c);
          };
          for (const n of nodes) walk(n);
          return out;
        })(thread.roots)
          .map((n) => n.message?.raw)
          .filter((r): r is NonNullable<typeof r> => Boolean(r)),
      ]
    : [],
);
assert.equal(root?.id, "g1", "earliest material is root");
assert.equal(latest?.id, "g3", "latest material is the leaf of the longest chain");

// ---- Dedupe ----
assert.deepEqual(shingle("one two three four"), ["one two three", "two three four"]);
assert.deepEqual(shingle("one"), ["one"]);
const a = signatureOf("send the pricing deck tomorrow afternoon please");
const b = signatureOf("send the pricing deck tomorrow afternoon please");
const c = signatureOf("completely unrelated text about weather forecasts");
assert.ok(similarity(a, b) >= 0.95, "identical text must score >= 0.95");
assert.ok(similarity(a, c) < 0.3, "unrelated text must score low");

const match = findNearDuplicate(
  "acme power inr 1249 2026-11-25 your monthly electricity bill is ready",
  [
    {
      text: "acme power inr 1249 2026-11-25 your monthly electricity bill is ready",
      record: { id: 7 },
    },
    { text: "unrelated newsletter sign up today", record: { id: 8 } },
  ],
  0.95,
);
assert.ok(match && match.record.id === 7, "near-dup should match the twin");

// ---- Rules engine ----
resetEngineForTests();
// Facts for a brand-new domain: must require manual approval.
const newDomainOutcome = await evaluateDraft({
  is_known_client: false,
  has_attachment: false,
  domain_seen_count: 0,
});
assert.equal(newDomainOutcome?.kind, "require_manual_approval");
assert.equal(newDomainOutcome?.rule, "block-auto-send-to-new-domains");

// Known client, no attachment, seen >= 2 -> auto send approved.
const autoOutcome = await evaluateDraft({
  is_known_client: true,
  has_attachment: false,
  domain_seen_count: 10,
});
assert.equal(autoOutcome?.kind, "auto_send_approved");
assert.equal(autoOutcome?.rule, "auto-approve-known-client-text-replies");
assert.equal((autoOutcome as { cancelWindowMinutes: number }).cancelWindowMinutes, 5);

// Known client WITH attachment: no rule fires -> null (safe default = manual).
const withAttachment = await evaluateDraft({
  is_known_client: true,
  has_attachment: true,
  domain_seen_count: 10,
});
assert.equal(withAttachment, null, "attachment must disqualify auto-send");

// Known client but domain only seen once -> block-rule wins over auto.
const borderline = await evaluateDraft({
  is_known_client: true,
  has_attachment: false,
  domain_seen_count: 1,
});
assert.equal(
  borderline?.kind,
  "require_manual_approval",
  "manual approval ALWAYS beats auto when both fire",
);

// ---- Scheduling CSP ----
// Monday 2026-10-26 window 09:00-18:00 IST (03:30-12:30 UTC).
const rangeStart = "2026-10-26T03:30:00Z";
const rangeEnd = "2026-10-26T12:30:00Z";
const slotA = solveSync({
  rangeStartIso: rangeStart,
  rangeEndIso: rangeEnd,
  busyByParticipant: [],
  durationMinutes: 30,
  constraints: {
    minTime: "09:00",
    maxTime: "18:00",
    avoidLunch: true,
    weekdaysOnly: true,
  },
});
assert.ok(slotA, "free window must return a slot");
assert.equal(slotA!.startIso, "2026-10-26T03:30:00.000Z");

// Lunch block: a 1pm start must be refused when avoidLunch=true.
const lunchStart = "2026-10-26T07:30:00Z"; // 13:00 IST
const slotLunch = solveSync({
  rangeStartIso: lunchStart,
  rangeEndIso: "2026-10-26T08:30:00Z",
  busyByParticipant: [],
  durationMinutes: 30,
  constraints: {
    minTime: "09:00",
    maxTime: "18:00",
    avoidLunch: true,
    weekdaysOnly: true,
  },
});
assert.equal(slotLunch, null, "slot inside lunch must be rejected");

// Two attendees with overlapping busy intervals: find a clear slot.
const slotB = solveSync({
  rangeStartIso: rangeStart,
  rangeEndIso: rangeEnd,
  busyByParticipant: [
    [
      { startIso: "2026-10-26T03:30:00Z", endIso: "2026-10-26T05:00:00Z" },
    ],
    [
      { startIso: "2026-10-26T05:00:00Z", endIso: "2026-10-26T06:30:00Z" },
    ],
  ],
  durationMinutes: 30,
  constraints: {
    minTime: "09:00",
    maxTime: "18:00",
    avoidLunch: true,
    weekdaysOnly: true,
  },
});
assert.ok(slotB, "backtracker must find a clear slot");
const slotStart = Date.parse(slotB!.startIso);
assert.ok(
  slotStart >= Date.parse("2026-10-26T06:30:00Z"),
  "slot must land after both attendees are free",
);

// 3-second timeout: a trivial problem must beat the deadline.
const timed = await findOptimalSlot({
  rangeStartIso: rangeStart,
  rangeEndIso: rangeEnd,
  busyByParticipant: [],
  durationMinutes: 30,
  constraints: {
    minTime: "09:00",
    maxTime: "18:00",
    avoidLunch: true,
    weekdaysOnly: true,
  },
});
assert.ok(timed, "wrapped solver must still return a slot");

// Timeout wiring: the SchedulingTimeoutError class is shaped correctly
// and carries the user-facing message. (The actual Promise.race deadline
// is non-deterministic on fast machines - we don't assert timing here.)
const err = new SchedulingTimeoutError();
assert.equal(err.name, "SchedulingTimeoutError");
assert.match(err.message, /optimal slot|manual time/i);

console.log("Autonomy stack checks passed.");
