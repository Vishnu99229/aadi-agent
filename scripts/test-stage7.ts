import "dotenv/config";

function ensureTestEnv(): void {
  process.env.LLM_PROVIDER ??= "claude";
  process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
  process.env.OWNER_TELEGRAM_ID ??= "1";
  process.env.CLAUDE_MODEL ??= "claude-haiku-4-5";
  process.env.ANTHROPIC_API_KEY ??= "test-key";
  process.env.BRIEF_TIME ??= "08:00";
  process.env.PRE_MEETING_MINUTES ??= "15";
  process.env.SKIP_INTERNAL_RECURRING ??= "true";
}

ensureTestEnv();

const {
  buildMeetingBriefText,
  briefsDueForFirstNudge,
  briefsDueForRemindNudge,
  callLabel,
  companyFromEmail,
  eventsDueForBrief,
  meetingKey,
  nextQualifyingEvent,
  nudgeQuestion,
  skipReason,
  suggestedGoal,
  toMeetingAttendees,
} = await import("../src/meeting_logic.ts");
const {
  consumePendingMeetingWrapUp,
  formatWrapUpPrefill,
  setPendingMeetingWrapUp,
} = await import("../src/meetings.ts");
const {
  getMeetingBriefByEvent,
  recordMeetingBrief,
  updateMeetingNudge,
} = await import("../src/db.ts");

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const SELF = "vishnu.rajan@epicode.in";
const NOW = new Date("2026-10-14T12:00:00+05:30");

function timedEvent(overrides: {
  id?: string;
  summary?: string;
  minutesFromNow?: number;
  durationMin?: number;
  attendees?: Array<{
    email?: string;
    displayName?: string;
    responseStatus?: string;
    self?: boolean;
  }>;
  allDay?: boolean;
  recurring?: boolean;
  declined?: boolean;
  status?: string;
}) {
  const start = new Date(
    NOW.getTime() + (overrides.minutesFromNow ?? 10) * 60 * 1000,
  );
  const end = new Date(
    start.getTime() + (overrides.durationMin ?? 30) * 60 * 1000,
  );
  const attendees = overrides.declined
    ? [
        {
          email: SELF,
          self: true,
          responseStatus: "declined",
        },
        {
          email: "priya@acme.com",
          displayName: "Priya Sharma",
          responseStatus: "accepted",
        },
      ]
    : (overrides.attendees ?? [
        { email: SELF, self: true, responseStatus: "accepted" },
        {
          email: "priya@acme.com",
          displayName: "Priya Sharma",
          responseStatus: "accepted",
        },
      ]);
  return {
    id: overrides.id ?? "evt-1",
    status: overrides.status ?? "confirmed",
    summary: overrides.summary ?? "Acme pricing call",
    start: overrides.allDay
      ? { date: "2026-10-14" }
      : { dateTime: start.toISOString() },
    end: overrides.allDay
      ? { date: "2026-10-15" }
      : { dateTime: end.toISOString() },
    attendees,
    recurrence: overrides.recurring ? ["RRULE:FREQ=WEEKLY"] : undefined,
  };
}

function testSkipRules(): void {
  assert(
    skipReason(timedEvent({ attendees: [{ email: SELF, self: true }] }), SELF, true) ===
      "no-other-attendees",
    "skip solo events",
  );
  assert(
    skipReason(timedEvent({ allDay: true }), SELF, true) === "all-day",
    "skip all-day",
  );
  assert(
    skipReason(timedEvent({ declined: true }), SELF, true) === "declined",
    "skip declined",
  );
  assert(
    skipReason(
      timedEvent({
        recurring: true,
        attendees: [
          { email: SELF, self: true },
          { email: "ops@epicode.in", displayName: "Ops" },
        ],
      }),
      SELF,
      true,
    ) === "internal-recurring",
    "skip internal recurring when enabled",
  );
  assert(
    skipReason(
      timedEvent({
        recurring: true,
        attendees: [
          { email: SELF, self: true },
          { email: "ops@epicode.in", displayName: "Ops" },
        ],
      }),
      SELF,
      false,
    ) === null,
    "do not skip internal recurring when disabled",
  );
  assert(
    skipReason(
      timedEvent({
        attendees: [
          { email: SELF, self: true },
          { email: "ops@epicode.in", displayName: "Ops" },
        ],
      }),
      SELF,
      true,
    ) === null,
    "do not skip one-off internal meetings",
  );
  assert(
    skipReason(
      timedEvent({
        recurring: true,
        attendees: [
          { email: SELF, self: true },
          { email: "ops@epicode.in" },
          { email: "priya@acme.com", displayName: "Priya" },
        ],
      }),
      SELF,
      true,
    ) === null,
    "do not skip recurring with an external attendee",
  );
  assert(
    skipReason(timedEvent({ status: "cancelled" }), SELF, true) === "cancelled",
    "skip cancelled",
  );
}

function testCompanyAndLabel(): void {
  assert(companyFromEmail("priya@acme.com") === "Acme", "acme domain");
  assert(companyFromEmail("sam@gmail.com") === "", "gmail has no company");
  const attendees = toMeetingAttendees(timedEvent({}), SELF);
  assert(attendees[0]?.company === "Acme", "attendee company");
  assert(
    callLabel("x", attendees) === "Priya Sharma (Acme)",
    "single attendee label",
  );
}

function testBriefAndGoal(): void {
  const attendees = toMeetingAttendees(timedEvent({}), SELF);
  const first = suggestedGoal({ threads: [], openItems: [] });
  assert(
    first.includes("first conversation"),
    "empty context is first conversation",
  );
  const fromThread = suggestedGoal({
    threads: [
      { from: "Priya", subject: "Pricing follow-up", date: "13 Oct" },
    ],
    openItems: [],
  });
  assert(
    fromThread.includes("Pricing follow-up"),
    "goal uses thread subject",
  );
  assert(!fromThread.toLowerCase().includes("invent"), "no invented wording");

  const text = buildMeetingBriefText({
    title: "Acme pricing call",
    startIso: new Date(NOW.getTime() + 10 * 60 * 1000).toISOString(),
    attendees,
    threads: [
      { from: "Priya", subject: "Pricing follow-up", date: "13 Oct 2026" },
    ],
    openItems: [
      { kind: "follow-up", text: "Pricing follow-up (priya@acme.com)" },
      { kind: "task", text: "Send Acme proposal" },
      { kind: "note", text: "Acme intro" },
    ],
  });
  assert(text.includes("Acme pricing call"), "title in brief");
  assert(text.includes("Priya Sharma (Acme)"), "attendee in brief");
  assert(text.includes("Pricing follow-up"), "thread in brief");
  assert(text.includes("follow-up:"), "open follow-up");
  assert(text.includes("Suggested goal for this call"), "goal line");
  assert(
    nudgeQuestion("Acme pricing call", attendees).includes("Priya Sharma (Acme)"),
    "nudge names the person",
  );
}

function testWindowAndDedupeSelection(): void {
  const due = timedEvent({ id: "due", minutesFromNow: 10 });
  const later = timedEvent({ id: "later", minutesFromNow: 40 });
  const selected = eventsDueForBrief(
    [due, later],
    NOW,
    15,
    SELF,
    true,
    new Set(),
  );
  assert(selected.length === 1 && selected[0]?.id === "due", "only 15-min window");
  const skipped = eventsDueForBrief(
    [due],
    NOW,
    15,
    SELF,
    true,
    new Set([meetingKey("due", due.start.dateTime!)]),
  );
  assert(skipped.length === 0, "already-sent event ids are skipped");
  const next = nextQualifyingEvent([later, due], NOW, SELF, true);
  assert(next?.id === "later" || next?.id === "due", "next qualifying exists");
}

function testNudgeTiming(): void {
  const ended = {
    id: 1,
    end_at: new Date(NOW.getTime() - 60 * 1000).toISOString(),
    nudge_status: "briefed",
    nudge_at: new Date(NOW.getTime() - 60 * 1000).toISOString(),
  };
  const waiting = {
    id: 2,
    end_at: new Date(NOW.getTime() + 10 * 60 * 1000).toISOString(),
    nudge_status: "briefed",
    nudge_at: new Date(NOW.getTime() + 10 * 60 * 1000).toISOString(),
  };
  assert(
    briefsDueForFirstNudge([ended, waiting], NOW).map((row) => row.id).join() ===
      "1",
    "nudge only after end",
  );
  const remindDue = {
    id: 3,
    end_at: ended.end_at,
    nudge_status: "remind_scheduled",
    nudge_at: new Date(NOW.getTime() - 1000).toISOString(),
  };
  const remindLater = {
    id: 4,
    end_at: ended.end_at,
    nudge_status: "remind_scheduled",
    nudge_at: new Date(NOW.getTime() + 30 * 60 * 1000).toISOString(),
  };
  const already = {
    id: 5,
    end_at: ended.end_at,
    nudge_status: "re_nudged",
    nudge_at: ended.end_at,
  };
  assert(
    briefsDueForRemindNudge([remindDue, remindLater, already], NOW).map(
      (row) => row.id,
    ).join() === "3",
    "remind fires once when due, not if already re_nudged",
  );
}

function testPersistOnceAndWrapUp(): void {
  const startAt = `2099-01-01T0${Date.now() % 8}:00:00.000Z`;
  const first = recordMeetingBrief({
    eventId: "stage7-test-event",
    startAt,
    endAt: "2099-01-01T10:00:00.000Z",
    title: "Stage 7 test",
    attendeesJson: JSON.stringify([
      { name: "Priya", email: "priya@acme.com", company: "Acme", domain: "acme.com" },
    ]),
    nudgeAt: "2099-01-01T10:00:00.000Z",
  });
  const second = recordMeetingBrief({
    eventId: "stage7-test-event",
    startAt,
    endAt: "2099-01-01T10:00:00.000Z",
    title: "Stage 7 test",
    attendeesJson: "[]",
    nudgeAt: "2099-01-01T10:00:00.000Z",
  });
  assert(first.id === second.id, "same event id stored once");
  assert(
    getMeetingBriefByEvent("stage7-test-event", startAt)?.id === first.id,
    "lookup by event id",
  );
  updateMeetingNudge(first.id, "nudged");
  setPendingMeetingWrapUp({
    briefId: first.id,
    title: "Stage 7 test",
    attendeeLine: "Priya",
  });
  const pending = consumePendingMeetingWrapUp();
  assert(pending?.briefId === first.id, "pending wrap-up stored");
  const prefilled = formatWrapUpPrefill(pending!, "Discussed pricing.");
  assert(prefilled.includes("Stage 7 test"), "wrap-up has title");
  assert(prefilled.includes("Priya"), "wrap-up has attendees");
  assert(prefilled.includes("Discussed pricing."), "wrap-up has user text");
  assert(
    consumePendingMeetingWrapUp() === undefined,
    "pending wrap-up consumed once",
  );
}

testSkipRules();
testCompanyAndLabel();
testBriefAndGoal();
testWindowAndDedupeSelection();
testNudgeTiming();
testPersistOnceAndWrapUp();
console.log("Stage 7 checks passed.");
