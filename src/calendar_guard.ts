const CALENDAR_QUESTION =
  /\b(calendar|schedule|agenda)\b|\bmeetings?\b|\bwhat(?:'s| is) on\b|\bam i free\b|\bany (?:meetings|calls)\b/i;

const CREATE_MEETING_INTENT =
  /\b(create|book|schedule|set up|setup|make|add)\b[\s\S]{0,60}\b(meeting|call|event)\b|\bmeeting with\b|\bshare the (?:meeting )?link\b|\binvite\b[\s\S]{0,40}\b(calendar|meet)/i;

const DELETE_EVENT_INTENT =
  /\b(delete|remove|cancel)\b[\s\S]{0,80}\b(event|meeting|from (?:my |the )?calendar)\b/i;

const CALENDAR_WRITE_TOOLS = new Set([
  "list_events",
  "create_meeting",
  "delete_calendar_event",
  "propose_calendar_event",
]);

export function looksLikeCalendarQuestion(text: string): boolean {
  return CALENDAR_QUESTION.test(text);
}

export function looksLikeCreateMeeting(text: string): boolean {
  return CREATE_MEETING_INTENT.test(text);
}

export function looksLikeDeleteEvent(text: string): boolean {
  return DELETE_EVENT_INTENT.test(text);
}

export function shouldForceCalendarTool(
  userText: string,
  toolNames: readonly string[],
): boolean {
  if (looksLikeCreateMeeting(userText) || looksLikeDeleteEvent(userText)) {
    return false;
  }
  if (toolNames.some((name) => CALENDAR_WRITE_TOOLS.has(name))) {
    return false;
  }
  return looksLikeCalendarQuestion(userText);
}
