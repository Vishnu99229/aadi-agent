import { decodedAccounts } from "./accounts.js";
import { findAccountsInText } from "./account_logic.js";
import { queueDraftApproval } from "./approvals.js";
import {
  getMeetingBrief,
  getNote,
  listMeetingBriefs,
  searchNotes,
  type MeetingBriefRecord,
  type NoteActionItem,
  type NoteRecord,
} from "./db.js";
import { getGoogleAccount } from "./google/auth.js";
import { createNewEmailDraft } from "./google/mail.js";
import {
  buildMomDraft,
  hasMomRecipients,
  parseNoteMeeting,
  parseNoteSections,
  type MomActionItem,
  type MomAttendee,
  type NoteMeeting,
} from "./mom_logic.js";

function parseAttendeesJson(raw: string): MomAttendee[] {
  try {
    const parsed = JSON.parse(raw) as Array<{ name?: string; email?: string }>;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((item) => item && typeof item.email === "string" && item.email.trim())
      .map((item) => ({
        name: typeof item.name === "string" ? item.name : item.email!,
        email: item.email!,
      }));
  } catch {
    return [];
  }
}

export function meetingFromBrief(brief: MeetingBriefRecord): NoteMeeting {
  return {
    title: brief.title,
    startAt: brief.start_at,
    attendees: parseAttendeesJson(brief.attendees_json),
    briefId: brief.id,
  };
}

function actionItemsFromNote(note: NoteRecord): MomActionItem[] {
  if (!note.pending_action_items) {
    return [];
  }
  try {
    const parsed = JSON.parse(note.pending_action_items) as NoteActionItem[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function meetingMatchesQuery(meeting: NoteMeeting, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  const hay = [
    meeting.title,
    ...meeting.attendees.map((item) => `${item.name} ${item.email}`),
  ]
    .join(" ")
    .toLowerCase();
  return hay.includes(needle);
}

function resolveMeetingForNote(
  note: NoteRecord,
  query?: string,
): NoteMeeting | null {
  const stored = parseNoteMeeting(note.meeting_json);
  if (stored && hasMomRecipients(stored.attendees)) {
    return stored;
  }

  const briefs = listMeetingBriefs().slice().reverse();
  const haystack = `${note.title} ${note.people} ${query ?? ""}`.toLowerCase();
  for (const brief of briefs) {
    const meeting = meetingFromBrief(brief);
    if (!hasMomRecipients(meeting.attendees)) {
      continue;
    }
    if (query && meetingMatchesQuery(meeting, query)) {
      return meeting;
    }
    const briefHay = `${brief.title} ${brief.attendees_json}`.toLowerCase();
    if (
      note.title &&
      (briefHay.includes(note.title.toLowerCase()) ||
        haystack.split(/\s+/).some((word) => word.length >= 4 && briefHay.includes(word)))
    ) {
      return meeting;
    }
  }
  return stored;
}

function trackedAccountLine(haystack: string): string | undefined {
  const matches = findAccountsInText(decodedAccounts(), haystack);
  if (matches.length === 0) {
    return undefined;
  }
  return `Tracked account: ${matches.map((item) => item.name).join(", ")}`;
}

export async function draftMomForNote(
  noteId: number,
  query?: string,
): Promise<string> {
  const note = getNote(noteId);
  if (!note) {
    throw new Error("That note was not found.");
  }
  const meeting = resolveMeetingForNote(note, query);
  if (!meeting || !hasMomRecipients(meeting.attendees)) {
    throw new Error(
      "I couldn't find calendar attendees for that call, so I can't draft a MoM email.",
    );
  }

  const sections = parseNoteSections(note.content);
  const dateValue = meeting.startAt || sections.dateValue || note.created_at;
  const draft = buildMomDraft({
    title: meeting.title || note.title,
    dateValue,
    attendees: meeting.attendees,
    keyPoints: sections.keyPoints,
    decisions: sections.decisions,
    actionItems: actionItemsFromNote(note),
    nextSteps: sections.openQuestions,
  });
  if (draft.to.length === 0) {
    throw new Error(
      "That meeting has no attendee email addresses besides yours.",
    );
  }

  const account = await getGoogleAccount("work");
  const created = await createNewEmailDraft({
    account,
    to: draft.to,
    subject: draft.subject,
    body: draft.body,
  });
  console.log(
    `MoM draft created: draft_id=${created.draftId} recipients=${draft.to.length} note_id=${noteId}`,
  );

  const extra: string[] = [];
  const accountLine = trackedAccountLine(
    `${meeting.title}\n${note.title}\n${note.people}\n${note.content}`,
  );
  if (accountLine) {
    extra.push(accountLine);
  }
  if (draft.tbdWarnings.length > 0) {
    extra.push(`TBD in this MoM:\n${draft.tbdWarnings.map((line) => `• ${line}`).join("\n")}`);
  }

  await queueDraftApproval({
    draftId: created.draftId,
    threadId: created.threadId,
    to: draft.to.join(", "),
    subject: draft.subject,
    body: draft.body,
    googleAccount: "work",
    extraLines: extra,
  });

  return JSON.stringify({
    draft_id: created.draftId,
    account: "work",
    tag: "work",
    recipients: draft.to.length,
    tbd: draft.tbdWarnings.length,
  });
}

export async function draftMomForQuery(query: string): Promise<string> {
  const needle = query.trim();
  if (!needle) {
    throw new Error("Say who the call was with, for example: send MoM for my call with Pinnacle.");
  }
  const notes = searchNotes(needle);
  if (notes.length === 0) {
    throw new Error("I couldn't find notes matching that call.");
  }
  return draftMomForNote(notes[0]!.id, needle);
}

export { hasMomRecipients, parseNoteMeeting };
