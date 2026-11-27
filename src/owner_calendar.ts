import { google, type calendar_v3 } from "googleapis";
import { explicitEmailField, focusBookedMeeting, getPendingAction, matchOwnerSupplied } from "./action_context.js";
import { rememberContactChoice } from "./contacts.js";
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
import { routeMiss, type PreRouteResult } from "./pre_route.js";
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

function isEmailAboutPeople(phrase: string): boolean {
  return /\b(?:draft|e-?mail|mail|write)\b/i.test(phrase) && !/\b(?:book|schedule)\b/i.test(phrase);
}

function isMeetingBooking(phrase: string): boolean {
  return /\b(?:book|schedule|another meeting|new meeting|meet with)\b/i.test(phrase);
}

interface ReuseRequest {
  title: string;
  date?: string;
  /** Every IST day the meeting may be on, when he named a day. */
  days?: string[];
  accountId?: GoogleAccountId;
  span?: { pastDays: number; futureDays: number };
  /** "the Friday demo" read with Friday as part of the title, if nothing is on a Friday. */
  weekdayTitle?: string;
}

function reuseTitle(phrase: string): string {
  const titled = /\b(?:from|at)\s+(?:the\s+)?([^?.]+)/i.exec(phrase);
  return (titled?.[1] ?? "")
    .replace(/\bon the\b.*$/i, "")
    .replace(/\b(meeting|discussion|people)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function reuseRequest(phrase: string, now: Date): ReuseRequest | undefined {
  if (!/\b(?:same people|everyone from)\b/i.test(phrase)) {
    return undefined;
  }
  const accountId = /\bpersonal calendar\b/i.test(phrase)
    ? "personal"
    : /\bwork calendar\b/i.test(phrase)
      ? "work"
      : undefined;
  // The day comes out of the phrase first, so "last Monday's Acme" searches for Acme on that Monday.
  const mention = dateMention(phrase, now);
  const days = mention.days;
  const date = days?.length === 1 ? days[0] : undefined;
  const span = mention.lastWeek ? { pastDays: 14, futureDays: 0 } : undefined;
  const title = reuseTitle(mention.rest);
  const weekdayTitle = mention.bareWeekday ? reuseTitle(phrase.replace(/\blast week(?:'s|\u2019s)?/i, " ")) : undefined;
  return title ? { title, date, days, accountId, span, weekdayTitle } : undefined;
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
  // Words of the question, never of a title: "which meeting did I have last Thursday?"
  "did", "had", "have", "has", "was", "were", "what", "who", "when", "where", "there",
  "and", "for", "our", "your", "you", "are", "next",
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

/** An add/remove while both an email draft and a meeting are open, with no word that picks one. */
function ambiguousSharedReference(text: string, chatId: number, now: Date): boolean {
  if (!parseAttendeeEdit(text) || explicitEmailField(text)) {
    return false;
  }
  if (/\b(?:meeting|calendar|attendee|invite|invitation|task|reminder|bill|memory|shopping)\b/i.test(text)) {
    return false;
  }
  const pending = getPendingAction(chatId, now);
  const emailOpen = pending?.status === "open" && Boolean(pending.email?.draftId);
  const meetingOpen = Boolean(pending?.status === "open" && pending.meeting) || refsFromStore(chatId).some((ref) => ref.focused);
  return emailOpen && meetingOpen;
}

/** Bare "add/remove NAME" is a meeting edit only while a meeting is in play. */
function isMeetingAttendeeEdit(text: string, edit: AttendeeEdit, chatId: number, now: Date): boolean {
  if (explicitEmailField(text)) {
    return false;
  }
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
  const withoutNotice = text
    .replace(/\b(?:quietly|without notifying|no notifications?)\b/gi, " ")
    .replace(/\b(?:don'?t|do not)\s+(?:notify|email|e-mail|tell)(?:\s+\w+){0,3}\b/gi, " ")
    .replace(/\b(?:let them know|notify them|tell them|send (?:the )?(?:invitation|update))\b/gi, " ");
  if (!edit) {
    return withoutNotice;
  }
  if (edit.op === "replace") {
    return withoutNotice.replace(edit.from, " ").replace(edit.to, " ");
  }
  return withoutNotice.replace(edit.name, " ");
}

function istWeekday(now: Date): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, weekday: "long" }).format(now).toLowerCase();
  return WEEKDAYS.indexOf(name);
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_WORD = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const WEEKDAY_WORD = "(monday|tuesday|wednesday|thursday|friday|saturday|sunday)";
const POSSESSIVE = "(?:'s|\u2019s)?";

/** A day or days he named, with that phrase taken out of the words left to match. */
interface DateMention {
  /** IST days the meeting may be on. Two for a bare weekday: the last one and the next. */
  days?: string[];
  lastWeek?: boolean;
  /** A bare weekday, which could also be part of a title such as "Friday demo". */
  bareWeekday?: string;
  rest: string;
}

function validYmd(year: number, month: number, day: number): string | undefined {
  const at = new Date(Date.UTC(year, month - 1, day));
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) {
    return undefined;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** "17 Nov" with no year: the one nearest today, so a reference in January to "28 Dec" is last year's. */
function nearestYmd(month: number, day: number, today: string): string | undefined {
  const year = Number(today.slice(0, 4));
  const options = [year - 1, year, year + 1]
    .map((candidate) => validYmd(candidate, month, day))
    .filter((value): value is string => Boolean(value));
  const distance = (ymd: string) => Math.abs(Date.parse(`${ymd}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`));
  return options.sort((left, right) => distance(left) - distance(right))[0];
}

/**
 * Turns the day he named into actual IST dates: today, yesterday, tomorrow, last week,
 * last/next/this Monday, a bare weekday, 2026-11-17, 17 Nov, Nov 17th. The phrase is
 * removed from the text, so a weekday or a month is never searched for as a title word.
 */
function dateMention(text: string, now: Date): DateMention {
  const today = istYmd(now);
  const cut = (pattern: RegExp): string => text.replace(pattern, " ").replace(/\s+/g, " ").trim();
  const lastWeek = new RegExp(`\\blast week${POSSESSIVE}(?![\\p{L}])`, "iu");
  if (lastWeek.test(text)) {
    return { lastWeek: true, rest: cut(lastWeek) };
  }
  for (const [word, offset] of [["today", 0], ["yesterday", -1], ["tomorrow", 1]] as const) {
    const pattern = new RegExp(`\\b${word}${POSSESSIVE}(?![\\p{L}])`, "iu");
    if (pattern.test(text)) {
      return { days: [addIstDays(today, offset)], rest: cut(pattern) };
    }
  }
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/;
  const isoHit = iso.exec(text);
  const isoDay = isoHit ? validYmd(Number(isoHit[1]), Number(isoHit[2]), Number(isoHit[3])) : undefined;
  if (isoDay) {
    return { days: [isoDay], rest: cut(iso) };
  }
  const dayFirst = new RegExp(`\\b(?:on\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_WORD}(?:,?\\s+(\\d{4}))?${POSSESSIVE}(?![\\p{L}])`, "iu");
  const monthFirst = new RegExp(`\\b(?:on\\s+)?${MONTH_WORD}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?${POSSESSIVE}(?![\\p{L}\\d])`, "iu");
  for (const [pattern, dayAt, monthAt] of [[dayFirst, 1, 2], [monthFirst, 2, 1]] as const) {
    const hit = pattern.exec(text);
    if (!hit) {
      continue;
    }
    const month = MONTHS.indexOf(hit[monthAt]!.slice(0, 3).toLowerCase()) + 1;
    const day = Number(hit[dayAt]);
    const ymd = hit[3] ? validYmd(Number(hit[3]), month, day) : nearestYmd(month, day, today);
    if (ymd) {
      return { days: [ymd], rest: cut(pattern) };
    }
  }
  const weekday = istWeekday(now);
  const qualified = new RegExp(`\\b(last|next|this|on)\\s+${WEEKDAY_WORD}${POSSESSIVE}(?![\\p{L}])`, "iu");
  const bare = new RegExp(`\\b${WEEKDAY_WORD}${POSSESSIVE}(?![\\p{L}])`, "iu");
  const hit = qualified.exec(text);
  const named = hit ? hit[2]! : bare.exec(text)?.[1];
  if (!named) {
    return { rest: text };
  }
  const target = WEEKDAYS.indexOf(named.toLowerCase());
  const back = (weekday - target + 7) % 7;
  const ahead = (target - weekday + 7) % 7;
  const which = hit?.[1]?.toLowerCase();
  if (which === "last") {
    return { days: [addIstDays(today, -(back || 7))], rest: cut(qualified) };
  }
  if (which === "next") {
    return { days: [addIstDays(today, ahead || 7)], rest: cut(qualified) };
  }
  // "Monday", "on Monday", "this Monday": today if it is that day, else the last one and the next one.
  const days = back === 0 ? [today] : [addIstDays(today, -back), addIstDays(today, ahead)];
  return { days, bareWeekday: named.toLowerCase(), rest: cut(hit ? qualified : bare) };
}

function eventDay(start: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    return start;
  }
  const instant = new Date(start);
  return Number.isFinite(instant.getTime()) ? istYmd(instant) : "";
}

function peopleMatching(
  name: string,
  attendees: ReadonlyArray<{ name: string; email: string; resource?: boolean }>,
): Array<{ name: string; email: string }> {
  return attendees.filter((person) => !person.resource && personMatches(name, person));
}

function personMatches(name: string, attendee: { name: string; email: string }): boolean {
  const query = name.trim().toLowerCase();
  if (!query) {
    return false;
  }
  if (query.includes("@")) {
    return attendee.email.toLowerCase() === query;
  }
  const queryWords = query.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 3);
  const words = `${attendee.name} ${attendee.email.split("@")[0] ?? ""}`
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3);
  return queryWords.length > 0 && queryWords.every((token) =>
    words.some((word) => word === token || (token.length >= 6 && word.length >= 6 && namesFuzzyEqual(word, token))),
  );
}

function contentTokens(text: string): string[] {
  return nameTokens(text).filter((token) => token.length >= 3 && !CAL_STOP.has(token) && token !== "work" && token !== "personal");
}

interface MeetingCues {
  accountId?: GoogleAccountId;
  /** The IST days he named, already parsed. Absent when he named none. */
  days?: string[];
  lastWeek?: boolean;
  /** A bare weekday that may instead be a title word, tried only if no meeting is on those days. */
  bareWeekday?: string;
  /** Title and attendee words, with the date phrase removed. */
  tokens: string[];
}

function meetingCues(text: string, now: Date): MeetingCues {
  const accountId = /\bpersonal calendar\b/i.test(text)
    ? "personal"
    : /\bwork calendar\b/i.test(text)
      ? "work"
      : undefined;
  const mention = dateMention(text, now);
  return {
    accountId,
    days: mention.days,
    lastWeek: mention.lastWeek,
    bareWeekday: mention.bareWeekday,
    tokens: contentTokens(mention.rest),
  };
}

function namesADay(cues: MeetingCues): boolean {
  return Boolean(cues.days?.length || cues.lastWeek);
}

/** "the Friday demo": no meeting on a Friday, so Friday was part of the title. */
function weekdayAsTitle(cues: MeetingCues): MeetingCues | undefined {
  return cues.bareWeekday
    ? { accountId: cues.accountId, tokens: [...cues.tokens, cues.bareWeekday] }
    : undefined;
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
  if (cues.lastWeek) {
    if (!day || day < addIstDays(today, -14) || day > today) {
      return 0;
    }
  } else if (cues.days && !cues.days.includes(day)) {
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
  if (cues.days) {
    score += 14;
  } else if (cues.lastWeek) {
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
  const stored = refsFromStore(input.chatId);
  const pronoun = cues.tokens.length === 0 && !namesADay(cues);
  if (pronoun) {
    const focused = stored.filter((ref) => ref.focused && (!cues.accountId || ref.accountId === cues.accountId));
    if (focused.length === 1) {
      return { kind: "one", ref: focused[0]! };
    }
    const available = stored.filter((ref) => !cues.accountId || ref.accountId === cues.accountId);
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
  const found = await pickFromCalendar(stored, cues, input.now, hint);
  if (found.kind !== "none") {
    return found;
  }
  const asTitle = weekdayAsTitle(cues);
  return asTitle ? pickFromCalendar(stored, asTitle, input.now, hint) : found;
}

/** Remembered and live meetings scored against the cues. Asks only when the best ones tie. */
async function pickFromCalendar(
  stored: MeetingRef[],
  cues: MeetingCues,
  now: Date,
  hint: string | undefined,
): Promise<{ kind: "none" } | { kind: "many"; question: string } | { kind: "one"; ref: MeetingRef }> {
  const live: MeetingRef[] = [];
  for (const date of cues.days?.length ? cues.days : [undefined]) {
    live.push(...(await searchLiveMeetings({ tokens: cues.tokens, accountId: cues.accountId, date, now })));
  }
  const seen = new Set(stored.map((ref) => `${ref.accountId}:${ref.eventId}`));
  const liveById = new Map(live.map((ref) => [`${ref.accountId}:${ref.eventId}`, ref]));
  let pool = stored.map((ref) => {
    const fresh = liveById.get(`${ref.accountId}:${ref.eventId}`);
    if (!fresh || fresh.attendees.length === 0) {
      return ref;
    }
    return { ...ref, title: fresh.title, startIso: fresh.startIso, attendees: fresh.attendees };
  });
  const added = new Set<string>();
  for (const ref of live) {
    const key = `${ref.accountId}:${ref.eventId}`;
    if (!seen.has(key) && !added.has(key)) {
      added.add(key);
      pool = [...pool, ref];
    }
  }
  const scored = pool.map((ref) => ({ ref, score: scoreMeeting(ref, cues, now, hint) }));
  const choice = pickMeeting(scored);
  if (!choice) {
    return { kind: "none" };
  }
  if (choice === "many") {
    const viable = scored.filter((item) => item.score > 0).sort((left, right) => right.score - left.score);
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
  if (/\b(?:e-?mails?|inbox|draft|compose)\b/i.test(text) && !/\b(?:book|schedule)\b/i.test(text)) {
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
interface ReferencedMeetingEdit {
  chatId: number;
  text: string;
  confirmation: { chatId: number; messageId: number } | undefined;
  now?: Date;
}

export async function reviseReferencedMeeting(input: ReferencedMeetingEdit): Promise<string | undefined> {
  const result = await tryReviseReferencedMeeting(input);
  return result?.kind === "miss" ? result.note : result?.text;
}

export async function tryReviseReferencedMeeting(input: ReferencedMeetingEdit): Promise<PreRouteResult | undefined> {
  const now = input.now ?? new Date();
  if (explicitEmailField(input.text)) {
    return undefined;
  }
  if (ambiguousSharedReference(input.text, input.chatId, now)) {
    return { kind: "clarification", text: "Do you mean the email draft or the meeting?" };
  }
  const edit = parseAttendeeEdit(input.text);
  if (!edit || !isMeetingAttendeeEdit(input.text, edit, input.chatId, now)) {
    return undefined;
  }
  const pending = getPendingAction(input.chatId, now);
  const cues = meetingCues(referencePhrase(input.text, edit), now);
  if (pending?.status === "open" && pending.meeting && cues.tokens.length === 0 && !namesADay(cues)) {
    const focused = refsFromStore(input.chatId).find((ref) => ref.focused);
    if (focused) {
      return { kind: "clarification", text: `Which meeting? The one still being scheduled, or ${describeMeeting(focused)}?` };
    }
    return undefined;
  }
  const resolved = await resolveMeetingReference({ chatId: input.chatId, text: input.text, edit, now });
  if (resolved.kind === "many") {
    return { kind: "clarification", text: resolved.question };
  }
  if (resolved.kind === "none") {
    return pending?.status === "open" && pending.meeting
      ? undefined
      : routeMiss("I couldn't tell which meeting you mean.", { scope: "read_only" });
  }
  const booked = resolved.ref;
  const current = await currentAttendees(booked);
  if (!current) {
    return routeMiss(`Not changed: I couldn't read the current guest list for ${booked.title}.`, { scope: "read_only" });
  }
  const resolveNew = (name: string): { email: string; name: string } | PreRouteResult => {
    const typed = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.exec(name);
    if (typed) {
      const email = typed[0].toLowerCase();
      const local = email.split("@")[0]?.replace(/[._]+/g, " ").trim() || email;
      rememberContactChoice(local, { name: local, emails: [email], sources: ["known"] });
      return { email, name: local };
    }
    const found = matchOwnerSupplied(input.chatId, name, now);
    if (found.kind === "one") {
      return { email: found.contact.email, name: found.contact.name };
    }
    if (found.kind === "many") {
      return { kind: "clarification", text: `Which ${name}? ${found.contacts.map((item) => item.email).join(", ")}` };
    }
    return routeMiss(`I don't have an address for ${name}.`, { scope: "read_only" });
  };
  let next = current.map((person) => ({ ...person }));
  if (edit.op === "remove") {
    const matched = peopleMatching(edit.name, next);
    if (matched.length === 0) {
      return routeMiss(`${edit.name} is not on ${booked.title}.`, { scope: "read_only" });
    }
    if (matched.length > 1) {
      return { kind: "clarification", text: `Which ${edit.name}? ${matched.map((person) => person.email ? `${person.name} <${person.email}>` : person.name).join(", ")}` };
    }
    next = next.filter((person) => person.resource || person.email !== matched[0]!.email);
  } else if (edit.op === "add") {
    const person = resolveNew(edit.name);
    if ("kind" in person) {
      return person;
    }
    if (next.some((item) => item.email === person.email)) {
      return { kind: "handled", text: `${person.email} is already on ${booked.title}.` };
    }
    next = [...next, { ...person, resource: false }];
  } else {
    const person = resolveNew(edit.to);
    if ("kind" in person) {
      return person;
    }
    const matched = peopleMatching(edit.from, next);
    if (matched.length === 0) {
      return routeMiss(`${edit.from} is not on ${booked.title}.`, { scope: "read_only" });
    }
    if (matched.length > 1) {
      return { kind: "clarification", text: `Which ${edit.from}? ${matched.map((item) => item.email ? `${item.name} <${item.email}>` : item.name).join(", ")}` };
    }
    const without = next.filter((item) => item.resource || item.email !== matched[0]!.email);
    next = without.some((item) => item.email === person.email) ? without : [...without, { ...person, resource: false }];
  }
  const updated = await tryUpdateEventAttendees({
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
  if (updated.kind === "handled") {
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
    const known = new Map(ref.attendees.map((person) => [person.email.toLowerCase(), person.name]));
    const guests = (listed ?? [])
      .map((person) => {
        const email = (person.email ?? "").trim().toLowerCase();
        return {
          email,
          name: (person.displayName || known.get(email) || person.email || "").trim(),
          resource: NOT_A_PERSON.test(person.email ?? ""),
        };
      })
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
interface AttendeeUpdate {
  event: OwnerCalendarEvent;
  attendees: Array<{ email: string; name?: string }>;
  previousEmails?: readonly string[];
  ownerText?: string;
  confirmation: { chatId: number; messageId: number } | undefined;
}

export async function updateEventAttendees(input: AttendeeUpdate): Promise<string> {
  const result = await tryUpdateEventAttendees(input);
  return result.kind === "miss" ? result.note : result.text;
}

async function tryUpdateEventAttendees(input: AttendeeUpdate): Promise<PreRouteResult> {
  try {
    allowOwnerChatAddAttendee(input.confirmation);
  } catch {
    return { kind: "refusal", text: "Not changed: only Vishnu's own chat message can change a meeting's attendees." };
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
    return { kind: "handled", text: `Updated ${input.event.title}. Attendees: ${expected.join(", ")}. The guest list was already that.` };
  }
  const policy = chooseSendUpdates(input.ownerText ?? "", added, removed);
  if ("ask" in policy) {
    return { kind: "clarification", text: policy.ask };
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
      return routeMiss(`Not changed: Google Calendar did not confirm the attendee list for ${input.event.title}.`, { scope: "read_only" });
    }
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.log(`calendar attendee update failed (${errorType})`);
    return routeMiss(`Not changed: Google Calendar refused the update to ${input.event.title}.`, { scope: "read_only" });
  }
  return { kind: "handled", text: `Updated ${input.event.title}. Attendees: ${expected.join(", ")}. ${policy.note}` };
}

type ReusedAttendees =
  | { kind: "none" }
  | { kind: "many"; question: string }
  | { kind: "miss"; note: string }
  | { kind: "one"; title: string; accountId: GoogleAccountId; attendees: Array<{ email: string; name: string }> };

async function reusedAttendees(phrase: string, now: Date): Promise<ReusedAttendees> {
  const request = reuseRequest(phrase, now);
  if (!request) {
    return { kind: "none" };
  }
  let matches = (await listMatchingEvents(request.title, request.date, request.accountId, request.span, now))
    .filter((event) => titleMatches(request.title, event.title))
    .filter((event) => !request.days || request.days.includes(eventDay(event.start)));
  if (matches.length === 0 && request.weekdayTitle) {
    const title = request.weekdayTitle;
    matches = (await listMatchingEvents(title, undefined, request.accountId, undefined, now))
      .filter((event) => titleMatches(title, event.title));
  }
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
    return { kind: "miss", note: `I found ${event.title} but couldn't read its guests, so I didn't copy them.` };
  }
  return { kind: "one", title: event.title, accountId: event.accountId, attendees: peopleFromApi(listed) };
}

/** Attendees of the one meeting Vishnu named for a new booking. An email request is not a booking. */
export async function attendeesForNewMeeting(phrase: string, now = new Date()): Promise<ReusedAttendees> {
  if (!isMeetingBooking(phrase) || isEmailAboutPeople(phrase)) {
    return { kind: "none" };
  }
  return reusedAttendees(phrase, now);
}

/** Attendees to put on an email about a previous meeting. Does not book anything. */
export async function attendeesForEmailDraft(phrase: string, now = new Date()): Promise<ReusedAttendees> {
  if (!isEmailAboutPeople(phrase) || !/\b(?:same people|everyone from)\b/i.test(phrase)) {
    return { kind: "none" };
  }
  return reusedAttendees(phrase, now);
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
