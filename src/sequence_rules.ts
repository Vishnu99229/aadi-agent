import * as chrono from "chrono-node";
const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET = "+05:30";
const WINDOW_START_HOUR = 10;
const WINDOW_END_HOUR = 17;
/** No sequence email leaves outside these IST hours, whatever the prospect's zone. */
const IST_FLOOR_START_HOUR = 9;
const IST_FLOOR_END_HOUR = 19;
/** Their hours for a slot worth offering without him choosing it. */
const DAY_START_HOUR = 8;
const DAY_END_HOUR = 20;
/** The pattern repeats weekly, so a week and a day finds any window there is. */
const WINDOW_SCAN_MINUTES = 8 * 24 * 60;
const OOO_DEFAULT_DAYS = 3;
const OOO_MAX_DAYS = 90;
/** A step stuck in sending this long with nothing in Gmail never went out. */
export const STALE_CLAIM_MS = 30 * 60 * 1000;
/** Time for an approved blocked step to be recorded before it can look like his
 *  own email. */
const BLOCKED_SEND_GRACE_MS = 2 * 60 * 1000;

function parseOffset(value: string): number | undefined {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    return undefined;
  }
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

/** "+HH:MM" from an RFC 5322 Date header, taken literally, +0000 included. -0000
 *  means no information by definition (RFC 5322 3.3), and a named zone such as
 *  "GMT" has no numeric offset to read, so both are unknown. */
export function parseDateHeaderOffset(date: string): string | undefined {
  const match = /([+-])(\d{2})(\d{2})\s*(?:\([^)]*\)\s*)?$/.exec(date.trim());
  if (!match) {
    return undefined;
  }
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (hours > 14 || minutes > 59 || (match[1] === "-" && hours === 0 && minutes === 0)) {
    return undefined;
  }
  return `${match[1]}${match[2]}:${match[3]}`;
}

function offsetMinutes(timezone: string | null | undefined): number {
  return parseOffset(timezone ?? "") ?? (parseOffset(IST_OFFSET) as number);
}

/** The zone to show beside IST on a slot line. None when it would repeat IST. */
export function slotDisplayZone(timezone: string | null | undefined): string | null {
  return timezone && timezone !== IST_OFFSET && parseOffset(timezone) !== undefined
    ? timezone
    : null;
}

function localClock(at: Date, offset: number): { weekday: number; minutes: number } {
  const local = new Date(at.getTime() + offset * 60_000);
  return { weekday: local.getUTCDay(), minutes: local.getUTCHours() * 60 + local.getUTCMinutes() };
}

/** Mon-Fri 10:00-17:00 in the prospect's zone (IST when it is unknown), and also
 *  09:00-19:00 IST, whatever their zone. */
export function inSendWindow(at: Date, timezone: string | null | undefined): boolean {
  const theirs = localClock(at, offsetMinutes(timezone));
  const ist = localClock(at, offsetMinutes(IST_OFFSET));
  return (
    theirs.weekday >= 1 &&
    theirs.weekday <= 5 &&
    theirs.minutes >= WINDOW_START_HOUR * 60 &&
    theirs.minutes < WINDOW_END_HOUR * 60 &&
    ist.minutes >= IST_FLOOR_START_HOUR * 60 &&
    ist.minutes < IST_FLOOR_END_HOUR * 60
  );
}

/** The first moment at or after this one that a step may go out. Undefined when
 *  their working day never meets the IST floor, which is -03:30 and further west. */
export function nextSendWindow(
  at: Date,
  timezone: string | null | undefined,
): Date | undefined {
  if (inSendWindow(at, timezone)) {
    return at;
  }
  const firstMinute = Math.floor(at.getTime() / 60_000) + 1;
  for (let minute = 0; minute < WINDOW_SCAN_MINUTES; minute += 1) {
    const candidate = new Date((firstMinute + minute) * 60_000);
    if (inSendWindow(candidate, timezone)) {
      return candidate;
    }
  }
  return undefined;
}

/** How many of these slots sit wholly inside 08:00-20:00 in their zone. */
export function slotsInProspectDay(
  slots: ReadonlyArray<{ start: Date; end: Date }>,
  timezone: string | null | undefined,
): number {
  const offset = offsetMinutes(timezone);
  return slots.filter((slot) => {
    const start = localClock(slot.start, offset);
    const end = localClock(slot.end, offset);
    return (
      start.weekday === end.weekday &&
      start.minutes >= DAY_START_HOUR * 60 &&
      end.minutes <= DAY_END_HOUR * 60
    );
  }).length;
}

/** Midnight IST at the start of this moment's IST day, for the daily cap. */
export function istDayStart(at: Date): Date {
  const offset = offsetMinutes(IST_OFFSET);
  const local = new Date(at.getTime() + offset * 60_000);
  return new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) -
      offset * 60_000,
  );
}

/** The newest part of a reply: quoted text is Vishnu's own words coming back. */
export function topReplyText(body: string): string {
  const lines: string[] = [];
  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    const text = line.trim();
    if (
      /^on\b.*\bwrote:$/i.test(text) ||
      /^-{2,}\s*original message\s*-{2,}$/i.test(text) ||
      /^from:\s.+/i.test(text) ||
      /^_{5,}$/.test(text)
    ) {
      break;
    }
    if (!text.startsWith(">")) {
      lines.push(line);
    }
  }
  return lines.join("\n").trim();
}

export interface InboundFact {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  autoSubmitted: string;
  autoReplyHeader: boolean;
  precedence: string;
  listUnsubscribe: boolean;
  /** Full body, quoted text removed by classifyInbound. */
  body: string;
  at: number;
}

export type InboundKind = "bounce" | "out_of_office" | "do_not_contact" | "reply";

const OOO_SUBJECT =
  /^(?:automatic reply|auto(?:matic)?[- ]?(?:reply|response)|autoreply|out of (?:the )?office|ooo\b|auto:|away from)/i;
const LEFT_COMPANY =
  /\bno longer (?:with|at|work|employed)|\bhas left\b|\bleft the company\b/i;
const DO_NOT_CONTACT =
  /\bnot interested\b|\bremove me\b|\bunsubscribe\b|\bstop (?:emailing|mailing|contacting|sending)\b|\bdo(?:n't|n’t| not) (?:email|contact)\b/i;

/** Out-of-office is decided first, so an auto-reply never reads as a real reply.
 *  It takes an auto-reply header or subject: a person typing "I'm away until
 *  Monday" is a reply, and stopping is the safe way to be wrong. */
export function classifyInbound(message: InboundFact): InboundKind {
  if (/^(?:mailer-daemon|postmaster)@/i.test(message.from)) {
    return "bounce";
  }
  const top = topReplyText(message.body);
  const autoReply =
    message.autoSubmitted.toLowerCase().startsWith("auto-replied") ||
    message.autoReplyHeader ||
    message.precedence.toLowerCase() === "auto_reply" ||
    OOO_SUBJECT.test(message.subject.trim());
  if (autoReply && !LEFT_COMPANY.test(top)) {
    return "out_of_office";
  }
  const bulk =
    message.listUnsubscribe || ["bulk", "list"].includes(message.precedence.toLowerCase());
  return !bulk && DO_NOT_CONTACT.test(top) ? "do_not_contact" : "reply";
}

/** The return date an out-of-office states, as 10:00 in their zone, or a few days
 *  out when it states none. Never earlier than the message, never absurdly far. */
export function outOfOfficeUntil(
  message: Pick<InboundFact, "body" | "at">,
  timezone: string | null | undefined,
): Date {
  const reference = new Date(message.at);
  const fallback = new Date(message.at + OOO_DEFAULT_DAYS * DAY_MS);
  const sentences = topReplyText(message.body)
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((sentence) => /\b(?:until|till|return|back|resum|away|out of)/i.test(sentence));
  let latest: Date | undefined;
  const offset = offsetMinutes(timezone);
  for (const sentence of sentences) {
    for (const parsed of chrono.parse(sentence, reference, { forwardDate: true })) {
      const end = parsed.end ?? parsed.start;
      const year = end.get("year");
      const month = end.get("month");
      const day = end.get("day");
      if (year === null || month === null || day === null) {
        continue;
      }
      const at = new Date(
        Date.UTC(year, month - 1, day, WINDOW_START_HOUR) - offset * 60_000,
      );
      if (at.getTime() > message.at && (!latest || at > latest)) {
        latest = at;
      }
    }
  }
  if (!latest) {
    return fallback;
  }
  const furthest = new Date(message.at + OOO_MAX_DAYS * DAY_MS);
  return latest > furthest ? furthest : latest;
}

export interface OwnSendFact {
  id: string;
  threadId: string;
  at: number;
}

export interface StopFacts {
  now: Date;
  threadId: string;
  timezone: string | null;
  blockedParty: boolean;
  doNotContact: boolean;
  bounced: boolean;
  inbound: InboundFact[];
  meeting: boolean;
  /** His sent mail to the prospect since enrolment, recorded steps removed. */
  ownSends: OwnSendFact[];
  /** A colleague wrote on the sequence's thread since enrolment. */
  colleagueOnThread: boolean;
  /** A step claimed for sending that never got recorded. */
  claimed?: { stepNo: number; claimedAt: number };
  /** Paused on a blocked card. */
  pausedOnCard: boolean;
}

export type StopDecision =
  | { action: "none" }
  | { action: "postpone"; until: Date }
  | {
      action: "stop";
      reason:
        | "partner_domain"
        | "do_not_contact"
        | "bounced"
        | "replied"
        | "meeting_booked"
        | "own_email"
        | "colleague_on_thread"
        | "send_unconfirmed"
        | "send_recovered";
      /** Sender addresses to mark do-not-contact as well as the prospect. */
      doNotContact?: string[];
      recovered?: { stepNo: number; message: OwnSendFact };
      unconfirmedStep?: number;
    };

/** Every stop rule on one sequence. Each message is sorted by classifyInbound
 *  before any rule reads it, which is what keeps out-of-office ahead of the reply
 *  stop. A real reply still wins over an earlier out-of-office. */
export function evaluateStopRules(facts: StopFacts): StopDecision {
  if (facts.blockedParty) {
    return { action: "stop", reason: "partner_domain" };
  }
  if (facts.doNotContact) {
    return { action: "stop", reason: "do_not_contact" };
  }
  const kinds = facts.inbound.map((message) => ({ message, kind: classifyInbound(message) }));
  if (facts.bounced || kinds.some((item) => item.kind === "bounce")) {
    return { action: "stop", reason: "bounced" };
  }
  const refusals = kinds.filter((item) => item.kind === "do_not_contact");
  if (refusals.length > 0) {
    return {
      action: "stop",
      reason: "do_not_contact",
      doNotContact: refusals.map((item) => item.message.from),
    };
  }
  if (kinds.some((item) => item.kind === "reply")) {
    return { action: "stop", reason: "replied" };
  }
  if (facts.meeting) {
    return { action: "stop", reason: "meeting_booked" };
  }
  const graceFloor = facts.now.getTime() - BLOCKED_SEND_GRACE_MS;
  const own = facts.pausedOnCard
    ? facts.ownSends.filter((message) => message.at <= graceFloor)
    : facts.ownSends;
  if (facts.claimed) {
    const { stepNo, claimedAt } = facts.claimed;
    const delivered = own.find(
      (message) => message.threadId === facts.threadId && message.at >= claimedAt - 60_000,
    );
    if (delivered) {
      return {
        action: "stop",
        reason: "send_recovered",
        recovered: { stepNo, message: delivered },
      };
    }
  }
  if (own.length > 0) {
    return { action: "stop", reason: "own_email" };
  }
  if (facts.colleagueOnThread) {
    return { action: "stop", reason: "colleague_on_thread" };
  }
  if (facts.claimed && facts.now.getTime() - facts.claimed.claimedAt >= STALE_CLAIM_MS) {
    return { action: "stop", reason: "send_unconfirmed", unconfirmedStep: facts.claimed.stepNo };
  }
  const away = kinds.filter((item) => item.kind === "out_of_office");
  if (away.length > 0) {
    const until = away
      .map((item) => outOfOfficeUntil(item.message, facts.timezone))
      .reduce((left, right) => (right > left ? right : left));
    return { action: "postpone", until };
  }
  return { action: "none" };
}

export interface StopTargetRow {
  id: number;
  prospect_email: string;
  prospect_domain: string;
  prospect_name: string;
  prospect_company: string;
}

export type StopMatch<T> =
  | { kind: "all"; rows: T[] }
  | { kind: "one"; rows: T[] }
  | { kind: "none"; rows: T[] }
  | { kind: "ambiguous"; rows: T[] };

function squash(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function hasWholeWords(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(haystack);
}

const ALL_TARGET =
  /^(?:all|everyone|everybody|every one|all of them|(?:all|every|all the)\s+(?:(?:follow[\s-]*ups?|sequences?|prospects?)\s*)+)$/i;

/** Names a word at a time, so "Raj" doesn't stop Rajan. More than one match is
 *  the caller's cue to ask, unless he said "all". */
export function matchSequencesForStop<T extends StopTargetRow>(
  rows: T[],
  rawTarget: string,
): StopMatch<T> {
  const target = rawTarget.trim().replace(/\s+/g, " ");
  if (ALL_TARGET.test(target)) {
    return { kind: "all", rows };
  }
  if (!target) {
    return { kind: "none", rows: [] };
  }
  const lower = target.toLowerCase();
  const matched = rows.filter((row) => {
    if (lower.includes("@")) {
      return row.prospect_email === lower;
    }
    if (lower.includes(".") && !lower.includes(" ")) {
      return row.prospect_domain === lower;
    }
    return (
      hasWholeWords(row.prospect_name, target) ||
      hasWholeWords(row.prospect_company, target) ||
      (squash(target) !== "" && squash(target) === squash(row.prospect_company))
    );
  });
  if (matched.length === 0) {
    return { kind: "none", rows: [] };
  }
  return { kind: matched.length === 1 ? "one" : "ambiguous", rows: matched };
}

/** A name that needs quoting or encoding is dropped: the address is what counts. */
export function sequenceRecipient(row: {
  prospect_name: string;
  prospect_email: string;
}): string {
  return /^[A-Za-z][A-Za-z .'-]*$/.test(row.prospect_name.trim())
    ? `${row.prospect_name.trim()} <${row.prospect_email}>`
    : row.prospect_email;
}
