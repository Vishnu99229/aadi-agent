import { deleteSetting, getSetting, setSetting } from "./db.js";
import { applyIgnore, confirmationForIgnore, type IgnoreCandidate } from "./ignore.js";

/**
 * Aadi's own latest "which one should I ignore?" question, and the exact list it
 * showed. His next message is read as the answer: "all of them" ignores every
 * item shown, "the LinkedIn one" or "2" ignores that subset, and "no" or
 * "cancel" ignores nothing. The question binds once: the next message of his
 * consumes it whatever it says, and it expires. Only his own typed or voice
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
  const pending: PendingIgnoreQuestion = { askedAt: now, expiresAt: now + PENDING_IGNORE_TTL_MS, instruction, candidates };
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

export type IgnoreAnswer = { kind: "all" } | { kind: "some"; indexes: number[] } | { kind: "cancel" } | { kind: "unrelated" };

/** Checked first: any of these, anywhere, means ignore nothing. Never a bulk ignore. */
const CANCEL =
  /^\s*(?:no|nope|nah|none|neither|cancel|never\s*mind|nvm|forget\s+it|leave\s+(?:it|them|those)|not\s+now)\b|\b(?:don'?t|dont|do\s+not|not|none|nothing|neither|cancel)\b/i;
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

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** How his answer maps onto the shown list. Anything with words that name nothing shown is unrelated. */
export function parseIgnoreAnswer(text: string, candidates: readonly IgnoreCandidate[]): IgnoreAnswer {
  const clean = text.trim();
  if (!clean) {
    return { kind: "unrelated" };
  }
  if (CANCEL.test(clean)) {
    return { kind: "cancel" };
  }
  const tokens = words(clean);
  if (tokens.length > 12) {
    return { kind: "unrelated" };
  }
  const vocabulary = new Set(candidates.flatMap((candidate) => words(candidate.names)));
  const indexes = new Set<number>();
  let sawAll = false;
  let named = false;
  // "id 36" / "#36": the id printed on the shown line.
  for (const match of clean.matchAll(/(?:\bid\s*|#)(\d+)\b/gi)) {
    const id = match[1]!;
    candidates.forEach((candidate, index) => {
      if (candidate.input.entityId === id || new RegExp(`(?:\\(id ${id}\\)|#${id}\\b)`).test(candidate.label)) {
        indexes.add(index);
      }
    });
  }
  const withoutIds = clean.replace(/(?:\bid\s*|#)\d+\b/gi, " ");
  for (const token of words(withoutIds)) {
    if (ALL_WORDS.has(token)) {
      sawAll = true;
    } else if (FILLER.has(token) || vocabulary.has(token)) {
      named ||= vocabulary.has(token) && !FILLER.has(token);
    } else if (token in ORDINALS || /^\d+(?:st|nd|rd|th)?$/.test(token)) {
      const n = token in ORDINALS ? ORDINALS[token]! : Number.parseInt(token, 10);
      if (sawAll && n === candidates.length) {
        continue; // "all 7"
      }
      const index = n === -1 ? candidates.length - 1 : n - 1;
      if (index < 0 || index >= candidates.length) {
        return { kind: "unrelated" };
      }
      indexes.add(index);
    } else {
      // A word that names nothing shown: this message is about something else.
      return { kind: "unrelated" };
    }
  }
  if (named) {
    // "linkedin and facebook": each part picks the items carrying all of its names.
    for (const part of withoutIds.split(/\s*(?:,|&|\+|\band\b|\bor\b|\bplus\b)\s*/i)) {
      const names = words(part).filter((token) => vocabulary.has(token) && !FILLER.has(token) && !ALL_WORDS.has(token));
      if (names.length === 0) {
        continue;
      }
      const hits = candidates
        .map((candidate, index) => ({ index, own: new Set(words(candidate.names)) }))
        .filter((entry) => names.every((name) => entry.own.has(name)));
      for (const hit of hits.length > 0 ? hits : candidates.map((candidate, index) => ({ index, own: new Set(words(candidate.names)) })).filter((entry) => names.some((name) => entry.own.has(name)))) {
        indexes.add(hit.index);
      }
    }
  }
  if (indexes.size > 0) {
    return indexes.size === candidates.length ? { kind: "all" } : { kind: "some", indexes: [...indexes].sort((a, b) => a - b) };
  }
  return sawAll ? { kind: "all" } : { kind: "unrelated" };
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
 * open question is used up: it binds to this one message only.
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
    return { text: "OK, I won't ignore any of them. Nothing changed." };
  }
  const chosen = answer.kind === "all" ? pending.candidates : answer.indexes.map((index) => pending.candidates[index]!);
  return {
    text: ignoreCandidates(chosen, `${pending.instruction} → ${input.ownWords}`, `owner_chat:${input.chatId}:${input.messageId}`, pending.candidates.length),
  };
}

/** Ignores each chosen item once (several bills of one biller are one rule) and says what changed. */
export function ignoreCandidates(chosen: readonly IgnoreCandidate[], instruction: string, authRef: string, shownCount = chosen.length): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const candidate of chosen) {
    const rule = `${candidate.input.entityType}|${candidate.input.matchScope}|${candidate.input.matchKey}|${candidate.input.entityId ?? ""}`;
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
