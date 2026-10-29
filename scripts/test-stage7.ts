import { readFile } from "node:fs/promises";
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
  process.env.AADI_DB_PATH ??= ":memory:";
}

ensureTestEnv();

const {
  briefAction,
  buildMeetingBriefText,
  briefsDueForFirstNudge,
  briefsDueForRemindNudge,
  callLabel,
  companyFromEmail,
  dueThresholdsForEvent,
  eventsDueForBrief,
  formatThreadDate,
  meetingKey,
  nextBriefInstant,
  nextThresholdInstantAcross,
  nextQualifyingEvent,
  nudgeQuestion,
  planNudgeRefresh,
  selectLinkedOpenItems,
  skipReason,
  suggestedGoal,
  textLinkedToMeeting,
  toMeetingAttendees,
} = await import("../src/meeting_logic.ts");
const { shouldForceCalendarTool } = await import("../src/calendar_guard.ts");
const {
  addOwnerCalendarAttendee,
  resetOwnerCalendarTestHooks,
  setOwnerCalendarTestHooks,
} = await import("../src/owner_calendar.ts");
const { calendarAccountIds, istInclusiveRange } = await import(
  "../src/tools/list_events.ts"
);
const { quotedMessageText, withQuotedContext } = await import(
  "../src/reply_context.ts"
);
const { storeOutboundText } = await import("../src/outbound.ts");
const { clearMessages, getRecentMessages } = await import("../src/db.ts");
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
  assert(first === "", "no suggested goal when nothing relevant is linked");
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
  });
  assert(text.includes("Acme pricing call"), "title in brief");
  assert(text.includes("Priya Sharma (Acme)"), "attendee in brief");
  // Clutter must be gone.
  assert(!text.includes("Recent threads"), "no Recent threads section");
  assert(!text.includes("Open:"), "no Open section");
  assert(!text.includes("Remembered"), "no Remembered section");
  assert(!text.includes("Suggested goal"), "no Suggested goal line");

  const withCountdown = buildMeetingBriefText({
    title: "Acme pricing call",
    startIso: new Date(NOW.getTime() + 10 * 60 * 1000).toISOString(),
    attendees,
    minutesUntil: 10,
  });
  assert(
    withCountdown.startsWith("In 10 minutes:"),
    "countdown header on reminder",
  );

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

function vatsalAttendees() {
  return toMeetingAttendees(
    timedEvent({
      attendees: [
        { email: SELF, self: true, responseStatus: "accepted" },
        {
          email: "vatsal@rumik.ai",
          displayName: "Vatsal",
          responseStatus: "accepted",
        },
        {
          email: "art@rumik.ai",
          displayName: "Art",
          responseStatus: "accepted",
        },
      ],
    }),
    SELF,
  );
}

function testRescheduleAndCancel(): void {
  const stored = {
    start_at: new Date("2026-10-19T15:15:00+05:30").toISOString(),
    end_at: new Date("2026-10-19T15:30:00+05:30").toISOString(),
    nudge_status: "briefed",
    nudge_at: new Date("2026-10-19T15:30:00+05:30").toISOString(),
  };
  const now = new Date("2026-10-19T15:31:00+05:30");
  const moved = {
    id: "vatsal-evt",
    status: "confirmed",
    start: { dateTime: "2026-10-19T16:00:00+05:30" },
    end: { dateTime: "2026-10-19T16:15:00+05:30" },
  };
  const plan = planNudgeRefresh(stored, moved, now);
  assert(plan.action === "reschedule", "moved event reschedules the nudge");
  if (plan.action === "reschedule") {
    assert(
      new Date(plan.endAt).getTime() > now.getTime(),
      "rescheduled end is the new end",
    );
    assert(plan.needsRebrief, "a new start needs another brief");
    const again = planNudgeRefresh(
      {
        start_at: plan.startAt,
        end_at: plan.endAt,
        nudge_status: "briefed",
        nudge_at: plan.nudgeAt,
      },
      moved,
      now,
    );
    assert(again.action === "wait", "no nudge before the current end");
  }
  const cancelled = planNudgeRefresh(
    stored,
    { ...moved, status: "cancelled" },
    now,
  );
  assert(
    cancelled.action === "skip" && cancelled.reason === "cancelled",
    "cancelled event does not nudge",
  );
  const onTime = planNudgeRefresh(
    stored,
    {
      status: "confirmed",
      start: { dateTime: stored.start_at },
      end: { dateTime: stored.end_at },
    },
    now,
  );
  assert(onTime.action === "send", "unchanged event nudges after its end");
}

function testMultiThresholdReminders(): void {
  const event = {
    id: "multi-evt",
    status: "confirmed",
    summary: "Multi",
    start: { dateTime: "2026-10-19T16:00:00+05:30" },
    end: { dateTime: "2026-10-19T16:30:00+05:30" },
    attendees: [
      { email: SELF, self: true },
      { email: "guest@example.com", displayName: "Guest" },
    ],
  };
  const thresholds = [15, 10, 5] as const;
  const before = new Date("2026-10-19T15:30:00+05:30");
  const atFifteen = new Date("2026-10-19T15:45:00+05:30");
  const atTen = new Date("2026-10-19T15:50:00+05:30");
  const atFive = new Date("2026-10-19T15:55:00+05:30");

  assert(
    dueThresholdsForEvent(event, before, thresholds, SELF, true, []).length === 0,
    "no thresholds due 30 min before",
  );

  // At the 15-min mark: 15 is due, 10 and 5 are not.
  const dueAt15 = dueThresholdsForEvent(event, atFifteen, thresholds, SELF, true, []);
  assert(JSON.stringify(dueAt15) === JSON.stringify([15]), "only 15 due at 15");

  // At the 10-min mark with 15 already fired: only 10 is due.
  const dueAt10 = dueThresholdsForEvent(event, atTen, thresholds, SELF, true, [15]);
  assert(JSON.stringify(dueAt10) === JSON.stringify([10]), "only 10 due after 15 fired");

  // At the 5-min mark, if scanner missed the 10-min slot (e.g. phone off):
  // both 10 and 5 fire now, descending.
  const dueAt5Missed10 = dueThresholdsForEvent(event, atFive, thresholds, SELF, true, [15]);
  assert(
    JSON.stringify(dueAt5Missed10) === JSON.stringify([10, 5]),
    "catches up on missed thresholds, largest first",
  );

  // Already fired at a threshold: never re-fires.
  const dueAfterAll = dueThresholdsForEvent(event, atFive, thresholds, SELF, true, [15, 10, 5]);
  assert(dueAfterAll.length === 0, "no re-fire once all fired");

  // Cancelled meeting: nothing fires.
  const cancelled = dueThresholdsForEvent(
    { ...event, status: "cancelled" },
    atFifteen,
    thresholds,
    SELF,
    true,
    [],
  );
  assert(cancelled.length === 0, "cancelled event skipped");

  // nextThresholdInstantAcross picks the earliest remaining threshold.
  const firedByKey = new Map<string, number[]>();
  const nextMs = nextThresholdInstantAcross(
    [event],
    before,
    thresholds,
    SELF,
    true,
    firedByKey,
  );
  assert(
    nextMs === new Date("2026-10-19T15:45:00+05:30").getTime(),
    "next instant is the 15-min mark when nothing fired",
  );

  firedByKey.set(meetingKey(event.id, event.start.dateTime!), [15]);
  const nextAfter15 = nextThresholdInstantAcross(
    [event],
    atFifteen,
    thresholds,
    SELF,
    true,
    firedByKey,
  );
  assert(
    nextAfter15 === new Date("2026-10-19T15:50:00+05:30").getTime(),
    "next instant moves to the 10-min mark after 15 fired",
  );
}

function testBriefRetimed(): void {
  const event = {
    id: "vatsal-evt",
    status: "confirmed",
    summary: "Vatsal",
    start: { dateTime: "2026-10-19T16:00:00+05:30" },
    end: { dateTime: "2026-10-19T16:15:00+05:30" },
    attendees: [
      { email: SELF, self: true },
      { email: "vatsal@rumik.ai", displayName: "Vatsal" },
    ],
  };
  const early = new Date("2026-10-19T15:20:00+05:30");
  const shortNotice = new Date("2026-10-19T15:50:00+05:30");
  const ideal = new Date("2026-10-19T15:45:00+05:30");
  assert(
    briefAction(event, early, 15, SELF, true, false) === "later",
    "brief waits until 15 minutes before",
  );
  assert(
    nextBriefInstant([event], early, 15, SELF, true, new Set()) ===
      ideal.getTime(),
    "brief is armed for the 15-minute mark",
  );
  assert(
    briefAction(event, ideal, 15, SELF, true, false) === "send",
    "brief sends at the 15-minute mark",
  );
  assert(
    briefAction(event, shortNotice, 15, SELF, true, false) === "send",
    "moved meeting inside the window sends immediately",
  );
  assert(
    briefAction({ ...event, status: "cancelled" }, shortNotice, 15, SELF, true, false) ===
      "skip",
    "cancelled meeting does not get a brief",
  );
}

function testBriefFiltering(): void {
  const attendees = vatsalAttendees();
  const accounts = [
    {
      name: "Rumik",
      aliases: ["Rumik AI"],
      email_domains: ["rumik.ai"],
    },
  ];
  const eleven = "ElevenLabs follow-up karthik@elevenlabs.io";
  assert(
    !textLinkedToMeeting(eleven, attendees, accounts),
    "elevenlabs follow-up is not linked to a Rumik meeting",
  );
  const items = selectLinkedOpenItems({
    attendees,
    accounts,
    followups: [
      {
        status: "waiting",
        recipient: "karthik@elevenlabs.io",
        subject: "ElevenLabs follow-up",
      },
      {
        status: "waiting",
        recipient: "alex@rumik.ai",
        subject: "Rumik pricing",
      },
    ],
    tasks: [
      { status: "open", text: "Email Karthik at ElevenLabs" },
      { status: "open", text: "Send Vatsal the deck" },
    ],
    notes: [
      {
        title: "ElevenLabs intro",
        people: "Karthik",
        content: "Follow up with ElevenLabs",
      },
      { title: "Rumik sync", people: "Vatsal", content: "Pricing" },
    ],
  });
  const rendered = items.map((item) => item.text).join("\n");
  assert(!rendered.toLowerCase().includes("elevenlabs"), "unrelated follow-up excluded");
  assert(!rendered.toLowerCase().includes("karthik"), "unrelated name excluded");
  assert(rendered.includes("Rumik pricing"), "same-domain follow-up kept");
  assert(rendered.includes("Send Vatsal the deck"), "attendee name kept as a whole word");
  assert(rendered.includes("Rumik sync"), "matched account note kept");
  const goal = suggestedGoal({ threads: [], openItems: items });
  assert(goal.includes("Rumik pricing"), "goal uses the linked follow-up");
  assert(!goal.toLowerCase().includes("elevenlabs"), "goal skips the unrelated follow-up");
  const dated = formatThreadDate("Mon, 19 Oct 2026 09:43:00 +0000");
  assert(!dated.includes("+0000"), "thread dates are not raw +0000");
  assert(dated.includes("19"), "thread date keeps the IST day");
  assert(/3:13|15:13/.test(dated), "09:43 UTC is 15:13 IST");
  const brief = buildMeetingBriefText({
    title: "Vatsal",
    startIso: "2026-10-19T16:00:00+05:30",
    attendees,
  });
  assert(!brief.includes("Suggested goal"), "empty brief has no suggested goal");
}

function testHistoryQuoteAndCalendar(): void {
  clearMessages();
  storeOutboundText("How did the call with Vatsal go?");
  const saved = getRecentMessages(5);
  assert(
    saved.some(
      (message) =>
        message.role === "assistant" &&
        message.content === "How did the call with Vatsal go?",
    ),
    "proactive nudge is stored as an assistant turn",
  );
  storeOutboundText("How did the call with Vatsal go?");
  assert(
    getRecentMessages(5).length === saved.length,
    "the same outbound text is not stored twice in a row",
  );
  const quoted = quotedMessageText({
    text: "How did the call with Vatsal go?",
  });
  const modelText = withQuotedContext("It went well", quoted);
  assert(
    modelText.includes("How did the call with Vatsal go?"),
    "reply quotes Aadi's message",
  );
  assert(modelText.includes("It went well"), "reply keeps Vishnu's text");
  assert(
    calendarAccountIds(undefined).join(",") === "personal,work",
    "omitted account reads both calendars",
  );
  const range = istInclusiveRange("2026-10-19", "2026-10-19");
  assert(
    range.timeMin === "2026-10-18T18:30:00.000Z",
    "today starts at Asia/Kolkata midnight",
  );
  assert(
    range.timeMax === "2026-10-19T18:30:00.000Z",
    "today ends at the next Asia/Kolkata midnight",
  );
  assert(
    shouldForceCalendarTool("any meetings with Vatsal today?", []),
    "calendar questions require list_events",
  );
  assert(
    !shouldForceCalendarTool("any meetings with Vatsal today?", ["list_events"]),
    "list_events satisfies the calendar guard",
  );
  assert(
    !shouldForceCalendarTool("remember to buy milk", []),
    "unrelated chat does not force the calendar",
  );
  assert(
    !shouldForceCalendarTool("create a meeting with Nitish tomorrow at 4pm", []),
    "create-meeting requests do not force list_events",
  );
  assert(
    !shouldForceCalendarTool("share the meeting link here", ["create_meeting"]),
    "create_meeting satisfies the calendar guard",
  );
  assert(
    shouldForceCalendarTool("what's on my calendar", []),
    "explicit calendar questions still force list_events",
  );
  assert(
    shouldForceCalendarTool("when is my next meeting", []),
    "next-meeting questions still force list_events",
  );
  assert(
    !shouldForceCalendarTool(
      "Call notes: the meeting with Sujal went well, we stretched the 3pm Catch up",
      [],
    ),
    "wrap-up notes do not force list_events",
  );
  assert(
    !shouldForceCalendarTool("wrap up the Aspirare call, they want a follow-up meeting", []),
    "wrap up prefix does not force list_events",
  );
  assert(
    !shouldForceCalendarTool("The meeting with Sujal went well", []),
    "mentioning a meeting in recap does not force list_events",
  );
  assert(
    !shouldForceCalendarTool("add ashwini@epicode.in to the Catch up meeting", []),
    "add-attendee requests do not force list_events",
  );
}

async function testAddCalendarAttendee(): Promise<void> {
  resetOwnerCalendarTestHooks();
  const confirmation = { chatId: 1, messageId: 10 };
  const catchup = {
    accountId: "work" as const,
    eventId: "evt-1",
    title: "Catch up",
    start: "2026-10-27T15:00:00+05:30",
    attendeeCount: 1,
  };

  {
    const reply = await addOwnerCalendarAttendee({
      eventTitle: "Catch up",
      attendeeEmail: "ashwini@epicode.in",
      confirmation: undefined,
    });
    assert(
      reply.startsWith("Not added: only Vishnu's own chat"),
      "refused without confirmation",
    );
  }

  {
    const patches: Array<{
      attendees: Array<{ email?: string | null }>;
      sendUpdates: string;
    }> = [];
    setOwnerCalendarTestHooks({
      list: async () => [catchup],
      getAttendees: async () => [{ email: "vishnu@epicode.in" }],
      patch: async (query) => {
        patches.push({
          attendees: query.attendees,
          sendUpdates: query.sendUpdates,
        });
      },
    });
    const reply = await addOwnerCalendarAttendee({
      eventTitle: "Catch up",
      date: "2026-10-27",
      attendeeEmail: "ashwini@epicode.in",
      confirmation,
    });
    assert(patches.length === 1, "one match patches the event");
    assert(patches[0]!.sendUpdates === "all", "patch sends updates to all attendees");
    assert(
      patches[0]!.attendees.some((person) => person.email === "ashwini@epicode.in"),
      "patch includes the new attendee",
    );
    assert(
      patches[0]!.attendees.some((person) => person.email === "vishnu@epicode.in"),
      "patch keeps existing attendees",
    );
    assert(
      reply === "Added ashwini@epicode.in to Catch up.",
      `got ${reply}`,
    );
  }

  {
    const patches: unknown[] = [];
    setOwnerCalendarTestHooks({
      list: async () => [
        catchup,
        { ...catchup, eventId: "evt-2", start: "2026-10-28T10:00:00+05:30" },
      ],
      patch: async () => {
        patches.push("patched");
      },
    });
    const reply = await addOwnerCalendarAttendee({
      eventTitle: "Catch up",
      attendeeEmail: "ashwini@epicode.in",
      confirmation,
    });
    assert(reply.startsWith("Not added: several matches"), "several matches ask");
    assert(patches.length === 0, "several matches patches nothing");
  }

  const ownerSrc = await readFile(
    new URL("../src/owner_calendar.ts", import.meta.url),
    "utf8",
  );
  assert(
    ownerSrc.includes('sendUpdates: "all"') && ownerSrc.includes("events.patch"),
    "add_calendar_attendee patches with sendUpdates=all",
  );
  resetOwnerCalendarTestHooks();
}

testSkipRules();
testCompanyAndLabel();
testBriefAndGoal();
testWindowAndDedupeSelection();
testNudgeTiming();
testPersistOnceAndWrapUp();
testRescheduleAndCancel();
testBriefRetimed();
testMultiThresholdReminders();
testBriefFiltering();
testHistoryQuoteAndCalendar();
await testAddCalendarAttendee();
console.log("Stage 7 checks passed.");
