import {
  deletePendingActionContext,
  getPendingActionContext,
  upsertPendingActionContext,
} from "./db.js";
import { looksLikeIgnoreInstruction } from "./ignore.js";
import { lastPresentedEntities, resolveReferentPhrase, type ReferentEntity } from "./referents.js";
import { looksLikeTimeFill, parseOwnerTime } from "./time_parse.js";

const ACTION_TTL_MS = 30 * 60 * 1000;

export interface ResolvedAttendee {
  query: string;
  name: string;
  email: string;
  resolved: boolean;
}

export interface PendingMeetingState {
  title?: string;
  calendar: "work";
  attendees: ResolvedAttendee[];
  startIso?: string;
  durationMinutes?: number;
  waiting: "time" | "attendees" | "confirm_contact";
  resolutionAttempts: Record<string, string[]>;
}

export interface PendingAction {
  action: "create_meeting" | "ignore" | "send_email";
  ownerWords: string;
  confirmChat: number;
  confirmMessage: number;
  meeting?: PendingMeetingState;
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
  if (now.getTime() - Date.parse(row.updated_at) > ACTION_TTL_MS) {
    deletePendingActionContext(chatId);
    return undefined;
  }
  const parsed = parseState(row.state_json);
  if (!parsed) {
    return undefined;
  }
  return {
    ...parsed,
    ownerWords: row.owner_words,
    confirmChat: row.confirm_chat,
    confirmMessage: row.confirm_message,
    updatedAt: row.updated_at,
  };
}

export function savePendingAction(chatId: number, action: PendingAction): void {
  upsertPendingActionContext({
    chatId,
    action: action.action,
    stateJson: JSON.stringify(action),
    ownerWords: action.ownerWords,
    confirmChat: action.confirmChat,
    confirmMessage: action.confirmMessage,
    updatedAt: new Date().toISOString(),
  });
}

export function clearPendingAction(chatId: number): void {
  deletePendingActionContext(chatId);
}

/** Owner words that authorized this workflow, including earlier turns. */
export function authorizationWords(
  chatId: number | undefined,
  currentText: string,
): string {
  const current = currentText.trim();
  if (chatId === undefined) {
    return current;
  }
  const pending = getPendingAction(chatId);
  if (!pending) {
    return current;
  }
  if (pending.ownerWords.trim() === current) {
    return current;
  }
  return `${pending.ownerWords}\n${current}`.trim();
}

export function pendingResolvedEmails(chatId: number | undefined): Map<string, ResolvedAttendee> {
  const found = new Map<string, ResolvedAttendee>();
  if (chatId === undefined) {
    return found;
  }
  const pending = getPendingAction(chatId);
  for (const attendee of pending?.meeting?.attendees ?? []) {
    if (attendee.resolved && attendee.email) {
      found.set(attendee.email.toLowerCase(), attendee);
      found.set(attendee.query.toLowerCase(), attendee);
    }
  }
  return found;
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

  if (!pending || pending.action !== "create_meeting" || !pending.meeting) {
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
  if (action.action === "create_meeting" && action.meeting) {
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
    return `Pending meeting "${action.meeting.title ?? "untitled"}" with ${people}. ${waiting}. Continue this booking; do not ask for emails already resolved.`;
  }
  return `Pending ${action.action}. Continue it from where it stands.`;
}
