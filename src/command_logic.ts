import { parseAddressList, type ParsedMailbox } from "./address_list.js";

const ADDRESS = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const NOT_NAME_WORDS = new Set([
  "at", "from", "of", "the", "in", "to", "mr", "mrs", "ms", "sir", "madam", "ji", "and", "team",
]);
/** Mailboxes that carry a person's display name but are not that person:
 *  Google Docs comments, Drive shares, calendar notifications, and any
 *  local-part that contains no-reply. */
const AUTOMATED_ADDRESS =
  /(?:^|[+._-])(?:no-?reply|do-?not-?reply)(?:[+._-][^@]*)?@|^(?:mailer-daemon|postmaster|notifications?|bounces?|alerts?|newsletters?|updates?|calendar-notification)(?:[+._-][^@]*)?@|@(?:[a-z0-9-]+\.)*(?:docs\.google\.com|calendar\.google\.com)$/i;

/** "Draft this, but don't send" / "without sending": the draft is allowed, the send is not. */
const SEND_IS_FORBIDDEN =
  /\b(?:(?:don'?t|don’t|do not|never|without)\b(?!\s+forget)[^.?!\n]{0,40}\bsend(?:ing)?|stop\s+sending)\b/i;

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

export function notAnEventCommand(ownWords: string): string | undefined {
  const text = withoutActionConstraints(ownWords);
  for (const [pattern, reason] of NOT_AN_EVENT_COMMAND) {
    if (pattern.test(text)) {
      return reason;
    }
  }
  return undefined;
}

const CONTENT_STARTS =
  /\b(?:saying|say|telling|tell|about|regarding|asking|ki|to confirm|mention(?:ing)?\s+that|that(?!\s+(?:email|mail|draft|message|reply|one|card|it|for|to|now|out)\b))\b/gi;

/** Malayalam puts "saying" after what is said. */
const CONTENT_ENDS = /\bennu\b/i;

export function splitOwnerEmailCommand(text: string): { command: string; content: string } {
  if (CONTENT_ENDS.test(text)) {
    const at = text.search(CONTENT_ENDS);
    return { command: text, content: at === -1 ? "" : text.slice(0, at) };
  }
  for (const match of text.matchAll(CONTENT_STARTS)) {
    const command = text.slice(0, match.index);
    if (command.trim()) {
      return { command, content: text.slice(match.index) };
    }
  }
  return { command: text, content: "" };
}

const NOT_A_TARGET = new Set([
  "email", "mail", "emails", "message", "note", "scheduled", "schedule", "send", "one", "reply", "follow", "up", "followup",
]);

/** Which scheduled sends he means. Words anywhere in the name, address or subject. */
export function scheduledTargetWords(target: string): string[] {
  return nameTokens(target).filter((word) => !NOT_A_TARGET.has(word));
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
  const address = parseAddressList(query)[0]?.email;
  if (address) {
    return parseAddressList(ownWords).some((mailbox) => mailbox.email === address);
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
    const addresses = parseAddressList(sentence).map(({ email }) => email);
    if (tokens.length > 0 && tokens.every((token) => hasWord(sentence, token))) {
      found.push(...addresses);
    }
  }
  return found;
}
