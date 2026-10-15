const CONSUMER_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "icloud.com",
  "me.com",
  "proton.me",
  "protonmail.com",
]);

const TIME_ZONE = "Asia/Kolkata";

export interface CalendarAttendeeLike {
  email?: string | null;
  displayName?: string | null;
  responseStatus?: string | null;
  self?: boolean | null;
  resource?: boolean | null;
}

export interface CalendarEventLike {
  id?: string | null;
  status?: string | null;
  summary?: string | null;
  start?: { dateTime?: string | null; date?: string | null } | null;
  end?: { dateTime?: string | null; date?: string | null } | null;
  attendees?: CalendarAttendeeLike[] | null;
  recurrence?: string[] | null;
  recurringEventId?: string | null;
}

export interface MeetingAttendee {
  name: string;
  email: string;
  company: string;
  domain: string;
}

export interface EmailThreadLine {
  from: string;
  subject: string;
  date: string;
}

export interface OpenItemLine {
  kind: "follow-up" | "task" | "note";
  text: string;
}

export function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).toLowerCase() : "";
}

export function companyFromEmail(email: string): string {
  const domain = emailDomain(email);
  if (!domain || CONSUMER_DOMAINS.has(domain)) {
    return "";
  }
  const head = domain.split(".")[0] ?? "";
  if (!head) {
    return "";
  }
  return head.charAt(0).toUpperCase() + head.slice(1);
}

export function attendeeName(attendee: CalendarAttendeeLike): string {
  const named = attendee.displayName?.trim();
  if (named) {
    return named;
  }
  const email = attendee.email?.trim() ?? "";
  const local = email.split("@")[0] ?? "";
  return local || email || "Guest";
}

export function eventStartMs(event: CalendarEventLike): number | null {
  const value = event.start?.dateTime;
  if (!value) {
    return null;
  }
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function eventEndMs(event: CalendarEventLike): number | null {
  const value = event.end?.dateTime;
  if (!value) {
    return null;
  }
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function isAllDay(event: CalendarEventLike): boolean {
  return Boolean(event.start?.date && !event.start?.dateTime);
}

export function isRecurring(event: CalendarEventLike): boolean {
  return Boolean(
    (event.recurrence && event.recurrence.length > 0) || event.recurringEventId,
  );
}

function normalizeEmail(email: string | null | undefined): string {
  return email?.trim().toLowerCase() ?? "";
}

export function otherAttendees(
  event: CalendarEventLike,
  selfEmail: string,
): CalendarAttendeeLike[] {
  const self = normalizeEmail(selfEmail);
  return (event.attendees ?? []).filter((attendee) => {
    if (attendee.resource) {
      return false;
    }
    if (attendee.self) {
      return false;
    }
    const email = normalizeEmail(attendee.email);
    if (email && self && email === self) {
      return false;
    }
    return Boolean(email || attendee.displayName);
  });
}

export function isDeclined(
  event: CalendarEventLike,
  selfEmail: string,
): boolean {
  const self = normalizeEmail(selfEmail);
  return (event.attendees ?? []).some((attendee) => {
    const mine =
      Boolean(attendee.self) ||
      (self !== "" && normalizeEmail(attendee.email) === self);
    return mine && attendee.responseStatus === "declined";
  });
}

export function isInternalOnly(
  event: CalendarEventLike,
  selfEmail: string,
): boolean {
  const emails = [
    ...otherAttendees(event, selfEmail).map((item) =>
      normalizeEmail(item.email),
    ),
    normalizeEmail(selfEmail),
  ].filter(Boolean);
  if (emails.length === 0) {
    return false;
  }
  return emails.every((email) => email.endsWith("@epicode.in"));
}

export function skipReason(
  event: CalendarEventLike,
  selfEmail: string,
  skipInternalRecurring: boolean,
): string | null {
  if (event.status === "cancelled") {
    return "cancelled";
  }
  if (isAllDay(event)) {
    return "all-day";
  }
  if (!event.start?.dateTime) {
    return "all-day";
  }
  if (isDeclined(event, selfEmail)) {
    return "declined";
  }
  if (otherAttendees(event, selfEmail).length === 0) {
    return "no-other-attendees";
  }
  if (skipInternalRecurring && isRecurring(event) && isInternalOnly(event, selfEmail)) {
    return "internal-recurring";
  }
  return null;
}

export function startsWithinMinutes(
  event: CalendarEventLike,
  now: Date,
  minutes: number,
): boolean {
  const start = eventStartMs(event);
  if (start === null) {
    return false;
  }
  const delta = start - now.getTime();
  return delta >= 0 && delta <= minutes * 60 * 1000;
}

export function toMeetingAttendees(
  event: CalendarEventLike,
  selfEmail: string,
): MeetingAttendee[] {
  return otherAttendees(event, selfEmail).map((attendee) => {
    const email = attendee.email?.trim() ?? "";
    return {
      name: attendeeName(attendee),
      email,
      company: email ? companyFromEmail(email) : "",
      domain: email ? emailDomain(email) : "",
    };
  });
}

export function formatKolkataTime(iso: string): string {
  const date = new Date(iso);
  return new Intl.DateTimeFormat("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: TIME_ZONE,
  }).format(date);
}

export function formatAttendeeLine(attendees: MeetingAttendee[]): string {
  return attendees
    .map((attendee) =>
      attendee.company
        ? `${attendee.name} (${attendee.company})`
        : attendee.name,
    )
    .join(", ");
}

export function callLabel(
  title: string,
  attendees: MeetingAttendee[],
): string {
  if (attendees.length === 0) {
    return title || "the meeting";
  }
  if (attendees.length === 1) {
    const attendee = attendees[0]!;
    return attendee.company
      ? `${attendee.name} (${attendee.company})`
      : attendee.name;
  }
  const companies = [
    ...new Set(attendees.map((item) => item.company).filter(Boolean)),
  ];
  if (companies.length === 1) {
    return companies[0]!;
  }
  return `${attendees[0]!.name} and ${attendees.length - 1} others`;
}

export function matchesAttendees(
  haystack: string,
  attendees: MeetingAttendee[],
): boolean {
  const lower = haystack.toLowerCase();
  return attendees.some((attendee) => {
    const needles = [
      attendee.name,
      attendee.email,
      attendee.company,
      attendee.email.split("@")[0] ?? "",
    ]
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length >= 3);
    return needles.some((needle) => lower.includes(needle));
  });
}

export function suggestedGoal(params: {
  threads: EmailThreadLine[];
  openItems: OpenItemLine[];
}): string {
  const followup = params.openItems.find((item) => item.kind === "follow-up");
  if (followup) {
    return `Suggested goal for this call: follow up on ${followup.text}.`;
  }
  const task = params.openItems.find((item) => item.kind === "task");
  if (task) {
    return `Suggested goal for this call: ${task.text}.`;
  }
  const note = params.openItems.find((item) => item.kind === "note");
  if (note) {
    return `Suggested goal for this call: pick up from ${note.text}.`;
  }
  const thread = params.threads[0];
  if (thread?.subject) {
    return `Suggested goal for this call: continue ${thread.subject}.`;
  }
  return "Suggested goal for this call: this looks like a first conversation.";
}

export function formatThreadLine(thread: EmailThreadLine): string {
  const when = thread.date ? ` — ${thread.date}` : "";
  return `• ${thread.subject || "(no subject)"}${when}`;
}

export function buildMeetingBriefText(params: {
  title: string;
  startIso: string;
  attendees: MeetingAttendee[];
  threads: EmailThreadLine[];
  openItems: OpenItemLine[];
  memories?: string[];
}): string {
  const title = params.title.trim() || "(Untitled event)";
  const attendeeLine = formatAttendeeLine(params.attendees) || "None";
  const threads =
    params.threads.length > 0
      ? params.threads.slice(0, 3).map(formatThreadLine).join("\n")
      : "• None";
  const open =
    params.openItems.length > 0
      ? params.openItems
          .slice(0, 6)
          .map((item) => `• ${item.kind}: ${item.text}`)
          .join("\n")
      : "• None";

  const remembered =
    params.memories && params.memories.length > 0
      ? params.memories.slice(0, 5).map((item) => `• ${item}`).join("\n")
      : "";

  return [
    title,
    formatKolkataTime(params.startIso),
    `Attendees: ${attendeeLine}`,
    "",
    "Recent threads:",
    threads,
    "",
    "Open:",
    open,
    ...(remembered ? ["", "Remembered:", remembered] : []),
    "",
    suggestedGoal({
      threads: params.threads,
      openItems: params.openItems,
    }),
  ].join("\n");
}

export function meetingKey(eventId: string, startIso: string): string {
  return `${eventId}|${startIso}`;
}

export function nudgeQuestion(
  title: string,
  attendees: MeetingAttendee[],
): string {
  return `How did the call with ${callLabel(title, attendees)} go?`;
}

export function eventsDueForBrief(
  events: CalendarEventLike[],
  now: Date,
  minutes: number,
  selfEmail: string,
  skipInternalRecurring: boolean,
  alreadySent: Set<string>,
): CalendarEventLike[] {
  return events.filter((event) => {
    if (skipReason(event, selfEmail, skipInternalRecurring)) {
      return false;
    }
    if (!startsWithinMinutes(event, now, minutes)) {
      return false;
    }
    const startIso = event.start?.dateTime;
    if (!event.id || !startIso) {
      return false;
    }
    return !alreadySent.has(meetingKey(event.id, startIso));
  });
}

export function nextQualifyingEvent(
  events: CalendarEventLike[],
  now: Date,
  selfEmail: string,
  skipInternalRecurring: boolean,
): CalendarEventLike | undefined {
  return events.find((event) => {
    const start = eventStartMs(event);
    return (
      start !== null &&
      start >= now.getTime() &&
      skipReason(event, selfEmail, skipInternalRecurring) === null
    );
  });
}

export interface NudgeRow {
  id: number;
  end_at: string;
  nudge_status: string;
  nudge_at: string | null;
}

export function briefsDueForFirstNudge<T extends NudgeRow>(
  rows: T[],
  now: Date,
): T[] {
  return rows.filter(
    (row) => row.nudge_status === "briefed" && new Date(row.end_at) <= now,
  );
}

export function briefsDueForRemindNudge<T extends NudgeRow>(
  rows: T[],
  now: Date,
): T[] {
  return rows.filter(
    (row) =>
      row.nudge_status === "remind_scheduled" &&
      Boolean(row.nudge_at) &&
      new Date(row.nudge_at!) <= now,
  );
}
