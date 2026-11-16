/**
 * Central ignore registry. One SQLite table, deterministic matching, no LLM
 * on the suppression path. Vishnu's own chat or a Telegram tap may write;
 * emails, forwards, A2A and background jobs may only read.
 */
import { canonicalBiller, normalizeBillerKey } from "./bill_aliases.js";
import {
  cancelPendingRemindersForBill,
  cancelPendingRemindersForTask,
  expireDueIgnoreRules,
  getAccounts,
  getActiveIgnoreRuleByKey,
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
  transitionReminderStatus,
  type BillRecord,
  type IgnoreDuration,
  type IgnoreEntityType,
  type IgnoreMatchScope,
  type IgnoreRuleRecord,
  type IgnoreTag,
  type ItemTag,
  type ReminderRecord,
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

export type IgnoreResolveResult =
  | { kind: "apply"; input: Omit<IgnoreApplyInput, "instruction" | "authRef">; label: string }
  | { kind: "clarify"; question: string }
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

function keysOverlap(ruleKey: string, candidate: string, aliases: readonly string[] = []): boolean {
  const ruleKeys = expandAliases(ruleKey);
  const candidateKeys = [
    candidate,
    ...expandAliases(candidate),
    ...aliases.map((alias) => normalizeIgnoreKey(alias)),
  ];
  for (const left of ruleKeys) {
    for (const right of candidateKeys) {
      if (phraseMatches(left, right) || phraseMatches(right, left)) {
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
  const stamp = now.getTime();
  if (cachedActive && stamp - cachedAt < CACHE_MS) {
    return cachedActive;
  }
  expireDueIgnoreRules(nowIso(now));
  cachedActive = listActiveIgnoreRules();
  cachedAt = stamp;
  return cachedActive;
}

export function matchingIgnoreRule(
  subject: IgnoreSubject,
  now = new Date(),
): IgnoreRuleRecord | undefined {
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
  for (const rule of activeRules(now)) {
    if (!tagMatches(rule.tag, subject.tag)) {
      continue;
    }
    if (rule.entity_type !== subject.entityType) {
      if (
        !(
          (rule.entity_type === "notification" &&
            (subject.entityType === "bill" || subject.entityType === "email_source")) ||
          (rule.entity_type === "email_source" && subject.entityType === "notification")
        )
      ) {
        continue;
      }
    }
    if (rule.match_scope === "record") {
      if (entityId && rule.entity_id === entityId) {
        return rule;
      }
      continue;
    }
    if (keysOverlap(rule.match_key, matchKey, aliases)) {
      return rule;
    }
  }
  return undefined;
}

export function isIgnored(subject: IgnoreSubject, now = new Date()): boolean {
  return matchingIgnoreRule(subject, now) !== undefined;
}

export function billIsIgnored(bill: BillRecord, now = new Date()): boolean {
  const canonical = canonicalBiller(bill.biller);
  return isIgnored(
    {
      entityType: "bill",
      entityId: bill.id,
      matchKey: normalizeBillerKey(canonical),
      tag: "personal",
      aliases: [bill.biller, canonical, normalizeBillerKey(bill.biller)],
    },
    now,
  );
}

export function taskIsIgnored(task: TaskRecord, now = new Date()): boolean {
  return isIgnored(
    {
      entityType: "task",
      entityId: task.id,
      matchKey: normalizeIgnoreKey(task.text.replace(/^promise:\s*/i, "")),
      tag: task.tag,
      aliases: [task.text],
    },
    now,
  );
}

export function reminderIsIgnored(reminder: ReminderRecord, now = new Date()): boolean {
  if (
    isIgnored(
      {
        entityType: "reminder",
        entityId: reminder.id,
        matchKey: reminder.text,
        tag: reminder.tag,
      },
      now,
    )
  ) {
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
  const existing = getActiveIgnoreRuleByKey(
    input.entityType,
    matchKey,
    input.matchScope,
    input.tag,
  );
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
    const raced = getActiveIgnoreRuleByKey(
      input.entityType,
      matchKey,
      input.matchScope,
      input.tag,
    );
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
  suppressMatchingReminders(rule);
  return { kind: "created", rule, duplicate: false };
}

function suppressMatchingReminders(rule: IgnoreRuleRecord): void {
  if (rule.entity_type === "bill") {
    for (const bill of getBills()) {
      if (bill.status !== "upcoming") {
        continue;
      }
      if (billIsIgnored(bill)) {
        cancelPendingRemindersForBill(bill.id);
      }
    }
    return;
  }
  if (rule.entity_type === "task") {
    for (const task of getTasks()) {
      if (task.status !== "open") {
        continue;
      }
      if (taskIsIgnored(task)) {
        cancelPendingRemindersForTask(task.id);
      }
    }
    return;
  }
  if (rule.entity_type === "reminder" && rule.entity_id) {
    const reminder = getReminder(Number(rule.entity_id));
    if (reminder && reminder.status === "pending") {
      transitionReminderStatus(reminder.id, "pending", "cancelled");
    }
  }
}

export function resumeIgnore(
  ruleId: number,
  authRef: string,
  instruction = "",
): IgnoreRuleRecord | undefined {
  const rule = getIgnoreRule(ruleId);
  if (!rule || rule.status !== "active") {
    return undefined;
  }
  const at = nowIso();
  if (!markIgnoreRuleResumed(ruleId, at)) {
    return undefined;
  }
  recordIgnoreRuleEvent(ruleId, "resumed", authRef, instruction || null, null);
  invalidateIgnoreCache();
  skipPastRemindersForResumed(rule);
  return getIgnoreRule(ruleId);
}

function skipPastRemindersForResumed(rule: IgnoreRuleRecord): void {
  const now = Date.now();
  for (const reminder of getReminders()) {
    if (reminder.status !== "pending") {
      continue;
    }
    if (new Date(reminder.remind_at).getTime() > now) {
      continue;
    }
    const matches =
      (rule.entity_type === "reminder" &&
        (String(reminder.id) === rule.entity_id ||
          keysOverlap(rule.match_key, normalizeIgnoreKey(reminder.text), [
            reminder.text,
          ]))) ||
      (rule.entity_type === "bill" &&
        reminder.related_bill_id !== null &&
        billMatchesRule(getBill(reminder.related_bill_id), rule)) ||
      (rule.entity_type === "task" &&
        reminder.related_task_id !== null &&
        taskMatchesRule(getTask(reminder.related_task_id), rule));
    if (matches) {
      transitionReminderStatus(reminder.id, "pending", "cancelled");
    }
  }
}

function billMatchesRule(
  bill: BillRecord | undefined,
  rule: IgnoreRuleRecord,
): boolean {
  if (!bill) {
    return false;
  }
  if (rule.entity_id && String(bill.id) === rule.entity_id) {
    return true;
  }
  return keysOverlap(
    rule.match_key,
    normalizeBillerKey(canonicalBiller(bill.biller)),
    [bill.biller],
  );
}

function taskMatchesRule(
  task: TaskRecord | undefined,
  rule: IgnoreRuleRecord,
): boolean {
  if (!task) {
    return false;
  }
  if (rule.entity_id && String(task.id) === rule.entity_id) {
    return true;
  }
  return keysOverlap(rule.match_key, normalizeIgnoreKey(task.text), [task.text]);
}

export function resumeIgnoreByQuery(
  query: string,
  authRef: string,
  instruction: string,
):
  | { kind: "resumed"; rules: IgnoreRuleRecord[] }
  | { kind: "clarify"; question: string }
  | { kind: "none"; message: string } {
  const matches = findActiveRulesForQuery(query);
  if (matches.length === 0) {
    return { kind: "none", message: "Nothing matching that is currently ignored." };
  }
  if (matches.length > 1 && !/\ball\b/i.test(query)) {
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

const IGNORE_FILLER =
  /\b(?:aadi,?\s+|please\s+|pls\s+|kindly\s+|now\s+|just\s+)?(?:ignore|stop bothering me about|stop tracking|stop reminding me about|forget about|don'?t remind me about|do not remind me about|i don'?t want to see)\b/i;

export function stripIgnoreWords(text: string): string {
  return text
    .replace(IGNORE_FILLER, " ")
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

export function resolveIgnoreTarget(text: string): IgnoreResolveResult {
  const duration = parseIgnoreDuration(text);
  const tagHint = parseTagHint(text);
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

  if (hint === "task" || (!hint && matchingTasks(key).length === 1)) {
    const matches = matchingTasks(key);
    if (matches.length > 1) {
      return {
        kind: "clarify",
        question:
          "Which task should I ignore?\n" +
          matches
            .map((task) => `- #${task.id} ${task.text} (${task.tag})`)
            .join("\n"),
      };
    }
    if (matches.length === 1) {
      const task = matches[0]!;
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
    if (matches.length > 1) {
      return {
        kind: "clarify",
        question:
          "Which reminder should I ignore?\n" +
          matches
            .map((reminder) => `- #${reminder.id} ${reminder.text}`)
            .join("\n"),
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
    return {
      kind: "clarify",
      question:
        "Which task should I ignore?\n" +
        matchingTasks(key)
          .map((task) => `- #${task.id} ${task.text} (${task.tag})`)
          .join("\n"),
    };
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
