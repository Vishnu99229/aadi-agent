import { addressIn, nameTokens, notASendCommand } from "./command_logic.js";
import { namesFuzzyEqual } from "./contact_logic.js";
import { rememberContactChoice } from "./contacts.js";
import { retrieveRelevantContext, wantsHistoricalContext } from "./context_lookup.js";
import {
  deletePendingActionContext,
  getPendingActionContext,
  getScheduledSend,
  listCanonicalContacts,
  listScheduledSendsForDraft,
  markTaskDone,
  transitionScheduledSend,
  upsertCalendarEventRef,
  upsertPendingActionContext,
  writeScheduledCopy,
  type ScheduledCopyChange,
  type ScheduledPerson,
  type ScheduledSendRecord,
} from "./db.js";
import { looksLikeIgnoreInstruction } from "./ignore.js";
import { parseAddressList } from "./mail_helpers.js";
import { sameConversation } from "./subject_logic.js";
import { lastPresentedEntities, resolveReferentPhrase, type ReferentEntity } from "./referents.js";
import { looksLikeTimeFill, parseOwnerTime } from "./time_parse.js";

/** How long an unfinished draft or meeting stays resumable. */
export const TASK_TTL_MS = 12 * 60 * 60 * 1000;
/** How long a send instruction keeps authorizing that send. */
export const AUTH_TTL_MS = 30 * 60 * 1000;

export interface ResolvedAttendee {
  query: string;
  name: string;
  email: string;
  resolved: boolean;
}

export interface PendingMeetingState {
  title?: string;
  calendar: "work" | "personal";
  attendees: ResolvedAttendee[];
  startIso?: string;
  durationMinutes?: number;
  waiting: "time" | "attendees" | "confirm_contact";
  resolutionAttempts: Record<string, string[]>;
}

/** An address Vishnu himself typed. Gmail and memory never write this. */
export interface OwnerSuppliedContact {
  email: string;
  name: string;
  phone?: string;
  messageId: number;
  at: string;
}

export interface PendingEmailState {
  to: ResolvedAttendee[];
  cc: ResolvedAttendee[];
  subject?: string;
  purpose?: string;
  notes: string[];
  sendAt?: string;
  account: "work" | "personal";
  scheduledSendId?: number;
  draftId?: string;
  /** A recipient change waiting until Vishnu picks one confirmed person. */
  pendingRedirect?: string;
  waiting: "recipient" | "purpose" | "confirm";
}

export type PendingActionStatus = "open" | "cancelled" | "done" | "superseded";

export interface PendingAction {
  id?: string;
  action: "create_meeting" | "ignore" | "send_email" | "draft_email" | "note";
  status?: PendingActionStatus;
  ownerWords: string;
  /** When the owner words authorized a send. Draft notes do not set this. */
  authorizedAt?: string;
  confirmChat: number;
  confirmMessage: number;
  meeting?: PendingMeetingState;
  /** The meeting just created, so a later correction can patch that event. */
  bookedMeeting?: {
    eventId: string;
    accountId: "work" | "personal";
    title: string;
    startIso: string;
    attendees: Array<{ name: string; email: string }>;
  } | null;
  email?: PendingEmailState;
  /** Survives cancel. It identifies someone; it does not authorize a send. */
  ownerSupplied?: OwnerSuppliedContact[];
  ignoreEntities?: ReferentEntity[];
  updatedAt: string;
}

function parseState(json: string): Omit<PendingAction, "ownerWords" | "confirmChat" | "confirmMessage"> | undefined {
  try {
    const parsed = JSON.parse(json) as PendingAction;
    if (!parsed || typeof parsed.action !== "string") {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function getPendingAction(chatId: number, now = new Date()): PendingAction | undefined {
  const row = getPendingActionContext(chatId);
  if (!row) {
    return undefined;
  }
  if (now.getTime() - Date.parse(row.updated_at) > TASK_TTL_MS) {
    deletePendingActionContext(chatId);
    return undefined;
  }
  const parsed = parseState(row.state_json);
  if (!parsed) {
    return undefined;
  }
  return {
    ...parsed,
    status: parsed.status ?? "open",
    ownerSupplied: parsed.ownerSupplied ?? [],
    ownerWords: row.owner_words,
    confirmChat: row.confirm_chat,
    confirmMessage: row.confirm_message,
    updatedAt: row.updated_at,
  };
}

export function savePendingAction(chatId: number, action: PendingAction, now = new Date()): void {
  const existing = getPendingAction(chatId, now);
  const ownerSupplied = mergeSupplied(existing?.ownerSupplied, action.ownerSupplied);
  const email =
    action.email ??
    (existing?.email?.waiting && existing.email.scheduledSendId && action.action === "create_meeting"
      ? existing.email
      : action.email);
  const stored: PendingAction = {
    ...action,
    id: action.id ?? existing?.id ?? `act-${chatId}-${now.getTime()}`,
    status: action.status ?? "open",
    ownerSupplied,
    email,
    bookedMeeting: action.bookedMeeting === null ? undefined : action.bookedMeeting ?? existing?.bookedMeeting,
    updatedAt: now.toISOString(),
  };
  upsertPendingActionContext({
    chatId,
    action: stored.action,
    stateJson: JSON.stringify(stored),
    ownerWords: stored.ownerWords,
    confirmChat: stored.confirmChat,
    confirmMessage: stored.confirmMessage,
    updatedAt: stored.updatedAt,
  });
}

function storeBookedRef(
  chatId: number,
  booked: NonNullable<PendingAction["bookedMeeting"]>,
  now: Date,
): void {
  upsertCalendarEventRef({
    chatId,
    eventId: booked.eventId,
    accountId: booked.accountId,
    title: booked.title,
    startIso: booked.startIso,
    attendees: booked.attendees,
    focused: true,
    updatedAt: now.toISOString(),
  });
}

export function rememberBookedMeeting(
  chatId: number,
  booked: NonNullable<PendingAction["bookedMeeting"]>,
  now = new Date(),
): void {
  storeBookedRef(chatId, booked, now);
  const pending = getPendingAction(chatId, now);
  savePendingAction(
    chatId,
    {
      action: "note",
      status: "done",
      ownerWords: pending?.ownerWords ?? "",
      confirmChat: pending?.confirmChat ?? chatId,
      confirmMessage: pending?.confirmMessage ?? 0,
      ownerSupplied: pending?.ownerSupplied,
      updatedAt: now.toISOString(),
      bookedMeeting: booked,
    },
    now,
  );
}

/**
 * Whether a scheduled row is this email. The only link is the one fixed when it was
 * scheduled: the same Gmail draft id (or no draft on either side) in the same mailbox.
 * Shared recipients never link two emails.
 */
function rowBelongsTo(row: ScheduledSendRecord, email: { draftId?: string; account: string }): boolean {
  try {
    const request = JSON.parse(row.request) as { draftId?: unknown; account?: unknown };
    const bound = typeof request.draftId === "string" && request.draftId ? request.draftId : undefined;
    if (bound !== (email.draftId || undefined)) {
      return false;
    }
    return typeof request.account !== "string" || request.account === email.account;
  } catch {
    return false;
  }
}

function openRow(row: ScheduledSendRecord | undefined): row is ScheduledSendRecord {
  return Boolean(row && (row.status === "scheduled" || row.status === "held"));
}

/** A newly created draft inherits a schedule only when that row was scheduled from this draft. */
function scheduleOwnsDraft(scheduledSendId: number, draftId: string, account: string): boolean {
  const row = getScheduledSend(scheduledSendId);
  return Boolean(draftId) && openRow(row) && rowBelongsTo(row, { draftId, account });
}

/** The open email's schedule, when that row was scheduled as this very email. */
export function contextScheduleForDraft(email: PendingEmailState): number | undefined {
  if (!email.scheduledSendId) {
    return undefined;
  }
  const row = getScheduledSend(email.scheduledSendId);
  return openRow(row) && rowBelongsTo(row, email) ? email.scheduledSendId : undefined;
}

/** What an approved edit did to the scheduled email it belongs to. */
export type ScheduleSync =
  | { kind: "none" }
  | { kind: "synced"; id: number }
  | { kind: "stopped"; id: number; itemText: string }
  | { kind: "too_late"; id: number; itemText: string; sent: boolean };

/** A scheduled email the worker has claimed. No correction can reach it any more. */
export interface LockedSchedule {
  id: number;
  itemText: string;
  sent: boolean;
}

function lockedRow(row: ScheduledSendRecord | undefined): LockedSchedule | undefined {
  return row && (row.status === "sending" || row.status === "sent")
    ? { id: row.id, itemText: row.item_text, sent: row.status === "sent" }
    : undefined;
}

/** The open email's scheduled send, once it is going out or gone. */
export function lockedScheduleFor(email: PendingEmailState | undefined): LockedSchedule | undefined {
  if (!email?.scheduledSendId) {
    return undefined;
  }
  const row = getScheduledSend(email.scheduledSendId);
  return row && rowBelongsTo(row, email) ? lockedRow(row) : undefined;
}

/** Before a draft edit: the scheduled email this draft was scheduled as, when it can no
 *  longer change. Only the binding made at scheduling counts. */
export function lockedScheduleForDraft(draftId: string, account: string): LockedSchedule | undefined {
  const rows = listScheduledSendsForDraft(draftId, account);
  if (rows.some(openRow)) {
    return undefined;
  }
  return lockedRow(rows[0]);
}

/** The refusal for a correction that arrives after the send was claimed. Nothing changed. */
export function tooLateText(locked: LockedSchedule): string {
  return locked.sent
    ? `Too late: that scheduled email already went out with the previous version, and a sent email stays as it was sent, so I didn't change anything. (${locked.itemText}) I can draft a new email if you want to follow up.`
    : `Too late: that scheduled email is already being sent with the previous version, so I didn't change anything. (${locked.itemText})`;
}

/** What Vishnu must be told after an edit. Empty when the scheduled copy simply matches. */
export function scheduleSyncNotice(sync: ScheduleSync): string {
  if (sync.kind === "stopped") {
    return `I couldn't copy this change into the scheduled email, so I cancelled it. Nothing will go out at the scheduled time. (${sync.itemText})`;
  }
  if (sync.kind === "too_late") {
    return sync.sent
      ? `Too late for the scheduled email: it had already gone out with the previous version, so this change didn't reach it. (${sync.itemText})`
      : `Too late for the scheduled email: it had already started sending with the previous version, so this change didn't reach it. (${sync.itemText})`;
  }
  return "";
}

/**
 * Copies an approved change into one scheduled email in a single write. If the write
 * can't land, the send is cancelled so the older copy can't go out. If the worker has
 * already claimed it, that is reported as too late, never as done.
 */
export function applyToSchedule(id: number, change: ScheduledCopyChange): ScheduleSync {
  if (writeScheduledCopy(id, change).ok) {
    return { kind: "synced", id };
  }
  const row = getScheduledSend(id);
  const locked = lockedRow(row);
  if (locked) {
    return { kind: "too_late", ...locked };
  }
  if (row && (row.status === "scheduled" || row.status === "held")) {
    if (transitionScheduledSend(row.id, ["scheduled", "held"], "cancelled")) {
      markTaskDone(row.task_id);
      console.log(`Scheduled send ${row.id}: status -> cancelled reason=sync_failed`);
      return { kind: "stopped", id: row.id, itemText: row.item_text };
    }
    const after = lockedRow(getScheduledSend(id));
    if (after) {
      return { kind: "too_late", ...after };
    }
  }
  return { kind: "none" };
}

const SYNC_RANK: Record<ScheduleSync["kind"], number> = { none: 0, synced: 1, too_late: 2, stopped: 3 };

function worse(left: ScheduleSync, right: ScheduleSync): ScheduleSync {
  return SYNC_RANK[right.kind] > SYNC_RANK[left.kind] ? right : left;
}

/** Every open scheduled email that was scheduled from this Gmail draft in this mailbox,
 *  whichever chat or button edited the draft. */
export function syncBoundSchedules(draftId: string, account: string, change: ScheduledCopyChange): ScheduleSync {
  const rows = listScheduledSendsForDraft(draftId, account);
  const open = rows.filter(openRow);
  if (open.length === 0) {
    const locked = lockedRow(rows[0]);
    return locked ? { kind: "too_late", ...locked } : { kind: "none" };
  }
  return open.reduce<ScheduleSync>(
    (result, row) => worse(result, applyToSchedule(row.id, change)),
    { kind: "none" },
  );
}

function peopleIn(header: string): ScheduledPerson[] {
  return parseAddressList(header).map((mailbox) => ({ name: mailbox.name, email: mailbox.email }));
}

/** The draft's fields as the scheduled worker reads them. */
export function draftChange(input: {
  to?: string;
  cc?: string;
  subject?: string;
  body?: string;
}): ScheduledCopyChange {
  return {
    to: input.to === undefined ? undefined : peopleIn(input.to),
    cc: input.cc === undefined ? undefined : peopleIn(input.cc),
    subject: input.subject,
    body: input.body,
  };
}

/** The people on a To or Cc header, as the chat's email records them. */
export function attendeesIn(header: string | undefined): ResolvedAttendee[] {
  return (header ? peopleIn(header) : []).map((person) => ({
    query: person.email,
    name: person.name || person.email,
    email: person.email,
    resolved: true,
  }));
}

/**
 * Vishnu tapped Edit on this draft's card. From now on the chat's open email is this
 * draft, whatever was drafted after it, together with the schedule it was scheduled as.
 */
export function focusSelectedDraft(
  chatId: number,
  input: { draftId: string; to: string; cc?: string; subject: string; body: string; account: "work" | "personal" },
  now = new Date(),
): void {
  const pending = getPendingAction(chatId, now);
  const same = pending?.email?.draftId === input.draftId && pending.email.account === input.account;
  const bound = listScheduledSendsForDraft(input.draftId, input.account).find(openRow);
  const to = attendeesIn(input.to);
  savePendingAction(
    chatId,
    {
      action: bound ? "send_email" : "draft_email",
      status: "open",
      ownerWords: pending?.ownerWords ?? "",
      confirmChat: pending?.confirmChat ?? chatId,
      confirmMessage: pending?.confirmMessage ?? 0,
      ownerSupplied: pending?.ownerSupplied,
      meeting: pending?.meeting,
      updatedAt: now.toISOString(),
      email: {
        to: to.length > 0 ? to : same ? pending!.email!.to : [],
        cc: attendeesIn(input.cc),
        subject: input.subject,
        purpose: same ? pending!.email!.purpose ?? input.subject : input.subject,
        notes: [
          ...(same ? pending!.email!.notes.filter((note) => !note.startsWith("Current draft:")) : []),
          `Current draft:\n${input.body}`,
        ],
        account: input.account,
        waiting: "confirm",
        draftId: input.draftId,
        scheduledSendId: bound?.id,
        sendAt: bound?.send_at,
      },
    },
    now,
  );
}

/** Remember a Gmail draft the Email Agent just created, so a later cancel can drop its Send card. */
export function linkPublishedDraft(input: {
  chatId: number;
  draftId: string;
  to: string;
  subject: string;
  body?: string;
  account: "work" | "personal";
}): void {
  const pending = getPendingAction(input.chatId);
  const addresses = [...input.to.matchAll(new RegExp(EMAIL_RE.source, "gi"))].map((match) => match[0].toLowerCase());
  const to = addresses.map((email) => ({
    query: email,
    name: email.split("@")[0]?.replace(/[._]+/g, " ").trim() || email,
    email,
    resolved: true,
  }));
  const linkedSchedule =
    pending?.email?.scheduledSendId && input.draftId
      ? scheduleOwnsDraft(pending.email.scheduledSendId, input.draftId, input.account)
      : false;
  savePendingAction(input.chatId, {
    action: pending?.action === "send_email" ? "send_email" : "draft_email",
    status: "open",
    ownerWords: pending?.ownerWords ?? "",
    confirmChat: pending?.confirmChat ?? input.chatId,
    confirmMessage: pending?.confirmMessage ?? 0,
    ownerSupplied: pending?.ownerSupplied,
    meeting: pending?.meeting,
    updatedAt: new Date().toISOString(),
    email: {
      to: to.length > 0 ? to : pending?.email?.to ?? [],
      cc: pending?.email?.cc ?? [],
      notes: linkedSchedule
        ? [
            ...(pending?.email?.notes ?? []).filter((note) => !note.startsWith("Current draft:")),
            ...(input.body ? [`Current draft:\n${input.body}`] : []),
          ]
        : input.body
          ? [`Current draft:\n${input.body}`]
          : [],
      subject: input.subject,
      purpose: linkedSchedule ? pending?.email?.purpose ?? input.subject : input.subject,
      account: input.account,
      waiting: "confirm",
      draftId: input.draftId,
      sendAt: linkedSchedule ? pending?.email?.sendAt : undefined,
      scheduledSendId: linkedSchedule ? pending?.email?.scheduledSendId : undefined,
    },
  });
}

/**
 * Keep the chat's draft pointed at what a later update_draft wrote, and copy the same
 * recipients, subject and body into the scheduled email it belongs to.
 */
export function syncDraftRecipient(input: {
  chatId: number;
  draftId: string;
  to: string;
  cc?: string;
  subject: string;
  body?: string;
  account: "work" | "personal";
}): ScheduleSync {
  const pending = getPendingAction(input.chatId);
  const change = draftChange(input);
  if (pending?.email?.draftId && pending.email.draftId !== input.draftId) {
    return syncBoundSchedules(input.draftId, input.account, change);
  }
  if (!pending?.email) {
    linkPublishedDraft(input);
    return syncBoundSchedules(input.draftId, input.account, change);
  }
  const to = (change.to ?? []).map((person) => ({
    query: person.email,
    name: person.name || person.email,
    email: person.email,
    resolved: true,
  }));
  const notes = input.body
    ? [...pending.email.notes.filter((note) => !note.startsWith("Current draft:")), `Current draft:\n${input.body}`]
    : pending.email.notes;
  let email: PendingEmailState = {
    ...pending.email,
    to: to.length > 0 ? to : pending.email.to,
    subject: input.subject || pending.email.subject,
    notes,
    draftId: pending.email.draftId || input.draftId,
    account: input.account,
  };
  const linkedId = contextScheduleForDraft(email);
  email = linkedId ? email : { ...email, scheduledSendId: undefined, sendAt: undefined };
  let sync: ScheduleSync = { kind: "none" };
  if (email.scheduledSendId) {
    sync = applyToSchedule(email.scheduledSendId, change);
    if (sync.kind !== "synced") {
      email = { ...email, scheduledSendId: undefined, sendAt: undefined };
    }
  }
  savePendingAction(input.chatId, { ...pending, email });
  return worse(sync, syncBoundSchedules(input.draftId, input.account, change));
}

/** So "cancel that email" can stop a send that was scheduled from this chat. */
export function rememberScheduledSend(input: {
  chatId: number;
  scheduledSendId: number;
  sendAt: string;
  to: string;
  subject: string;
  account: "work" | "personal";
  /** The Gmail draft this was scheduled from, already checked against its mailbox and people. */
  draftId?: string;
  body?: string;
}): void {
  const pending = getPendingAction(input.chatId);
  const open = pending?.email;
  // Only the draft he named carries its notes over. Another open draft, even to the same
  // person, stays a separate email that this schedule can't change or cancel.
  const sameEmail = Boolean(input.draftId) && open?.draftId === input.draftId && open?.account === input.account;
  const notes = sameEmail && open ? open.notes.filter((note) => !note.startsWith("Current draft:")) : [];
  if (input.body) {
    notes.push(`Current draft:\n${input.body}`);
  }
  savePendingAction(input.chatId, {
    action: "send_email",
    status: "open",
    ownerWords: pending?.ownerWords ?? "",
    confirmChat: pending?.confirmChat ?? input.chatId,
    confirmMessage: pending?.confirmMessage ?? 0,
    ownerSupplied: pending?.ownerSupplied,
    meeting: pending?.meeting,
    updatedAt: new Date().toISOString(),
    email: {
      to: attendeesIn(input.to),
      cc: [],
      notes,
      subject: input.subject,
      purpose: sameEmail && open ? open.purpose ?? input.subject : input.subject,
      account: input.account,
      waiting: "confirm",
      draftId: input.draftId,
      scheduledSendId: input.scheduledSendId,
      sendAt: input.sendAt,
    },
  });
}

export function focusBookedMeeting(
  chatId: number,
  booked: NonNullable<PendingAction["bookedMeeting"]>,
  now = new Date(),
): void {
  storeBookedRef(chatId, booked, now);
  const pending = getPendingAction(chatId, now);
  savePendingAction(
    chatId,
    {
      action: pending?.action ?? "note",
      status: pending?.status ?? "done",
      ownerWords: pending?.ownerWords ?? "",
      confirmChat: pending?.confirmChat ?? chatId,
      confirmMessage: pending?.confirmMessage ?? 0,
      ownerSupplied: pending?.ownerSupplied,
      email: pending?.email,
      meeting: pending?.meeting,
      updatedAt: now.toISOString(),
      bookedMeeting: booked,
    },
    now,
  );
}

export function clearPendingAction(chatId: number, now = new Date()): void {
  const pending = getPendingAction(chatId, now);
  if (!pending || ((pending.ownerSupplied?.length ?? 0) === 0 && !pending.bookedMeeting)) {
    deletePendingActionContext(chatId);
    return;
  }
  savePendingAction(
    chatId,
    {
      ...pending,
      status: "done",
      action: pending.action === "note" ? "note" : pending.action,
      meeting: undefined,
    },
    now,
  );
}

/** Owner words that authorized this workflow, including earlier turns. */
export function authorizationWords(
  chatId: number | undefined,
  currentText: string,
  now = new Date(),
): string {
  const current = currentText.trim();
  if (chatId === undefined) {
    return current;
  }
  const pending = getPendingAction(chatId, now);
  if (!pending || pending.status !== "open") {
    return current;
  }
  if (pending.action === "draft_email" || pending.action === "note" || pending.action === "ignore") {
    return current;
  }
  if (pending.action === "send_email") {
    const authorizedAt = Date.parse(pending.authorizedAt ?? "");
    if (!Number.isFinite(authorizedAt) || now.getTime() - authorizedAt > AUTH_TTL_MS) {
      return current;
    }
  }
  if (pending.action !== "create_meeting" && pending.action !== "send_email") {
    return current;
  }
  if (pending.ownerWords.trim() === current) {
    return current;
  }
  return `${pending.ownerWords}\n${current}`.trim();
}

export function pendingResolvedEmails(
  chatId: number | undefined,
  now = new Date(),
): Map<string, ResolvedAttendee> {
  const found = new Map<string, ResolvedAttendee>();
  if (chatId === undefined) {
    return found;
  }
  const pending = getPendingAction(chatId, now);
  if (pending?.status !== "open") {
    return found;
  }
  const people = [
    ...(pending.meeting?.attendees ?? []),
    ...(pending.email?.to ?? []),
    ...(pending.email?.cc ?? []),
  ];
  for (const attendee of people) {
    if (attendee.resolved && attendee.email) {
      found.set(attendee.email.toLowerCase(), attendee);
      found.set(attendee.query.toLowerCase(), attendee);
    }
  }
  return found;
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE_RE = /(?:\+?91[\s-]?)?[6-9]\d{9}\b/;
const SHARED_ADDRESS =
  /\b(?:this|that|the|same)\s+(?:email(?:\s+id)?|address)\b|\bemail i (?:just )?(?:shared|gave|sent|typed)\b|\baddress i (?:just )?(?:shared|gave|sent|typed)\b|\bsend it to (?:him|her|them)\b|\bthe person we discussed\b/i;

function hasWord(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(text);
}

function mergeSupplied(
  previous: readonly OwnerSuppliedContact[] | undefined,
  incoming: readonly OwnerSuppliedContact[] | undefined,
): OwnerSuppliedContact[] {
  const byEmail = new Map<string, OwnerSuppliedContact>();
  for (const item of [...(previous ?? []), ...(incoming ?? [])]) {
    const key = item.email.toLowerCase();
    const prior = byEmail.get(key);
    byEmail.set(key, {
      ...prior,
      ...item,
      email: key,
      phone: item.phone ?? prior?.phone,
    });
  }
  return [...byEmail.values()];
}

function knownContacts(chatId: number, now: Date): OwnerSuppliedContact[] {
  const pending = getPendingAction(chatId, now)?.ownerSupplied ?? [];
  const saved: OwnerSuppliedContact[] = [];
  for (const row of listCanonicalContacts()) {
    if (!row.confirmed) {
      continue;
    }
    let sources: string[] = [];
    let emails: string[] = [];
    try {
      sources = JSON.parse(row.sources_json) as string[];
      emails = JSON.parse(row.emails_json) as string[];
    } catch {
      continue;
    }
    if (!sources.includes("known")) {
      continue;
    }
    for (const email of emails) {
      saved.push({
        email: email.toLowerCase(),
        name: row.display_name,
        messageId: 0,
        at: row.updated_at,
      });
    }
  }
  return mergeSupplied(saved, pending);
}

function shell(chatId: number, now: Date, existing?: PendingAction): PendingAction {
  return (
    existing ?? {
      action: "note",
      status: "open",
      ownerWords: "",
      confirmChat: chatId,
      confirmMessage: 0,
      ownerSupplied: [],
      updatedAt: now.toISOString(),
    }
  );
}

export function messageAuthorizesExternalSend(text: string): boolean {
  return /\b(?:send|e-?mail|mail|schedule)\b/i.test(text) && !/\b(?:don'?t|do not|never)\s+(?:send|e-?mail|mail|schedule)\b/i.test(text) && !/\bdraft\b/i.test(text);
}

function looksLikeEmailContext(text: string): boolean {
  if (/^(?:what|who|when|where|why|how|show|list|find|search)\b/i.test(text.trim())) {
    return false;
  }
  if (/\b(?:add|remove|delete|set|create|schedule|book|cancel)\b/i.test(text) && /\b(?:task|reminder|bill|meeting|calendar)\b/i.test(text)) {
    return false;
  }
  if (/\badd\s+(?:this|that|a|one more|another)\s+(?:point|line|sentence)\b/i.test(text)) {
    return true;
  }
  return /\b(?:about|regarding|mention|wants?|needs?|requirement|context|subject|shorter|longer|wording|reword|rephrase|formal|tone)\b/i.test(text);
}

function recipientInstead(text: string): string | undefined {
  const match =
    /^(?:actually,?\s+)?(?:please\s+)?(?:send|e-?mail)\s+it\s+to\s+(.+?)\s+instead\.?$/i.exec(text.trim())
    ?? /^(?:change|switch|update)\s+(?:the\s+)?recipient\s+to\s+(.+?)\.?$/i.exec(text.trim());
  const name = match?.[1]?.trim();
  return name || undefined;
}

const WHEN_WORDS =
  /\b(?:tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|scheduled|later)(?:'s|\u2019s)?\b/i;

/** "Cancel tomorrow's email", "cancel the email to Bob": words that point at a different
 *  email than the open one. Then the open email is left alone and the scheduled-send
 *  tool finds the one he named. */
function namesAnotherEmail(text: string, email: PendingEmailState): boolean {
  if (WHEN_WORDS.test(text) && !email.scheduledSendId) {
    return true;
  }
  const named = /\bto\s+([\p{L}][\p{L}.'-]*(?:\s+[\p{L}][\p{L}.'-]*){0,2})/iu.exec(text)?.[1] ?? "";
  const asked = nameTokens(named).filter((token) => token.length >= 3 && !/^(?:the|that|this|him|her|them|tomorrow|today|tonight|send)$/.test(token));
  if (asked.length === 0) {
    return false;
  }
  const known = new Set(
    [...email.to, ...email.cc].flatMap((person) => nameTokens(`${person.name} ${person.query} ${person.email.replace(/[@.]/g, " ")}`)),
  );
  return !asked.some((token) => known.has(token));
}

function correctionOfEmail(text: string, email: PendingEmailState | undefined): boolean {
  if (!email) {
    return false;
  }
  if (namesAnotherEmail(text, email)) {
    return false;
  }
  if (/\b(?:don'?t send|do not send|never send)\b/i.test(text)) {
    return true;
  }
  if (/\bcancel\b/i.test(text)) {
    if (/\b(?:meeting|reminder|task|bill|event)\b/i.test(text)) {
      return false;
    }
    return /\b(?:email|e-mail|mail|draft|it|that)\b/i.test(text);
  }
  if (/^(?:not|no)\b/i.test(text.trim()) && /\b(?:context|explain|tell you)\b/i.test(text)) {
    return true;
  }
  const token = (email.subject ?? email.purpose ?? "").split(/\s+/).find((word) => word.length > 3);
  if (token && new RegExp(`\\bnot\\b[^.?!\\n]{0,40}\\b${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) {
    return true;
  }
  return false;
}

function cancelLinkedSend(email: PendingEmailState | undefined): void {
  if (!email?.scheduledSendId) {
    return;
  }
  const row = getScheduledSend(email.scheduledSendId);
  // Never another email's schedule, even one to the same person.
  if (!row || !rowBelongsTo(row, email)) {
    return;
  }
  if (transitionScheduledSend(row.id, ["scheduled", "held"], "cancelled")) {
    markTaskDone(row.task_id);
  }
}

/** A scheduled reply whose new subject no longer matches its thread. */
function scheduledReplyLeavesThread(id: number, subject: string): boolean {
  try {
    const request = JSON.parse(getScheduledSend(id)?.request ?? "{}") as { threadId?: unknown; threadSubject?: unknown };
    return typeof request.threadId === "string" && typeof request.threadSubject === "string" && !sameConversation(subject, request.threadSubject);
  } catch {
    return false;
  }
}

function tooLateToCancelText(locked: LockedSchedule): string {
  return locked.sent
    ? `Too late to cancel: that scheduled email already went out. (${locked.itemText})`
    : `Too late to cancel: that scheduled email is already being sent. (${locked.itemText})`;
}

/** "Change the subject to X and mention Y": the subject, and the rest as a rewrite. */
function splitSubjectChange(captured: string): { subject: string; rest?: string } {
  const joined = /^(.+?)\s+and\s+(?:also\s+)?((?:mention|add|say|include|note|tell (?:him|her|them)|let (?:him|her|them) know)\s.+)$/i.exec(captured);
  return joined ? { subject: joined[1]!.trim(), rest: joined[2]!.trim() } : { subject: captured.trim() };
}

export type OwnerReference =
  | { kind: "none" }
  | { kind: "one"; contact: OwnerSuppliedContact }
  | { kind: "many"; contacts: OwnerSuppliedContact[] };

/** An address Vishnu typed in this chat. Never an address Aadi only read. */
export function matchOwnerSupplied(chatId: number | undefined, query: string, now = new Date()): OwnerReference {
  if (chatId === undefined) {
    return { kind: "none" };
  }
  const local = getPendingAction(chatId, now)?.ownerSupplied ?? [];
  const supplied = knownContacts(chatId, now);
  if (supplied.length === 0) {
    return { kind: "none" };
  }
  const address = addressIn(query);
  if (address) {
    const hit = supplied.find((item) => item.email === address);
    return hit ? { kind: "one", contact: hit } : { kind: "none" };
  }
  if (/^(?:him|her|them|it)$/i.test(query.trim())) {
    if (local.length === 1) {
      return { kind: "one", contact: local[0]! };
    }
    return local.length > 1 ? { kind: "many", contacts: local } : { kind: "none" };
  }
  if (SHARED_ADDRESS.test(query)) {
    const pool = local.length > 0 ? local : supplied.slice(-1);
    return pool.length === 1
      ? { kind: "one", contact: pool[0]! }
      : { kind: "many", contacts: pool };
  }
  const tokens = nameTokens(query);
  if (tokens.length === 0) {
    return { kind: "none" };
  }
  const matches = supplied.filter((item) => {
    const haystack = `${item.name} ${item.email.replace(/[@.]/g, " ")}`;
    return tokens.every((token) => hasWord(haystack, token));
  });
  if (matches.length === 1) {
    return { kind: "one", contact: matches[0]! };
  }
  if (matches.length > 1) {
    return { kind: "many", contacts: matches };
  }
  const fuzzy = supplied.filter((item) => {
    const first = nameTokens(item.name)[0] ?? "";
    const local = nameTokens(item.email.split("@")[0] ?? "")[0] ?? "";
    return (
      tokens.length === 1 &&
      tokens[0] !== undefined &&
      (namesFuzzyEqual(tokens[0], first) || namesFuzzyEqual(tokens[0], local))
    );
  });
  if (fuzzy.length === 1) {
    return { kind: "one", contact: fuzzy[0]! };
  }
  if (fuzzy.length > 1) {
    return { kind: "many", contacts: fuzzy };
  }
  return { kind: "none" };
}

export interface OwnerTurnResult {
  handled: boolean;
  text?: string;
  /** Unhandled, but he asked about the past and this is what was found. The caller gives it
   *  to the model as data to answer from, never as instructions. */
  historyNote?: string;
  /** The draft is complete. The caller posts one Gmail approval card and does not repeat the body. */
  publishDraft?: boolean;
  /** A published Gmail draft whose Send card must be discarded with this turn. */
  retireDraftId?: string;
  /** Replace only the subject of the open Gmail draft. With reviseEmail, the subject that rewrite uses. */
  subjectUpdate?: string;
  /** Change the open draft's To line without rewriting the message. */
  redirectDraft?: { draftId: string; to: string };
  /** Rewrite the open draft from this instruction, replacing superseded facts. */
  reviseEmail?: string;
}

/**
 * Record what Vishnu himself just typed and fold it into the open action.
 * Forwarded text must not be passed here.
 */
export function applyOwnerContextTurn(
  chatId: number,
  text: string,
  messageId: number,
  now = new Date(),
  options: { forwarded?: boolean } = {},
): OwnerTurnResult {
  if (options.forwarded) {
    return { handled: false };
  }
  const clean = text.trim();
  if (!clean) {
    return { handled: false };
  }
  const pending = getPendingAction(chatId, now);
  const base = shell(chatId, now, pending);
  const emails = [...clean.matchAll(EMAIL_RE)].map((match) => match[0].toLowerCase());
  for (const email of emails) {
    const local = email.split("@")[0]?.replace(/[._]+/g, " ").trim() || email;
    rememberContactChoice(local, { name: local, emails: [email], sources: ["known"] });
  }
  let contextNote = "";
  const unhandled = (): OwnerTurnResult =>
    contextNote ? { handled: false, historyNote: contextNote } : { handled: false };
  if (wantsHistoricalContext(clean)) {
    const found = retrieveRelevantContext(clean);
    if (found.kind === "many") {
      savePendingAction(chatId, { ...base, ownerSupplied: base.ownerSupplied }, now);
      return { handled: true, text: found.question };
    }
    if (found.kind === "one") {
      contextNote = found.summary;
    }
  }
  const phone = clean.match(PHONE_RE)?.[0].replace(/\D/g, "");
  let supplied = [...(base.ownerSupplied ?? [])];
  for (const email of emails) {
    const local = email.split("@")[0] ?? email;
    supplied = mergeSupplied(supplied, [
      {
        email,
        name: local.replace(/[._]+/g, " ").trim(),
        messageId,
        at: now.toISOString(),
      },
    ]);
  }
  if (phone && emails.length === 0) {
    const last = supplied[supplied.length - 1];
    if (last) {
      supplied = mergeSupplied(supplied, [{ ...last, phone, messageId, at: now.toISOString() }]);
    }
  }
  let next: PendingAction = { ...base, ownerSupplied: supplied, confirmMessage: messageId || base.confirmMessage };

  if (correctionOfEmail(clean, next.email) && next.email && next.status === "open") {
    const locked = lockedScheduleFor(next.email);
    if (locked) {
      return { handled: true, text: tooLateToCancelText(locked) };
    }
    cancelLinkedSend(next.email);
    const retireDraftId = next.email.draftId;
    next = {
      ...next,
      status: "cancelled",
      action: next.action === "note" ? "draft_email" : next.action,
      email: {
        ...next.email,
        waiting: "purpose",
        scheduledSendId: undefined,
        purpose: undefined,
        subject: undefined,
        draftId: undefined,
      },
    };
    savePendingAction(chatId, next, now);
    return {
      handled: true,
      text: "Cancelled that email. It will not be sent. Tell me the context when you're ready.",
      retireDraftId,
    };
  }

  const remove = /^(?:remove|drop)\s+(.+)$/i.exec(clean);
  if (
    remove &&
    next.action === "create_meeting" &&
    next.status === "open" &&
    next.meeting &&
    !/\b(?:task|reminder|bill|memory|shopping)\b/i.test(clean)
  ) {
    const name = remove[1]!.replace(/\s+from\s+.*$/i, "").trim();
    const token = name.toLowerCase();
    const words = token.includes("@") ? [token] : token.split(/\s+/).filter((word) => word.length >= 3);
    const matched = next.meeting.attendees.flatMap((item, index) => {
      const hay = `${item.name} ${item.query}`.toLowerCase();
      const hit = words.length > 0 && words.every((word) => hay.includes(word));
      return hit ? [{ item, index }] : [];
    });
    if (matched.length > 1) {
      return {
        handled: true,
        text: `Which ${name}? ${matched.map(({ item }) => item.name || item.query || "unnamed").join(", ")}`,
      };
    }
    if (matched.length === 1) {
      const dropAt = matched[0]!.index;
      next = {
        ...next,
        meeting: {
          ...next.meeting,
          attendees: next.meeting.attendees.filter((_, index) => index !== dropAt),
        },
      };
      savePendingAction(chatId, next, now);
      return {
        handled: true,
        text: `Removed ${name} from the pending meeting. The other attendees stay.`,
      };
    }
  }

  if (/\b(?:the other one|not that one)\b/i.test(clean) && supplied.length === 2 && next.email?.to[0]) {
    const other = supplied.find((item) => item.email !== next.email!.to[0]!.email);
    const locked = other ? lockedScheduleFor(next.email) : undefined;
    if (locked) {
      return { handled: true, text: tooLateText(locked) };
    }
    if (other && next.email) {
      const email = {
        ...next.email,
        to: [{ query: other.name, name: other.name, email: other.email, resolved: true }],
      };
      let scheduleNote = "";
      const scheduleId = contextScheduleForDraft(email);
      if (scheduleId) {
        const sync = applyToSchedule(scheduleId, { to: [{ name: other.name, email: other.email }] });
        if (sync.kind !== "synced") {
          email.scheduledSendId = undefined;
          email.sendAt = undefined;
          scheduleNote = ` ${scheduleSyncNotice(sync)}`.trimEnd();
        }
      } else if (email.scheduledSendId) {
        email.scheduledSendId = undefined;
        email.sendAt = undefined;
      }
      next = { ...next, status: "open", email };
      savePendingAction(chatId, next, now);
      return {
        handled: true,
        text: `Using ${other.email} instead. Nothing has been sent.${scheduleNote}`,
        publishDraft: Boolean(email.draftId),
      };
    }
  }

  const openEmail = next.status === "open" && (next.action === "draft_email" || next.action === "send_email");
  const redirectName = recipientInstead(clean);
  if (openEmail && next.email && (redirectName || next.email.pendingRedirect)) {
    const asked = redirectName ?? next.email.pendingRedirect ?? "";
    const typed = emails.length === 1 ? emails[0] : undefined;
    const found = typed
      ? { kind: "one" as const, contact: { email: typed, name: typed.split("@")[0]?.replace(/[._]+/g, " ") ?? typed, messageId, at: now.toISOString() } }
      : matchOwnerSupplied(chatId, asked === next.email.pendingRedirect && !redirectName ? clean : asked, now);
    if (found.kind === "many") {
      next = { ...next, email: { ...next.email, pendingRedirect: asked } };
      savePendingAction(chatId, next, now);
      return {
        handled: true,
        text: `Which ${asked}? ${found.contacts.map((item) => `${item.name} <${item.email}>`).join(", ")}`,
      };
    }
    if (found.kind === "none") {
      next = { ...next, email: { ...next.email, pendingRedirect: asked } };
      savePendingAction(chatId, next, now);
      return {
        handled: true,
        text: `I don't have a confirmed address for ${asked}. Tell me which address to use.`,
      };
    }
    const person = found.contact;
    const locked = lockedScheduleFor(next.email);
    if (locked) {
      return { handled: true, text: tooLateText(locked) };
    }
    let email: PendingEmailState = {
      ...next.email,
      pendingRedirect: undefined,
      to: [{ query: person.name, name: person.name, email: person.email, resolved: true }],
    };
    let scheduleNote = "";
    const scheduleId = contextScheduleForDraft(email);
    if (scheduleId) {
      const sync = applyToSchedule(scheduleId, { to: [{ name: person.name, email: person.email }] });
      if (sync.kind !== "synced") {
        email = { ...email, scheduledSendId: undefined, sendAt: undefined };
        scheduleNote = ` ${scheduleSyncNotice(sync)}`.trimEnd();
      }
    }
    next = { ...next, status: "open", email };
    savePendingAction(chatId, next, now);
    return {
      handled: true,
      text: scheduleNote
        ? `The draft now says ${person.email}.${scheduleNote}`
        : `Using ${person.email} instead. The subject, message, and time stay.`,
      redirectDraft: email.draftId ? { draftId: email.draftId, to: person.email } : undefined,
    };
  }
  const subjectChange = /^(?:please\s+)?(?:change|set|update|make)\s+(?:the\s+)?subject\s+(?:to|as|:)\s+(.+?)\.?$/i.exec(clean)
    ?? /^subject\s*(?:to|:)\s+(.+?)\.?$/i.exec(clean);
  if (subjectChange && openEmail && (next.email?.draftId || next.email?.scheduledSendId)) {
    const locked = lockedScheduleFor(next.email);
    if (locked) {
      return { handled: true, text: tooLateText(locked) };
    }
    const { subject, rest } = splitSubjectChange(subjectChange[1]!);
    if (rest) {
      // The rewrite carries the new subject, so both land together or not at all.
      return { handled: true, reviseEmail: rest, subjectUpdate: subject };
    }
    let scheduleNote = "";
    let current = next.email!;
    const scheduleId = contextScheduleForDraft(current);
    if (scheduleId) {
      const sync = applyToSchedule(scheduleId, { subject });
      if (sync.kind !== "synced") {
        current = { ...current, scheduledSendId: undefined, sendAt: undefined };
        scheduleNote = scheduleSyncNotice(sync);
      }
    }
    next = { ...next, email: { ...current, subject } };
    savePendingAction(chatId, next, now);
    const leaves = !scheduleNote && scheduleId ? scheduledReplyLeavesThread(scheduleId, subject) : false;
    const text =
      scheduleNote ||
      (current.draftId
        ? undefined
        : `The scheduled email's subject is now "${subject}".${leaves ? " It will go out as a new conversation, not as a reply in the original thread." : ""}`);
    return { handled: true, subjectUpdate: subject, text };
  }
  const freshDraft = /\b(?:draft|write|compose)\b/i.test(clean) && /\b(?:e-?mails?|mail)\b/i.test(clean)
    && !/\b(?:shorter|longer|subject)\b/i.test(clean);
  if (freshDraft) {
    const named = clean.replace(/^.*\bto\s+/i, "").replace(/[.?!].*$/, "").trim();
    next = {
      ...next,
      action: "draft_email",
      status: "open",
      ownerWords: [next.ownerWords, clean].filter(Boolean).join("\n"),
      confirmChat: chatId,
      confirmMessage: messageId,
      email: {
        to: [],
        cc: [],
        notes: [],
        account: "work",
        waiting: "recipient",
        purpose: named && !addressIn(named) ? undefined : undefined,
      },
    };
    if (named && !addressIn(named)) {
      next.email!.notes.push(`recipient query: ${named}`);
    }
    savePendingAction(chatId, next, now);
    return unhandled();
  }

  if (openEmail && next.email && emails.length === 1 && next.email.to.length === 0) {
    const contact = supplied.find((item) => item.email === emails[0]);
    next = {
      ...next,
      email: {
        ...next.email,
        to: [
          {
            query: contact?.name ?? emails[0]!,
            name: contact?.name ?? emails[0]!,
            email: emails[0]!,
            resolved: true,
          },
        ],
        waiting: next.email.purpose ? "confirm" : "purpose",
      },
    };
  } else if (
    openEmail &&
    next.email &&
    looksLikeEmailContext(clean) &&
    !messageAuthorizesExternalSend(clean) &&
    emails.length === 0
  ) {
    if (next.email.draftId || next.email.scheduledSendId) {
      const locked = lockedScheduleFor(next.email);
      return locked ? { handled: true, text: tooLateText(locked) } : { handled: true, reviseEmail: clean };
    }
    const notes = [...next.email.notes, clean, ...(contextNote ? [contextNote] : [])];
    next = {
      ...next,
      email: {
        ...next.email,
        notes,
        purpose: next.email.purpose ?? clean,
        waiting: next.email.to.length > 0 ? "confirm" : "recipient",
      },
    };
  } else if (
    pending?.status === "cancelled" &&
    looksLikeEmailContext(clean) &&
    !messageAuthorizesExternalSend(clean)
  ) {
    const contact = supplied[supplied.length - 1];
    next = {
      ...next,
      action: "draft_email",
      status: "open",
      ownerWords: clean,
      confirmChat: chatId,
      confirmMessage: messageId,
      email: {
        to: contact
          ? [{ query: contact.name, name: contact.name, email: contact.email, resolved: true }]
          : [],
        cc: [],
        notes: [clean, ...(contextNote ? [contextNote] : [])],
        purpose: clean,
        account: "work",
        waiting: contact ? "confirm" : "recipient",
      },
    };
  }

  const changed =
    emails.length > 0 ||
    Boolean(phone) ||
    freshDraft ||
    next.status !== base.status ||
    next.action !== base.action ||
    next.email?.purpose !== base.email?.purpose ||
    (next.email?.notes.length ?? 0) !== (base.email?.notes.length ?? 0);
  if (!changed) {
    return unhandled();
  }
  savePendingAction(chatId, next, now);
  if (
    looksLikeEmailContext(clean) &&
    next.email &&
    next.status === "open" &&
    next.email.to.length > 0 &&
    next.email.purpose &&
    !messageAuthorizesExternalSend(clean)
  ) {
    return { handled: true, publishDraft: true };
  }
  if (contextNote && !next.email?.to.length) {
    return {
      handled: true,
      text: `${contextNote} Who should I write to?`,
    };
  }
  return unhandled();
}

/** Tool-side gate: a context update must not send, and a cancelled email stays cancelled. */
export function holdEmailToolTurn(
  chatId: number,
  ownWords: string,
  now = new Date(),
): string | undefined {
  const pending = getPendingAction(chatId, now);
  if (correctionOfEmail(ownWords, pending?.email) && pending?.email && pending.status === "open") {
    const locked = lockedScheduleFor(pending.email);
    if (locked) {
      return tooLateToCancelText(locked);
    }
    cancelLinkedSend(pending.email);
    savePendingAction(
      chatId,
      {
        ...pending,
        status: "cancelled",
        email: { ...pending.email, scheduledSendId: undefined, subject: undefined, purpose: undefined },
      },
      now,
    );
    return "Cancelled that email. It will not be sent.";
  }
  if (
    pending?.status === "cancelled" &&
    pending.email &&
    !messageAuthorizesExternalSend(ownWords)
  ) {
    return "Not sent: that email was cancelled. Nothing from it will go out. Say send when you want a new one.";
  }
  if (pending?.status === "open" && pending.email && !messageAuthorizesExternalSend(ownWords)) {
    if (notASendCommand(ownWords) === undefined && /\b(?:send|e-?mail|mail|reply|schedule)\b/i.test(ownWords)) {
      return undefined;
    }
    const stillAuthorized =
      pending.action === "send_email" &&
      messageAuthorizesExternalSend(pending.ownerWords) &&
      Boolean(pending.email.sendAt) &&
      Number.isFinite(Date.parse(pending.authorizedAt ?? "")) &&
      now.getTime() - Date.parse(pending.authorizedAt ?? "") <= AUTH_TTL_MS;
    if (!stillAuthorized) {
      return "Not sent: this message adds context, and it does not send or schedule anything.";
    }
  }
  return undefined;
}

const NEW_REQUEST =
  /\b(?:send|e-?mail|mail|find|search|show|check|book|schedule|remind|draft|write|reply|forward|list|add|delete|cancel|summari[sz]e|read|call|tell|create)\b/i;

export type PendingContinuation =
  | { kind: "none" }
  | { kind: "meeting_time"; startIso: string; pending: PendingAction }
  | { kind: "ignore"; entities: ReferentEntity[]; pendingKind?: string }
  | { kind: "yes"; pending: PendingAction };

/** Whether this short reply continues a stored action instead of starting a new one. */
export function continuePendingAction(
  chatId: number | undefined,
  text: string,
  now = new Date(),
): PendingContinuation {
  if (chatId === undefined) {
    return { kind: "none" };
  }
  const clean = text.trim();
  const pending = getPendingAction(chatId, now);
  const referents = resolveReferentPhrase(clean, chatId, now);
  const { pendingKind } = lastPresentedEntities(chatId, now);

  if (referents.kind === "yes" && pending?.meeting?.waiting === "confirm_contact") {
    return { kind: "yes", pending };
  }

  const ignoreEntities =
    referents.kind === "collection" || referents.kind === "indexes"
      ? referents.entities
      : referents.kind === "singular"
        ? [referents.entity]
        : [];
  if (
    ignoreEntities.length > 0 &&
    (looksLikeIgnoreInstruction(clean) || pendingKind === "ignore_which")
  ) {
    return { kind: "ignore", entities: ignoreEntities, pendingKind };
  }

  if (!pending || pending.status !== "open" || pending.action !== "create_meeting" || !pending.meeting) {
    return { kind: "none" };
  }
  if (/\b(?:don'?t|do not|never)\b/i.test(clean)) {
    return { kind: "none" };
  }
  if (NEW_REQUEST.test(clean) && !looksLikeTimeFill(clean) && !looksLikeIgnoreInstruction(clean)) {
    return { kind: "none" };
  }
  if (pending.meeting.waiting === "time") {
    const startIso = parseOwnerTime(clean, now);
    if (startIso && looksLikeTimeFill(clean)) {
      return { kind: "meeting_time", startIso, pending };
    }
  }
  return { kind: "none" };
}

export function formatPendingAction(action: PendingAction): string {
  const known = (action.ownerSupplied ?? [])
    .map((item) => `${item.name} <${item.email}>${item.phone ? ` phone ${item.phone}` : ""}`)
    .join("; ");
  const knownLine = known
    ? ` Vishnu already typed these addresses (identity only, not a send): ${known}.`
    : "";
  if (action.status === "cancelled" && action.email) {
    return `The previous email was cancelled and must not be sent or restored.${knownLine}`;
  }
  if (action.status === "open" && action.email && (action.action === "draft_email" || action.action === "send_email")) {
    const people = action.email.to
      .map((item) => (item.resolved ? `${item.name} <${item.email}>` : item.query))
      .join(", ");
    return `Pending ${action.action} for ${people || "an unresolved recipient"}. Context: ${(action.email.notes ?? []).join(" ") || action.email.purpose || "none"}. Do not ask for an email address he already typed. Do not send unless he said send or schedule.${knownLine}`;
  }
  if (action.status === "open" && action.action === "create_meeting" && action.meeting) {
    const people = action.meeting.attendees
      .map((item) =>
        item.resolved
          ? `${item.name} <${item.email}>`
          : `${item.query} (unresolved)`,
      )
      .join("; ");
    const waiting =
      action.meeting.waiting === "time"
        ? "waiting for a time"
        : action.meeting.waiting === "attendees"
          ? "waiting for attendee clarification"
          : "waiting for confirmation";
    return `Pending meeting "${action.meeting.title ?? "untitled"}" with ${people}. ${waiting}. Continue this booking; do not ask for emails already resolved.${knownLine}`;
  }
  return `Pending ${action.action}. Continue it from where it stands.${knownLine}`;
}
