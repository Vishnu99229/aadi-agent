import type { ParsedMailbox } from "./mail_helpers.js";

const ADDRESS = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const NOT_NAME_WORDS = new Set([
  "at", "from", "of", "the", "in", "to", "mr", "mrs", "ms", "sir", "madam", "ji", "and", "team",
]);
const AUTOMATED_ADDRESS =
  /^(?:no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?|bounces?|alerts?|newsletters?|updates?)(?:[+._-][^@]*)?@|@(?:[a-z0-9-]+\.)*calendar\.google\.com$/i;

const SEND_WORD = "(?:send|email|e-mail|mail|reply|respond|write|follow[ -]?up)";

/** Things that mention sending without telling Aadi to send. English only: other
 *  languages are the model's call, and its choice of tool is what these back up. */
const NOT_A_COMMAND: ReadonlyArray<readonly [RegExp, string]> = [
  [new RegExp(`\\b(?:don'?t|don’t|do not|never|not to|shouldn'?t|wouldn'?t)\\b(?!\\s+forget)[^.?!\\n]{0,20}\\b${SEND_WORD}\\b`, "i"), "he said not to"],
  [new RegExp(`\\bremind\\s+me\\s+to\\s+${SEND_WORD}\\b`, "i"), "he asked for a reminder"],
  [/\bfollow(?:ing)?[ -]?up\s+on\s+my\s+email\b/i, "that asks for a follow-up sequence card"],
  [new RegExp(`\\b(?:should|shall|must)\\s+(?:i|we)\\b[^.?!\\n]{0,20}\\b${SEND_WORD}\\b`, "i"), "he asked a question"],
  [new RegExp(`\\b(?:did|have|has)\\s+(?:i|you|we)\\b[^.?!\\n]{0,20}\\b(?:sent|send|emailed|email|mailed|replied)\\b`, "i"), "he asked a question"],
  [new RegExp(`\\bi\\s+(?:need|have|want|plan|ought)\\s+to\\s+${SEND_WORD}\\b`, "i"), "he described a plan"],
  [new RegExp(`\\bi(?:'ll|’ll| will|'m going to|’m going to| am going to)\\s+${SEND_WORD}\\b`, "i"), "he described a plan"],
];

const DRAFT_WORD = /\b(?:draft|prepare|write|compose)\b/i;
/** "Draft this, but don't send" / "without sending": the draft is allowed, the send is not. */
const SEND_IS_FORBIDDEN =
  /\b(?:don'?t|don’t|do not|never|without)\b[^.?!\n]{0,40}\bsend(?:ing)?\b/i;

/**
 * Drop constraints that limit a requested action ("without attendees",
 * "don't send") so the rest of the sentence can still be the action.
 * A bare "don't send" or "don't delete" is left as a refusal.
 */
export function withoutActionConstraints(text: string): string {
  return text
    .replace(ATTENDEE_LIMIT, " ")
    .replace(
      /\bwithout\s+(?:any\s+|no\s+)?(?:attendees?|guests?|invitations?|invites?)\b/gi,
      " ",
    )
    .replace(/\bwithout\s+sending(?:\s+(?:any\s+)?(?:invitations?|invites?|emails?|mail))?\b/gi, " ")
    .replace(SEND_IS_FORBIDDEN, " ");
}

/** Why these words aren't a command to send, or undefined when they may be.
 *  "Draft", "write" and "prepare" stay reviewable unless he also said send. "Reply to X"
 *  is a command to send. "Draft but don't send" is a draft, not a refusal to act. */
export function notASendCommand(ownWords: string): string | undefined {
  if (DRAFT_WORD.test(ownWords) && SEND_IS_FORBIDDEN.test(ownWords)) {
    return "he asked for a draft";
  }
  for (const [pattern, reason] of NOT_A_COMMAND) {
    if (pattern.test(ownWords)) {
      return reason;
    }
  }
  if (DRAFT_WORD.test(ownWords) && !/\bsend\b/i.test(ownWords)) {
    return "he asked for a draft";
  }
  return undefined;
}

const EVENT_WORD =
  "(?:book|schedule|set up|setup|invite|create|block|add|put|delete|cancel|remove|move|reschedule|shift)";

const NOT_AN_EVENT_COMMAND: ReadonlyArray<readonly [RegExp, string]> = [
  [new RegExp(`\\b(?:don'?t|don’t|do not|never|not to|shouldn'?t|wouldn'?t)\\b(?!\\s+forget)[^.?!\\n]{0,20}\\b${EVENT_WORD}\\b`, "i"), "he said not to"],
  [new RegExp(`\\bremind\\s+me\\s+to\\s+${EVENT_WORD}\\b`, "i"), "he asked for a reminder"],
  [new RegExp(`\\b(?:should|shall|must)\\s+(?:i|we)\\b[^.?!\\n]{0,20}\\b${EVENT_WORD}\\b`, "i"), "he asked a question"],
  [new RegExp(`\\b(?:did|have|has)\\s+(?:i|you|we)\\b[^.?!\\n]{0,20}\\b(?:booked|book|scheduled|schedule|created|create|blocked|block|added|add|deleted|delete|cancelled|canceled|cancel|moved|move)\\b`, "i"), "he asked a question"],
  [new RegExp(`\\bi\\s+(?:need|have|want|plan|ought)\\s+to\\s+${EVENT_WORD}\\b`, "i"), "he described a plan"],
  [new RegExp(`\\bi(?:'ll|’ll| will|'m going to|’m going to| am going to)\\s+${EVENT_WORD}\\b`, "i"), "he described a plan"],
  [/\b(?:propose|suggest|park)\b/i, "he asked to propose it, which is propose_calendar_event"],
];

/**
 * "Do not add attendees" limits who is invited. It is not a refusal to create
 * or move the event. Deleting, cancelling, and "don't book" stay refusals.
 */
const ATTENDEE_LIMIT =
  /\b(?:don'?t|don’t|do not|never|not to|shouldn'?t|wouldn'?t)\b(?!\s+forget)[^.?!\n]{0,40}\b(?:add|invite|include)\b[^.?!\n]{0,40}\b(?:any\s+|the\s+|no\s+)?(?:attendees?|guests?|invitations?|invites?)\b/gi;

/** The calendar version of notASendCommand. */
export function notAnEventCommand(ownWords: string): string | undefined {
  const text = withoutActionConstraints(ownWords);
  for (const [pattern, reason] of NOT_AN_EVENT_COMMAND) {
    if (pattern.test(text)) {
      return reason;
    }
  }
  return undefined;
}

const COMMAND_TURN: readonly RegExp[] = [
  /\b(?:send|email|e-?mail|mail|reply|respond|bhej\w*|ayakk\w*|ayach\w*)\b/i,
  /\b(?:book|schedule|set up|setup|reschedule|block|cancel|delete|remove|move|shift|add|create|invite)\b[\s\S]{0,60}\b(?:meeting|call|event|calendar|appointment)\b/i,
  /\b(?:block|to)\s+my\s+calendar\b/i,
];

/** Turns that may act with no card run on Sonnet, so the model acts instead of
 *  asking. A false match only costs a Sonnet turn: this picks the model and grants
 *  nothing. */
export function looksLikeCommandTurn(text: string): boolean {
  return COMMAND_TURN.some((pattern) => pattern.test(text));
}

const CONTENT_STARTS = /\b(?:saying|say|that|telling|tell|about|regarding|asking|ki|to confirm)\b/i;
/** Malayalam puts "saying" after what's said, so any date there may be its content. */
const CONTENT_ENDS = /\bennu\b/i;
const SEND_DATE =
  /\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b|\b(?:tomorrow|tonight|next week|later today|kal|naale)\b|\bon\s+\d{1,2}(?:st|nd|rd|th)?\b|\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i;

/** He gave a date or time for the send, as opposed to one inside the email: "email
 *  Selvaraj on Monday" against "email Selvaraj saying we're on for Monday". */
export function mentionsSendDate(ownWords: string): boolean {
  if (CONTENT_ENDS.test(ownWords)) {
    return false;
  }
  const start = ownWords.search(CONTENT_STARTS);
  return SEND_DATE.test(start === -1 ? ownWords : ownWords.slice(0, start));
}

const NOT_A_TARGET = new Set([
  "email", "mail", "emails", "message", "note", "scheduled", "schedule", "send", "one", "reply", "follow", "up", "followup",
]);

/** Which scheduled sends he means. Words anywhere in the name, address or subject. */
export function scheduledTargetWords(target: string): string[] {
  return nameTokens(target).filter((word) => !NOT_A_TARGET.has(word));
}

export function asksForAttachment(ownWords: string): boolean {
  return /\battach|\benclos/i.test(ownWords);
}

/** An email may not mention an attachment, because this path can't add one. */
export function referencesAttachment(text: string): boolean {
  return /\battach(?:ed|es|ing|ments?)?\b|\benclos(?:ed|es|ing|ure)\b|\bherewith\b/i.test(text);
}

export function addressIn(text: string): string | undefined {
  return ADDRESS.exec(text)?.[0]?.toLowerCase();
}

export function isAutomatedAddress(email: string): boolean {
  return AUTOMATED_ADDRESS.test(email.trim());
}

/** The words that identify a person or company in what he said. */
export function nameTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 2 && !NOT_NAME_WORDS.has(word));
}

function hasWord(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(text);
}

/** The recipient has to come from his own message, not from anything Aadi read,
 *  so text inside an email can never choose who gets one. */
export function namedInOwnWords(query: string, ownWords: string): boolean {
  const address = addressIn(query);
  if (address) {
    return ownWords.toLowerCase().includes(address);
  }
  const tokens = nameTokens(query);
  return tokens.length > 0 && tokens.every((token) => hasWord(ownWords, token));
}

/** Every word he used has to match this mailbox's name, address or company. */
export function mailboxMatches(mailbox: ParsedMailbox, tokens: readonly string[]): boolean {
  if (tokens.length === 0) {
    return false;
  }
  const words = new Set(nameTokens(`${mailbox.name} ${mailbox.email.replace("@", " ")}`));
  return tokens.every((token) => words.has(token));
}

/** Only a person's own text counts for a memory: the name and address in one sentence. */
export function addressesInMemory(memory: string, tokens: readonly string[]): string[] {
  const found: string[] = [];
  for (const sentence of memory.split(/(?<=[.!?])\s+|\n+/)) {
    const address = addressIn(sentence);
    if (address && tokens.length > 0 && tokens.every((token) => hasWord(sentence, token))) {
      found.push(address);
    }
  }
  return found;
}
