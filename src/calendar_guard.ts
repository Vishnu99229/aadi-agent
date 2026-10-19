const CALENDAR_QUESTION =
  /\b(calendar|schedule|agenda)\b|\bmeetings?\b|\bwhat(?:'s| is) on\b|\bam i free\b|\bany (?:meetings|calls)\b/i;

export function looksLikeCalendarQuestion(text: string): boolean {
  return CALENDAR_QUESTION.test(text);
}

export function shouldForceCalendarTool(
  userText: string,
  toolNames: readonly string[],
): boolean {
  return (
    looksLikeCalendarQuestion(userText) && !toolNames.includes("list_events")
  );
}
