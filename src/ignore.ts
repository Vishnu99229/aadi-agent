/**
 * Central ignore registry. One SQLite table, deterministic matching, no LLM
 * on the suppression path. Vishnu's own chat or a Telegram tap may write;
 * emails, forwards, A2A and background jobs may only read.
 */
import { canonicalBiller, normalizeBillerKey } from "./bill_aliases.js";
import {
  createReminder,
  expireDueIgnoreRules,
  getAccounts,
  getActiveIgnoreRuleByKey,
  getActiveIgnoreRuleByRecord,
  getBill,
  getBills,
  getIgnoreRule,
  getImportantDates,
  getReminder,
  getReminders,
  getTask,
  getTasks,
  insertIgnoreRule,
  listActiveIgnoreRules,
  markIgnoreRuleResumed,
  recordIgnoreRuleEvent,
  restoreIgnoreOwnedBill,
  transitionReminderStatus,
  type BillRecord,
  type IgnoreDuration,
  type IgnoreEntityType,
  type IgnoreMatchScope,
  type IgnoreRuleRecord,
  type IgnoreTag,
  type ItemTag,
  type ReminderRecord,
  type ReminderRecurrence,
  type TaskRecord,
} from "./db.js";

const TIME_ZONE = "Asia/Kolkata";

export type IgnoreSubject = {
  entityType: IgnoreEntityType;
  entityId?: string | number | null;
  matchKey: string;
  tag?: ItemTag;
  aliases?: readonly string[];
  relatedBillId?: number | null;
  relatedTaskId?: number | null;
  fromHeader?: string;
  /** Recurring reminders only: the stable schedule id. */
  seriesId?: number | null;
};

export type IgnoreApplyInput = {
  entityType: IgnoreEntityType;
  matchKey: string;
  matchScope: IgnoreMatchScope;
  tag: IgnoreTag;
  entityId?: string | null;
  duration?: IgnoreDuration;
  expiresAt?: string | null;
  instruction: string;
  authRef: string;
  reason?: string | null;
};

export type IgnoreApplyResult =
  | { kind: "created"; rule: IgnoreRuleRecord; duplicate: false }
  | { kind: "duplicate"; rule: IgnoreRuleRecord; duplicate: true };

/** One item a clarifying "which one?" question listed, ready to ignore as shown. */
export type IgnoreCandidate = {
  /** The line as he saw it. */
  label: string;
  /** The words his answer can name it by ("LinkedIn", "Facebook"). */
  names: string;
  /** How the confirmation names it. */
  confirmLabel: string;
  input: Omit<IgnoreApplyInput, "instruction" | "authRef">;
};

export type IgnoreResolveResult =
  | { kind: "apply"; input: Omit<IgnoreApplyInput, "instruction" | "authRef">; label: string }
  | { kind: "clarify"; question: string; candidates?: IgnoreCandidate[] }
  | { kind: "none"; message: string };

const SOURCE_ALIASES: Record<string, readonly string[]> = {
  aws: ["aws", "amazon web services", "amazon web service"],
  "amazon web services": ["aws", "amazon web services", "amazon web service"],
  "google workspace": ["google workspace", "g suite", "gsuite"],
  gsuite: ["google workspace", "g suite", "gsuite"],
  linkedin: ["linkedin"],
  anthropic: ["anthropic", "anthropic claude"],
  goibibo: ["goibibo"],
};

let cachedActive: IgnoreRuleRecord[] | null = null;
let cachedAt = 0;
const CACHE_MS = 5_000;

export function invalidateIgnoreCache(): void {
  cachedActive = null;
  cachedAt = 0;
}

function nowIso(now = new Date()): string {
  return now.toISOString();
}

export function kolkataYmd(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function kolkataWeekday(now: Date): number {
  const name = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    timeZone: TIME_ZONE,
  }).format(now);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
}

export function normalizeIgnoreKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function keyIsSpecific(key: string): boolean {
  const tokens = key.split(" ").filter(Boolean);
  return tokens.some((token) => token.length >= 3) && key.length >= 3;
}

function expandAliases(key: string): string[] {
  const keys = new Set<string>([key]);
  const mapped = SOURCE_ALIASES[key];
  if (mapped) {
    for (const alias of mapped) {
      keys.add(alias);
    }
  }
  return [...keys];
}

function phraseMatches(ruleKey: string, candidate: string): boolean {
  if (!ruleKey || !candidate) {
    return false;
  }
  if (ruleKey === candidate) {
    return true;
  }
  const padded = ` ${candidate} `;
  if (padded.includes(` ${ruleKey} `)) {
    return true;
  }
  return candidate.startsWith(`${ruleKey} `) || candidate.endsWith(` ${ruleKey}`);
}

/** Words that name nothing: a rule "three linkedin" or "axis bank alerts" still means that source. */
const RULE_NOISE = new Set([
  "a", "an", "the", "my", "all", "both", "every", "each", "these", "those", "this", "that", "of", "and", "for",
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "first", "second", "third",
  "bill", "bills", "payment", "payments", "charge", "charges", "invoice", "invoices", "subscription", "subscriptions",
  "renewal", "renewals", "reminder", "reminders", "alert", "alerts", "notification", "notifications",
  "email", "emails", "mail", "mails", "monthly", "yearly", "annual", "recurring",
]);

/** The longer key adds only noise to the shorter one ("three linkedin" over "linkedin"). */
function addsOnlyNoise(longer: string, shorter: string): boolean {
  const base = new Set(shorter.split(" "));
  return longer.split(" ").every((word) => base.has(word) || RULE_NOISE.has(word) || /^\d+$/.test(word));
}

/**
 * "lookup" (finding a rule or an item by his words) matches a part of a name either
 * way, so "resume linkedin bills" finds a rule for "google play linkedin ...".
 * "suppress" (does this rule hide this item) is directional: the item names the
 * rule's source, or the rule is the item plus noise words. A rule for
 * "google play linkedin ..." does not hide every "google play" bill.
 */
type OverlapMode = "lookup" | "suppress";

function keysOverlap(
  ruleKey: string,
  candidate: string,
  aliases: readonly string[] = [],
  mode: OverlapMode = "lookup",
): boolean {
  const ruleKeys = expandAliases(ruleKey);
  const candidateKeys = [
    candidate,
    ...expandAliases(candidate),
    ...aliases.map((alias) => normalizeIgnoreKey(alias)),
  ];
  for (const left of ruleKeys) {
    for (const right of candidateKeys) {
      if (phraseMatches(left, right) || (phraseMatches(right, left) && (mode === "lookup" || addsOnlyNoise(left, right)))) {
        return true;
      }
    }
  }
  return false;
}

function tagMatches(ruleTag: IgnoreTag, subjectTag?: ItemTag): boolean {
  if (ruleTag === "both" || !subjectTag) {
    return true;
  }
  return ruleTag === subjectTag;
}

function activeRules(now = new Date()): IgnoreRuleRecord[] {
  const expired = expireDueIgnoreRules(nowIso(now));
  if (expired.length > 0) {
    invalidateIgnoreCache();
  }
  for (const rule of expired) {
    restoreAfterIgnore(rule, expiryBoundary(rule, now));
  }
  const stamp = Date.now();
  if (expired.length === 0 && cachedActive && stamp - cachedAt < CACHE_MS) {
    return cachedActive;
  }
  cachedActive = listActiveIgnoreRules();
  cachedAt = stamp;
  return cachedActive;
}

/**
 * An expired rule stopped hiding things at expires_at, not when we noticed.
 * Settle against that instant: occurrences due before it were suppressed and
 * are dropped; anything due after it was never hidden, so it stays pending
 * and the scheduler delivers it (as "missed while offline" after a restart).
 */
function expiryBoundary(rule: IgnoreRuleRecord, now: Date): Date {
  const at = rule.expires_at ? new Date(rule.expires_at) : now;
  if (Number.isNaN(at.getTime()) || at.getTime() > now.getTime()) {
    return now;
  }
  return at;
}

/** Expire temporary rules and restore what they were suppressing. */
export function refreshIgnoreRules(now = new Date()): void {
  activeRules(now);
}

type PreparedSubject = {
  subject: IgnoreSubject;
  matchKey: string;
  entityId: string;
  aliases: string[];
};

function prepareSubject(subject: IgnoreSubject): PreparedSubject {
  const matchKey = normalizeIgnoreKey(subject.matchKey);
  const entityId =
    subject.entityId === undefined || subject.entityId === null
      ? ""
      : String(subject.entityId);
  const aliases = (subject.aliases ?? []).map((alias) => normalizeIgnoreKey(alias));
  if (subject.fromHeader) {
    aliases.push(normalizeIgnoreKey(subject.fromHeader));
    const email = subject.fromHeader.match(/<([^>]+)>/)?.[1] ?? subject.fromHeader;
    const domain = email.includes("@") ? email.split("@")[1] : "";
    if (domain) {
      aliases.push(normalizeIgnoreKey(domain));
    }
  }
  return { subject, matchKey, entityId, aliases };
}

/**
 * The one answer to "does this rule cover this item". Suppression and
 * restoration both use it, so ending a rule settles exactly what it hid:
 * same tag, same entity type, same record or series, same keys.
 */
function ruleCoversSubject(rule: IgnoreRuleRecord, prepared: PreparedSubject): boolean {
  const { subject, matchKey, entityId, aliases } = prepared;
  if (!tagMatches(rule.tag, subject.tag)) {
    return false;
  }
  if (rule.entity_type !== subject.entityType) {
    if (
      !(
        (rule.entity_type === "notification" &&
          (subject.entityType === "bill" || subject.entityType === "email_source")) ||
        (rule.entity_type === "email_source" && subject.entityType === "notification")
      )
    ) {
      return false;
    }
  }
  if (rule.match_scope === "record") {
    if (entityId && rule.entity_id === entityId) {
      return true;
    }
    return (
      subject.entityType === "reminder" &&
      subject.seriesId != null &&
      recordRuleSeriesId(rule) === subject.seriesId
    );
  }
  return keysOverlap(rule.match_key, matchKey, aliases, "suppress");
}

/**
 * Would a rule made for `rule` also hide `other`? The suppression matcher, on
 * two items of a shown list: a "Google Play" rule also hides "Google Play
 * (LinkedIn ...)".
 */
export function ignoreInputCovers(rule: IgnoreCandidate["input"], other: IgnoreCandidate): boolean {
  if (rule.entityType !== other.input.entityType) {
    return false;
  }
  if (rule.matchScope === "record") {
    return rule.entityId != null && String(rule.entityId) === String(other.input.entityId ?? "");
  }
  return keysOverlap(normalizeIgnoreKey(rule.matchKey), normalizeIgnoreKey(other.input.matchKey), [other.names], "suppress");
}

export function matchingIgnoreRule(
  subject: IgnoreSubject,
  now = new Date(),
): IgnoreRuleRecord | undefined {
  const prepared = prepareSubject(subject);
  return activeRules(now).find((rule) => ruleCoversSubject(rule, prepared));
}

/**
 * A record rule on a recurring reminder stands for its whole schedule, so it
 * keeps matching after the scheduler or a restore writes the next occurrence.
 * One-time reminders have no series and stay matched by exact id.
 */
function recordRuleSeriesId(rule: IgnoreRuleRecord): number | null {
  if (rule.entity_type !== "reminder" || rule.match_scope !== "record" || !rule.entity_id) {
    return null;
  }
  const target = getReminder(Number(rule.entity_id));
  if (!target || target.recurrence === "none") {
    return null;
  }
  return target.series_id;
}

function reminderSeriesId(reminder: ReminderRecord): number | null {
  return reminder.recurrence === "none" ? null : reminder.series_id;
}

export function isIgnored(subject: IgnoreSubject, now = new Date()): boolean {
  return matchingIgnoreRule(subject, now) !== undefined;
}

function billSubject(bill: BillRecord): IgnoreSubject {
  const canonical = canonicalBiller(bill.biller);
  return {
    entityType: "bill",
    entityId: bill.id,
    matchKey: normalizeBillerKey(canonical),
    tag: "personal",
    aliases: [bill.biller, canonical, normalizeBillerKey(bill.biller)],
  };
}

function taskSubject(task: TaskRecord): IgnoreSubject {
  return {
    entityType: "task",
    entityId: task.id,
    matchKey: normalizeIgnoreKey(task.text.replace(/^promise:\s*/i, "")),
    tag: task.tag,
    aliases: [task.text],
  };
}

function reminderSubject(reminder: ReminderRecord): IgnoreSubject {
  return {
    entityType: "reminder",
    entityId: reminder.id,
    matchKey: reminder.text,
    tag: reminder.tag,
    seriesId: reminderSeriesId(reminder),
  };
}

export function billIsIgnored(bill: BillRecord, now = new Date()): boolean {
  return isIgnored(billSubject(bill), now);
}

export function taskIsIgnored(task: TaskRecord, now = new Date()): boolean {
  return isIgnored(taskSubject(task), now);
}

export function reminderIsIgnored(reminder: ReminderRecord, now = new Date()): boolean {
  if (isIgnored(reminderSubject(reminder), now)) {
    return true;
  }
  if (reminder.related_bill_id) {
    const bill = getBill(reminder.related_bill_id);
    if (bill && billIsIgnored(bill, now)) {
      return true;
    }
  }
  if (reminder.related_task_id) {
    const task = getTask(reminder.related_task_id);
    if (task && taskIsIgnored(task, now)) {
      return true;
    }
  }
  return false;
}

export function dateIsIgnored(
  record: { id: number; person: string; type: string },
  now = new Date(),
): boolean {
  return isIgnored(
    {
      entityType: "date",
      entityId: record.id,
      matchKey: `${record.person} ${record.type}`,
      aliases: [record.person],
    },
    now,
  );
}

export function accountIsIgnored(
  account: { id: number; name: string },
  now = new Date(),
): boolean {
  return isIgnored(
    {
      entityType: "account",
      entityId: account.id,
      matchKey: account.name,
      tag: "work",
      aliases: [account.name],
    },
    now,
  );
}

export function calendarEventIsIgnored(
  title: string,
  tag?: ItemTag,
  now = new Date(),
): boolean {
  return isIgnored(
    {
      entityType: "calendar_event",
      matchKey: title,
      tag,
    },
    now,
  );
}

export function buildNotificationIsIgnored(
  text: string,
  buildId?: number,
  now = new Date(),
): boolean {
  return isIgnored(
    {
      entityType: "build",
      entityId: buildId,
      matchKey: text,
    },
    now,
  );
}

export function emailSourceIsIgnored(input: {
  fromHeader?: string;
  subject?: string;
  tag?: ItemTag;
  now?: Date;
}): boolean {
  const now = input.now ?? new Date();
  const from = input.fromHeader ?? "";
  const subject = input.subject ?? "";
  return isIgnored(
    {
      entityType: "email_source",
      matchKey: `${from} ${subject}`,
      tag: input.tag,
      fromHeader: from,
      aliases: [from, subject],
    },
    now,
  );
}

export function applyIgnore(input: IgnoreApplyInput): IgnoreApplyResult {
  const matchKey = normalizeIgnoreKey(input.matchKey);
  if (!keyIsSpecific(matchKey)) {
    throw new Error("Ignore target is too broad. Name the bill, task, reminder or source.");
  }
  const existing = activeRuleFor(input, matchKey);
  if (existing) {
    recordIgnoreRuleEvent(
      existing.id,
      "duplicate",
      input.authRef,
      input.instruction,
      null,
    );
    return { kind: "duplicate", rule: existing, duplicate: true };
  }
  const duration: IgnoreDuration =
    input.duration ?? (input.expiresAt ? "temporary" : "permanent");
  const rule = insertIgnoreRule({
    tag: input.tag,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    matchKey,
    matchScope: input.matchScope,
    duration,
    expiresAt: duration === "temporary" ? input.expiresAt ?? null : null,
    instruction: input.instruction,
    authRef: input.authRef,
    reason: input.reason ?? null,
  });
  if (!rule) {
    const raced = activeRuleFor(input, matchKey);
    if (raced) {
      recordIgnoreRuleEvent(
        raced.id,
        "duplicate",
        input.authRef,
        input.instruction,
        null,
      );
      return { kind: "duplicate", rule: raced, duplicate: true };
    }
    throw new Error("Could not save the ignore rule.");
  }
  recordIgnoreRuleEvent(rule.id, "created", input.authRef, input.instruction, null);
  invalidateIgnoreCache();
  return { kind: "created", rule, duplicate: false };
}

function activeRuleFor(
  input: Pick<IgnoreApplyInput, "entityType" | "matchScope" | "tag" | "entityId">,
  matchKey: string,
): IgnoreRuleRecord | undefined {
  if (input.matchScope === "record" && input.entityId) {
    const exact = getActiveIgnoreRuleByRecord(
      input.entityType,
      String(input.entityId),
      input.matchScope,
      input.tag,
    );
    if (exact || input.entityType !== "reminder") {
      return exact;
    }
    const target = getReminder(Number(input.entityId));
    const seriesId = target ? reminderSeriesId(target) : null;
    if (seriesId == null) {
      return undefined;
    }
    return listActiveIgnoreRules().find(
      (rule) =>
        rule.entity_type === "reminder" &&
        rule.match_scope === "record" &&
        rule.tag === input.tag &&
        recordRuleSeriesId(rule) === seriesId,
    );
  }
  return getActiveIgnoreRuleByKey(
    input.entityType,
    matchKey,
    input.matchScope,
    input.tag,
  );
}

export function resumeIgnore(
  ruleId: number,
  authRef: string,
  instruction = "",
  now = new Date(),
): IgnoreRuleRecord | undefined {
  const rule = getIgnoreRule(ruleId);
  if (!rule || rule.status !== "active") {
    return undefined;
  }
  const at = nowIso(now);
  if (!markIgnoreRuleResumed(ruleId, at)) {
    return undefined;
  }
  recordIgnoreRuleEvent(ruleId, "resumed", authRef, instruction || null, null);
  invalidateIgnoreCache();
  const resumed = getIgnoreRule(ruleId);
  if (resumed) {
    restoreAfterIgnore(resumed, now);
  }
  return resumed;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Resume and temporary expiry share this. It runs after the rule is marked
 * ended, so every check below sees only the rules still active.
 *
 * Restoring never makes anything deliverable by itself. It cancels missed
 * occurrences and writes the next one in the same series; the scheduler then
 * checks every active rule again before sending (processDue, deliverReminder).
 * A rule that still covers the reminder, its series, task, bill or text keeps
 * the new occurrence suppressed.
 */
export function restoreAfterIgnore(rule: IgnoreRuleRecord, now = new Date()): void {
  if (
    rule.entity_type === "bill" &&
    rule.match_scope === "record" &&
    rule.entity_id
  ) {
    // Resume lifts the registry rule. The bill's own state changes only when
    // provenance shows the old card Ignore made it; a skip or duplicate wins.
    restoreIgnoreOwnedBill(Number(rule.entity_id));
  }
  if (rule.entity_type === "bill") {
    restoreBillReminders(rule, now);
    return;
  }
  if (rule.entity_type === "task") {
    restoreTaskReminders(rule, now);
    return;
  }
  if (rule.entity_type === "reminder") {
    restoreReminderRules(rule, now);
  }
}

/** Restore only what the rule suppressed: the same predicate, tag included. */
function billMatchesRule(bill: BillRecord, rule: IgnoreRuleRecord): boolean {
  return ruleCoversSubject(rule, prepareSubject(billSubject(bill)));
}

function taskMatchesRule(task: TaskRecord, rule: IgnoreRuleRecord): boolean {
  return ruleCoversSubject(rule, prepareSubject(taskSubject(task)));
}

function addDaysYmd(ymd: string, days: number): string {
  const date = new Date(`${ymd}T12:00:00+05:30`);
  date.setDate(date.getDate() + days);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function nineAmKolkataIso(dateYmd: string): string {
  return new Date(`${dateYmd}T09:00:00+05:30`).toISOString();
}

function billReminderText(bill: BillRecord): string {
  const amount =
    bill.amount === null ? "amount unknown" : `${bill.currency} ${bill.amount}`;
  return (
    `Bill due: ${bill.biller} for ${amount}. ` +
    `Due on ${bill.due_date}. Tap Done when paid.`
  );
}

function sameInstant(left: string, right: string): boolean {
  return new Date(left).getTime() === new Date(right).getTime();
}

function explicitlyStopped(reminder: ReminderRecord): boolean {
  return (
    reminder.status === "cancelled" &&
    (reminder.status_reason === "user" || reminder.status_reason === "completion")
  );
}

function restoreBillReminders(rule: IgnoreRuleRecord, now: Date): void {
  for (const bill of getBills()) {
    if (bill.status !== "upcoming" || !billMatchesRule(bill, rule)) {
      continue;
    }
    const linked = () =>
      getReminders().filter((reminder) => reminder.related_bill_id === bill.id);
    for (const offset of [-3, -1, 0]) {
      const slot = nineAmKolkataIso(addDaysYmd(bill.due_date, offset));
      const at = new Date(slot).getTime();
      const same = linked().filter((reminder) => sameInstant(reminder.remind_at, slot));
      if (at <= now.getTime()) {
        for (const reminder of same) {
          if (reminder.status === "pending") {
            transitionReminderStatus(reminder.id, "pending", "cancelled", "ignore");
          }
        }
        continue;
      }
      if (same.some((reminder) => reminder.status === "pending")) {
        continue;
      }
      if (same.some((reminder) => explicitlyStopped(reminder))) {
        continue;
      }
      createReminder(billReminderText(bill), "personal", slot, "none", {
        relatedBillId: bill.id,
      });
    }
    for (const reminder of linked()) {
      if (
        reminder.status === "pending" &&
        new Date(reminder.remind_at).getTime() <= now.getTime()
      ) {
        transitionReminderStatus(reminder.id, "pending", "cancelled", "ignore");
      }
    }
  }
}

function restoreTaskReminders(rule: IgnoreRuleRecord, now: Date): void {
  for (const task of getTasks()) {
    if (task.status !== "open" || !taskMatchesRule(task, rule)) {
      continue;
    }
    settleMatchedReminders(
      getReminders().filter((reminder) => reminder.related_task_id === task.id),
      now,
    );
  }
}

/** Same match a reminder rule used while it was active, including linked rows. */
function ruleSuppressesReminder(rule: IgnoreRuleRecord, reminder: ReminderRecord): boolean {
  return (
    rule.entity_type === "reminder" &&
    ruleCoversSubject(rule, prepareSubject(reminderSubject(reminder)))
  );
}

function restoreReminderRules(rule: IgnoreRuleRecord, now: Date): void {
  settleMatchedReminders(
    getReminders().filter((reminder) => ruleSuppressesReminder(rule, reminder)),
    now,
  );
}

function seriesKey(reminder: ReminderRecord): string {
  return reminder.series_id == null ? `row:${reminder.id}` : `series:${reminder.series_id}`;
}

function settleMatchedReminders(reminders: readonly ReminderRecord[], now: Date): void {
  const groups = new Map<string, ReminderRecord[]>();
  for (const reminder of reminders) {
    const key = reminder.recurrence === "none" ? `row:${reminder.id}` : seriesKey(reminder);
    const group = groups.get(key) ?? [];
    group.push(reminder);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group[0]?.recurrence === "none") {
      settleOneShot(getReminder(group[0]!.id) ?? group[0]!, now);
    } else {
      settleSeries(group, now);
    }
  }
}

function settleOneShot(reminder: ReminderRecord, now: Date): void {
  const at = new Date(reminder.remind_at).getTime();
  if (reminder.status === "pending" && at <= now.getTime()) {
    transitionReminderStatus(reminder.id, "pending", "cancelled", "ignore");
  }
}

function nextFutureAt(
  remindAt: string,
  recurrence: ReminderRecurrence,
  now: Date,
): string | undefined {
  if (recurrence === "none") {
    return undefined;
  }
  let candidate = new Date(remindAt);
  const increment = recurrence === "weekly" ? 7 * ONE_DAY_MS : ONE_DAY_MS;
  for (let step = 0; step < 4000; step += 1) {
    candidate = new Date(candidate.getTime() + increment);
    if (candidate.getTime() <= now.getTime()) {
      continue;
    }
    if (recurrence === "weekdays") {
      const day = kolkataWeekday(candidate);
      if (day === 0 || day === 6) {
        continue;
      }
    }
    return candidate.toISOString();
  }
  return undefined;
}

function settleSeries(group: readonly ReminderRecord[], now: Date): void {
  const fresh = group
    .map((reminder) => getReminder(reminder.id))
    .filter((reminder): reminder is ReminderRecord => reminder !== undefined);
  if (fresh.length === 0) {
    return;
  }
  const stopped = fresh.some((reminder) => explicitlyStopped(reminder));
  const pending = fresh.filter((reminder) => reminder.status === "pending");
  const future = pending
    .filter((reminder) => new Date(reminder.remind_at).getTime() > now.getTime())
    .sort(
      (left, right) =>
        new Date(left.remind_at).getTime() - new Date(right.remind_at).getTime() ||
        left.id - right.id,
    );
  const keepId = future[0]?.id;
  let settledPast = false;
  for (const reminder of pending) {
    if (reminder.id === keepId) {
      continue;
    }
    if (transitionReminderStatus(reminder.id, "pending", "cancelled", "ignore")) {
      settledPast = true;
    }
  }
  if (keepId !== undefined || stopped) {
    return;
  }
  const ignoreOwned =
    settledPast || fresh.some((reminder) => reminder.status_reason === "ignore");
  if (!ignoreOwned) {
    return;
  }
  const basis = [...fresh].sort(
    (left, right) =>
      new Date(right.remind_at).getTime() - new Date(left.remind_at).getTime() ||
      right.id - left.id,
  )[0];
  if (!basis || basis.recurrence === "none" || basis.series_id == null) {
    return;
  }
  const nextAt = nextFutureAt(basis.remind_at, basis.recurrence, now);
  if (!nextAt) {
    return;
  }
  const already = getReminders().some(
    (reminder) =>
      reminder.status === "pending" &&
      reminder.series_id === basis.series_id &&
      sameInstant(reminder.remind_at, nextAt),
  );
  if (already) {
    return;
  }
  createReminder(basis.text, basis.tag, nextAt, basis.recurrence, {
    relatedTaskId: basis.related_task_id,
    relatedBillId: basis.related_bill_id,
    seriesId: basis.series_id,
  });
}

/** `all` resumes every match at once; resume_item sets it from his own words, not the model's query. */
export function resumeIgnoreByQuery(
  query: string,
  authRef: string,
  instruction: string,
  all = /\ball\b/i.test(query),
):
  | { kind: "resumed"; rules: IgnoreRuleRecord[] }
  | { kind: "clarify"; question: string }
  | { kind: "none"; message: string } {
  const matches = findActiveRulesForQuery(query);
  if (matches.length === 0) {
    return { kind: "none", message: "Nothing matching that is currently ignored." };
  }
  if (matches.length > 1 && !all) {
    return {
      kind: "clarify",
      question:
        "Which ignored item should I resume?\n" +
        matches
          .map((rule) => `- ${formatIgnoreRule(rule)} (id ${rule.id})`)
          .join("\n"),
    };
  }
  const resumed: IgnoreRuleRecord[] = [];
  for (const rule of matches) {
    const next = resumeIgnore(rule.id, authRef, instruction);
    if (next) {
      resumed.push(next);
    }
  }
  return { kind: "resumed", rules: resumed };
}

export function resumeAllIgnoreRules(
  authRef: string,
  instruction: string,
): IgnoreRuleRecord[] {
  const resumed: IgnoreRuleRecord[] = [];
  for (const rule of listActiveIgnoreRules()) {
    const next = resumeIgnore(rule.id, authRef, instruction);
    if (next) {
      resumed.push(next);
    }
  }
  return resumed;
}

export function findActiveRulesForQuery(query: string): IgnoreRuleRecord[] {
  const key = normalizeIgnoreKey(stripIgnoreWords(query));
  if (!key) {
    return listActiveIgnoreRules();
  }
  return listActiveIgnoreRules().filter((rule) => {
    if (rule.entity_id && key === String(rule.id)) {
      return true;
    }
    return keysOverlap(rule.match_key, key, [rule.instruction]);
  });
}

export function formatIgnoreRule(rule: IgnoreRuleRecord): string {
  const when = rule.created_at.slice(0, 10);
  const duration =
    rule.duration === "temporary" && rule.expires_at
      ? `until ${rule.expires_at.slice(0, 10)}`
      : "Permanent";
  const scope = rule.tag === "both" ? "Both" : rule.tag === "work" ? "Work" : "Personal";
  return `${labelForRule(rule)} | ${scope} | ${duration} | since ${when}`;
}

export function labelForRule(rule: IgnoreRuleRecord): string {
  if (rule.entity_type === "bill") {
    return titleCase(rule.match_key) + " bills";
  }
  if (rule.entity_type === "task") {
    return titleCase(rule.match_key) + " task";
  }
  if (rule.entity_type === "email_source") {
    return titleCase(rule.match_key) + " emails";
  }
  if (rule.entity_type === "notification") {
    return titleCase(rule.match_key) + " alerts";
  }
  if (rule.entity_type === "account") {
    return titleCase(rule.match_key) + " account follow-ups";
  }
  if (rule.entity_type === "calendar_event") {
    return titleCase(rule.match_key) + " event reminders";
  }
  if (rule.entity_type === "build") {
    return titleCase(rule.match_key) + " build alerts";
  }
  if (rule.entity_type === "date") {
    return titleCase(rule.match_key);
  }
  return titleCase(rule.match_key);
}

function titleCase(value: string): string {
  return value
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function looksLikeIgnoreInstruction(text: string): boolean {
  const clean = text.trim();
  if (!clean) {
    return false;
  }
  if (looksLikeResumeInstruction(clean) || looksLikeListIgnoredInstruction(clean)) {
    return false;
  }
  return (
    /\bignore\b/i.test(clean) ||
    /\bstop bothering me\b/i.test(clean) ||
    /\bdon'?t\s+(?:remind|ping|bother|track)\b/i.test(clean) ||
    /\bdo not\s+(?:remind|ping|bother|track)\b/i.test(clean) ||
    /\bi don'?t want to see\b/i.test(clean) ||
    /\bforget about this\b/i.test(clean) ||
    /\bstop tracking\b/i.test(clean) ||
    /\bstop reminding me\b/i.test(clean)
  );
}

export function looksLikeResumeInstruction(text: string): boolean {
  return (
    /\b(?:start|resume)\s+track(?:ing)?\b/i.test(text) ||
    /\bstart reminding me\b/i.test(text) ||
    /\btrack\b[^.?\n]{0,40}\bagain\b/i.test(text) ||
    /\bundo the ignore\b/i.test(text) ||
    /\bstop ignoring\b/i.test(text) ||
    /\bresume\b[^.?\n]{0,40}\b(?:bill|task|reminder|alert|item)/i.test(text) ||
    /\bresume all ignored\b/i.test(text)
  );
}

export function looksLikeListIgnoredInstruction(text: string): boolean {
  return (
    /\bwhat have i asked you to ignore\b/i.test(text) ||
    /\b(?:show|list|open)\b[^.?\n]{0,20}\bignored(?:\s+items)?\b/i.test(text)
  );
}

/**
 * Negation, the one check every ignore, skip and resume path uses. It counts only
 * when it governs the action verb: "don't / do not / never / not ignore",
 * "don't skip", "don't resume". A "-n't" or "not" elsewhere in the sentence does
 * not: "ignore the AWS alerts, I don't need them" and "can't you ignore them"
 * are requests to ignore. "Stop ignoring" means resume, so it negates ignoring.
 */
const NEGATOR = String.raw`\b(?:don['\u2019]?t|do\s+not|never|(?<!\bwhy\s)not)(?:\s+(?:ever|even|just|really|actually|please|yet))*\s+`;
const IGNORE_VERBS = String.raw`(?:ignor(?:e|ing)|skip(?:ping)?|mut(?:e|ing)|dismiss(?:ing)?)\b`;
const SKIP_VERBS = String.raw`skip(?:ping)?\b`;
const RESUME_VERBS = String.raw`(?:resum(?:e|ing)|unignor(?:e|ing)|start\s+(?:tracking|reminding)|stop\s+ignoring)\b`;
const NEGATED_IGNORE = new RegExp(`${NEGATOR}${IGNORE_VERBS}|\\bstop\\s+ignoring\\b`, "i");
const NEGATED_SKIP = new RegExp(`${NEGATOR}${SKIP_VERBS}`, "i");
const NEGATED_RESUME = new RegExp(`${NEGATOR}${RESUME_VERBS}`, "i");

/** His words say not to ignore (or skip, mute, dismiss). */
export function negatesIgnore(text: string): boolean {
  return NEGATED_IGNORE.test(text);
}

/** His words say not to skip this cycle. */
export function negatesSkip(text: string): boolean {
  return NEGATED_SKIP.test(text);
}

/** His words say not to resume. */
export function negatesResume(text: string): boolean {
  return NEGATED_RESUME.test(text);
}

/** His words cover every match: all, every, everything, each, both. */
export function saysAll(text: string): boolean {
  return /\b(?:all|every|everything|each|both)\b/i.test(text);
}

export const NOTHING_IGNORED = "OK, I won't ignore anything. Nothing changed.";
export const NOTHING_SKIPPED = "OK, I won't skip it. Nothing changed.";
export const NOTHING_RESUMED = "OK, I won't resume anything. Nothing changed.";

/**
 * The clause that asks, without the reasons around it: "ignore the AWS alerts,
 * I don't need them" asks about "ignore the AWS alerts". A plain list of names
 * ("ignore linkedin, facebook and netflix") stays whole.
 */
const CLAUSE_BREAK =
  /\s*(?:[.;!?]+\s+|,\s*(?=(?:i|i['\u2019]m|im|it|it['\u2019]s|its|they|we|he|she|that['\u2019]s|thats|because|since|cause|coz|cuz|so|as)\b)|\s+(?:because|since|cause|coz|cuz)\s+)/i;

export function askingClause(text: string): string {
  const clauses = text.split(CLAUSE_BREAK).filter((clause) => clause.trim());
  if (clauses.length < 2) {
    return text;
  }
  return clauses.find((clause) => IGNORE_FILLER.test(clause)) ?? clauses[0]!;
}

const IGNORE_FILLER =
  /\b(?:aadi,?\s+|please\s+|pls\s+|kindly\s+|now\s+|just\s+)?(?:ignore|stop bothering me about|stop tracking|stop reminding me about|forget about|don'?t remind me about|do not remind me about|i don'?t want to see)\b/i;

export function stripIgnoreWords(text: string): string {
  return text
    .replace(/\b(?:can|ca|could|would|will|wo)(?:n['\u2019]?t)?\s+you\b/gi, " ")
    .replace(IGNORE_FILLER, " ")
    .replace(/\bthem\b/gi, " ")
    .replace(
      /\b(?:the|my|this|that|these|those|a|an|all|future|again|permanently|please|pls)\b/gi,
      " ",
    )
    .replace(
      /\b(?:just for today|for today|until \w+|for a week|for \d+ days?)\b/gi,
      " ",
    )
    .replace(
      /\b(?:bills?|invoices?|renewals?|subscriptions?|tasks?|to-?dos?|reminders?|alerts?|notifications?|e-?mails?|newsletters?|follow-?ups?)\b/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

export function parseIgnoreDuration(
  text: string,
  now = new Date(),
): { duration: IgnoreDuration; expiresAt: string | null } {
  if (/\bpermanent(?:ly)?\b/i.test(text)) {
    return { duration: "permanent", expiresAt: null };
  }
  if (/\b(?:just )?for today\b|\btoday only\b/i.test(text)) {
    return { duration: "temporary", expiresAt: endOfKolkataDay(now) };
  }
  if (/\buntil tomorrow\b/i.test(text)) {
    const startOfToday = new Date(`${kolkataYmd(now)}T00:00:00+05:30`);
    return {
      duration: "temporary",
      expiresAt: new Date(startOfToday.getTime() + 86_400_000).toISOString(),
    };
  }
  const untilDay = /\buntil\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.exec(
    text,
  );
  if (untilDay) {
    return {
      duration: "temporary",
      expiresAt: nextWeekdayStart(now, untilDay[1]!.toLowerCase()),
    };
  }
  const days = /\bfor\s+(\d+)\s+days?\b/i.exec(text);
  if (days) {
    const count = Number(days[1]);
    const expires = new Date(now.getTime() + count * 86_400_000);
    return { duration: "temporary", expiresAt: expires.toISOString() };
  }
  if (/\bfor a week\b/i.test(text)) {
    return {
      duration: "temporary",
      expiresAt: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
    };
  }
  return { duration: "permanent", expiresAt: null };
}

function endOfKolkataDay(now: Date): string {
  return new Date(`${kolkataYmd(now)}T23:59:59.999+05:30`).toISOString();
}

function nextWeekdayStart(now: Date, weekday: string): string {
  const names = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  const target = names.indexOf(weekday);
  const current = kolkataWeekday(now);
  let delta = (target - current + 7) % 7;
  if (delta === 0) {
    delta = 7;
  }
  const ymd = kolkataYmd(new Date(now.getTime() + delta * 86_400_000));
  return new Date(`${ymd}T00:00:00+05:30`).toISOString();
}

function parseTagHint(text: string): IgnoreTag | undefined {
  if (/\bwork\b/i.test(text) && !/\bpersonal\b/i.test(text)) {
    return "work";
  }
  if (/\bpersonal\b/i.test(text) && !/\bwork\b/i.test(text)) {
    return "personal";
  }
  return undefined;
}

function entityHint(text: string): IgnoreEntityType | "ambiguous" | undefined {
  const bills = /\bbills?\b|\binvoices?\b|\brenewals?\b|\bsubscriptions?\b/i.test(text);
  const tasks = /\btasks?\b|\bto-?dos?\b/i.test(text);
  const reminders = /\breminders?\b/i.test(text);
  const emails = /\be-?mails?\b|\bnewsletters?\b|\bsenders?\b/i.test(text);
  const alerts = /\balerts?\b|\bnotifications?\b/i.test(text);
  const dates = /\bbirthdays?|\banniversar(?:y|ies)\b|\bimportant dates?\b/i.test(text);
  const accounts = /\bprospects?\b|\baccounts?\b|\bfollow-?ups?\b/i.test(text);
  const builds = /\bbuilds?\b|\bci\b|\bpull requests?\b/i.test(text);
  const events = /\bevents?\b|\bmeetings?\b/i.test(text);
  if (tasks) {
    return "task";
  }
  if (reminders && !bills) {
    return "reminder";
  }
  if (emails && !bills) {
    return "email_source";
  }
  if (bills) {
    return "bill";
  }
  if (alerts) {
    return "notification";
  }
  if (dates) {
    return "date";
  }
  if (accounts) {
    return "account";
  }
  if (builds) {
    return "build";
  }
  if (events) {
    return "calendar_event";
  }
  return undefined;
}

export function resolveIgnoreTarget(words: string): IgnoreResolveResult {
  const duration = parseIgnoreDuration(words);
  const tagHint = parseTagHint(words);
  const text = askingClause(words);
  const hint = entityHint(text);
  const target = stripIgnoreWords(text);
  const key = normalizeIgnoreKey(target);
  if (!keyIsSpecific(key) && hint !== "task" && hint !== "reminder") {
    return {
      kind: "none",
      message:
        "Which item or source should I ignore? Name the bill, task, reminder or sender.",
    };
  }

  if (hint === "ambiguous") {
    return {
      kind: "clarify",
      question: clarifyQuestion(target),
    };
  }

  if (hint === "bill" || (!hint && matchingBills(key).length > 0 && !/\btask\b/i.test(text))) {
    if (/\balerts?\b|\be-?mails?\b|\bnotifications?\b/i.test(text) && !/\bbills?\b/i.test(text)) {
      return {
        kind: "clarify",
        question: `Do you mean ${titleCase(key)} bill reminders or all ${titleCase(key)} notification emails?`,
      };
    }
    return {
      kind: "apply",
      label: `${titleCase(canonicalBiller(target || key))} bills`,
      input: {
        entityType: "bill",
        matchKey: normalizeBillerKey(canonicalBiller(target || key)),
        matchScope: "source",
        tag: tagHint ?? "personal",
        duration: duration.duration,
        expiresAt: duration.expiresAt,
      },
    };
  }

  const taskInput = (task: TaskRecord): IgnoreCandidate["input"] => ({
    entityType: "task",
    matchKey: normalizeIgnoreKey(task.text.replace(/^promise:\s*/i, "")),
    matchScope: "source",
    tag: tagHint ?? task.tag,
    entityId: String(task.id),
    duration: duration.duration,
    expiresAt: duration.expiresAt,
  });
  const whichTask = (tasks: TaskRecord[]): IgnoreResolveResult => ({
    kind: "clarify",
    question: "Which task should I ignore?\n" + tasks.map((task) => `- #${task.id} ${task.text} (${task.tag})`).join("\n"),
    candidates: tasks.map((task) => ({
      label: `#${task.id} ${task.text} (${task.tag})`,
      names: task.text,
      confirmLabel: task.text,
      input: taskInput(task),
    })),
  });

  if (hint === "task" || (!hint && matchingTasks(key).length === 1)) {
    const matches = matchingTasks(key);
    if (matches.length > 1) {
      return whichTask(matches);
    }
    if (matches.length === 1) {
      const task = matches[0]!;
      return { kind: "apply", label: task.text, input: taskInput(task) };
    }
    if (hint === "task" && keyIsSpecific(key)) {
      return {
        kind: "apply",
        label: `${titleCase(key)} task`,
        input: {
          entityType: "task",
          matchKey: key,
          matchScope: "source",
          tag: tagHint ?? "personal",
          duration: duration.duration,
          expiresAt: duration.expiresAt,
        },
      };
    }
  }

  if (hint === "reminder") {
    const matches = matchingReminders(key);
    const reminderInput = (reminder: ReminderRecord): IgnoreCandidate["input"] => ({
      entityType: "reminder",
      matchKey: normalizeIgnoreKey(reminder.text),
      matchScope: "record",
      tag: tagHint ?? reminder.tag ?? "personal",
      entityId: String(reminder.id),
      duration: duration.duration,
      expiresAt: duration.expiresAt,
    });
    if (matches.length > 1) {
      return {
        kind: "clarify",
        question:
          "Which reminder should I ignore?\n" +
          matches
            .map((reminder) => `- #${reminder.id} ${reminder.text}`)
            .join("\n"),
        candidates: matches.map((reminder) => ({
          label: `#${reminder.id} ${reminder.text}`,
          names: reminder.text,
          confirmLabel: reminder.text,
          input: reminderInput(reminder),
        })),
      };
    }
    const reminder = matches[0];
    return {
      kind: "apply",
      label: reminder ? reminder.text : `${titleCase(key)} reminder`,
      input: {
        entityType: "reminder",
        matchKey: reminder ? normalizeIgnoreKey(reminder.text) : key,
        matchScope: reminder ? "record" : "source",
        tag: tagHint ?? reminder?.tag ?? "personal",
        entityId: reminder ? String(reminder.id) : null,
        duration: duration.duration,
        expiresAt: duration.expiresAt,
      },
    };
  }

  if (hint === "email_source") {
    return {
      kind: "apply",
      label: `${titleCase(key)} emails`,
      input: {
        entityType: "email_source",
        matchKey: key,
        matchScope: "source",
        tag: tagHint ?? "both",
        duration: duration.duration,
        expiresAt: duration.expiresAt,
      },
    };
  }

  if (hint === "notification") {
    if (matchingBills(key).length > 0) {
      return {
        kind: "clarify",
        question: `Do you mean ${titleCase(key)} bill reminders or all ${titleCase(key)} notification emails?`,
      };
    }
    return {
      kind: "apply",
      label: `${titleCase(key)} alerts`,
      input: {
        entityType: "notification",
        matchKey: key,
        matchScope: "source",
        tag: tagHint ?? "both",
        duration: duration.duration,
        expiresAt: duration.expiresAt,
      },
    };
  }

  if (hint === "date") {
    const matches = matchingDates(key);
    if (matches.length > 1) {
      return {
        kind: "clarify",
        question:
          "Which date reminders should I ignore?\n" +
          matches.map((record) => `- ${record.person} (${record.type})`).join("\n"),
        candidates: matches.map((record) => ({
          label: `${record.person} (${record.type})`,
          names: `${record.person} ${record.type}`,
          confirmLabel: `${record.person} (${record.type})`,
          input: {
            entityType: "date",
            matchKey: `${record.person} ${record.type}`,
            matchScope: "record",
            tag: tagHint ?? "personal",
            entityId: String(record.id),
            duration: duration.duration,
            expiresAt: duration.expiresAt,
          },
        })),
      };
    }
    const record = matches[0];
    return {
      kind: "apply",
      label: record ? `${record.person} (${record.type})` : titleCase(key),
      input: {
        entityType: "date",
        matchKey: record ? `${record.person} ${record.type}` : key,
        matchScope: record ? "record" : "source",
        tag: tagHint ?? "personal",
        entityId: record ? String(record.id) : null,
        duration: duration.duration,
        expiresAt: duration.expiresAt,
      },
    };
  }

  if (hint === "account") {
    const matches = matchingAccounts(key);
    if (matches.length > 1) {
      return {
        kind: "clarify",
        question:
          "Which account follow-ups should I ignore?\n" +
          matches.map((account) => `- ${account.name}`).join("\n"),
        candidates: matches.map((account) => ({
          label: account.name,
          names: account.name,
          confirmLabel: `${account.name} follow-ups`,
          input: {
            entityType: "account",
            matchKey: account.name,
            matchScope: "source",
            tag: "work",
            entityId: String(account.id),
            duration: duration.duration,
            expiresAt: duration.expiresAt,
          },
        })),
      };
    }
    const account = matches[0];
    return {
      kind: "apply",
      label: account ? `${account.name} follow-ups` : `${titleCase(key)} account follow-ups`,
      input: {
        entityType: "account",
        matchKey: account ? account.name : key,
        matchScope: "source",
        tag: "work",
        entityId: account ? String(account.id) : null,
        duration: duration.duration,
        expiresAt: duration.expiresAt,
      },
    };
  }

  if (hint === "build") {
    return {
      kind: "apply",
      label: `${titleCase(key)} build alerts`,
      input: {
        entityType: "build",
        matchKey: key || "notifications",
        matchScope: key ? "source" : "category",
        tag: tagHint ?? "both",
        duration: duration.duration,
        expiresAt: duration.expiresAt,
      },
    };
  }

  if (hint === "calendar_event") {
    return {
      kind: "apply",
      label: `${titleCase(key)} event reminders`,
      input: {
        entityType: "calendar_event",
        matchKey: key,
        matchScope: "source",
        tag: tagHint ?? "both",
        duration: duration.duration,
        expiresAt: duration.expiresAt,
      },
    };
  }

  if (matchingBills(key).length > 0) {
    return {
      kind: "apply",
      label: `${titleCase(canonicalBiller(target || key))} bills`,
      input: {
        entityType: "bill",
        matchKey: normalizeBillerKey(canonicalBiller(target || key)),
        matchScope: "source",
        tag: tagHint ?? "personal",
        duration: duration.duration,
        expiresAt: duration.expiresAt,
      },
    };
  }

  if (matchingTasks(key).length === 1) {
    const task = matchingTasks(key)[0]!;
    return {
      kind: "apply",
      label: task.text,
      input: {
        entityType: "task",
        matchKey: normalizeIgnoreKey(task.text.replace(/^promise:\s*/i, "")),
        matchScope: "source",
        tag: tagHint ?? task.tag,
        entityId: String(task.id),
        duration: duration.duration,
        expiresAt: duration.expiresAt,
      },
    };
  }

  if (matchingTasks(key).length > 1 && matchingBills(key).length === 0) {
    return whichTask(matchingTasks(key));
  }

  if (keyIsSpecific(key)) {
    return {
      kind: "apply",
      label: titleCase(key),
      input: {
        entityType: "notification",
        matchKey: key,
        matchScope: "source",
        tag: tagHint ?? "both",
        duration: duration.duration,
        expiresAt: duration.expiresAt,
      },
    };
  }

  return {
    kind: "none",
    message: "I couldn't tell what to ignore. Name the bill, task, reminder or source.",
  };
}

function clarifyQuestion(target: string): string {
  const name = titleCase(normalizeIgnoreKey(target) || target);
  return `Do you mean ${name} bill reminders or all ${name} notification emails?`;
}

function matchingBills(key: string): BillRecord[] {
  if (!key) {
    return [];
  }
  return getBills().filter((bill) =>
    keysOverlap(key, normalizeBillerKey(canonicalBiller(bill.biller)), [
      bill.biller,
    ]),
  );
}

function matchingTasks(key: string): TaskRecord[] {
  if (!key) {
    return [];
  }
  return getTasks().filter(
    (task) =>
      task.status === "open" &&
      keysOverlap(key, normalizeIgnoreKey(task.text), [task.text]),
  );
}

function matchingReminders(key: string): ReminderRecord[] {
  if (!key) {
    return [];
  }
  return getReminders().filter(
    (reminder) =>
      reminder.status === "pending" &&
      keysOverlap(key, normalizeIgnoreKey(reminder.text), [reminder.text]),
  );
}

function matchingDates(key: string) {
  if (!key) {
    return [];
  }
  return getImportantDates().filter((record) =>
    keysOverlap(key, normalizeIgnoreKey(`${record.person} ${record.type}`), [
      record.person,
    ]),
  );
}

function matchingAccounts(key: string) {
  if (!key) {
    return [];
  }
  return getAccounts().filter((account) =>
    keysOverlap(key, normalizeIgnoreKey(account.name), [account.name]),
  );
}

export function confirmationForIgnore(
  result: IgnoreApplyResult,
  label: string,
): string {
  const until =
    result.rule.duration === "temporary" && result.rule.expires_at
      ? ` until ${result.rule.expires_at.slice(0, 10)}`
      : " until you ask me to resume";
  if (result.duplicate) {
    return `Already ignoring ${label}${until}.`;
  }
  if (result.rule.entity_type === "bill") {
    return `Got it. I'll stop tracking ${label} and exclude them from your reminders and reports${until}.`;
  }
  if (result.rule.entity_type === "task") {
    return `I'll stop tracking and reminding you about that task${until}.`;
  }
  return `I'll ignore ${label}${until}.`;
}

export function confirmationForResume(rules: IgnoreRuleRecord[]): string {
  if (rules.length === 0) {
    return "Nothing matching that is currently ignored.";
  }
  if (rules.length === 1) {
    const rule = rules[0]!;
    if (rule.entity_type === "bill") {
      return `${labelForRule(rule)} tracking resumed. I'll include them in future bill checks and reminders.`;
    }
    return `${labelForRule(rule)} resumed.`;
  }
  return `Resumed ${rules.length} ignored items.`;
}

export function ownerMayChangeIgnore(input: {
  confirmation?: { chatId: number; messageId: number };
  userText?: string;
}): boolean {
  return Boolean(input.confirmation);
}
