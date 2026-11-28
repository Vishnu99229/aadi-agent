import { notAnEventCommand, splitOwnerEmailCommand, withoutActionConstraints } from "./command_logic.js";

/**
 * The kinds of explicit command his own English words name. Only agent routing
 * reads this now (agents/orchestrator.ts pickRoute, until routing moves to
 * records in PR D). The agent loop no longer reads his words: whether a reply
 * is truthful is the reply checker's call (reply_checker.ts).
 */
export type CommandKind =
  | "sequence_stop"
  | "sequence_timezone"
  | "sales_fact_add"
  | "sales_fact_remove"
  | "draft"
  | "draft_discard"
  | "calendar"
  | "reminder"
  | "task_add"
  | "task"
  | "bill"
  | "date_add"
  | "date"
  | "account"
  | "memory"
  | "qa_bank"
  | "ignore"
  | "resume"
  | "ignore_list";

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

/** Questions, plans and "don't" aren't commands. */
const NEGATED = /\b(?:don'?t|don’t|do not|never|not to|no need to|shouldn'?t|wouldn'?t)\b/i;
const ASKED =
  /^\s*(?:what|when|where|which|who|whom|whose|why|how|is|are|was|were|do|does|did|has|have|had|any|am)\b/i;
const ASKED_ABOUT = /\b(?:did|have|has)\s+(?:i|you|we)\b|\b(?:should|shall|must)\s+(?:i|we)\b/i;
const PLANNED =
  /\bi\s+(?:need|have|want|plan|ought)\s+to\b|\bi(?:'ll|’ll| will|'m going to|’m going to| am going to)\b/i;
const REMIND_ME = /\bremind\s+me\b/i;

function notAnInstruction(text: string, options: { negationAllowed?: boolean; remindAllowed?: boolean } = {}): boolean {
  return (
    (!options.negationAllowed && NEGATED.test(text)) ||
    ASKED.test(text) ||
    ASKED_ABOUT.test(text) ||
    PLANNED.test(text) ||
    (!options.remindAllowed && REMIND_ME.test(text))
  );
}

/** At the start of a sentence, or after please / can you. */
const LEAD = "(?:^|[.!?\\n]\\s*|\\b(?:please|pls|kindly|now|also|and|can you|could you|would you)\\s+)";

const STOP_SEQUENCE = [
  /\b(?:stop|pause|end|cancel|halt)\b[^.?!\n]{0,30}?\b(?:sequences?|follow[\s-]*ups?|following\s+up|auto[\s-]*follow[\s-]*ups?)\b/i,
  /\b(?:don'?t|don’t|do not|never)\s+(?:e-?mail|contact|chase|follow\s+up\s+with)\b[^.?!\n]{0,40}?\bagain\b/i,
];
const SET_TIMEZONE = [
  /\b(?:set|change|update|make|fix|correct|switch)\b[^.?!\n]{0,40}?\btime[\s-]?zones?\b/i,
  /\btime[\s-]?zone\s+(?:to|should be|is)\s+\w/i,
];
const ADD_SALES_FACT = /\b(?:add|put|save|include)\b[^.?!\n]{0,25}?\bsales[\s-]?facts?\b/i;
const REMOVE_SALES_FACT = /\b(?:remove|delete|drop)\b[^.?!\n]{0,25}?\bsales[\s-]?facts?\b/i;
const DRAFT = [
  new RegExp(`${LEAD}(?:draft|compose|write|prepare)\\b[^.?!\\n]{0,40}?\\b(?:e-?mail|mail|reply|response|follow[ -]?up|mom|minutes)\\b`, "i"),
  /\b(?:change|edit|update|rewrite|redo|shorten|tweak)\s+(?:the|that|this|my)\s+draft\b/i,
];
const DISCARD_DRAFT = /\b(?:discard|scrap|bin|trash|throw away|delete|cancel)\s+(?:the|that|this|my)\s+draft\b/i;
const SET_REMINDER = [
  new RegExp(`${LEAD}remind\\s+me\\b(?!\\s+(?:what|who|when|where|why|how|which)\\b)`, "i"),
  /\bset\s+(?:a\s+|an\s+)?(?:reminder|alarm)\b/i,
];
const CANCEL_REMINDER = /\b(?:cancel|delete|remove|stop|drop)\s+(?:the\s+|that\s+|this\s+|my\s+|all\s+)?(?:[\p{L}\p{N}'-]+\s+){0,3}?reminders?\b/iu;
const ADD_TASK = [
  /\badd\b[^.?!\n]{0,60}?\bto\s+(?:my\s+|the\s+)?(?:tasks?|to-?dos?|to-?do\s+list|task\s+list)\b/i,
  new RegExp(`${LEAD}(?:add|create|make)\\s+(?:a\\s+|an\\s+)?(?:new\\s+)?(?:task|to-?do)\\b`, "i"),
];
const CHANGE_TASK = [
  /\b(?:mark|tick|check off)\b[^.?!\n]{0,50}?\b(?:as\s+)?(?:done|complete|completed|finished)\b/i,
  /\b(?:complete|finish|close|delete|remove|drop|dismiss)\s+(?:the\s+|my\s+|that\s+|this\s+)?(?:[\p{L}\p{N}'-]+\s+){0,3}?tasks?\b/iu,
];
const IGNORE = [
  /\bignore\b/i,
  /\bstop bothering me\b/i,
  /\bdon'?t\s+(?:remind|ping|bother|track)\b/i,
  /\bdo not\s+(?:remind|ping|bother|track)\b/i,
  /\bi don'?t want to see\b/i,
  /\bforget about this\b/i,
  /\bstop tracking\b/i,
  /\bstop reminding me\b/i,
];
const RESUME = [
  /\b(?:start|resume)\s+track(?:ing)?\b/i,
  /\bstart reminding me\b/i,
  /\btrack\b[^.?\n]{0,40}\bagain\b/i,
  /\bundo the ignore\b/i,
  /\bstop ignoring\b/i,
  /\bresume\b[^.?\n]{0,40}\b(?:bill|task|reminder|alert|item)/i,
  /\bresume all ignored\b/i,
];
const LIST_IGNORED = [
  /\bwhat have i asked you to ignore\b/i,
  /\b(?:show|list|open)\b[^.?\n]{0,20}\bignored(?:\s+items)?\b/i,
];
const BILL = [
  /\bmark\b[^.?!\n]{0,50}?\bpaid\b/i,
  /\b(?:ignore|skip|dismiss|drop|clear)\s+(?:the\s+|my\s+|that\s+|this\s+)?(?:[\p{L}\p{N}'-]+\s+){0,3}?bills?\b/iu,
];
const ADD_DATE = /\b(?:add|save|note|set|put)\b[^.?!\n]{0,40}?\b(?:birthday|b'?day|anniversary)\b/i;
const REMOVE_DATE = /\b(?:remove|delete|drop)\b[^.?!\n]{0,40}?\b(?:birthday|anniversary)\b/i;
const NOT_A_DEAL = /\b(?:google|gmail|work|personal|e-?mail|telegram|linkedin)\s+accounts?\b/i;
const ACCOUNT = [
  /\badd\b[^.?!\n]{0,40}?\bas\s+(?:an?\s+)?(?:new\s+)?(?:partner|end[\s-]?client|client|customer|account|deal)\b/i,
  new RegExp(`${LEAD}(?:add|create)\\s+(?:an?\\s+)?(?:new\\s+)?(?:account|deal)\\b`, "i"),
  /\b(?:remove|delete|update)\s+(?:the\s+)?(?:[\p{L}\p{N}'-]+\s+){0,3}?(?:account|deal)\b/iu,
];
const MEMORY = [
  new RegExp(`${LEAD}remember\\b(?!\\s+(?:when|what|who|how|where|why|which|me|the time)\\b)`, "i"),
  new RegExp(`${LEAD}forget\\b`, "i"),
  /\bupdate\b[^.?!\n]{0,20}?\bmemor(?:y|ies)\b/i,
];
/** "Remember my discussion with Hardik?", "remember the conversation we had": recalling
 *  something from the past, not asking to save a memory. */
const RECALL = [
  /\bremember\s+(?:my|our|the|that|this)\s+(?:last\s+|previous\s+|earlier\s+|recent\s+)?(?:discussions?|conversations?|talks?|chats?|exchanges?)\b/i,
  /\bremember\b[^.!\n]*\?\s*$/i,
];
const QA_BANK = /\b(?:learn|add|save|import)\b[^.?!\n]{0,40}?\b(?:q\s*&\s*a|q\s+and\s+a|qa)(?:\s+bank)?\b/i;

/** These name what the command is about, so a "call" or an "email" inside them
 *  doesn't also make it a calendar or send command. */
const SPECIFIC: readonly CommandKind[] = [
  "sequence_stop",
  "sequence_timezone",
  "sales_fact_add",
  "sales_fact_remove",
  "draft",
  "draft_discard",
  "reminder",
  "task_add",
  "task",
  "bill",
  "date_add",
  "date",
  "account",
  "memory",
  "qa_bank",
  "ignore",
  "resume",
  "ignore_list",
];

/** The explicit commands in his own words, in English, for routing only. Other
 *  languages stay the model's call, and no rule here grants anything. */
export function commandIntents(ownWords: string): CommandKind[] {
  const text = ownWords.trim();
  if (!text) {
    return [];
  }
  const found = new Set<CommandKind>();
  const any = (patterns: readonly RegExp[]): boolean => patterns.some((pattern) => pattern.test(text));
  if (any(STOP_SEQUENCE) && !notAnInstruction(text, { negationAllowed: true })) {
    found.add("sequence_stop");
  }
  // "don't send" and "without attendees" constrain the action. They do not
  // cancel a draft or a create that the same sentence asks for.
  const plain = !notAnInstruction(withoutActionConstraints(text));
  if (plain && any(SET_TIMEZONE)) {
    found.add("sequence_timezone");
  }
  if (plain && ADD_SALES_FACT.test(text)) {
    found.add("sales_fact_add");
  }
  if (plain && REMOVE_SALES_FACT.test(text)) {
    found.add("sales_fact_remove");
  }
  const emailCommand = splitOwnerEmailCommand(text).command;
  if (plain && DRAFT.some((pattern) => pattern.test(emailCommand))) {
    found.add("draft");
  }
  if (plain && DISCARD_DRAFT.test(emailCommand)) {
    found.add("draft_discard");
  }
  if (
    (MAKE_EVENT.test(text) || CREATE_EVENT.test(text) || CHANGE_EVENT.test(text) || BLOCK_CALENDAR.test(text)) &&
    !notAnEventCommand(text) &&
    !CALENDAR_QUESTION.test(text)
  ) {
    found.add("calendar");
  }
  // "Remind me to follow up with X" is a sequence card; "remind me to follow up
  // with me" is still a reminder.
  if (
    (any(SET_REMINDER) || CANCEL_REMINDER.test(text)) &&
    !notAnInstruction(text, { remindAllowed: true })
  ) {
    found.add("reminder");
  }
  if (plain && any(ADD_TASK)) {
    found.add("task_add");
  }
  if (plain && any(CHANGE_TASK) && !/\bpaid\b/i.test(text)) {
    found.add("task");
  }
  if (plain && any(BILL)) {
    found.add("bill");
  }
  if (plain && ADD_DATE.test(text)) {
    found.add("date_add");
  }
  if (plain && REMOVE_DATE.test(text)) {
    found.add("date");
  }
  if (plain && any(ACCOUNT) && !NOT_A_DEAL.test(text)) {
    found.add("account");
  }
  if (plain && any(MEMORY) && !any(RECALL)) {
    found.add("memory");
  }
  if (plain && QA_BANK.test(text)) {
    found.add("qa_bank");
  }
  if (any(LIST_IGNORED)) {
    found.add("ignore_list");
  }
  if (any(RESUME) && !notAnInstruction(text, { negationAllowed: true })) {
    found.add("resume");
  }
  if (any(IGNORE) && !notAnInstruction(text, { negationAllowed: true })) {
    found.add("ignore");
    found.delete("task");
  }
  if (SPECIFIC.some((kind) => found.has(kind))) {
    found.delete("calendar");
  }
  return [...found];
}
