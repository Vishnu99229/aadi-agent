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
  ]),
  booked: new Set(["create_meeting"]),
  created: new Set([
    "create_meeting",
    "add_task",
    "add_account",
    "add_date",
    "draft_reply",
    "draft_new_email",
    "draft_mom",
    "propose_calendar_event",
  ]),
  scheduled: new Set([
    "create_meeting",
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
  invited: new Set(["add_calendar_attendee", "create_meeting"]),
  deleted: new Set([
    "delete_calendar_event",
    "delete_task",
    "forget_memory",
    "remove_account",
    "remove_date",
  ]),
  updated: new Set(["update_draft", "update_memory", "update_account"]),
  answered: new Set(["search_qa_bank", "learn_qa_bank"]),
  completed: new Set(["complete_task"]),
  searched: new Set(["web_search"]),
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

export function unreceiptedClaims(
  reply: string,
  receipts: readonly ToolReceipt[],
): ClaimAction[] {
  const claimed = detectClaimedActions(reply);
  if (claimed.length === 0) {
    return [];
  }
  const ok = new Set(
    receipts.filter((row) => row.success).map((row) => row.name),
  );
  return claimed.filter((action) => {
    for (const name of TOOLS_FOR[action]) {
      if (ok.has(name)) {
        return false;
      }
    }
    return true;
  });
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
