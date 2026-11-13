export const CLAIM_ACTIONS = [
  "sent",
  "booked",
  "created",
  "scheduled",
  "saved",
  "discarded",
  "reminded",
  "invited",
  "deleted",
  "updated",
  "answered",
  "completed",
  "searched",
  "offered",
] as const;

export type ClaimAction = (typeof CLAIM_ACTIONS)[number];

export interface ToolReceipt {
  name: string;
  success: boolean;
}

const TOOLS_FOR: Record<ClaimAction, ReadonlySet<string>> = {
  sent: new Set([
    "draft_reply",
    "draft_new_email",
    "confirm_send_pending_draft",
    "send_email",
  ]),
  booked: new Set(["create_meeting", "book_meeting"]),
  created: new Set([
    "create_meeting",
    "create_event",
    "book_meeting",
    "add_task",
    "add_account",
    "add_date",
    "draft_reply",
    "draft_new_email",
    "draft_mom",
    "propose_calendar_event",
  ]),
  scheduled: new Set([
    "send_email",
    "create_meeting",
    "create_event",
    "book_meeting",
    "move_event",
    "set_reminder",
    "propose_calendar_event",
  ]),
  saved: new Set([
    "remember",
    "draft_reply",
    "draft_new_email",
    "draft_mom",
    "update_draft",
    "learn_qa_bank",
  ]),
  discarded: new Set(["discard_pending_draft"]),
  reminded: new Set(["set_reminder"]),
  invited: new Set(["add_calendar_attendee", "create_meeting", "book_meeting"]),
  deleted: new Set([
    "cancel_scheduled_send",
    "delete_calendar_event",
    "delete_task",
    "forget_memory",
    "remove_account",
    "remove_date",
  ]),
  updated: new Set(["update_draft", "update_memory", "update_account", "move_event"]),
  answered: new Set(["search_qa_bank", "learn_qa_bank"]),
  completed: new Set(["complete_task"]),
  searched: new Set(["web_search", "latest_release"]),
  offered: new Set(["start_sequence"]),
};

const CLAIM_RE: Record<ClaimAction, RegExp> = {
  sent: /\b(i(?:'ve| have)?|we)\s+(?:just\s+)?(?:sent|emailed)\b|\bsent (?:it|that|the (?:email|reply|mail))\b|\b(?:email|mail|reply)\s+(?:was\s+)?sent\b|^sent\b/i,
  booked: /\b(i(?:'ve| have)?|we)\s+(?:just\s+)?booked\b|\b(?:meeting|call|event)\s+(?:is\s+|was\s+)?booked\b|^booked\b/i,
  created: /\b(i(?:'ve| have)?|we)\s+(?:just\s+)?created\b|\b(?:event|meeting|task|draft|reminder)\s+(?:is\s+|was\s+)?created\b|^created\b/i,
  scheduled: /\b(i(?:'ve| have)?|we)\s+(?:just\s+)?scheduled\b|\b(?:meeting|call|event)\s+(?:is\s+|was\s+)?scheduled\b|^scheduled\b/i,
  saved: /\b(i(?:'ve| have)?|we)\s+(?:just\s+)?saved\b|\b(?:draft|it|that)\s+(?:is\s+|was\s+)?saved\b|^saved\b/i,
  discarded: /\b(i(?:'ve| have)?|we)\s+(?:just\s+)?discarded\b|\b(?:draft|it|that)\s+(?:is\s+|was\s+)?discarded\b|^discarded\b/i,
  reminded: /\b(i(?:'ve| have)?|we)\s+(?:just\s+)?(?:set a reminder|reminded)\b|\breminder\s+(?:is\s+|was\s+)?(?:set|saved|created)\b|^reminded\b/i,
  invited: /\b(i(?:'ve| have)?|we)\s+(?:just\s+)?invited\b|\binvite(?:d)?\s+(?:them|him|her|sent)\b|^invited\b/i,
  deleted: /\b(i(?:'ve| have)?|we)\s+(?:just\s+)?deleted\b|\b(?:event|meeting|task|it)\s+(?:is\s+|was\s+)?deleted\b|^deleted\b/i,
  updated: /\b(i(?:'ve| have)?|we)\s+(?:just\s+)?updated\b|\b(?:draft|event|it)\s+(?:is\s+|was\s+)?updated\b|^updated\b/i,
  answered: /\b(i(?:'ve| have)?|we)\s+(?:just\s+)?answered\b|\banswered (?:all|every|the) questions?\b/i,
  completed: /\b(i(?:'ve| have)?|we)\s+(?:just\s+)?completed\b|\b(?:task|it)\s+(?:is\s+|was\s+)?(?:completed|done)\b|^completed\b/i,
  searched:
    /\b(i(?:'ve| have)?|we)\s+(?:just\s+)?(?:searched|looked (?:it|that|this) up)\b|\b(?:from|via) (?:the )?(?:web|internet|search results?)\b|\bas of (?:today|now|this (?:morning|afternoon|evening))\b|\b(?:latest|breaking) (?:news|headlines?)\b|\bcurrent (?:price|rate|score|standings?|headline)\b|\blive (?:score|price|rate|updates?)\b|\baccording to (?:search|the web|sources?|reports?)\b|\b(?:search )?results? (?:show|say|from)\b/i,
  offered:
    /\boffer posted\b|\bsequence card is shown\b|\bstart card sent\b|\bcard is shown above\b|\bwaiting for (?:your|vishnu's) start tap\b/i,
};

const NEGATION =
  /\b(not|never|didn't|did not|couldn't|could not|cannot|can't|won't|wasn't|hasn't|haven't|no tool)\b/i;

export function isSuccessfulToolResult(
  content: string,
  isError?: boolean,
): boolean {
  if (isError) {
    return false;
  }
  const text = content.trim();
  if (!text) {
    return false;
  }
  if (/^Not\s/i.test(text) || /^Tool failed/i.test(text) || /^Unknown tool/i.test(text)) {
    return false;
  }
  return true;
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?\n])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function detectClaimedActions(reply: string): ClaimAction[] {
  const trimmed = reply.trim();
  if (!trimmed || /^I couldn't do that:/i.test(trimmed)) {
    return [];
  }
  const found = new Set<ClaimAction>();
  for (const sentence of sentences(trimmed)) {
    if (NEGATION.test(sentence)) {
      continue;
    }
    for (const action of CLAIM_ACTIONS) {
      if (CLAIM_RE[action].test(sentence)) {
        found.add(action);
      }
    }
  }
  return [...found];
}

/** What the turn was, for telling a claim from a description of something read. */
export interface ClaimContext {
  /** Vishnu's own words this turn. */
  ownerText?: string;
  /** True for a tool that only reads. */
  isReadTool?: (name: string) => boolean;
}

const OWN_VERBS: Record<ClaimAction, string> = {
  sent: "(?:sent|emailed)",
  booked: "booked",
  created: "created",
  scheduled: "scheduled",
  saved: "saved",
  discarded: "discarded",
  reminded: "(?:set a reminder|reminded)",
  invited: "invited",
  deleted: "deleted",
  updated: "updated",
  answered: "answered",
  completed: "completed",
  searched: "(?:searched|looked (?:it|that|this) up)",
  offered: "(?:offered|posted)",
};

/** Aadi saying it did the thing itself: "I sent", "I've booked", "we deleted". */
function ownClaim(action: ClaimAction): RegExp {
  return new RegExp(
    `\\b(?:i|we)(?:'ve|’ve| have)?\\s+(?:just\\s+|already\\s+)?${OWN_VERBS[action]}\\b`,
    "i",
  );
}

/** What each action sounds like when Vishnu asks for it. */
const ASKED_FOR: Record<ClaimAction, RegExp> = {
  sent: /\b(?:send|resend|reply|respond|forward|follow[ -]?up|draft|write|compose|e-?mail\s+(?:him|her|them|back)|bhej\w*|ayakk\w*|ayach\w*)\b/i,
  booked: /\b(?:book|schedule|set\s*up|arrange|invite)\b/i,
  created: /\b(?:create|make|add|draft|write|set\s*up|book|schedule|propose)\b/i,
  scheduled: /\b(?:schedule|reschedule|book|set\s*up|move|remind|send)\b/i,
  saved: /\b(?:save|remember|note|draft|write|learn|update|store)\b/i,
  discarded: /\b(?:discard|delete|drop|cancel|remove|scrap)\b/i,
  reminded: /\b(?:remind|reminder|nudge)\b/i,
  invited: /\b(?:invite|add|book|schedule|include)\b/i,
  deleted: /\b(?:delete|remove|cancel|forget|drop|clear)\b/i,
  updated: /\b(?:update|change|edit|revise|move|reschedule|fix|rewrite)\b/i,
  answered: /\b(?:answer|fill|respond|reply)\b/i,
  completed: /\b(?:complete|finish|mark|tick|close)\b/i,
  searched: /$^/,
  offered: /\b(?:sequence|follow[\s-]*up)\b/i,
};

const ASKS_TO_LOOK =
  /\b(?:find|search|look|show|summari[sz]e|summary|recap|check|read|list|tell|what|when|who|whom|which|where|did|does|has|have|is|are|was|were|any|latest|last|recent|how)\b/i;

/** "Did Hardik reply?" and "has it been sent?" ask what happened, not for it to happen. */
const ASKS_WHAT_HAPPENED = /^\s*(?:did|has|have|had|was|were|is|are|when|who|what|which)\b/i;

/**
 * True when Vishnu asked for something to be looked up and did not ask for
 * this action. A go-ahead such as "yes, do it" is not a lookup, so the check
 * stays strict for it.
 */
export function askedOnlyToLook(ownerText: string, action: ClaimAction): boolean {
  const text = ownerText.trim();
  if (!text || !ASKS_TO_LOOK.test(text)) {
    return false;
  }
  if (!ASKED_FOR[action].test(text)) {
    return true;
  }
  if (!ASKS_WHAT_HAPPENED.test(text)) {
    return false;
  }
  // A question about the past, unless something after it asks for the action.
  const rest = text.split(/[?.!,;\n]/).slice(1).join(" ");
  return !ASKED_FOR[action].test(rest);
}

/** Words Aadi is quoting from what it read are not Aadi's own. */
function withoutQuoted(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    .replace(/"[^"\n]*"|“[^”\n]*”/g, " ");
}

function claimsItself(reply: string, action: ClaimAction): boolean {
  const own = ownClaim(action);
  return sentences(withoutQuoted(reply)).some(
    (sentence) => !NEGATION.test(sentence) && own.test(sentence),
  );
}

/**
 * Actions the reply claims that no tool did.
 *
 * With `context`, a reply that only describes what was read is let through:
 * "Hardik's email was sent on Monday" after a mail search is a summary, not a
 * claim that Aadi sent anything. That holds only when Vishnu asked to look
 * something up and not for this action, a read tool succeeded this turn, no
 * tool that could have done the action was even tried, and the reply doesn't
 * say Aadi did it ("I sent"). Live-lookup claims ("searched") are never relaxed.
 */
export function unreceiptedClaims(
  reply: string,
  receipts: readonly ToolReceipt[],
  context: ClaimContext = {},
): ClaimAction[] {
  const claimed = detectClaimedActions(reply);
  if (claimed.length === 0) {
    return [];
  }
  const ok = new Set(
    receipts.filter((row) => row.success).map((row) => row.name),
  );
  const missing = claimed.filter((action) => {
    for (const name of TOOLS_FOR[action]) {
      if (ok.has(name)) {
        return false;
      }
    }
    return true;
  });
  const { ownerText, isReadTool } = context;
  if (missing.length === 0 || !ownerText || !isReadTool) {
    return missing;
  }
  if (!receipts.some((row) => row.success && isReadTool(row.name))) {
    return missing;
  }
  return missing.filter(
    (action) =>
      action === "searched" ||
      receipts.some((row) => TOOLS_FOR[action].has(row.name)) ||
      !askedOnlyToLook(ownerText, action) ||
      claimsItself(reply, action),
  );
}

export function receiptRetryPrompt(actions: readonly ClaimAction[]): string {
  if (actions.includes("searched")) {
    return "You stated a current fact as if you searched, but no search provider returned results this turn. Call web_search now, or say plainly you could not search. Do not invent news, prices or sources.";
  }
  return `You claimed ${actions.join(", ")} but no tool did it. Do it now, or say plainly it didn't happen.`;
}

export function receiptFailureMessage(actions: readonly ClaimAction[]): string {
  if (actions.includes("searched") && actions.length === 1) {
    return "I couldn't search: no provider returned results, so I won't present that as a live lookup.";
  }
  return `I couldn't do that: no tool confirmed ${actions.join(", ")}.`;
}
