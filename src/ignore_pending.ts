import { deleteSetting, getSetting, setSetting } from "./db.js";
import {
  applyIgnore,
  confirmationForIgnore,
  ignoreInputCovers,
  negatesIgnore,
  NOTHING_IGNORED,
  type IgnoreCandidate,
} from "./ignore.js";

/**
 * Aadi's own latest "which one should I ignore?" question, and the exact list it
 * showed. His next message is read as the answer: "all of them" ignores every
 * item shown, "the LinkedIn one" or "2" ignores that subset, and "no" or
 * "cancel" ignores nothing. The question binds once: the next message of his
 * consumes it whatever it says (except a position that contradicts the name he
 * gave, which changes nothing and leaves it open), and it expires. Only his own typed or voice
 * words count (bot.ts never passes a forward, a retry or quoted text here).
 */
export const PENDING_IGNORE_TTL_MS = 30 * 60_000;

interface PendingIgnoreQuestion {
  askedAt: number;
  expiresAt: number;
  /** His words that led to the question, kept for the rule's audit trail. */
  instruction: string;
  candidates: IgnoreCandidate[];
}

const key = (chatId: number) => `ignore_pending_question:${chatId}`;

/** Saves the question Aadi is about to ask. A newer question replaces an older one. */
export function savePendingIgnoreQuestion(chatId: number, instruction: string, candidates: IgnoreCandidate[], now = Date.now()): void {
  if (candidates.length < 2) {
    return;
  }
  storePending(chatId, { askedAt: now, expiresAt: now + PENDING_IGNORE_TTL_MS, instruction, candidates });
}

function storePending(chatId: number, pending: PendingIgnoreQuestion): void {
  setSetting(key(chatId), JSON.stringify(pending));
}

export function clearPendingIgnoreQuestion(chatId: number): void {
  deleteSetting(key(chatId));
}

/** The open question, or undefined when there is none or it has expired (then it is cleared). */
export function pendingIgnoreQuestion(chatId: number, now = Date.now()): PendingIgnoreQuestion | undefined {
  const raw = getSetting(key(chatId));
  if (!raw) {
    return undefined;
  }
  try {
    const pending = JSON.parse(raw) as PendingIgnoreQuestion;
    if (!Array.isArray(pending.candidates) || !(pending.expiresAt > now)) {
      clearPendingIgnoreQuestion(chatId);
      return undefined;
    }
    return pending;
  } catch {
    clearPendingIgnoreQuestion(chatId);
    return undefined;
  }
}

// ---------------------------------------------------------------- reading the answer

export type IgnoreAnswer =
  | { kind: "all" }
  /** `excluded`: the items he explicitly left out ("all, not the LinkedIn one"). */
  | { kind: "some"; indexes: number[]; excluded?: number[] }
  | { kind: "cancel" }
  /** A position with a name the shown item doesn't carry ("the 6th Facebook one"): not an answer. */
  | { kind: "mismatch"; index: number }
  /** He left something out but the rest can't be read ("not the LinkedIn one" alone): ask again. */
  | { kind: "unclear" }
  | { kind: "unrelated" };

/**
 * An answer that picks none: "no", "none of them", "cancel", "never mind", a bare
 * "don't". A negated verb ("don't ignore them") is negatesIgnore, shared with
 * every other path.
 */
const ANSWER_CANCEL =
  /^\s*(?:no|nope|nah|none|neither|cancel|never\s*mind|nvm|forget\s+it|leave\s+(?:it|them|those)|not\s+now)\b|^\s*(?:don['\u2019]?t|do\s+not)\s*[.!]*\s*$|\b(?:none|nothing|neither|cancel)\b/i;
/** "all, not the LinkedIn one", "all except 1 and 2": what follows is left out. */
const EXCEPT = /\b(?:except(?:\s+for)?|but\s+not|other\s+than|apart\s+from|excluding|besides|but|not)\b/i;
const ALL_WORDS = new Set(["all", "every", "everything", "each", "both", "everyone"]);
/** Words that carry no choice: politeness, "ignore", "the one", "bills". */
const FILLER = new Set([
  "the", "a", "an", "one", "ones", "bill", "bills", "biller", "billers", "only", "just", "that", "those", "these", "this",
  "them", "it", "of", "and", "or", "for", "me", "too", "also", "please", "pls", "kindly", "ok", "okay", "yes", "yeah",
  "yep", "sure", "go", "ahead", "do", "can", "could", "would", "you", "i", "want", "to", "ignore", "ignoring", "my",
  "now", "going", "forward", "permanently", "thanks", "thank", "item", "items", "ones", "options", "option", "listed",
  "above", "shown", "reminder", "reminders", "task", "tasks", "follow", "ups", "up", "id",
  "stop", "tracking", "track", "skip", "mute", "dismiss",
]);
const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, last: -1,
};
/** "id 36" / "#36": the id printed on the shown line. */
const ID_RE = /(?:\bid\s*|#)(\d+)\b/gi;
/** "the 2nd and the LinkedIn one": each part picks on its own and the picks add up. */
const PARTS = /\s*(?:,|&|\+|\band\b|\bor\b|\bplus\b)\s*/i;

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** His words say to leave some of the shown items out. */
export function leavesSomeOut(text: string): boolean {
  return EXCEPT.test(text);
}

type Picked = { indexes: Set<number>; sawAll: boolean };

/**
 * The items one stretch of his answer names. Within one part, a position
 * ("the 6th", "id 36") picks the item and a name only narrows it: "the 6th
 * Google Play one" is the 6th, never every Google Play bill. A name alone picks
 * every item carrying it. A word that names nothing shown makes it unrelated.
 */
function pick(text: string, candidates: readonly IgnoreCandidate[]): Picked | { kind: "unrelated" } | { kind: "mismatch"; index: number } {
  const vocabulary = new Set(candidates.flatMap((candidate) => words(candidate.names)));
  const own = candidates.map((candidate) => new Set(words(candidate.names)));
  const indexes = new Set<number>();
  let sawAll = false;
  for (const part of text.split(PARTS)) {
    const positions = new Set<number>();
    const names: string[] = [];
    for (const match of part.matchAll(ID_RE)) {
      const id = match[1]!;
      candidates.forEach((candidate, index) => {
        if (candidate.input.entityId === id || new RegExp(`(?:\\(id ${id}\\)|#${id}\\b)`).test(candidate.label)) {
          positions.add(index);
        }
      });
    }
    for (const token of words(part.replace(ID_RE, " "))) {
      if (ALL_WORDS.has(token)) {
        sawAll = true;
      } else if (FILLER.has(token)) {
        continue;
      } else if (vocabulary.has(token)) {
        names.push(token);
      } else if (token in ORDINALS || /^\d+(?:st|nd|rd|th)?$/.test(token)) {
        const n = token in ORDINALS ? ORDINALS[token]! : Number.parseInt(token, 10);
        if (sawAll && n === candidates.length) {
          continue; // "all 7"
        }
        const index = n === -1 ? candidates.length - 1 : n - 1;
        if (index < 0 || index >= candidates.length) {
          return { kind: "unrelated" };
        }
        positions.add(index);
      } else {
        return { kind: "unrelated" };
      }
    }
    if (positions.size > 0) {
      for (const index of positions) {
        if (!names.every((name) => own[index]!.has(name))) {
          return { kind: "mismatch", index };
        }
        indexes.add(index);
      }
    } else if (names.length > 0) {
      // "linkedin and facebook": the items carrying all of a part's names, else any of them.
      const every = own.flatMap((set, index) => (names.every((name) => set.has(name)) ? [index] : []));
      const hits = every.length > 0 ? every : own.flatMap((set, index) => (names.some((name) => set.has(name)) ? [index] : []));
      for (const index of hits) {
        indexes.add(index);
      }
    }
  }
  return { indexes, sawAll };
}

/**
 * How his answer maps onto the shown list. "all, not the LinkedIn one" or "all
 * except 1 and 2" is everything picked before the exception minus what follows
 * it; if the exception can't be read, or there's nothing to leave it out of, it
 * asks again rather than guess.
 */
export function parseIgnoreAnswer(text: string, candidates: readonly IgnoreCandidate[]): IgnoreAnswer {
  const clean = text.trim();
  if (!clean) {
    return { kind: "unrelated" };
  }
  if (negatesIgnore(clean) || ANSWER_CANCEL.test(clean)) {
    return { kind: "cancel" };
  }
  if (words(clean).length > 12) {
    return { kind: "unrelated" };
  }
  const exception = EXCEPT.exec(clean);
  const included = pick(exception ? clean.slice(0, exception.index) : clean, candidates);
  if ("kind" in included) {
    return included;
  }
  const base = included.indexes.size > 0
    ? included.indexes
    : included.sawAll
      ? new Set(candidates.map((_, index) => index))
      : undefined;
  if (!exception) {
    if (!base) {
      return { kind: "unrelated" };
    }
    return base.size === candidates.length ? { kind: "all" } : { kind: "some", indexes: [...base].sort((a, b) => a - b) };
  }
  const left = pick(clean.slice(exception.index + exception[0].length), candidates);
  if (!base || "kind" in left || left.indexes.size === 0) {
    return { kind: "unclear" };
  }
  const kept = [...base].filter((index) => !left.indexes.has(index)).sort((a, b) => a - b);
  return kept.length === 0 ? { kind: "unclear" } : { kind: "some", indexes: kept, excluded: [...left.indexes].sort((a, b) => a - b) };
}

// ---------------------------------------------------------------- answering

export interface IgnoreAnswerInput {
  chatId: number;
  messageId: number;
  /** His own words, without any quoted text. */
  ownWords: string;
  /** Set when his message is a Telegram reply: it binds only if it replies to Aadi's question or later. */
  replyTo?: { fromBot: boolean; dateMs: number };
  now?: number;
}

/**
 * Reads his message as the answer to Aadi's open ignore question. Returns the
 * reply to send when it was one (applied or cancelled), or undefined when there
 * was no open question or the message was about something else. Either way an
 * open question is used up: it binds to this one message only. The exception is
 * a mismatch ("the 6th Facebook one" when the 6th isn't Facebook): nothing
 * changes and the same question stays open, unchanged, for the real answer.
 */
export function answerPendingIgnore(input: IgnoreAnswerInput): { text: string } | undefined {
  const now = input.now ?? Date.now();
  const pending = pendingIgnoreQuestion(input.chatId, now);
  if (!pending) {
    return undefined;
  }
  clearPendingIgnoreQuestion(input.chatId);
  // A reply to an older message, or to someone else's, is not an answer to this question.
  if (input.replyTo && (!input.replyTo.fromBot || input.replyTo.dateMs < pending.askedAt - 1_000)) {
    return undefined;
  }
  const answer = parseIgnoreAnswer(input.ownWords, pending.candidates);
  if (answer.kind === "unrelated") {
    return undefined;
  }
  if (answer.kind === "cancel") {
    return { text: NOTHING_IGNORED };
  }
  // Not an answer yet: say so, and keep the question open as it was for the real one.
  if (answer.kind === "mismatch") {
    storePending(input.chatId, pending);
    return {
      text:
        `Number ${answer.index + 1} on my list is ${pending.candidates[answer.index]!.label}, which isn't what you named. ` +
        "Nothing changed. Which one should I ignore?",
    };
  }
  if (answer.kind === "unclear") {
    storePending(input.chatId, pending);
    return { text: 'Nothing changed. Which ones should I ignore? Name them, give their numbers, or say "all except …".' };
  }
  const chosen = answer.kind === "all" ? pending.candidates : answer.indexes.map((index) => pending.candidates[index]!);
  const excluded = answer.kind === "some" ? (answer.excluded ?? []).map((index) => pending.candidates[index]!) : [];
  const result = ignoreChosen(chosen, pending.candidates, `${pending.instruction} → ${input.ownWords}`, `owner_chat:${input.chatId}:${input.messageId}`, excluded);
  if (!result.applied) {
    storePending(input.chatId, pending);
  }
  return { text: result.text };
}

/** The rule an item is ignored by: several bills of one biller share one. */
function ruleOf(candidate: IgnoreCandidate): string {
  const input = candidate.input;
  return `${input.entityType}|${input.matchScope}|${input.matchKey}|${input.entityId ?? ""}`;
}

/**
 * Shown items he didn't pick that a rule for one he did would also hide: an item
 * with a different rule (a "Google Play" rule hides "Google Play (LinkedIn ...)"),
 * or one he explicitly left out. Another bill of a picked biller is not spill:
 * ignoring is by biller, and it is the same rule.
 */
export function spillover(
  chosen: readonly IgnoreCandidate[],
  shown: readonly IgnoreCandidate[],
  excluded: readonly IgnoreCandidate[] = [],
): IgnoreCandidate[] {
  const picked = new Set(chosen.map(ruleOf));
  const leftOut = new Set(excluded.map((item) => item.label));
  return shown.filter(
    (other) =>
      !chosen.some((item) => item.label === other.label) &&
      (leftOut.has(other.label) || !picked.has(ruleOf(other))) &&
      chosen.some((item) => ignoreInputCovers(item.input, other)),
  );
}

/**
 * Ignores exactly the chosen shown items. When a rule for one of them would also
 * hide an item he didn't pick (a "Google Play" rule hides "Google Play (LinkedIn
 * ...)" too), nothing changes and it says why.
 */
export function ignoreChosen(
  chosen: readonly IgnoreCandidate[],
  shown: readonly IgnoreCandidate[],
  instruction: string,
  authRef: string,
  excluded: readonly IgnoreCandidate[] = [],
): { text: string; applied: boolean } {
  const spill = spillover(chosen, shown, excluded);
  if (spill.length > 0) {
    const wide = [...new Set(chosen.filter((item) => spill.some((other) => ignoreInputCovers(item.input, other))).map((item) => item.confirmLabel))];
    return {
      applied: false,
      text:
        `Ignoring ${wide.join(" and ")} would also hide ${spill.length === 1 ? "this one" : `these ${spill.length}`} on the list:\n` +
        spill.map((other) => `- ${other.label}`).join("\n") +
        `\nNothing changed. Say "all of them" to ignore all ${shown.length}, or pick others.`,
    };
  }
  return { applied: true, text: ignoreCandidates(chosen, instruction, authRef, shown.length) };
}

/** Ignores each chosen item once (several bills of one biller are one rule) and says what changed. */
export function ignoreCandidates(chosen: readonly IgnoreCandidate[], instruction: string, authRef: string, shownCount = chosen.length): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const candidate of chosen) {
    const rule = ruleOf(candidate);
    if (seen.has(rule)) {
      continue;
    }
    seen.add(rule);
    const result = applyIgnore({ ...candidate.input, instruction: instruction.slice(0, 500), authRef });
    console.log(`Ignore rule ${result.rule.id}: ${result.duplicate ? "duplicate" : "created"} ${result.rule.entity_type}/${result.rule.match_key}`);
    lines.push(confirmationForIgnore(result, candidate.confirmLabel));
  }
  return lines.length === 1 ? lines[0]! : `Ignoring ${chosen.length} of the ${shownCount} shown:\n${lines.map((line) => `- ${line}`).join("\n")}`;
}
