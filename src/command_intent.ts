import { notAnEventCommand, notASendCommand } from "./command_logic.js";
import { isExplicitSequenceRequest } from "./sequence_logic.js";

/** Commands where a reply must come from a tool that ran this turn, never from
 *  what Aadi said before. */
export type CommandKind =
  | "sequence"
  | "sequence_stop"
  | "sequence_timezone"
  | "sales_fact_add"
  | "sales_fact_remove"
  | "send"
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
  | "qa_bank";

interface CommandFamily {
  /** Tools that carry the command out. */
  action: readonly string[];
  /** Read tools the model may need first, such as list_tasks before complete_task.
   *  A fresh lookup that ends in "which one?" is a real answer too. */
  lookup: readonly string[];
  /** Forced on the first step where the backend allows it. Only tools that need
   *  no lookup first and can't do harm from a wrong guess. */
  force?: string;
  retry: string;
  notRun: string;
}

const FAMILIES: Record<CommandKind, CommandFamily> = {
  sequence: {
    action: ["start_sequence"],
    lookup: [],
    force: "start_sequence",
    retry: "For a sequence, call start_sequence now with the person as Vishnu named them.",
    notRun: "no sequence was started or checked",
  },
  sequence_stop: {
    action: ["stop_sequence", "stop_tracking"],
    lookup: ["list_waiting"],
    // Never forced: "pause all follow-ups" stops every sequence.
    retry: "To stop follow-ups, call stop_sequence now with who he named, or \"all\" only if he said all.",
    notRun: "no follow-ups were stopped",
  },
  sequence_timezone: {
    action: ["set_sequence_timezone"],
    lookup: [],
    force: "set_sequence_timezone",
    retry: "For a prospect's time zone, call set_sequence_timezone now.",
    notRun: "no time zone was changed",
  },
  sales_fact_add: {
    action: ["add_sales_fact"],
    lookup: [],
    force: "add_sales_fact",
    retry: "To add a sales fact, call add_sales_fact now with his point.",
    notRun: "nothing was added to your sales facts",
  },
  sales_fact_remove: {
    action: ["remove_sales_fact"],
    lookup: ["list_sales_facts"],
    force: "remove_sales_fact",
    retry: "To remove a sales fact, call remove_sales_fact now.",
    notRun: "no sales fact was removed",
  },
  send: {
    action: [
      "send_email",
      "draft_new_email",
      "draft_reply",
      "confirm_send_pending_draft",
      "resend_draft_card",
      "cancel_scheduled_send",
    ],
    lookup: ["search_emails", "read_email", "read_draft"],
    retry: "For an email, call send_email now (find the thread with search_emails first if it's a reply), or the draft tool if he asked for a draft.",
    notRun: "no email was sent",
  },
  draft: {
    action: ["draft_new_email", "draft_reply", "draft_mom", "update_draft", "resend_draft_card"],
    lookup: ["search_emails", "read_email", "read_draft", "search_notes"],
    retry: "For a draft, call draft_new_email, draft_reply, draft_mom or update_draft now (search_emails first if it's a reply).",
    notRun: "no draft was written or changed",
  },
  draft_discard: {
    action: ["discard_pending_draft"],
    lookup: ["read_draft"],
    retry: "To discard the draft, call discard_pending_draft now.",
    notRun: "no draft was discarded",
  },
  calendar: {
    action: [
      "create_event",
      "book_meeting",
      "move_event",
      "delete_calendar_event",
      "add_calendar_attendee",
      "create_meeting",
      "propose_calendar_event",
    ],
    lookup: ["list_events"],
    retry: "For his calendar, call the tool for it now: create_event, book_meeting, move_event, delete_calendar_event or add_calendar_attendee.",
    notRun: "your calendar wasn't changed",
  },
  reminder: {
    action: ["set_reminder", "cancel_reminder", "add_task"],
    lookup: ["get_current_time", "list_reminders"],
    retry: "For a reminder, call set_reminder now (get_current_time first), or cancel_reminder to cancel one.",
    notRun: "no reminder was set or cancelled",
  },
  task_add: {
    action: ["add_task"],
    lookup: [],
    force: "add_task",
    retry: "To add a task, call add_task now.",
    notRun: "no task was added",
  },
  task: {
    action: ["complete_task", "delete_task"],
    lookup: ["list_tasks"],
    retry: "For a task, call list_tasks and then complete_task or delete_task now.",
    notRun: "your task list wasn't changed",
  },
  bill: {
    action: ["mark_bill_paid", "ignore_bill"],
    lookup: ["list_bills"],
    retry: "For a bill, call list_bills and then mark_bill_paid, or ignore_bill, now.",
    notRun: "no bill was marked paid or skipped",
  },
  date_add: {
    action: ["add_date"],
    lookup: [],
    force: "add_date",
    retry: "To save the date, call add_date now.",
    notRun: "no date was saved",
  },
  date: {
    action: ["remove_date"],
    lookup: ["list_dates", "list_upcoming_dates"],
    retry: "To remove the date, call list_dates and then remove_date now.",
    notRun: "no date was removed",
  },
  account: {
    action: ["add_account", "update_account", "remove_account"],
    lookup: ["list_accounts", "account_status"],
    retry: "For an account, call add_account, update_account or remove_account now (list_accounts first if you need its id).",
    notRun: "no account was changed",
  },
  memory: {
    action: ["remember", "update_memory", "forget_memory"],
    lookup: ["list_memories", "search_memories"],
    retry: "For a memory, call remember, update_memory or forget_memory now.",
    notRun: "nothing was remembered or forgotten",
  },
  qa_bank: {
    action: ["learn_qa_bank"],
    lookup: ["list_documents", "read_document"],
    retry: "For the Q&A bank, call learn_qa_bank now with the document's id (list_documents first if you need it).",
    notRun: "nothing was added to the Q&A bank",
  },
};

/** The tools that carry each command out. */
export const COMMAND_TOOLS: Record<CommandKind, readonly string[]> = Object.fromEntries(
  Object.entries(FAMILIES).map(([kind, family]) => [kind, family.action]),
) as Record<CommandKind, readonly string[]>;

/** Any of these running this turn means the command was carried out or checked
 *  against current data. */
export function commandFamilyTools(kind: CommandKind): readonly string[] {
  return [...FAMILIES[kind].action, ...FAMILIES[kind].lookup];
}

/** The one tool to force for these commands, if forcing is safe. */
export function forcedCommandTool(kinds: readonly CommandKind[]): string | undefined {
  return kinds.length === 1 ? FAMILIES[kinds[0]!].force : undefined;
}

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
  /\b(?:complete|finish|close|delete|remove|drop|dismiss|ignore)\s+(?:the\s+|my\s+|that\s+|this\s+)?(?:[\p{L}\p{N}'-]+\s+){0,3}?tasks?\b/iu,
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
const QA_BANK = /\b(?:learn|add|save|import)\b[^.?!\n]{0,40}?\b(?:q\s*&\s*a|q\s+and\s+a|qa)(?:\s+bank)?\b/i;

/** These name what the command is about, so a "call" or an "email" inside them
 *  doesn't also make it a calendar or send command. */
const SPECIFIC: readonly CommandKind[] = [
  "sequence",
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
];

/** The explicit commands in his own words, in English. Other languages stay the
 *  model's call, and no rule here grants anything: it only makes sure a tool runs. */
export function commandIntents(ownWords: string): CommandKind[] {
  const text = ownWords.trim();
  if (!text) {
    return [];
  }
  const found = new Set<CommandKind>();
  const any = (patterns: readonly RegExp[]): boolean => patterns.some((pattern) => pattern.test(text));
  if (isExplicitSequenceRequest(text) && !NOT_A_SEQUENCE_COMMAND.some((pattern) => pattern.test(text))) {
    found.add("sequence");
  }
  if (any(STOP_SEQUENCE) && !notAnInstruction(text, { negationAllowed: true })) {
    found.add("sequence_stop");
  }
  const plain = !notAnInstruction(text);
  if (plain && any(SET_TIMEZONE)) {
    found.add("sequence_timezone");
  }
  if (plain && ADD_SALES_FACT.test(text)) {
    found.add("sales_fact_add");
  }
  if (plain && REMOVE_SALES_FACT.test(text)) {
    found.add("sales_fact_remove");
  }
  if ((SEND_SOMETHING.test(text) || REPLY_TO.test(text) || EMAIL_SOMEONE.test(text)) && !notASendCommand(text)) {
    found.add("send");
  }
  if (plain && any(DRAFT) && !found.has("send")) {
    found.add("draft");
  }
  if (plain && DISCARD_DRAFT.test(text)) {
    found.add("draft_discard");
  }
  if (
    (MAKE_EVENT.test(text) || CREATE_EVENT.test(text) || CHANGE_EVENT.test(text) || BLOCK_CALENDAR.test(text)) &&
    !notAnEventCommand(text) &&
    !CALENDAR_QUESTION.test(text)
  ) {
    found.add("calendar");
  }
  // "Remind me to follow up with X" is a sequence, not a reminder.
  if (
    (any(SET_REMINDER) || CANCEL_REMINDER.test(text)) &&
    !/\bfollow[\s-]*up\b/i.test(text) &&
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
  if (plain && any(MEMORY)) {
    found.add("memory");
  }
  if (plain && QA_BANK.test(text)) {
    found.add("qa_bank");
  }
  if (SPECIFIC.some((kind) => found.has(kind))) {
    found.delete("calendar");
    if (!found.has("draft")) {
      found.delete("send");
    }
  }
  return [...found];
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

/** Asks again without pushing an action he didn't ask for: if the words only
 *  looked like a command, the model can say so, and he's told nothing ran. */
export function commandRetryPrompt(kinds: readonly CommandKind[]): string {
  return [
    "Vishnu's message looks like a command, and no tool has run for it this turn. An earlier answer in this chat is not a result: what happened before may have changed, so never repeat it.",
    ...kinds.map((kind) => FAMILIES[kind].retry),
    "Answer only from what the tool returns this turn. If his message isn't asking for that, don't call anything and say so in one line.",
  ].join(" ");
}

/** What he's told when the tool still didn't run: the truth, never an old answer. */
export function commandNotRunMessage(kinds: readonly CommandKind[]): string {
  const what = kinds.map((kind) => FAMILIES[kind].notRun).join(", and ");
  const hint = kinds.includes("sequence")
    ? " Say it again, or use /sequence with their name or email."
    : " Please say it again.";
  return `I didn't carry that out this time, so ${what}.${hint}`;
}
