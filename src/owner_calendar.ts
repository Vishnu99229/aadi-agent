import { google, type calendar_v3 } from "googleapis";
import { focusBookedMeeting, getPendingAction, matchOwnerSupplied } from "./action_context.js";
import { nameTokens } from "./command_logic.js";
import { namesFuzzyEqual } from "./contact_logic.js";
import { listCalendarEventRefs, type CalendarEventRefRecord } from "./db.js";
import { getGoogleAccount, loadGoogleAccounts, type GoogleAccountId } from "./google/auth.js";
import { istInclusiveRange } from "./tools/list_events.js";
import {
  allowOwnerChatAddAttendee,
  allowOwnerChatDeleteEvent,
  allowOwnerChatMoveEvent,
} from "./security/send_approval.js";
import { assertTestSeam } from "./test_seam.js";

const TIME_ZONE = "Asia/Kolkata";

export interface OwnerCalendarEvent {
  accountId: GoogleAccountId;
  eventId: string;
  title: string;
  start: string;
  /** Empty when the list didn't give one. */
  end?: string;
  attendeeCount: number;
}

interface OwnerCalendarHooks {
  list?: (query: {
    title: string;
    date?: string;
    accountId?: GoogleAccountId;
  }) => Promise<OwnerCalendarEvent[]>;
  delete?: (event: OwnerCalendarEvent) => Promise<void>;
  move?: (event: OwnerCalendarEvent, startIso: string, endIso: string) => Promise<void>;
  getAttendees?: (
    event: OwnerCalendarEvent,
  ) => Promise<Array<{ email?: string | null; displayName?: string | null }> | null | undefined>;
  eventCreated?: string | null;
  sleep?: (ms: number) => Promise<void>;
  patch?: (query: {
    event: OwnerCalendarEvent;
    attendees: Array<{ email?: string | null }>;
    sendUpdates: string;
  }) => Promise<{ attendees?: Array<{ email?: string | null }> | null } | void>;
}

let testHooks: OwnerCalendarHooks = {};

export function setOwnerCalendarTestHooks(hooks: OwnerCalendarHooks): void {
  assertTestSeam("setOwnerCalendarTestHooks");
  testHooks = hooks;
}

export function resetOwnerCalendarTestHooks(): void {
  testHooks = {};
}

const NOT_A_PERSON = /@(?:resource\.)?calendar\.google\.com$|noreply|calendar-notification/i;

function reuseRequest(
  phrase: string,
  now: Date,
): { title: string; date?: string; accountId?: GoogleAccountId; span?: { pastDays: number; futureDays: number } } | undefined {
  if (!/\b(?:same people|everyone from)\b/i.test(phrase)) {
    return undefined;
  }
  const accountId = /\bpersonal calendar\b/i.test(phrase)
    ? "personal"
    : /\bwork calendar\b/i.test(phrase)
      ? "work"
      : undefined;
  const date = /\byesterday\b/i.test(phrase) ? addIstDays(istYmd(now), -1) : undefined;
  const span = !date && /\blast week\b/i.test(phrase) ? { pastDays: 14, futureDays: 0 } : undefined;
  const titled =
    /(?:from|at)\s+(?:the\s+|yesterday(?:'s)?\s+|last week(?:'s)?\s+)?([^?.]+)/i.exec(phrase) ??
    /yesterday(?:'s)?\s+([^?.]+)/i.exec(phrase);
  const title = (titled?.[1] ?? "")
    .replace(/\bon the\b.*$/i, "")
    .replace(/\b(meeting|discussion|people)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return title ? { title, date, accountId, span } : undefined;
}

type AttendeeEdit =
  | { op: "remove"; name: string }
  | { op: "add"; name: string }
  | { op: "replace"; from: string; to: string };

type SendUpdatesMode = "all" | "externalOnly" | "none";

interface MeetingRef {
  eventId: string;
  accountId: GoogleAccountId;
  title: string;
  startIso: string;
  attendees: Array<{ name: string; email: string }>;
  focused: boolean;
}

const CAL_STOP = new Set([
  "meeting", "that", "this", "the", "from", "with", "last", "week", "tomorrow",
  "yesterday", "today", "remove", "drop", "add", "replace", "people", "same",
  "calendar", "onto", "into", "about", "remember", "find", "which",
]);
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function parseAttendeeEdit(text: string): AttendeeEdit | undefined {
  const replace = /^(?:replace)\s+(.+?)\s+with\s+(.+?)(?:\s+(?:on|in|from)\s+(.+))?\.?$/i.exec(text.trim());
  if (replace) {
    return { op: "replace", from: replace[1]!.trim(), to: replace[2]!.trim() };
  }
  const remove = /^(?:remove|drop)\s+(.+?)(?:\s+from\s+(.+))?\.?$/i.exec(text.trim());
  if (remove) {
    return { op: "remove", name: remove[1]!.trim() };
  }
  const add = /^(?:add)\s+(.+?)(?:\s+to\s+(.+))?\.?$/i.exec(text.trim());
  if (add) {
    return { op: "add", name: add[1]!.trim() };
  }
  return undefined;
}

/** Bare "add/remove NAME" is a meeting edit only while a meeting is in play. */
function isMeetingAttendeeEdit(text: string, edit: AttendeeEdit, chatId: number, now: Date): boolean {
  if (/\b(?:task|reminder|bill|memory|shopping)\b/i.test(text)) {
    return false;
  }
  if (/\b(?:meeting|calendar|attendee|invite|invitation)\b/i.test(text)) {
    return true;
  }
  const name = (edit.op === "replace" ? edit.from : edit.name).trim();
  if (/^(?:a|an|the|my|our)\b/i.test(name) || name.split(/\s+/).length > 3) {
    return false;
  }
  const pending = getPendingAction(chatId, now);
  if (pending?.status === "open" && pending.meeting) {
    return true;
  }
  return refsFromStore(chatId).length > 0;
}

function referencePhrase(text: string, edit: AttendeeEdit | undefined): string {
  if (!edit) {
    return text;
  }
  if (edit.op === "replace") {
    return text.replace(edit.from, " ").replace(edit.to, " ");
  }
  return text.replace(edit.name, " ");
}

function istWeekday(now: Date): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, weekday: "long" }).format(now).toLowerCase();
  return WEEKDAYS.indexOf(name);
}

function mentionedDay(text: string, now: Date): string | "last-week" | undefined {
  if (/\blast week\b/i.test(text)) {
    return "last-week";
  }
  if (/\btomorrow\b/i.test(text)) {
    return addIstDays(istYmd(now), 1);
  }
  if (/\byesterday\b/i.test(text)) {
    return addIstDays(istYmd(now), -1);
  }
  if (/\btoday\b/i.test(text)) {
    return istYmd(now);
  }
  const named = /\blast\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.exec(text);
  if (!named) {
    return undefined;
  }
  const target = WEEKDAYS.indexOf(named[1]!.toLowerCase());
  const today = istWeekday(now);
  let delta = (today - target + 7) % 7;
  if (delta === 0) {
    delta = 7;
  }
  return addIstDays(istYmd(now), -delta);
}

function eventDay(start: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    return start;
  }
  const instant = new Date(start);
  return Number.isFinite(instant.getTime()) ? istYmd(instant) : "";
}

function personMatches(name: string, attendee: { name: string; email: string }): boolean {
  const token = name.trim().toLowerCase();
  if (!token) {
    return false;
  }
  const words = `${attendee.name} ${attendee.email.split("@")[0] ?? ""}`
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3);
  return words.some((word) => word === token || (token.length >= 6 && word.length >= 6 && namesFuzzyEqual(word, token)));
}

function contentTokens(text: string): string[] {
  return nameTokens(text).filter((token) => token.length >= 3 && !CAL_STOP.has(token) && token !== "work" && token !== "personal");
}

interface MeetingCues {
  accountId?: GoogleAccountId;
  day?: string | "last-week";
  tokens: string[];
}

function meetingCues(text: string, now: Date): MeetingCues {
  const accountId = /\bpersonal calendar\b/i.test(text)
    ? "personal"
    : /\bwork calendar\b/i.test(text)
      ? "work"
      : undefined;
  return { accountId, day: mentionedDay(text, now), tokens: contentTokens(text) };
}

function tokenIn(words: readonly string[], token: string): boolean {
  return words.some((word) => word === token || (token.length >= 6 && word.length >= 6 && namesFuzzyEqual(word, token)));
}

function scoreMeeting(ref: MeetingRef, cues: MeetingCues, now: Date, hint?: string): number {
  if (cues.accountId && ref.accountId !== cues.accountId) {
    return 0;
  }
  const day = eventDay(ref.startIso);
  const today = istYmd(now);
  if (cues.day === "last-week") {
    if (!day || day < addIstDays(today, -14) || day > today) {
      return 0;
    }
  } else if (cues.day && day !== cues.day) {
    return 0;
  }
  const titleWords = nameTokens(ref.title);
  const people = ref.attendees.flatMap((person) => nameTokens(`${person.name} ${person.email.split("@")[0] ?? ""}`));
  let matched = false;
  let score = 0;
  for (const token of cues.tokens) {
    if (tokenIn(titleWords, token) || tokenIn(people, token)) {
      matched = true;
      score += 8;
    }
  }
  if (cues.tokens.length > 0 && !matched) {
    return 0;
  }
  if (cues.day && cues.day !== "last-week") {
    score += 14;
  } else if (cues.day === "last-week") {
    score += 6;
  }
  if (hint && ref.attendees.some((person) => personMatches(hint, person))) {
    score += 4;
  }
  return score;
}

function describeMeeting(ref: MeetingRef): string {
  const who = ref.attendees.map((person) => person.name || person.email).slice(0, 4).join(", ");
  return `[${ref.accountId}] ${ref.title} — ${formatEventDate(ref.startIso)}${who ? ` (${who})` : ""}`;
}

function refsFromStore(chatId: number): MeetingRef[] {
  return listCalendarEventRefs(chatId).map((row: CalendarEventRefRecord) => ({
    eventId: row.eventId,
    accountId: row.accountId,
    title: row.title,
    startIso: row.startIso,
    attendees: row.attendees,
    focused: row.focused,
  }));
}

function peopleFromApi(
  attendees: Array<{ email?: string | null; displayName?: string | null }> | null | undefined,
): Array<{ name: string; email: string }> {
  const people = (attendees ?? [])
    .map((person) => ({
      email: (person.email ?? "").trim().toLowerCase(),
      name: (person.displayName || person.email || "").trim(),
    }))
    .filter((person) => person.email && !NOT_A_PERSON.test(person.email));
  return [...new Map(people.map((person) => [person.email, person])).values()];
}

async function searchLiveMeetings(input: {
  tokens: string[];
  accountId?: GoogleAccountId;
  date?: string;
  now: Date;
}): Promise<MeetingRef[]> {
  const query = input.tokens.slice(0, 3).join(" ");
  if (!query && !input.date) {
    return [];
  }
  if (testHooks.list) {
    const listed = await testHooks.list({ title: query || input.date || "", date: input.date, accountId: input.accountId });
    const refs: MeetingRef[] = [];
    for (const event of listed) {
      const loaded = testHooks.getAttendees ? await testHooks.getAttendees(event) : [];
      refs.push({
        eventId: event.eventId,
        accountId: event.accountId,
        title: event.title,
        startIso: event.start,
        attendees: peopleFromApi(loaded),
        focused: false,
      });
    }
    return refs;
  }
  const range = input.date
    ? istInclusiveRange(input.date, input.date)
    : istInclusiveRange(addIstDays(istYmd(input.now), -30), addIstDays(istYmd(input.now), 14));
  const found: MeetingRef[] = [];
  let accounts: Awaited<ReturnType<typeof loadGoogleAccounts>>;
  try {
    accounts = await loadGoogleAccounts();
  } catch {
    return [];
  }
  for (const account of accounts) {
    if (input.accountId && account.id !== input.accountId) {
      continue;
    }
    if (found.length >= 15) {
      break;
    }
    try {
      const calendar = google.calendar({ version: "v3", auth: account.client });
      const listed = await calendar.events.list({
        calendarId: "primary",
        timeMin: range.timeMin,
        timeMax: range.timeMax,
        timeZone: TIME_ZONE,
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 15,
        q: query || undefined,
      });
      for (const event of listed.data.items ?? []) {
        if (event.status === "cancelled" || !event.id || found.length >= 15) {
          continue;
        }
        found.push({
          eventId: event.id,
          accountId: account.id,
          title: event.summary ?? "(Untitled event)",
          startIso: startOfEvent(event),
          attendees: peopleFromApi(event.attendees),
          focused: false,
        });
      }
    } catch (error) {
      const errorType = error instanceof Error ? error.name : "UnknownError";
      console.log(`calendar reference search failed (${errorType})`);
    }
  }
  return found;
}

function pickMeeting(scored: Array<{ ref: MeetingRef; score: number }>): MeetingRef | "many" | undefined {
  const viable = scored.filter((item) => item.score > 0).sort((left, right) => right.score - left.score);
  const best = viable[0];
  if (!best) {
    return undefined;
  }
  const tied = viable.filter((item) => item.score === best.score);
  if (tied.length > 1) {
    return "many";
  }
  return best.ref;
}

async function resolveMeetingReference(input: {
  chatId: number;
  text: string;
  edit?: AttendeeEdit;
  now: Date;
}): Promise<{ kind: "none" } | { kind: "many"; question: string } | { kind: "one"; ref: MeetingRef }> {
  const phrase = referencePhrase(input.text, input.edit);
  const cues = meetingCues(phrase, input.now);
  const hint = input.edit?.op === "add" ? undefined : input.edit?.op === "replace" ? input.edit.from : input.edit?.name;
  let pool = refsFromStore(input.chatId);
  const pronoun = cues.tokens.length === 0 && !cues.day;
  if (pronoun) {
    const focused = pool.filter((ref) => ref.focused && (!cues.accountId || ref.accountId === cues.accountId));
    if (focused.length === 1) {
      return { kind: "one", ref: focused[0]! };
    }
    const available = pool.filter((ref) => !cues.accountId || ref.accountId === cues.accountId);
    if (available.length === 1) {
      return { kind: "one", ref: available[0]! };
    }
    if (available.length > 1) {
      return {
        kind: "many",
        question: `Which meeting?\n${available.slice(0, 5).map(describeMeeting).join("\n")}`,
      };
    }
    return { kind: "none" };
  }
  const live = await searchLiveMeetings({
    tokens: cues.tokens,
    accountId: cues.accountId,
    date: cues.day && cues.day !== "last-week" ? cues.day : undefined,
    now: input.now,
  });
  const seen = new Set(pool.map((ref) => `${ref.accountId}:${ref.eventId}`));
  const liveById = new Map(live.map((ref) => [`${ref.accountId}:${ref.eventId}`, ref]));
  pool = pool.map((ref) => {
    const fresh = liveById.get(`${ref.accountId}:${ref.eventId}`);
    if (!fresh || fresh.attendees.length === 0) {
      return ref;
    }
    return { ...ref, title: fresh.title, startIso: fresh.startIso, attendees: fresh.attendees };
  });
  pool = [...pool, ...live.filter((ref) => !seen.has(`${ref.accountId}:${ref.eventId}`))];
  const choice = pickMeeting(pool.map((ref) => ({ ref, score: scoreMeeting(ref, cues, input.now, hint) })));
  if (!choice) {
    return { kind: "none" };
  }
  if (choice === "many") {
    const viable = pool
      .map((ref) => ({ ref, score: scoreMeeting(ref, cues, input.now, hint) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score);
    const top = viable[0]?.score ?? 0;
    return {
      kind: "many",
      question: `Which meeting?\n${viable.filter((item) => item.score === top).slice(0, 5).map((item) => describeMeeting(item.ref)).join("\n")}`,
    };
  }
  return { kind: "one", ref: choice };
}

/**
 * Google Calendar events.patch takes one sendUpdates value for the whole change.
 * Official values: "all" (every guest), "externalOnly" (guests who are not on
 * Google Calendar), "none" (no notifications requested). The event resource
 * that comes back does not say who was emailed. The deprecated
 * sendNotifications=false note says some mail can still be sent, so "none"
 * is a request, not proof of silence. One call cannot invite only the new
 * person and stay silent for everyone else.
 */
function chooseSendUpdates(text: string, added: number, removed: number): { mode: SendUpdatesMode; note: string } | { ask: string } {
  const quiet = /\b(?:don'?t|do not)\s+(?:notify|email|e-mail|tell)\b|\bno notifications?\b|\bwithout notifying\b|\bquietly\b/i.test(text);
  const announce = /\b(?:let them know|notify them|tell them|send (?:the )?(?:invitation|update))\b/i.test(text);
  const external = /\bexternal guests only\b|\bonly external\b/i.test(text);
  if ((quiet && announce) || (quiet && external) || (announce && external)) {
    return { ask: "Not changed: say whether Google should notify the guests, notify only people outside Google Calendar, or request no notifications." };
  }
  if (external) {
    return {
      mode: "externalOnly",
      note: "I requested sendUpdates=externalOnly, so Google is asked to email only guests who are not on Google Calendar. I can't confirm who was emailed.",
    };
  }
  if (quiet) {
    return {
      mode: "none",
      note: "You asked not to notify. I requested sendUpdates=none. That does not prove nobody was emailed, and a new guest may not receive an invitation.",
    };
  }
  if (announce || added > 0) {
    const removedNote = removed > 0 ? " The person who was removed may get a cancellation, and the others may get an update." : " The other guests may get an update as well.";
    return {
      mode: "all",
      note: `I requested sendUpdates=all so a new guest is invited.${removedNote} I can't confirm those emails.`,
    };
  }
  return {
    mode: "none",
    note: "I requested sendUpdates=none so the people who are staying are not sent a new invitation. The removed person may still be notified; this does not confirm either way.",
  };
}

/**
 * Names a past meeting and remembers it. Does not change the event.
 * Add, remove, and replace are handled separately.
 */
export async function noteCalendarReference(input: {
  chatId: number;
  text: string;
  now?: Date;
}): Promise<string | undefined> {
  const text = input.text.trim();
  if (/^(?:add|remove|drop|replace|book|schedule)\b/i.test(text) || !/\bmeeting\b/i.test(text)) {
    return undefined;
  }
  if (!/\b(?:remember|which|find)\b/i.test(text)) {
    return undefined;
  }
  const now = input.now ?? new Date();
  const resolved = await resolveMeetingReference({ chatId: input.chatId, text, now });
  if (resolved.kind === "none") {
    return undefined;
  }
  if (resolved.kind === "many") {
    return resolved.question;
  }
  const ref = resolved.ref;
  focusBookedMeeting(input.chatId, {
    eventId: ref.eventId,
    accountId: ref.accountId,
    title: ref.title,
    startIso: ref.startIso,
    attendees: ref.attendees,
  }, now);
  const who = ref.attendees.map((person) => person.email).join(", ");
  return `That's ${ref.title} on ${formatEventDate(ref.startIso)} on the ${ref.accountId} calendar${who ? `, with ${who}` : ""}. I haven't changed it.`;
}

/**
 * Changes attendees on the meeting the sentence refers to.
 * A still-pending list, with no named past event, is left for the local editor.
 * Several matches are asked, not patched.
 */
export async function reviseReferencedMeeting(input: {
  chatId: number;
  text: string;
  confirmation: { chatId: number; messageId: number } | undefined;
  now?: Date;
}): Promise<string | undefined> {
  const edit = parseAttendeeEdit(input.text);
  if (!edit || !isMeetingAttendeeEdit(input.text, edit, input.chatId, input.now ?? new Date())) {
    return undefined;
  }
  const now = input.now ?? new Date();
  const pending = getPendingAction(input.chatId, now);
  const cues = meetingCues(referencePhrase(input.text, edit), now);
  if (pending?.status === "open" && pending.meeting && cues.tokens.length === 0 && !cues.day) {
    const focused = refsFromStore(input.chatId).find((ref) => ref.focused);
    if (focused) {
      return `Which meeting? The one still being scheduled, or ${describeMeeting(focused)}?`;
    }
    return undefined;
  }
  const resolved = await resolveMeetingReference({ chatId: input.chatId, text: input.text, edit, now });
  if (resolved.kind === "many") {
    return resolved.question;
  }
  if (resolved.kind === "none") {
    return pending?.status === "open" && pending.meeting ? undefined : "I couldn't tell which meeting you mean.";
  }
  const booked = resolved.ref;
  const current = await currentAttendees(booked);
  if (!current) {
    return `Not changed: I couldn't read the current guest list for ${booked.title}.`;
  }
  const resolveNew = (name: string): { email: string; name: string } | string => {
    const found = matchOwnerSupplied(input.chatId, name, now);
    if (found.kind === "one") {
      return { email: found.contact.email, name: found.contact.name };
    }
    if (found.kind === "many") {
      return `Which ${name}? ${found.contacts.map((item) => item.email).join(", ")}`;
    }
    return `I don't have an address for ${name}.`;
  };
  let next = current.map((person) => ({ ...person }));
  if (edit.op === "remove") {
    const kept = next.filter((person) => person.resource || !personMatches(edit.name, person));
    if (kept.length === next.length) {
      return `${edit.name} is not on ${booked.title}.`;
    }
    next = kept;
  } else if (edit.op === "add") {
    const person = resolveNew(edit.name);
    if (typeof person === "string") {
      return person;
    }
    if (next.some((item) => item.email === person.email)) {
      return `${person.email} is already on ${booked.title}.`;
    }
    next = [...next, { ...person, resource: false }];
  } else {
    const person = resolveNew(edit.to);
    if (typeof person === "string") {
      return person;
    }
    const without = next.filter((item) => item.resource || !personMatches(edit.from, item));
    if (without.length === next.length) {
      return `${edit.from} is not on ${booked.title}.`;
    }
    next = without.some((item) => item.email === person.email) ? without : [...without, { ...person, resource: false }];
  }
  const updated = await updateEventAttendees({
    event: {
      accountId: booked.accountId,
      eventId: booked.eventId,
      title: booked.title,
      start: booked.startIso,
      attendeeCount: next.length,
    },
    attendees: next,
    previousEmails: current.map((person) => person.email),
    ownerText: input.text,
    confirmation: input.confirmation,
  });
  if (updated.startsWith("Updated ")) {
    focusBookedMeeting(input.chatId, {
      eventId: booked.eventId,
      accountId: booked.accountId,
      title: booked.title,
      startIso: booked.startIso,
      attendees: next.filter((person) => !person.resource),
    }, now);
  }
  return updated;
}

async function currentAttendees(
  ref: MeetingRef,
): Promise<Array<{ name: string; email: string; resource: boolean }> | undefined> {
  try {
    const listed = testHooks.getAttendees
      ? await testHooks.getAttendees({
          accountId: ref.accountId,
          eventId: ref.eventId,
          title: ref.title,
          start: ref.startIso,
          attendeeCount: ref.attendees.length,
        })
      : (await (await calendarFor(ref.accountId)).events.get({
          calendarId: "primary",
          eventId: ref.eventId,
        })).data.attendees;
    const guests = (listed ?? [])
      .map((person) => ({
        email: (person.email ?? "").trim().toLowerCase(),
        name: (person.displayName || person.email || "").trim(),
        resource: NOT_A_PERSON.test(person.email ?? ""),
      }))
      .filter((person) => person.email);
    return [...new Map(guests.map((person) => [person.email, person])).values()];
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.log(`calendar attendee read failed (${errorType})`);
    return undefined;
  }
}

/**
 * Patches one event's attendee list and checks Google echoed that list back.
 * sendUpdates follows the attendee-notification policy, not a fixed "all".
 */
export async function updateEventAttendees(input: {
  event: OwnerCalendarEvent;
  attendees: Array<{ email: string; name?: string }>;
  previousEmails?: readonly string[];
  ownerText?: string;
  confirmation: { chatId: number; messageId: number } | undefined;
}): Promise<string> {
  try {
    allowOwnerChatAddAttendee(input.confirmation);
  } catch {
    return "Not changed: only Vishnu's own chat message can change a meeting's attendees.";
  }
  const next = input.attendees.map((person) => ({
    email: person.email.toLowerCase(),
    displayName: person.name,
  }));
  const expected = next.map((person) => person.email);
  const before = (input.previousEmails ?? []).map((email) => email.toLowerCase());
  const added = expected.filter((email) => !before.includes(email)).length;
  const removed = before.filter((email) => !expected.includes(email)).length;
  if (added === 0 && removed === 0) {
    return `Updated ${input.event.title}. Attendees: ${expected.join(", ")}. The guest list was already that.`;
  }
  const policy = chooseSendUpdates(input.ownerText ?? "", added, removed);
  if ("ask" in policy) {
    return policy.ask;
  }
  try {
    if (testHooks.patch) {
      await testHooks.patch({ event: input.event, attendees: next, sendUpdates: policy.mode });
    } else {
      const calendar = await calendarFor(input.event.accountId);
      await calendar.events.patch({
        calendarId: "primary",
        eventId: input.event.eventId,
        sendUpdates: policy.mode,
        requestBody: { attendees: next },
      });
    }
    const echoed = testHooks.getAttendees
      ? await testHooks.getAttendees(input.event)
      : (await (await calendarFor(input.event.accountId)).events.get({
          calendarId: "primary",
          eventId: input.event.eventId,
        })).data.attendees;
    const got = new Set((echoed ?? []).map((person) => (person.email ?? "").toLowerCase()).filter(Boolean));
    const missing = expected.filter((email) => !got.has(email));
    const stillThere = before.filter((email) => !expected.includes(email) && got.has(email));
    if (missing.length > 0 || stillThere.length > 0) {
      return `Not changed: Google Calendar did not confirm the attendee list for ${input.event.title}.`;
    }
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.log(`calendar attendee update failed (${errorType})`);
    return `Not changed: Google Calendar refused the update to ${input.event.title}.`;
  }
  return `Updated ${input.event.title}. Attendees: ${expected.join(", ")}. ${policy.note}`;
}

/** Attendees of the one meeting Vishnu named. Several matches are listed, not guessed. */
export async function attendeesForNewMeeting(
  phrase: string,
  now = new Date(),
): Promise<
  | { kind: "none" }
  | { kind: "many"; question: string }
  | { kind: "one"; title: string; accountId: GoogleAccountId; attendees: Array<{ email: string; name: string }> }
> {
  const request = reuseRequest(phrase, now);
  if (!request) {
    return { kind: "none" };
  }
  const matches = (await listMatchingEvents(request.title, request.date, request.accountId, request.span, now))
    .filter((event) => titleMatches(request.title, event.title));
  if (matches.length === 0) {
    return { kind: "none" };
  }
  if (matches.length > 1) {
    return { kind: "many", question: `Which meeting?\n${matches.map(formatMatch).join("\n")}` };
  }
  const event = matches[0]!;
  let listed: Array<{ email?: string | null; displayName?: string | null }> | null | undefined;
  try {
    listed = testHooks.getAttendees
      ? await testHooks.getAttendees(event)
      : (await (await calendarFor(event.accountId)).events.get({
          calendarId: "primary",
          eventId: event.eventId,
        })).data.attendees;
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.log(`calendar attendee read failed (${errorType})`);
    return { kind: "many", question: `I found ${event.title} but couldn't read its guests, so I didn't start a new meeting.` };
  }
  return { kind: "one", title: event.title, accountId: event.accountId, attendees: peopleFromApi(listed) };
}

function istYmd(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function addIstDays(ymd: string, days: number): string {
  const [year, month, day] = ymd.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  const yyyy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function searchRange(
  date: string | undefined,
  now = new Date(),
  span?: { pastDays: number; futureDays: number },
): { timeMin: string; timeMax: string } {
  if (date) {
    return istInclusiveRange(date, date);
  }
  const today = istYmd(now);
  return istInclusiveRange(addIstDays(today, -(span?.pastDays ?? 7)), addIstDays(today, span?.futureDays ?? 60));
}

function titleMatches(query: string, summary: string): boolean {
  const needle = query.trim().toLowerCase();
  const hay = summary.trim().toLowerCase();
  return hay === needle || hay.includes(needle);
}

function formatEventDate(start: string): string {
  const instant = start.includes("T")
    ? new Date(start)
    : new Date(`${start}T00:00:00+05:30`);
  if (!Number.isFinite(instant.getTime())) {
    return start;
  }
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(instant);
}

function formatMatch(event: OwnerCalendarEvent, index: number): string {
  return `${index + 1}. [${event.accountId}] ${event.title} — ${formatEventDate(event.start)} (${event.start})`;
}

function startOfEvent(event: calendar_v3.Schema$Event): string {
  return event.start?.dateTime ?? event.start?.date ?? "";
}

async function listMatchingEvents(
  title: string,
  date: string | undefined,
  accountId?: GoogleAccountId,
  span?: { pastDays: number; futureDays: number },
  now = new Date(),
): Promise<OwnerCalendarEvent[]> {
  if (testHooks.list) {
    return testHooks.list({ title, date, accountId });
  }
  const range = searchRange(date, now, span);
  const found: OwnerCalendarEvent[] = [];
  const loaded = await loadGoogleAccounts();
  const accounts = accountId
    ? loaded.filter((item) => item.id === accountId)
    : loaded;
  for (const account of accounts) {
    const calendar = google.calendar({ version: "v3", auth: account.client });
    const listed = await calendar.events.list({
      calendarId: "primary",
      timeMin: range.timeMin,
      timeMax: range.timeMax,
      timeZone: TIME_ZONE,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 50,
      q: title,
    });
    for (const event of listed.data.items ?? []) {
      if (event.status === "cancelled" || !event.id) {
        continue;
      }
      const summary = event.summary ?? "(Untitled event)";
      if (!titleMatches(title, summary)) {
        continue;
      }
      const attendees = (event.attendees ?? []).filter(
        (person) => person.self !== true && person.email,
      );
      found.push({
        accountId: account.id,
        eventId: event.id,
        title: summary,
        start: startOfEvent(event),
        end: event.end?.dateTime ?? event.end?.date ?? "",
        attendeeCount: attendees.length,
      });
    }
  }
  return found;
}

async function deleteEvent(event: OwnerCalendarEvent): Promise<void> {
  if (testHooks.delete) {
    await testHooks.delete(event);
    return;
  }
  const accounts = await loadGoogleAccounts();
  const account = accounts.find((item) => item.id === event.accountId);
  if (!account) {
    throw new Error(`No ${event.accountId} Google account is connected.`);
  }
  const calendar = google.calendar({ version: "v3", auth: account.client });
  await calendar.events.delete({
    calendarId: "primary",
    eventId: event.eventId,
    sendUpdates: event.attendeeCount > 0 ? "all" : "none",
  });
}

export async function deleteOwnerCalendarEvent(input: {
  eventTitle: string;
  date?: string;
  confirmation: { chatId: number; messageId: number } | undefined;
}): Promise<string> {
  try {
    allowOwnerChatDeleteEvent(input.confirmation);
  } catch {
    return "Not deleted: only Vishnu's own chat message can delete a calendar event.";
  }

  const title = input.eventTitle.trim();
  if (!title) {
    return "Not deleted: I need the event title.";
  }
  if (input.date && !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    return "Not deleted: date must be YYYY-MM-DD.";
  }

  let matches: OwnerCalendarEvent[];
  try {
    matches = await listMatchingEvents(title, input.date);
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.log(`delete_calendar_event: list failed (${errorType})`);
    return "Not deleted: I could not search the calendars. Try again.";
  }

  if (matches.length === 0) {
    return `Not deleted: no matching event named "${title}".`;
  }
  if (matches.length > 1) {
    const lines = matches.map((event, index) => formatMatch(event, index));
    return `Not deleted: several matches — which one?\n${lines.join("\n")}`;
  }

  const event = matches[0]!;
  try {
    await deleteEvent(event);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const forbidden = /403|insufficient|insufficientPermissions/i.test(message);
    if (forbidden && event.accountId === "personal") {
      return "Not deleted: the personal calendar is read-only. Delete it in Google Calendar, or add calendar.events to personal (needs re-auth).";
    }
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.log(`delete_calendar_event: delete failed (${errorType})`);
    return "Not deleted: Google Calendar refused the delete. Nothing was changed.";
  }
  return `Deleted event: ${event.title} on ${formatEventDate(event.start)}.`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RECENT_EVENT_MS = 2 * 60 * 1000;
const INDEX_RETRY_DELAY_MS = 1000;
const PATCH_APPLY_ERROR = "Google Calendar failed to apply the attendee update.";

type CalendarAttendee = { email?: string | null };

function hasAttendeeEmail(
  attendees: CalendarAttendee[] | null | undefined,
  email: string,
): boolean {
  const needle = email.toLowerCase();
  return (attendees || []).some(
    (person) => (person.email ?? "").toLowerCase() === needle,
  );
}

function createdWithin(created: string | null | undefined, windowMs: number): boolean {
  if (!created) {
    return false;
  }
  const at = Date.parse(created);
  return Number.isFinite(at) && Date.now() - at <= windowMs;
}

async function wait(ms: number): Promise<void> {
  if (testHooks.sleep) {
    await testHooks.sleep(ms);
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function failedAdd(email: string, title: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Failed to add ${email} to ${title}. Error: ${message}`;
}

async function calendarFor(accountId: GoogleAccountId) {
  const account = await getGoogleAccount(accountId);
  return google.calendar({ version: "v3", auth: account.client });
}

async function workCalendar() {
  return calendarFor("work");
}

async function loadWorkEvent(event: OwnerCalendarEvent): Promise<{
  attendees: CalendarAttendee[];
  created?: string | null;
}> {
  if (testHooks.getAttendees) {
    const listed = await testHooks.getAttendees(event);
    return {
      attendees: listed || [],
      created: testHooks.eventCreated,
    };
  }
  const calendar = await workCalendar();
  const got = await calendar.events.get({
    calendarId: "primary",
    eventId: event.eventId,
  });
  const currentAttendees = got.data.attendees || [];
  return {
    attendees: currentAttendees,
    created: got.data.created,
  };
}

async function applyAttendeePatch(
  event: OwnerCalendarEvent,
  attendees: CalendarAttendee[],
  email: string,
): Promise<void> {
  if (testHooks.patch) {
    const patched = await testHooks.patch({
      event,
      attendees,
      sendUpdates: "all",
    });
    if (!hasAttendeeEmail(patched?.attendees, email)) {
      throw new Error(PATCH_APPLY_ERROR);
    }
    return;
  }
  const calendar = await workCalendar();
  const patched = await calendar.events.patch({
    calendarId: "primary",
    eventId: event.eventId,
    sendUpdates: "all",
    requestBody: { attendees },
  });
  const currentAttendees = patched.data.attendees || [];
  if (!hasAttendeeEmail(currentAttendees, email)) {
    throw new Error(PATCH_APPLY_ERROR);
  }
}

async function patchAttendeesWithRetry(
  event: OwnerCalendarEvent,
  attendees: CalendarAttendee[],
  email: string,
  recentlyCreated: boolean,
): Promise<void> {
  if (recentlyCreated) {
    await wait(INDEX_RETRY_DELAY_MS);
  }
  try {
    await applyAttendeePatch(event, attendees, email);
  } catch (error) {
    if (!recentlyCreated) {
      throw error;
    }
    console.log(`add_calendar_attendee: retrying patch eventId=${event.eventId}`);
    await wait(INDEX_RETRY_DELAY_MS);
    await applyAttendeePatch(event, attendees, email);
  }
}

export async function addOwnerCalendarAttendee(input: {
  eventTitle: string;
  date?: string;
  attendeeEmail: string;
  confirmation: { chatId: number; messageId: number } | undefined;
}): Promise<string> {
  try {
    allowOwnerChatAddAttendee(input.confirmation);
  } catch {
    return "Not added: only Vishnu's own chat message can add a calendar attendee.";
  }

  const title = input.eventTitle.trim();
  const email = input.attendeeEmail.trim();
  if (!title) {
    return "Not added: I need the event title.";
  }
  if (!EMAIL_RE.test(email)) {
    return "Not added: attendee_email must be an email address.";
  }
  if (input.date && !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    return "Not added: date must be YYYY-MM-DD.";
  }

  let matches: OwnerCalendarEvent[];
  try {
    matches = await listMatchingEvents(title, input.date, "work");
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.log(`add_calendar_attendee: list failed (${errorType})`);
    return failedAdd(email, title, "I could not search the work calendar.");
  }

  if (matches.length === 0) {
    return `Not added: no matching work event named "${title}".`;
  }
  if (matches.length > 1) {
    const lines = matches.map((event, index) => formatMatch(event, index));
    return `Not added: several matches — which one?\n${lines.join("\n")}`;
  }

  const event = matches[0]!;
  let loaded: { attendees: CalendarAttendee[]; created?: string | null };
  try {
    loaded = await loadWorkEvent(event);
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.log(`add_calendar_attendee: get failed (${errorType})`);
    return failedAdd(email, event.title, error);
  }

  const currentAttendees = loaded.attendees || [];
  if (hasAttendeeEmail(currentAttendees, email)) {
    return `Not added: ${email} is already on ${event.title}.`;
  }

  const nextAttendees = [...currentAttendees, { email }];
  try {
    await patchAttendeesWithRetry(
      event,
      nextAttendees,
      email,
      createdWithin(loaded.created, RECENT_EVENT_MS),
    );
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.log(`add_calendar_attendee: patch failed (${errorType})`);
    return failedAdd(email, event.title, error);
  }
  console.log(`add_calendar_attendee: patched eventId=${event.eventId}`);
  return `Added ${email} to ${event.title}.`;
}

async function moveEvent(event: OwnerCalendarEvent, startIso: string, endIso: string): Promise<void> {
  if (testHooks.move) {
    await testHooks.move(event, startIso, endIso);
    return;
  }
  const accounts = await loadGoogleAccounts();
  const account = accounts.find((item) => item.id === event.accountId);
  if (!account) {
    throw new Error(`No ${event.accountId} Google account is connected.`);
  }
  const calendar = google.calendar({ version: "v3", auth: account.client });
  await calendar.events.patch({
    calendarId: "primary",
    eventId: event.eventId,
    sendUpdates: event.attendeeCount > 0 ? "all" : "none",
    requestBody: {
      start: { dateTime: startIso, timeZone: TIME_ZONE },
      end: { dateTime: endIso, timeZone: TIME_ZONE },
    },
  });
}

/** Moves one matched event, keeping its length unless he gave an end. */
export async function moveOwnerCalendarEvent(input: {
  eventTitle: string;
  date?: string;
  newStart: string;
  newEnd?: string;
  confirmation: { chatId: number; messageId: number } | undefined;
  now?: Date;
}): Promise<string> {
  try {
    allowOwnerChatMoveEvent(input.confirmation);
  } catch {
    return "Not moved: only Vishnu's own message can move a calendar event.";
  }
  const title = input.eventTitle.trim();
  if (!title) {
    return "Not moved: I need the event title.";
  }
  if (input.date && !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    return "Not moved: date must be YYYY-MM-DD.";
  }
  const newStart = new Date(input.newStart);
  if (!Number.isFinite(newStart.getTime())) {
    return "Not moved: new_start must be ISO 8601 with a +05:30 offset.";
  }
  if (newStart.getTime() < (input.now ?? new Date()).getTime() - 5 * 60 * 1000) {
    return "Not moved: that time has already passed.";
  }
  let matches: OwnerCalendarEvent[];
  try {
    matches = await listMatchingEvents(title, input.date);
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.log(`move_event: list failed (${errorType})`);
    return "Not moved: I could not search the calendars. Try again.";
  }
  if (matches.length === 0) {
    return `Not moved: no matching event named "${title}".`;
  }
  if (matches.length > 1) {
    const lines = matches.map((event, index) => formatMatch(event, index));
    return `Not moved: several matches — which one?\n${lines.join("\n")}`;
  }
  const event = matches[0]!;
  if (!event.start.includes("T")) {
    return `Not moved: ${event.title} is an all-day event, so move it in Google Calendar.`;
  }
  const lengthMs = new Date(event.end ?? "").getTime() - new Date(event.start).getTime();
  const newEnd = input.newEnd ? new Date(input.newEnd) : new Date(newStart.getTime() + lengthMs);
  if (!Number.isFinite(newEnd.getTime()) || newEnd.getTime() <= newStart.getTime()) {
    return "Not moved: I couldn't work out when it should end. Ask Vishnu for the end time.";
  }
  try {
    await moveEvent(event, newStart.toISOString(), newEnd.toISOString());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/403|insufficient/i.test(message) && event.accountId === "personal") {
      return "Not moved: the personal calendar is read-only. Move it in Google Calendar, or add calendar.events to personal (needs re-auth).";
    }
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.log(`move_event: patch failed (${errorType})`);
    return "Not moved: Google Calendar refused it. Nothing was changed.";
  }
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(newStart);
  return `Moved ${event.title} to ${clock} IST.${event.attendeeCount > 0 ? " Attendees were told." : ""}`;
}
