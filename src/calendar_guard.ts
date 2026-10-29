import { isWrapUpText } from "./wrapup_triggers.js";

/** Explicit schedule questions only — not a mention of a meeting in notes. */
const CALENDAR_QUESTION =
  /\b(what(?:'s| is) on (?:my )?(?:calendar|schedule|agenda))\b|\bwhen is (?:my )?(?:next )?(?:meeting|call)\b|\bam i free\b|\bany (?:meetings|calls)\b|\b(show|list) (?:my )?(?:calendar|schedule|meetings|agenda)\b|\bwhat(?:'s| is) my (?:calendar|schedule)\b/i;

const CREATE_MEETING_INTENT =
  /\b(create|book|schedule|set up|setup|make|add)\b[\s\S]{0,60}\b(meeting|call|event)\b|\bmeeting with\b|\bshare the (?:meeting )?link\b|\binvite\b[\s\S]{0,40}\b(calendar|meet)/i;

const DELETE_EVENT_INTENT =
  /\b(delete|remove|cancel)\b[\s\S]{0,80}\b(event|meeting|from (?:my |the )?calendar)\b/i;

const ADD_ATTENDEE_INTENT =
  /\b(add|invite)\b[\s\S]{0,80}\bto\b[\s\S]{0,60}\b(meeting|call|event)\b/i;

const CALENDAR_WRITE_TOOLS = new Set([
  "list_events",
  "create_meeting",
  "delete_calendar_event",
  "add_calendar_attendee",
  "propose_calendar_event",
]);

export function looksLikeCalendarQuestion(text: string): boolean {
  return CALENDAR_QUESTION.test(text);
}

export function looksLikeCreateMeeting(text: string): boolean {
  if (looksLikeAddAttendee(text)) {
    return false;
  }
  return CREATE_MEETING_INTENT.test(text);
}

export function looksLikeDeleteEvent(text: string): boolean {
  return DELETE_EVENT_INTENT.test(text);
}

export function looksLikeAddAttendee(text: string): boolean {
  return ADD_ATTENDEE_INTENT.test(text);
}

export function shouldForceCalendarTool(
  userText: string,
  toolNames: readonly string[],
): boolean {
  if (isWrapUpText(userText) || /^\/wrapup\b/i.test(userText.trim())) {
    return false;
  }
  if (
    looksLikeCreateMeeting(userText) ||
    looksLikeDeleteEvent(userText) ||
    looksLikeAddAttendee(userText)
  ) {
    return false;
  }
  if (toolNames.some((name) => CALENDAR_WRITE_TOOLS.has(name))) {
    return false;
  }
  return looksLikeCalendarQuestion(userText);
}
