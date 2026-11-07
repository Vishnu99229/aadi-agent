import { notAnEventCommand, notASendCommand } from "./command_logic.js";
import { isExplicitSequenceRequest } from "./sequence_logic.js";

/** Commands where a reply must come from a tool that ran this turn, never from
 *  what Aadi said before. */
export type CommandKind = "sequence" | "send" | "calendar";

/** Any of these running counts as the command being carried out (or checked:
 *  a refusal or a question back from the tool is a fresh answer too). */
export const COMMAND_TOOLS: Record<CommandKind, readonly string[]> = {
  sequence: ["start_sequence"],
  send: [
    "send_email",
    "draft_new_email",
    "draft_reply",
    "confirm_send_pending_draft",
    "resend_draft_card",
    "cancel_scheduled_send",
  ],
  calendar: [
    "create_event",
    "book_meeting",
    "move_event",
    "delete_calendar_event",
    "add_calendar_attendee",
    "create_meeting",
    "propose_calendar_event",
  ],
};

const SEQUENCE_WORD = "(?:start|begin|auto[\\s-]*follow[\\s-]*up)";

/** Mentions of a sequence that don't ask for one. */
const NOT_A_SEQUENCE_COMMAND: readonly RegExp[] = [
  new RegExp(`\\b(?:don'?t|don’t|do not|never|not to|no need to)\\b[^.?!\\n]{0,20}\\b${SEQUENCE_WORD}`, "i"),
  new RegExp(`\\b(?:did|have|has|was|were)\\s+(?:i|you|we|it)\\b[^.?!\\n]{0,20}\\b(?:start|started|begin|began|auto)`, "i"),
  new RegExp(`\\b(?:should|shall|must)\\s+(?:i|we)\\b[^.?!\\n]{0,20}\\b${SEQUENCE_WORD}`, "i"),
  new RegExp(`\\bremind\\s+me\\s+to\\s+${SEQUENCE_WORD}`, "i"),
  new RegExp(`\\bi\\s+(?:need|have|want|plan|ought)\\s+to\\s+${SEQUENCE_WORD}`, "i"),
  new RegExp(`\\bi(?:'ll|’ll| will|'m going to|’m going to| am going to)\\s+${SEQUENCE_WORD}`, "i"),
];

/** "Send X an email", "send a reply to X", "send a follow-up to X". Not "send me
 *  the summary of his email": that's text for him, here. "Message" is left out
 *  because it may mean WhatsApp. */
const SEND_SOMETHING =
  /\bsend\b(?!\s+(?:me|us|it to me|that to me|this to me)\b)[^.?!\n]{0,40}?\b(?:e-?mail|mail|reply|follow[ -]?up)\b/i;
/** "Reply to X ...", "email X ...", "mail X ..." said as an instruction: at the
 *  start of a sentence, or after please / can you. */
const IMPERATIVE_START =
  "(?:^|[.!?\\n]\\s*|\\b(?:please|pls|kindly|now|can you|could you|would you)\\s+)";
const REPLY_TO = new RegExp(`${IMPERATIVE_START}(?:reply|respond)\\s+(?:back\\s+)?to\\b`, "i");
const EMAIL_SOMEONE = new RegExp(
  `${IMPERATIVE_START}(?:e-?mail|mail)\\s+(?!(?:from|thread|threads|about|said|says|address|id|list|inbox|is|was|and|or|to me)\\b)[\\p{L}\\p{N}]`,
  "iu",
);

/** "Call" also means a recording or a phone call, so those uses don't count. */
const NOT_THE_EVENT = "(?!\\s*(?:recordings?|notes?|summary|summaries|transcripts?|logs?|links?|deck|minutes|mom)\\b)";
const MAKE_EVENT = new RegExp(
  `\\b(?:book|schedule|set up|setup|arrange|fix)\\b[^.?!\\n]{0,40}?\\b(?:meeting|call|event|appointment|demo|sync|catch[ -]?up|slot)\\b${NOT_THE_EVENT}`,
  "i",
);
/** "Create an event", "add Dorothy to the meeting", "put it on my calendar". */
const CREATE_EVENT = new RegExp(
  `\\b(?:create|add|put|block)\\b(?!\\s+(?:a\\s+|an\\s+|the\\s+|my\\s+)?(?:notes?|comments?|tasks?|reminders?|agenda|links?|docs?|files?|summary)\\b)[^.?!\\n]{0,40}?\\b(?:event|meeting|appointment|invite|calendar)\\b${NOT_THE_EVENT}`,
  "i",
);
const CHANGE_EVENT = new RegExp(
  `\\b(?:delete|cancel|remove|move|reschedule|shift|push|postpone|prepone)\\b[^.?!\\n]{0,40}?\\b(?:meeting|call|event|appointment|invite|demo|sync)\\b${NOT_THE_EVENT}`,
  "i",
);
const BLOCK_CALENDAR = /\bblock\s+(?:my\s+|the\s+)?calendar\b|\b(?:to|on|in)\s+my\s+calendar\b/i;
/** "What meetings do I have", "when is my call": asking, not telling. */
const CALENDAR_QUESTION =
  /^\s*(?:what|when|where|which|who|how|is|are|do|does|any)\b|\b(?:do i have|have i got)\b/i;

/** The explicit commands in his own words, in English. Other languages stay the
 *  model's call, and no rule here grants anything: it only makes sure a tool runs. */
export function commandIntents(ownWords: string): CommandKind[] {
  const text = ownWords.trim();
  if (!text) {
    return [];
  }
  const kinds: CommandKind[] = [];
  if (
    isExplicitSequenceRequest(text) &&
    !NOT_A_SEQUENCE_COMMAND.some((pattern) => pattern.test(text))
  ) {
    kinds.push("sequence");
  }
  if (
    (SEND_SOMETHING.test(text) || REPLY_TO.test(text) || EMAIL_SOMEONE.test(text)) &&
    !notASendCommand(text)
  ) {
    kinds.push("send");
  }
  if (
    (MAKE_EVENT.test(text) || CREATE_EVENT.test(text) || CHANGE_EVENT.test(text) || BLOCK_CALENDAR.test(text)) &&
    !notAnEventCommand(text) &&
    !CALENDAR_QUESTION.test(text)
  ) {
    kinds.push("calendar");
  }
  return kinds;
}

const VAGUE_TARGET =
  /^(?:him|her|them|it|this|that|these|those|everyone|everybody|all|all of them|both|the other(?:\s+(?:one|person|guy|lady))?|this (?:person|one|guy|lady)|that (?:person|one|guy|lady)|the same (?:person|one))\b/i;
const TRAILING_FILLER =
  /(?:\s+(?:please|pls|now|also|too|as well|again|right now|today|asap|for me))+\s*$/i;

/** Who each "start a sequence for X" / "auto follow up with X" names, in his own
 *  words. Undefined when any of them can't be read from the words alone (a
 *  pronoun, or a phrasing this doesn't parse), so the model has to resolve it. */
export function sequenceTargets(ownWords: string): string[] | undefined {
  const targets: string[] = [];
  for (const sentence of ownWords.split(/(?<=[.!?])\s+|\n+/)) {
    if (!isExplicitSequenceRequest(sentence)) {
      continue;
    }
    const match =
      /\b(?:start|begin)\b(?:\s+(?:a|an|the|new|another|follow[\s-]*up|auto(?:matic)?|email|mail))*\s+sequences?\s+(?:for|with|to|on)\s+(.+)$/i.exec(sentence) ??
      /\bauto[\s-]*follow[\s-]*up\s+(?:with|on|for|to)\s+(.+)$/i.exec(sentence);
    const target = match?.[1]
      ?.replace(/[.!?,;:]+\s*$/, "")
      .replace(TRAILING_FILLER, "")
      .replace(/^["'“”]+|["'“”]+$/g, "")
      .trim();
    if (!target || target.length > 120 || VAGUE_TARGET.test(target)) {
      return undefined;
    }
    targets.push(target);
  }
  return targets.length > 0 ? targets : undefined;
}

function normalized(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}@.'-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstLine(text: string): string {
  return normalized(text.trim().split(/\n/)[0] ?? "");
}

/** The reply opens with what Aadi said, or a tool returned, on an earlier turn,
 *  nothing that ran this turn said it, and the outcome has changed since. That is
 *  a repeated answer, not a fresh result. When every tool this turn returned
 *  exactly what it returned before, saying the same again is right. */
export function echoesEarlierReply(
  reply: string,
  earlierReplies: readonly string[],
  freshResults: readonly string[],
  earlierToolResults: readonly string[] = [],
): boolean {
  const opening = firstLine(reply);
  if (opening.length < 20) {
    return false;
  }
  const before = new Set(earlierToolResults.map(normalized));
  if (freshResults.length > 0 && freshResults.every((result) => before.has(normalized(result)))) {
    return false;
  }
  if (freshResults.some((result) => normalized(result).includes(opening))) {
    return false;
  }
  return earlierReplies.some((earlier) => normalized(earlier).includes(opening));
}

const RETRY_LINES: Record<CommandKind, string> = {
  sequence: "For a sequence, call start_sequence now with the person as Vishnu named them.",
  send: "For an email, call send_email now (find the thread with search_emails first if it's a reply), or the draft tool if he asked for a draft.",
  calendar: "For his calendar, call the tool for it now: create_event, book_meeting, move_event, delete_calendar_event or add_calendar_attendee.",
};

/** Asks again without pushing an action he didn't ask for: if the words only
 *  looked like a command, the model can say so, and he's told nothing ran. */
export function commandRetryPrompt(kinds: readonly CommandKind[]): string {
  return [
    "Vishnu's message looks like a command, and no tool has run for it this turn. An earlier answer in this chat is not a result: what happened before may have changed, so never repeat it.",
    ...kinds.map((kind) => RETRY_LINES[kind]),
    "Answer only from what the tool returns this turn. If his message isn't asking for that, don't call anything and say so in one line.",
  ].join(" ");
}

const NOT_RUN: Record<CommandKind, string> = {
  sequence: "no sequence was started or checked",
  send: "no email was sent",
  calendar: "your calendar wasn't changed",
};

/** What he's told when the tool still didn't run: the truth, never an old answer. */
export function commandNotRunMessage(kinds: readonly CommandKind[]): string {
  const what = kinds.map((kind) => NOT_RUN[kind]).join(", and ");
  const hint = kinds.includes("sequence")
    ? " Say it again, or use /sequence with their name or email."
    : " Please say it again.";
  return `I didn't carry that out this time, so ${what}.${hint}`;
}
