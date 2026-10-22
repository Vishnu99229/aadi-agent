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

export interface LinkableAccount {
  name: string;
  aliases: string[];
  email_domains: string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function hasWholeWord(haystack: string, word: string): boolean {
  const needle = word.trim().toLowerCase();
  if (needle.length < 3 || needle.includes("@")) {
    return false;
  }
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`,
    "iu",
  ).test(haystack);
}

export function sameInstant(left: string, right: string): boolean {
  const a = new Date(left).getTime();
  const b = new Date(right).getTime();
  return Number.isFinite(a) && a === b;
}

function emailsIn(text: string): string[] {
  return [
    ...text.toLowerCase().matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g),
  ].map((match) => match[0]!);
}

export function accountsForAttendees(
  attendees: MeetingAttendee[],
  accounts: LinkableAccount[],
): LinkableAccount[] {
  return accounts.filter((account) =>
    attendees.some((attendee) => {
      const domains = account.email_domains.map((domain) => domain.toLowerCase());
      if (attendee.domain && domains.includes(attendee.domain.toLowerCase())) {
        return true;
      }
      const label = `${attendee.name} ${attendee.company}`;
      if (hasWholeWord(label, account.name)) {
        return true;
      }
      return account.aliases.some((alias) => hasWholeWord(label, alias));
    }),
  );
}

export function textLinkedToMeeting(
  haystack: string,
  attendees: MeetingAttendee[],
  accounts: LinkableAccount[] = [],
): boolean {
  const emails = new Set(emailsIn(haystack));
  const matched = accountsForAttendees(attendees, accounts);
  for (const attendee of attendees) {
    const email = attendee.email.trim().toLowerCase();
    if (email && emails.has(email)) {
      return true;
    }
    if (hasWholeWord(haystack, attendee.name)) {
      return true;
    }
    const domain = attendee.domain.trim().toLowerCase();
    if (domain && !CONSUMER_DOMAINS.has(domain)) {
      for (const found of emails) {
        if (emailDomain(found) === domain) {
          return true;
        }
      }
    }
  }
  for (const account of matched) {
    if (hasWholeWord(haystack, account.name)) {
      return true;
    }
    if (account.aliases.some((alias) => hasWholeWord(haystack, alias))) {
      return true;
    }
    for (const domain of account.email_domains) {
      const normalized = domain.trim().toLowerCase();
      if (!normalized || CONSUMER_DOMAINS.has(normalized)) {
        continue;
      }
      for (const found of emails) {
        if (emailDomain(found) === normalized) {
          return true;
        }
      }
    }
  }
  return false;
}

export function matchesAttendees(
  haystack: string,
  attendees: MeetingAttendee[],
): boolean {
  return textLinkedToMeeting(haystack, attendees, []);
}

export interface LinkedFollowup {
  status: string;
  recipient: string;
  subject: string;
}

export interface LinkedTask {
  status: string;
  text: string;
}

export interface LinkedNote {
  title: string;
  people: string;
  content: string;
}

export function selectLinkedOpenItems(params: {
  attendees: MeetingAttendee[];
  accounts?: LinkableAccount[];
  followups: LinkedFollowup[];
  tasks: LinkedTask[];
  notes: LinkedNote[];
}): OpenItemLine[] {
  const accounts = params.accounts ?? [];
  const items: OpenItemLine[] = [];
  for (const followup of params.followups) {
    if (followup.status !== "waiting" && followup.status !== "snoozed") {
      continue;
    }
    if (
      !textLinkedToMeeting(
        `${followup.recipient} ${followup.subject}`,
        params.attendees,
        accounts,
      )
    ) {
      continue;
    }
    items.push({
      kind: "follow-up",
      text: `${followup.subject} (${followup.recipient})`,
    });
  }
  for (const task of params.tasks) {
    if (task.status !== "open") {
      continue;
    }
    if (!textLinkedToMeeting(task.text, params.attendees, accounts)) {
      continue;
    }
    items.push({ kind: "task", text: task.text });
  }
  const seen = new Set<string>();
  for (const note of params.notes) {
    const haystack = `${note.title} ${note.people} ${note.content}`;
    if (!textLinkedToMeeting(haystack, params.attendees, accounts)) {
      continue;
    }
    if (seen.has(note.title)) {
      continue;
    }
    seen.add(note.title);
    items.push({ kind: "note", text: note.title });
  }
  return items;
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
  return "";
}

export function formatThreadDate(raw: string): string {
  const value = raw.trim();
  if (!value) {
    return "";
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return value.replace(/\s*(?:GMT|[+-]\d{4})\b/g, "").replace(/\s+/g, " ").trim();
  }
  return formatKolkataTime(new Date(parsed).toISOString());
}

export function formatThreadLine(thread: EmailThreadLine): string {
  const when = thread.date ? formatThreadDate(thread.date) : "";
  return `• ${thread.subject || "(no subject)"}${when ? ` — ${when}` : ""}`;
}

export function buildMeetingBriefText(params: {
  title: string;
  startIso: string;
  attendees: MeetingAttendee[];
  minutesUntil?: number;
}): string {
  const title = params.title.trim() || "(Untitled event)";
  const attendeeLine = formatAttendeeLine(params.attendees) || "None";
  const header =
    typeof params.minutesUntil === "number" && params.minutesUntil > 0
      ? `In ${params.minutesUntil} minutes:`
      : undefined;
  const lines = [
    ...(header ? [header, ""] : []),
    title,
    formatKolkataTime(params.startIso),
    `Attendees: ${attendeeLine}`,
  ];
  return lines.join("\n");
}

export function meetingKey(eventId: string, startIso: string): string {
  const ms = new Date(startIso).getTime();
  return `${eventId}|${Number.isFinite(ms) ? ms : startIso}`;
}

export type BriefAction = "send" | "later" | "skip";

export function briefAction(
  event: CalendarEventLike,
  now: Date,
  minutes: number,
  selfEmail: string,
  skipInternalRecurring: boolean,
  alreadySent: boolean,
): BriefAction {
  if (skipReason(event, selfEmail, skipInternalRecurring)) {
    return "skip";
  }
  const start = eventStartMs(event);
  if (!event.id || start === null || start <= now.getTime()) {
    return "skip";
  }
  if (alreadySent) {
    return "skip";
  }
  const sendAt = start - minutes * 60 * 1000;
  return now.getTime() >= sendAt ? "send" : "later";
}

export function nextBriefInstant(
  events: CalendarEventLike[],
  now: Date,
  minutes: number,
  selfEmail: string,
  skipInternalRecurring: boolean,
  alreadySent: Set<string>,
): number | null {
  let best: number | null = null;
  for (const event of events) {
    const startIso = event.start?.dateTime;
    if (!event.id || !startIso) {
      continue;
    }
    const action = briefAction(
      event,
      now,
      minutes,
      selfEmail,
      skipInternalRecurring,
      alreadySent.has(meetingKey(event.id, startIso)),
    );
    if (action !== "later") {
      continue;
    }
    const start = eventStartMs(event);
    if (start === null) {
      continue;
    }
    const sendAt = start - minutes * 60 * 1000;
    if (best === null || sendAt < best) {
      best = sendAt;
    }
  }
  return best;
}

// Composite key per (event, start, threshold). Used so the per-threshold
// scheduler can dedupe within one run.
export function meetingBriefKey(
  eventId: string,
  startIso: string,
  minutes: number,
): string {
  return `${meetingKey(eventId, startIso)}|${minutes}`;
}

// Thresholds that are due to fire now (sendAt <= now) and haven't fired yet.
// Returned descending (largest minutes first), matching how we iterate.
export function dueThresholdsForEvent(
  event: CalendarEventLike,
  now: Date,
  thresholds: readonly number[],
  selfEmail: string,
  skipInternalRecurring: boolean,
  alreadyFired: readonly number[],
): number[] {
  if (skipReason(event, selfEmail, skipInternalRecurring)) {
    return [];
  }
  const start = eventStartMs(event);
  if (!event.id || start === null || start <= now.getTime()) {
    return [];
  }
  const fired = new Set(alreadyFired);
  const due: number[] = [];
  for (const minutes of thresholds) {
    if (fired.has(minutes)) {
      continue;
    }
    const sendAt = start - minutes * 60 * 1000;
    if (now.getTime() >= sendAt) {
      due.push(minutes);
    }
  }
  return due.sort((a, b) => b - a);
}

// Next fire instant across all events × thresholds that are still pending.
// `firedByKey` maps meetingKey(eventId, startIso) → thresholds already fired.
export function nextThresholdInstantAcross(
  events: CalendarEventLike[],
  now: Date,
  thresholds: readonly number[],
  selfEmail: string,
  skipInternalRecurring: boolean,
  firedByKey: Map<string, readonly number[]>,
): number | null {
  let best: number | null = null;
  for (const event of events) {
    const startIso = event.start?.dateTime;
    if (!event.id || !startIso) {
      continue;
    }
    if (skipReason(event, selfEmail, skipInternalRecurring)) {
      continue;
    }
    const start = eventStartMs(event);
    if (start === null || start <= now.getTime()) {
      continue;
    }
    const fired = new Set(firedByKey.get(meetingKey(event.id, startIso)) ?? []);
    for (const minutes of thresholds) {
      if (fired.has(minutes)) {
        continue;
      }
      const sendAt = start - minutes * 60 * 1000;
      if (sendAt <= now.getTime()) {
        continue;
      }
      if (best === null || sendAt < best) {
        best = sendAt;
      }
    }
  }
  return best;
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
    const startIso = event.start?.dateTime;
    return (
      briefAction(
        event,
        now,
        minutes,
        selfEmail,
        skipInternalRecurring,
        Boolean(
          event.id &&
            startIso &&
            alreadySent.has(meetingKey(event.id, startIso)),
        ),
      ) === "send"
    );
  });
}

export interface NudgeSnapshot {
  start_at: string;
  end_at: string;
  nudge_status: string;
  nudge_at: string | null;
}

export type NudgePlan =
  | { action: "skip"; reason: "cancelled" | "missing" }
  | {
      action: "reschedule";
      startAt: string;
      endAt: string;
      nudgeAt: string;
      needsRebrief: boolean;
    }
  | { action: "wait" }
  | { action: "send" };

export function planNudgeRefresh(
  row: NudgeSnapshot,
  event: CalendarEventLike | null,
  now: Date,
): NudgePlan {
  if (!event) {
    return { action: "skip", reason: "missing" };
  }
  if (event.status === "cancelled") {
    return { action: "skip", reason: "cancelled" };
  }
  const startRaw = event.start?.dateTime;
  const endRaw = event.end?.dateTime;
  if (!startRaw || !endRaw) {
    return { action: "skip", reason: "missing" };
  }
  const startAt = new Date(startRaw).toISOString();
  const endAt = new Date(endRaw).toISOString();
  const startMoved = !sameInstant(row.start_at, startAt);
  const endMoved = !sameInstant(row.end_at, endAt);
  if (startMoved || endMoved) {
    const remindMs =
      row.nudge_status === "remind_scheduled" && row.nudge_at
        ? new Date(row.nudge_at).getTime()
        : Number.NaN;
    const endMs = new Date(endAt).getTime();
    const nudgeAt =
      Number.isFinite(remindMs) && remindMs > endMs
        ? new Date(remindMs).toISOString()
        : endAt;
    return {
      action: "reschedule",
      startAt,
      endAt,
      nudgeAt,
      needsRebrief: startMoved,
    };
  }
  if (new Date(endAt).getTime() > now.getTime()) {
    return { action: "wait" };
  }
  if (row.nudge_status === "briefed") {
    return { action: "send" };
  }
  if (
    row.nudge_status === "remind_scheduled" &&
    row.nudge_at &&
    new Date(row.nudge_at).getTime() <= now.getTime()
  ) {
    return { action: "send" };
  }
  return { action: "wait" };
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
