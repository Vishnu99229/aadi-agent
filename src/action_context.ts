import { addressIn, nameTokens, notASendCommand } from "./command_logic.js";
import { namesFuzzyEqual } from "./contact_logic.js";
import { rememberContactChoice } from "./contacts.js";
import { retrieveRelevantContext } from "./context_lookup.js";
import {
  deletePendingActionContext,
  getPendingActionContext,
  getScheduledSend,
  listCanonicalContacts,
  markTaskDone,
  transitionScheduledSend,
  upsertCalendarEventRef,
  upsertPendingActionContext,
} from "./db.js";
import { looksLikeIgnoreInstruction } from "./ignore.js";
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

/** Point "that meeting" at an older event without dropping an open draft. */
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
      notes: [
        ...(pending?.email?.notes ?? []).filter((note) => !note.startsWith("Current draft:")),
        ...(input.body ? [`Current draft:\n${input.body}`] : []),
      ],
      subject: input.subject,
      purpose: pending?.email?.purpose ?? input.subject,
      account: input.account,
      waiting: "confirm",
      draftId: input.draftId || pending?.email?.draftId,
      sendAt: pending?.email?.sendAt,
      scheduledSendId: pending?.email?.scheduledSendId,
    },
  });
}

/** So "cancel that email" can stop a send that was scheduled from this chat. */
export function rememberScheduledSend(input: {
  chatId: number;
  scheduledSendId: number;
  sendAt: string;
  to: string;
  subject: string;
  account: "work" | "personal";
}): void {
  linkPublishedDraft({
    chatId: input.chatId,
    draftId: getPendingAction(input.chatId)?.email?.draftId ?? "",
    to: input.to,
    subject: input.subject,
    account: input.account,
  });
  const pending = getPendingAction(input.chatId);
  if (!pending?.email) {
    return;
  }
  savePendingAction(input.chatId, {
    ...pending,
    action: "send_email",
    status: "open",
    email: { ...pending.email, scheduledSendId: input.scheduledSendId, sendAt: input.sendAt, draftId: pending.email.draftId || undefined },
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
  return /\b(?:about|regarding|mention|wants?|needs?|requirement|context|subject|shorter|longer)\b/i.test(text);
}

function correctionOfEmail(text: string, email: PendingEmailState | undefined): boolean {
  if (!email) {
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
  if (!row) {
    return;
  }
  if (transitionScheduledSend(row.id, ["scheduled", "held"], "cancelled")) {
    markTaskDone(row.task_id);
  }
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
  /** The draft is complete. The caller posts one Gmail approval card and does not repeat the body. */
  publishDraft?: boolean;
  /** A published Gmail draft whose Send card must be discarded with this turn. */
  retireDraftId?: string;
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
  if (/\b(?:remember|discussion|follow-?up|last week|same people|what happened|our conversation)\b/i.test(clean)) {
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

  if (correctionOfEmail(clean, next.email) && next.email && next.status !== "cancelled") {
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
    const token = remove[1]!.trim().toLowerCase();
    next = {
      ...next,
      meeting: {
        ...next.meeting,
        attendees: next.meeting.attendees.filter(
          (item) => !item.name.toLowerCase().includes(token) && !item.query.toLowerCase().includes(token),
        ),
      },
    };
    savePendingAction(chatId, next, now);
    return {
      handled: true,
      text: `Removed ${remove[1]!.trim()} from the pending meeting. The other attendees stay.`,
    };
  }

  if (/\b(?:the other one|not that one)\b/i.test(clean) && supplied.length === 2 && next.email?.to[0]) {
    const other = supplied.find((item) => item.email !== next.email!.to[0]!.email);
    if (other && next.email) {
      const email = {
        ...next.email,
        to: [{ query: other.name, name: other.name, email: other.email, resolved: true }],
      };
      next = { ...next, status: "open", email };
      savePendingAction(chatId, next, now);
      return {
        handled: true,
        text: `Using ${other.email} instead. Nothing has been sent.`,
        publishDraft: Boolean(email.draftId),
      };
    }
  }

  const openEmail = next.status === "open" && (next.action === "draft_email" || next.action === "send_email");
  const freshDraft = /\bdraft\b/i.test(clean) && /\b(?:email|e-mail|mail)\b/i.test(clean);
  if (freshDraft && !openEmail) {
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
    return { handled: false };
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
    return { handled: false };
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
  return { handled: false };
}

/** Tool-side gate: a context update must not send, and a cancelled email stays cancelled. */
export function holdEmailToolTurn(
  chatId: number,
  ownWords: string,
  now = new Date(),
): string | undefined {
  const pending = getPendingAction(chatId, now);
  if (correctionOfEmail(ownWords, pending?.email) && pending?.email && pending.status !== "cancelled") {
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
