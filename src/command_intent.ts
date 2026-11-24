import { notAnEventCommand, notASendCommand, splitOwnerEmailCommand, withoutActionConstraints } from "./command_logic.js";
import {
  COMMAND_FOLLOWUPS,
  COMMAND_GAP_DAYS,
  COUNT_WORD,
  isDirectSequenceCommand,
  isExplicitSequenceRequest,
} from "./sequence_logic.js";

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
  | "qa_bank"
  | "ignore"
  | "resume"
  | "ignore_list";

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
    action: ["stop_sequence"],
    lookup: [],
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
    action: ["mark_bill_paid", "ignore_bill", "ignore_item"],
    lookup: ["list_bills"],
    retry: "For a bill, call list_bills and then mark_bill_paid, ignore_bill, or ignore_item now.",
    notRun: "no bill was marked paid or skipped",
  },
  ignore: {
    action: ["ignore_item", "ignore_bill"],
    lookup: ["list_ignored", "list_tasks", "list_bills", "list_reminders"],
    retry: "To ignore something, call ignore_item now with what he named.",
    notRun: "nothing was ignored",
  },
  resume: {
    action: ["resume_item"],
    lookup: ["list_ignored"],
    retry: "To resume tracking, call resume_item now with what he named.",
    notRun: "nothing was resumed",
  },
  ignore_list: {
    action: ["list_ignored"],
    lookup: [],
    force: "list_ignored",
    retry: "To show ignored items, call list_ignored now.",
    notRun: "ignored items were not listed",
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
  // "Remind me (tomorrow / on Friday / at 5pm) to start a sequence" is a reminder.
  new RegExp(`\\bremind\\s+me\\b[^.?!\\n]{0,40}?\\bto\\s+(?:${SEQUENCE_WORD}|set\\s*up|put|add|create|schedule|run|launch|kick\\s*off)\\b`, "i"),
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
const TELL_BY_EMAIL = new RegExp(`${IMPERATIVE_START}tell\\s+[\\p{L}\\p{M}'’-]+(?:\\s+[\\p{L}\\p{M}'’-]+){0,3}\\s+by\\s+e-?mail\\b`, "iu");
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
  "ignore",
  "resume",
  "ignore_list",
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
  if (
    isExplicitSequenceRequest(maskQuoted(text)) &&
    !NOT_A_SEQUENCE_COMMAND.some((pattern) => pattern.test(text)) &&
    !isQuestionOrMaybe(maskQuoted(text)) &&
    !notAnInstruction(text, { remindAllowed: true })
  ) {
    found.add("sequence");
  }
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
  const emailRequest = SEND_SOMETHING.test(emailCommand) || REPLY_TO.test(emailCommand) ||
    TELL_BY_EMAIL.test(emailCommand) || EMAIL_SOMEONE.test(emailCommand);
  if (emailRequest && !notASendCommand(text)) {
    found.add("send");
  }
  if (plain && DRAFT.some((pattern) => pattern.test(emailCommand)) && !found.has("send")) {
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
    !found.has("sequence") &&
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
    // "Email X saying ... and start 3 follow-ups" is a send first, then the follow-ups.
    const sendThenFollowups = found.has("sequence") && (() => {
      const parsed = parseSequenceCommand(text);
      return parsed.kind === "direct" && parsed.combined;
    })();
    if (!found.has("draft") && !sendThenFollowups) {
      found.delete("send");
    }
  }
  return [...found];
}

/** Quoted text is what an email should say, never an instruction to Aadi. Blanked
 *  out (same length, so positions still line up), an unclosed quote to the end. */
export function maskQuoted(text: string): string {
  return text.replace(/"[^"]*(?:"|$)|“[^”]*(?:”|$)|‘[^’]*(?:’|$)/g, (match) => " ".repeat(match.length));
}

/** Settings he gave by command. Null gap: SEQUENCE_STEP_DAYS. Null CTA: the ask in his email. */
export interface FollowupSettings {
  followups: number;
  gapDays: number | null;
  cta: string | null;
}

/** What his words ask of the follow-ups. Only his own words are ever passed in. */
export type SequenceCommand =
  /** Not a sequence request. mentionsFollowups: the words "follow-ups" or
   *  "sequence" appear anyway, e.g. inside an email he dictated. */
  | { kind: "none"; mentionsFollowups: boolean }
  /** He said not to: "don't start the sequence yet", "no follow-ups", "... Not yet." */
  | { kind: "negated" }
  /** More than one person in one message. */
  | { kind: "several" }
  /** A softer phrasing that only offers the standard Start card. */
  | { kind: "soft" }
  | {
      kind: "direct";
      /** The message also sends an email first; the follow-ups are for that email. */
      combined: boolean;
      /** The follow-up clause, the only part settings are read from. */
      clause: string;
      /** In a combined message, everything before the clause. */
      emailPart: string;
      /** What could be read for certain. Anything unsure falls back to the standard
       *  value, and `unsure` says so. */
      settings: FollowupSettings;
      /** Every setting he mentioned that wasn't read for certain, in words for him. */
      unsure: string[];
      /** The command is one of the plain imperatives that may enrol with no card. */
      allowlisted: boolean;
      /** "put this email in a follow-up sequence": the email is the one he replied to. */
      thisEmail: boolean;
      /** The person the follow-up clause names, if any. */
      target: string | null;
    };

function nameTokens(value: string): string[] {
  return value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** "Jeff" and "Jeff Comstock" name the same person; "Jeff" and "Priya" don't. */
export function namesMatch(left: string, right: string): boolean {
  const a = nameTokens(left);
  const b = nameTokens(right);
  const aSet = new Set(a);
  const bSet = new Set(b);
  return a.length > 0 && b.length > 0 && (a.every((token) => bSet.has(token)) || b.every((token) => aSet.has(token)));
}

/** Sentences of the text, with where each starts and ends. */
function sentencesOf(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  // A dot inside a word (an address, "e.g") doesn't end a sentence.
  for (const match of text.matchAll(/(?:[^.!?\n]|[.!?](?=[^\s.!?]))+(?:[.!?]+|$)/g)) {
    if (match[0].trim()) {
      spans.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
    }
  }
  return spans;
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

function numberOf(word: string): number {
  const lower = word.toLowerCase();
  return /^\d+$/.test(lower) ? Number(lower) : (NUMBER_WORDS[lower] ?? Number.NaN);
}

/** No connective between the negation and the noun: "not sure, and start
 *  follow-ups" is not a stop word, "don't start the follow-ups" is. */
const UNBROKEN = "(?:(?!\\b(?:and|then|but)\\b)[^.?!\\n,;]){0,30}?";
const FOLLOWUP_NOUN = "(?:follow[\\s-]*ups?|sequences?|auto[\\s-]*follow)";
/** Stop words win wherever they are in the message, the email he dictated included. */
const SEQUENCE_STOP: readonly RegExp[] = [
  /\bno\s+(?:more\s+)?(?:follow[\s-]*ups?|sequences?)\b/i,
  /\bwithout\s+(?:any\s+)?(?:follow[\s-]*ups?|(?:a\s+)?sequences?)\b/i,
  new RegExp(`\\b(?:don'?t|don’t|do not|never|not|no need to|shouldn'?t)\\b${UNBROKEN}\\b${FOLLOWUP_NOUN}`, "i"),
  new RegExp(`\\b(?:not\\s+yet|hold\\s+off|wait\\s+(?:on|with|before))\\b${UNBROKEN}\\b${FOLLOWUP_NOUN}`, "i"),
  /\b(?:follow[\s-]*ups?|sequences?)\b[^.?!\n]{0,40}?\b(?:not\s+yet|later|hold\s+off)\b/i,
];

/** A deferral said on its own ("... Not yet.", "..., but wait.") or at the very end
 *  ("... asking for a demo Not yet."). Counted when the message asks for follow-ups. */
const STANDALONE_DEFERRAL =
  /(?:^|[.!?;,]\s*|\b(?:but|and)\s+)(?:not\s+(?:yet|now)|hold\s+off|wait|later|don'?t\s+start(?:\s+(?:it|them|yet))*)\s*(?:[.!?]+\s*|$)/i;
const END_DEFERRAL = /\b(?:not\s+(?:yet|now)|hold\s+off|later|wait)\s*[.!?]*\s*$/i;

/** His own question or musing, not a request to Aadi: "Can I start 3 follow-ups for
 *  X?", "start a sequence for X?", "I could ...", "maybe ...". "Can you / could you /
 *  would you ..." is still a request. */
const REQUEST_TO_AADI = /^(?:please\s+)?(?:can|could|would)\s+you\b/i;
const FIRST_PERSON_MAYBE =
  /\b(?:can|could|may|might|should|shall|would)\s+(?:i|we)\b|\b(?:i|we)\s+(?:could|might|may|should|would|can|already|just)\b|\b(?:thinking|wondering|considering)\s+(?:of|about|whether|if)\b|\bmaybe\b|\bwhat\s+if\b|\bhow\s+about\b|\bif\b|\bunless\b|\bwhen(?:ever)?\s+(?:he|she|they|i|we)\b|\b(?:asked|told|said|wanted)\s+(?:me|us|him|her|them)?\s*to\b/i;

function isQuestionOrMaybe(text: string): boolean {
  const trimmed = text.trim();
  if (REQUEST_TO_AADI.test(trimmed) && !FIRST_PERSON_MAYBE.test(trimmed.replace(REQUEST_TO_AADI, ""))) {
    return false;
  }
  return /\?\s*$/.test(trimmed) || FIRST_PERSON_MAYBE.test(trimmed);
}

/** The only commands that may enrol with no card: a plain imperative to Aadi,
 *  optionally after "please", "can you", "could you" or "would you". */
const ALLOWED_IMPERATIVE =
  /^(?:please\s+)?(?:(?:can|could|would)\s+you\s+(?:please\s+)?)?(?:start|set\s*up|setup|put|add|begin)\b/i;
/** In a send-then-follow-ups message, the email part must be a plain imperative too. */
const EMAIL_IMPERATIVE =
  /^(?:please\s+)?(?:(?:can|could|would)\s+you\s+(?:please\s+)?)?(?:e-?mail|mail|send|reply|respond|write\s+to|tell)\b/i;

/** A spacing he asked for that isn't in days: never swapped for the default. */
const INTERVAL_MENTION =
  /\b(?:every|each)\s+(?!one\b|of\b)\S+|\b(?:apart|between|gap|daily|weekly|monthly|fortnightly|biweekly|twice|thrice)\b|\b(?:a|per)\s+(?:day|week|month)\b/i;
const BEYOND_TWO_WEEKS = /\bmonths?\b|\bmonthly\b|\byears?\b|\byearly\b|\bannual(?:ly)?\b/i;
/** "A few follow-ups": a count he didn't give. */
const VAGUE_COUNT =
  /\b(?:a\s+few|few|several|a\s+couple(?:\s+of)?|couple\s+of|some|many|multiple|a\s+bunch\s+of|lots\s+of|a\s+number\s+of)\s+(?:more\s+)?follow[\s-]*ups?\b/i;
/** "for Mayur and Raj", "to Mayur, Raj and Priya": more than one person. */
const PERSON_LIST =
  /\b(?:for|to|with)\s+(.+?)(?=\s*(?:,\s*)?(?:\b(?:every|each|asking|ask|cta|call[\s-]*to[\s-]*action|gap|daily|weekly|monthly|fortnightly|with\s+(?:a|the)|apart|between|starting|from|on|by|next|this|tomorrow|today|in\s+(?:a|the|my))\b|\d|$|[.!?;]))/i;

/** Where a follow-up clause may start after an email request: "..., and start 3
 *  follow-ups", "... then put it in a sequence", "... . Start follow-ups." */
const CLAUSE_BOUNDARY =
  /(?:[.!?;]\s+|,\s*(?:and\s+(?:then\s+)?|then\s+)?|\s+and\s+(?:then\s+|also\s+)?|\s+then\s+|\s+also\s+)(?:(?:please|also|then|can you|could you|would you)\s+)?(?=(?:start|begin|set\s*up|create|kick\s*off|launch|schedule|run|put|add|enrol|move|place|auto|follow)\b)/gi;

const SEND_IT = /\bsend\s+(?:it|this|that|the\s+(?:draft|email|mail))\b/i;

function asksToSendEmail(text: string): boolean {
  const command = splitOwnerEmailCommand(text).command;
  return (
    SEND_IT.test(text) ||
    SEND_SOMETHING.test(command) ||
    REPLY_TO.test(command) ||
    TELL_BY_EMAIL.test(command) ||
    EMAIL_SOMEONE.test(command)
  );
}

/** Where his CTA ends: at the next setting or the end of the clause. */
const CTA_END = /,|;|\.(?:\s|$)|\s+(?:every|each|daily|weekly|fortnightly)\b|\s+\d+\s+days?\s+apart\b|\s+and\s+(?:every|space|make|send)\b/i;
const CTA_MAX = 100;

/** What is left of a clause once its settings are taken out; anything else means he
 *  said something these settings don't cover. */
const SETTING_FRAGMENTS: readonly RegExp[] = [
  /\b(?:every|each)\s+other\s+day\b/gi,
  /\b(?:every|each)\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen)\s+(?:days?|weeks?)\b/gi,
  /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|a)\s+(?:days?|weeks?)\s+(?:apart|between(?:\s+(?:them|each))?|in\s+between)\b/gi,
  /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)[\s-]*days?\s+gap\b|\bgap\s+of\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+days?\b/gi,
  /\b(?:every|each)\s+(?:day|week)\b|\b(?:daily|weekly|fortnightly)\b|\bevery\s+fortnight\b/gi,
  /\b(?:with\s+)?(?:a\s+)?(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?:[\s-]*steps?)?(?:[\s-]+(?:more|automatic|auto))?[\s-]+follow[\s-]*ups?\b/gi,
];
const CONNECTIVES = /^(?:[\s,;.:!-]|\b(?:and|with|then|please|thanks|thank\s+you)\b)*$/i;

function ctaOf(clause: string): { cta: string; start: number; end: number } | { unsure: string; start: number; end: number } | undefined {
  const patterns: Array<[RegExp, (value: string) => string]> = [
    [/\b(?:asking|ask|request(?:ing)?)\s+(?:(?:them|him|her|the\s+prospect)\s+)?for\s+/i, (value) => `ask for ${value}`],
    [/\b(?:asking|ask|getting|get|inviting|invite|telling|tell)\s+(?:them|him|her|the\s+prospect|\p{L}[\p{L}'’-]*)\s+to\s+/iu, (value) => `ask them to ${value}`],
    [/\b(?:asking|ask)\s+to\s+/i, (value) => `ask them to ${value}`],
    [/\b(?:cta|call[\s-]*to[\s-]*action)\b\s*(?:is\s+|:\s*|=\s*|of\s+|as\s+|being\s+|-\s*)?/i, (value) => value],
    [/\bwith\s+(?:the\s+)?ask\s+(?:being\s+|of\s+|:\s*)?/i, (value) => value],
  ];
  for (const [pattern, shape] of patterns) {
    const match = pattern.exec(clause);
    if (!match) {
      continue;
    }
    const from = match.index + match[0].length;
    const tail = clause.slice(from);
    // A quoted CTA runs to its closing quote, commas and all.
    const quoted = /^\s*(?:"([^"]+)"|“([^”]+)”|‘([^’]+)’)/.exec(tail);
    if (quoted) {
      const inner = (quoted[1] ?? quoted[2] ?? quoted[3] ?? "").replace(/\s+/g, " ").trim();
      const end = from + quoted[0].length;
      if (inner.length > CTA_MAX) {
        return { unsure: `your CTA is longer than ${CTA_MAX} characters`, start: match.index, end };
      }
      return inner ? { cta: shape(inner), start: match.index, end } : { unsure: "your CTA was empty", start: match.index, end };
    }
    if (/^\s*["“‘]/.test(tail)) {
      return { unsure: "your CTA's quote isn't closed", start: match.index, end: clause.length };
    }
    const stop = CTA_END.exec(tail);
    const end = from + (stop ? stop.index : tail.length);
    const value = (stop ? tail.slice(0, stop.index) : tail)
      .replace(/\s+(?:please|thanks|thank you)$/i, "")
      .replace(/[.!?,;:]+$/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!value) {
      return { unsure: "I couldn't read your CTA", start: match.index, end };
    }
    if (value.length > CTA_MAX) {
      return { unsure: `your CTA is longer than ${CTA_MAX} characters`, start: match.index, end };
    }
    // Anything after the CTA that isn't another setting: unclear where the CTA ends.
    let rest = clause.slice(end);
    for (const fragment of SETTING_FRAGMENTS) {
      rest = rest.replace(fragment, " ");
    }
    if (!CONNECTIVES.test(rest)) {
      return { unsure: "I couldn't tell where your CTA ends (put it in quotes)", start: match.index, end: clause.length };
    }
    return { cta: shape(value), start: match.index, end };
  }
  return undefined;
}

const COUNT_PATTERNS: readonly RegExp[] = [
  new RegExp(`\\b(${COUNT_WORD})(?:[\\s-]*steps?)?(?:[\\s-]+(?:more|automatic|auto))?[\\s-]+follow[\\s-]*ups?\\b`, "gi"),
  new RegExp(`\\b(${COUNT_WORD})[\\s-]*steps?\\b`, "gi"),
  new RegExp(`\\b(${COUNT_WORD})\\s+(?:more\\s+)?times?\\b`, "gi"),
];

/** "a follow-up", "a single follow-up": one. Not "a follow-up sequence". */
const ONE_FOLLOWUP = /\b(?:a|an|single|a\s+single|one\s+single)\s+follow[\s-]*up\b(?![\s-]*(?:s\b|sequences?\b))/gi;
/** A bare singular "follow-up" with no number: one, or a sequence? Unclear. */
const BARE_FOLLOWUP = /\bfollow[\s-]*up\b(?![\s-]*(?:s\b|sequences?\b))/i;

/** Every count he gave: "3 follow-ups", "a 3-step ...", "4 times", "a follow-up". */
function countsOf(text: string): number[] {
  const values = new Set<number>();
  for (const pattern of COUNT_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      values.add(numberOf(match[1]!));
    }
  }
  if (values.size === 0 && [...text.matchAll(ONE_FOLLOWUP)].length > 0) {
    values.add(1);
  }
  return [...values];
}

/** Every gap he gave, in days. */
function gapsOf(text: string): number[] {
  const values = new Set<number>();
  const add = (pattern: RegExp, days: (value: number) => number): void => {
    for (const match of text.matchAll(pattern)) {
      // The number from whichever alternative matched: "5-day gap" or "gap of 5 days".
      const value = match.slice(1).find((item) => item !== undefined);
      values.add(days(value ? numberOf(value) : 1));
    }
  };
  add(/\bevery\s+other\s+day\b/gi, () => 2);
  add(/\bevery\s+fortnight\b|\bfortnightly\b/gi, () => 14);
  add(new RegExp(`\\b(?:every|each)\\s+(${COUNT_WORD})\\s+weeks?\\b`, "gi"), (value) => value * 7);
  add(new RegExp(`\\b(${COUNT_WORD}|a)\\s+weeks?\\s+(?:apart|between|in\\s+between)\\b`, "gi"), (value) => value * 7);
  add(/\b(?:every|each)\s+week\b|\bweekly\b/gi, () => 7);
  add(new RegExp(`\\b(?:every|each)\\s+(${COUNT_WORD})\\s+days?\\b`, "gi"), (value) => value);
  add(new RegExp(`\\b(${COUNT_WORD}|a)\\s+days?\\s+(?:apart|between|in\\s+between)\\b`, "gi"), (value) => value);
  add(new RegExp(`\\b(${COUNT_WORD})[\\s-]*days?\\s+gap\\b|\\bgap\\s+of\\s+(${COUNT_WORD})\\s+days?\\b`, "gi"), (value) => value);
  add(/\b(?:every\s+day|each\s+day|daily)\b/gi, () => 1);
  return [...values];
}

const THIS_EMAIL =
  /\b(?:this|that)\s+(?:e-?mail|mail|message|thread|draft|one)\b|\b(?:put|add|enrol+|move|place)\s+(?:this|that|it)\b/i;

/** Words a plain follow-up command is made of. Anything else in the clause is
 *  something these settings don't cover ("next week", "in Hindi", "and cc Jeff"), so
 *  it can't enrol on its own. */
const COMMAND_WORDS = new Set([
  "please", "can", "could", "would", "you", "start", "set", "up", "setup", "put", "add", "begin",
  "a", "an", "the", "my", "new", "another", "automatic", "auto", "email", "mail", "more", "step", "steps",
  "follow", "ups", "followup", "followups", "sequence", "sequences", "for", "to", "with", "on", "in", "into",
  "of", "and", "then", "also", "them", "him", "her", "it", "this", "that", "last", "latest", "thread",
  "message", "draft", "one", "single", "every", "each", "other", "day", "days", "week", "weeks", "apart", "between",
  "gap", "daily", "weekly", "fortnight", "fortnightly", "now", "thanks", "thank", "pls", "cta",
  "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "fourteen",
]);

function leftoverWords(settingsText: string, target: string | null): string[] {
  const named = new Set(nameTokens(target ?? ""));
  return nameTokens(settingsText).filter((word) => !COMMAND_WORDS.has(word) && !named.has(word) && !/^\d+$/.test(word));
}
const POLITE_TAIL = /^\s*(?:thanks|thank\s+you|thx|please|pls|cheers)[\s.!]*$/i;

/**
 * Reads a follow-up command from his own words. Only the follow-up clause sets
 * anything: in "email Mayur saying ... and start 3 follow-ups", what the email says
 * is never read for numbers. A stop word anywhere wins. Whether it may enrol with no
 * card is decided by decideSequenceAction, from what this returns.
 */
export function parseSequenceCommand(ownWords: string): SequenceCommand {
  const text = ownWords.replace(/\s+/g, " ").trim();
  // What he quoted is what an email says; only the rest can be a command.
  const plain = maskQuoted(text);
  // "Follow-ups", "sequence" or "3 follow-up ...", not "send a follow-up to X".
  const mentionsFollowups =
    /\bfollow[\s-]*ups\b|\bsequences?\b|\b(?:\d+|two|three|four|five|six)\s+follow[\s-]*up\b/i.test(text);
  const explicit = Boolean(text) && isExplicitSequenceRequest(plain);
  if (
    SEQUENCE_STOP.some((pattern) => pattern.test(text)) ||
    NOT_A_SEQUENCE_COMMAND[0]!.test(text) ||
    (explicit && (STANDALONE_DEFERRAL.test(text) || END_DEFERRAL.test(text)))
  ) {
    return { kind: "negated" };
  }
  if (!explicit) {
    return { kind: "none", mentionsFollowups };
  }
  const requests = sentencesOf(plain).filter((span) => isExplicitSequenceRequest(plain.slice(span.start, span.end)));
  if (requests.length > 1) {
    return { kind: "several" };
  }
  if (!isDirectSequenceCommand(plain)) {
    return { kind: "soft" };
  }
  let clause = text;
  let emailPart = "";
  let combined = false;
  // Boundaries are found in the unquoted text, so a clause can't start inside a quote.
  for (const match of plain.matchAll(CLAUSE_BOUNDARY)) {
    const at = (match.index ?? 0) + match[0].length;
    if (isDirectSequenceCommand(plain.slice(at)) && asksToSendEmail(plain.slice(0, match.index))) {
      clause = text.slice(at);
      emailPart = text.slice(0, match.index).trim();
      combined = true;
      break;
    }
  }
  const clausePlain = maskQuoted(clause);
  const people = PERSON_LIST.exec(clausePlain)?.[1] ?? "";
  // "to the follow-up sequence, one follow-up" is where they go, not a list of people.
  if (!/\bfollow[\s-]*ups?\b|\bsequences?\b/i.test(people) && /,\s*\p{Lu}|\s(?:and|&)\s+\p{Lu}/u.test(people)) {
    return { kind: "several" };
  }
  const unsure: string[] = [];
  const clauseSentences = sentencesOf(clausePlain);
  const extra = clauseSentences.slice(1).some((span) => !POLITE_TAIL.test(clause.slice(span.start, span.end)));
  if (extra || (!combined && asksToSendEmail(plain))) {
    unsure.push("your message says more than the follow-up command");
  }
  const cta = ctaOf(clause);
  if (cta && "unsure" in cta) {
    unsure.push(cta.unsure);
  }
  const settingsText = cta ? `${clause.slice(0, cta.start)} ${clause.slice(cta.end)}` : clause;
  let followups: number = COMMAND_FOLLOWUPS.default;
  const counts = countsOf(settingsText);
  if (VAGUE_COUNT.test(settingsText)) {
    unsure.push("I couldn't tell how many follow-ups you want");
  } else if (counts.length > 1) {
    unsure.push("you gave more than one number of follow-ups");
  } else if (counts.length === 0 && BARE_FOLLOWUP.test(settingsText)) {
    unsure.push("I couldn't tell whether you want one follow-up or a sequence");
  } else if (counts.length === 1) {
    const count = counts[0]!;
    if (Number.isInteger(count) && count >= COMMAND_FOLLOWUPS.min && count <= COMMAND_FOLLOWUPS.max) {
      followups = count;
    } else {
      unsure.push(`${Number.isNaN(count) ? "that many" : count} follow-ups is outside ${COMMAND_FOLLOWUPS.min} to ${COMMAND_FOLLOWUPS.max}`);
    }
  }
  let gapDays: number | null = null;
  const gaps = gapsOf(settingsText);
  if (gaps.length > 1) {
    unsure.push("you gave more than one gap");
  } else if (gaps.length === 1) {
    const gap = gaps[0]!;
    if (Number.isInteger(gap) && gap >= COMMAND_GAP_DAYS.min && gap <= COMMAND_GAP_DAYS.max) {
      gapDays = gap;
    } else {
      unsure.push(`a gap of ${gap} days is outside ${COMMAND_GAP_DAYS.min} to ${COMMAND_GAP_DAYS.max}`);
    }
  } else if (INTERVAL_MENTION.test(settingsText)) {
    unsure.push(
      BEYOND_TWO_WEEKS.test(settingsText)
        ? `that gap is more than ${COMMAND_GAP_DAYS.max} days`
        : `I can only space follow-ups in days, ${COMMAND_GAP_DAYS.min} to ${COMMAND_GAP_DAYS.max} apart`,
    );
  }
  const target = sequenceTargets(clause)?.[0] ?? null;
  const leftover = leftoverWords(settingsText, target);
  if (leftover.length > 0 && !unsure.includes("your message says more than the follow-up command")) {
    unsure.push(`I don't act on "${leftover.join(" ")}" on my own`);
  }
  const allowlisted =
    ALLOWED_IMPERATIVE.test(clause.trim()) &&
    (!combined || EMAIL_IMPERATIVE.test(emailPart)) &&
    !isQuestionOrMaybe(plain) &&
    !REMIND_ME.test(plain) &&
    !NOT_A_SEQUENCE_COMMAND.slice(1).some((pattern) => pattern.test(plain)) &&
    !ASKED.test(plain) &&
    !ASKED_ABOUT.test(plain) &&
    !PLANNED.test(plain);
  return {
    kind: "direct",
    combined,
    clause,
    emailPart,
    settings: { followups, gapDays, cta: cta && "cta" in cta ? cta.cta : null },
    unsure,
    allowlisted,
    thisEmail: THIS_EMAIL.test(clause),
    target,
  };
}

/** His words with the follow-up clause taken out, for the email writer. */
export function withoutFollowupClause(ownWords: string): string {
  const parsed = parseSequenceCommand(ownWords);
  return parsed.kind === "direct" && parsed.combined ? parsed.emailPart : ownWords;
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
    // The email-anchored phrasings name the person after the email, whatever
    // comes before: "auto follow up on my email to Jeff", "start a sequence on the
    // email I sent Munil", "remind me to follow up on my email to Dorothy". They go
    // first, or a generic prefix below would take "my email to Jeff" as the name.
    const onEmail =
      /\bon\s+(?:my|the)\s+(?:last\s+|latest\s+)?(?:e-?mail|mail|message|note|thread)\s+(?:that\s+)?i\s+sent\s+(?:to\s+)?(.+)$/i.exec(sentence) ??
      /\bon\s+(?:my|the)\s+(?:last\s+|latest\s+)?(?:e-?mail|mail|message|note|thread)\s+(?:to|with|for)\s+(.+)$/i.exec(sentence) ??
      /\bfollow[\s-]*up\s+with\s+(.+?)\s+on\s+(?:my|the)\s+(?:last\s+|latest\s+)?(?:e-?mail|mail|thread)\b/i.exec(sentence) ??
      /\btrack\s+(?:my|the)\s+(?:last\s+|latest\s+)?(?:e-?mail|mail|thread)\s+(?:to|with)\s+(.+)$/i.exec(sentence);
    const reminded = onEmail
      ? null
      : /\bremind\s+me\s+to\s+follow[\s-]*up\s+(?:with|on)\s+(.+)$/i.exec(sentence);
    const counted = new RegExp(`\\bfollow[\\s-]*ups?\\s+(?:with\\s+)?(.+?)\\s+${COUNT_WORD}\\s+(?:more\\s+)?times?\\b`, "i").exec(sentence);
    const added = /\badd\s+(.+?)\s+to\s+(?:the\s+|a\s+|my\s+)?sequences?\b/i.exec(sentence);
    const withPerson = /\bfollow[\s-]*ups?\s+with\s+(?!(?:me|us|myself)\b)(.+)$/i.exec(sentence);
    // "put my email to Mayur in a follow-up sequence": the person after the email.
    const putEmail = /\b(?:put|add|enrol+|move|place)\s+(?:my|the)\s+(?:last\s+|latest\s+)?(?:e-?mail|mail|thread|message|note)\s+(?:to|with|for)\s+(.+?)\s+(?:in|into|to|on)\s+(?:(?:a|an|the|my)\s+)?(?:(?:automatic|auto|email|new)\s+)?(?:follow[\s-]*ups?|sequences?)\b/i.exec(sentence);
    // "add Mayur to follow-ups", "put Mayur in the sequence".
    const putPerson = /\b(?:put|add|enrol+|move|place)\s+(.+?)\s+(?:in|into|to|on)\s+(?:(?:a|an|the|my)\s+)?(?:(?:automatic|auto|email|new)\s+)?(?:follow[\s-]*ups?|sequences?)\b/i.exec(sentence);
    // "start a 3-step follow-up to Mayur", "set up 5 follow-ups for Mayur".
    const startFollowups = /\b(?:start|begin|set\s*up|create|kick\s*off|launch|schedule|run)\b[^.?!\n]*?\bfollow[\s-]*ups?\s+(?:to|for|with|on)\s+(?!(?:me|us|myself)\b)(.+)$/i.exec(sentence);
    const match =
      onEmail ??
      /\b(?:start|begin)\b(?:\s+(?:a|an|the|new|another|follow[\s-]*up|auto(?:matic)?|email|mail))*\s+sequences?\s+(?:for|with|to|on)\s+(.+)$/i.exec(sentence) ??
      /\bauto(?:matic(?:ally)?)?[\s-]*follow[\s-]*up\s+(?:with|on|for|to)\s+(.+)$/i.exec(sentence) ??
      counted ??
      putEmail ??
      added ??
      putPerson ??
      startFollowups ??
      withPerson;
    // "Remind me to follow up with Jeff on Monday": the person, not the day.
    const named = (reminded?.[1] ?? match?.[1])
      ?.replace(/,.*$/, "")
      .replace(
        new RegExp(`\\s+(?:every|each|asking|ask|cta|daily|weekly|with\\s+(?:a|the)\\s+(?:cta|ask)|${COUNT_WORD}(?:[\\s-]*(?:steps?|days?|weeks?|times?|follow[\\s-]*ups?))|a\\s+(?:day|week)\\s+apart)\\b.*$`, "i"),
        "",
      )
      .replace(
        /\s+(?:on|by|next|this|tomorrow|today|tonight|in|after|about|regarding|re|starting|from|instead|via|using|through|except|but|unless|if|when|before|until|because|since|so|or|as|like|same|only|without|and|then)\b.*$/i,
        "",
      )
      .replace(/[.!?,;:]+\s*$/, "")
      .replace(TRAILING_FILLER, "")
      .replace(/^["'“”]+|["'“”]+$/g, "")
      .trim();
    if (!named || named.length > 120 || VAGUE_TARGET.test(named)) {
      return undefined;
    }
    targets.push(named);
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
    ? " Say it again, or use /outbox with their name or email."
    : " Please say it again.";
  return `I didn't carry that out this time, so ${what}.${hint}`;
}
