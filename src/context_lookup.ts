import { assertTestSeam } from "./test_seam.js";
import { nameTokens } from "./command_logic.js";
import { namesFuzzyEqual } from "./contact_logic.js";
import { getRecentMessages, listCanonicalContacts, searchMemories, searchRelevantMessages } from "./db.js";
import { getGoogleAccount, type GoogleAccountId } from "./google/auth.js";
import { gmailClient } from "./google/mail.js";

/** Recent messages inspected for one reference. Older rows stay out of the prompt. */
export const CONTEXT_MESSAGE_SCAN = 40;
/** Gmail snippets attached to one lookup. */
export const GMAIL_SNIPPET_LIMIT = 5;
const CLIP = 180;

export interface ContextEvidence {
  source: string;
  text: string;
}

let evidenceForTests: ((query: string) => ContextEvidence[]) | undefined;
let stagedEvidence: ContextEvidence[] = [];

/** How long one turn may wait for Gmail evidence before it carries on without it. */
const EXTERNAL_LOOKUP_MS = 5000;

const HISTORY_CUE = /\b(?:remember|discussion|follow-?up|last week|same people|what happened|our conversation)\b/i;
const LOCAL_COMMAND =
  /\b(?:cancel|don'?t send|do not send|never send|stop|unschedule)\b|\b(?:mark|complete|finish|close|delete|snooze|tick off)\b[^.?!]{0,40}\b(?:task|reminder|bill)s?\b/i;

/**
 * Whether a message asks about past conversations. Only then is Gmail searched for
 * context, and only then is that context read. Cancellations and task updates stay
 * local even when they mention a follow-up, and draft edits use the draft itself.
 */
export function wantsHistoricalContext(text: string): boolean {
  return HISTORY_CUE.test(text) && !LOCAL_COMMAND.test(text);
}

/** Test stand-in for Gmail and Calendar evidence. Production searches those live, bounded. */
async function liveGmailSnippets(query: string): Promise<ContextEvidence[]> {
  // The names and topics he gave, not the words of the question ("remember", "discussion").
  const tokens = nameTokens(query).filter((token) => token.length >= 4 && !STOP.has(token)).slice(0, 4);
  if (tokens.length === 0) {
    return [];
  }
  const found: ContextEvidence[] = [];
  // "my personal email" searches only that mailbox.
  const only = namedAccount(query);
  for (const accountId of (only ? [only] : ["work", "personal"]) as GoogleAccountId[]) {
    if (found.length >= GMAIL_SNIPPET_LIMIT) {
      break;
    }
    try {
      const account = await getGoogleAccount(accountId);
      const listed = await gmailClient(account).users.messages.list({
        userId: "me",
        q: tokens.join(" "),
        maxResults: 3,
      });
      for (const message of listed.data.messages ?? []) {
        if (!message.id || found.length >= GMAIL_SNIPPET_LIMIT) {
          break;
        }
        const loaded = await gmailClient(account).users.messages.get({
          userId: "me",
          id: message.id,
          format: "metadata",
          metadataHeaders: ["From", "Subject"],
        });
        const headers = loaded.data.payload?.headers ?? [];
        const header = (name: string) =>
          headers.find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
        const snippet = (loaded.data.snippet ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
        found.push({
          source: `gmail:${accountId}`,
          text: `${header("Subject")} ${header("From")} ${snippet}`.trim(),
        });
      }
    } catch {
      continue;
    }
  }
  return found;
}

/**
 * Fills the next lookup with a few Gmail excerpts, only for a message that asks about the
 * past. A slow or failing Gmail never holds up the turn: it carries on with local context.
 * A test provider replaces the live search.
 */
export async function stageExternalContext(query: string): Promise<void> {
  stagedEvidence = [];
  if (!wantsHistoricalContext(query)) {
    return;
  }
  if (evidenceForTests) {
    stagedEvidence = evidenceForTests(query);
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    stagedEvidence = await Promise.race([
      liveGmailSnippets(query),
      new Promise<ContextEvidence[]>((resolve) => {
        timer = setTimeout(() => resolve([]), EXTERNAL_LOOKUP_MS);
      }),
    ]);
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(`Context lookup failed (${errorType}).`);
    stagedEvidence = [];
  } finally {
    clearTimeout(timer);
  }
}

export function setContextEvidenceForTests(
  provider: ((query: string) => ContextEvidence[]) | undefined,
): void {
  assertTestSeam("setContextEvidenceForTests");
  evidenceForTests = provider;
}

export type ContextLookup =
  | { kind: "none" }
  | { kind: "one"; summary: string }
  | { kind: "many"; question: string };

function clip(text: string, limit = CLIP): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

const STOP = new Set([
  "remember", "discussion", "conversation", "about", "with", "last", "week", "based",
  "draft", "follow", "what", "happened", "from", "that", "this", "have", "had",
  "the", "and", "for", "our", "please", "find", "meeting", "email", "mail", "your",
]);

interface RankedExcerpt {
  text: string;
  score: number;
  when: number;
  account?: "work" | "personal";
}

function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/\p{L}[\p{L}\p{N}]*/gu) ?? [];
}

function wordHit(word: string, token: string): boolean {
  if (word === token) {
    return true;
  }
  return token.length >= 6 && word.length >= 6 && namesFuzzyEqual(word, token);
}

function scoreExcerpt(text: string, tokens: readonly string[], names: ReadonlySet<string>): number {
  const words = wordsOf(text);
  let matched = 0;
  let score = 0;
  const hits: number[] = [];
  for (const token of tokens) {
    const at = words.findIndex((word) => wordHit(word, token));
    if (at < 0) {
      continue;
    }
    matched += 1;
    hits.push(at);
    score += words[at] === token ? 10 : 7;
    if (names.has(token) && words[at] === token) {
      score += 4;
    }
  }
  if (matched === 0) {
    return 0;
  }
  if (matched >= 2) {
    score += 8;
  }
  if (matched === tokens.length && tokens.length >= 2) {
    score += 8;
  }
  hits.sort((left, right) => left - right);
  for (let index = 1; index < hits.length; index += 1) {
    if (hits[index] === hits[index - 1]! + 1) {
      score += 12;
      break;
    }
  }
  return score;
}

function leftoverWords(text: string, tokens: readonly string[]): Set<string> {
  return new Set(
    wordsOf(text).filter((word) => word.length >= 4 && !STOP.has(word) && !tokens.some((token) => wordHit(word, token))),
  );
}

function sameTopic(left: string, right: string, tokens: readonly string[]): boolean {
  const a = leftoverWords(left, tokens);
  const b = leftoverWords(right, tokens);
  if (a.size < 2 || b.size < 2) {
    return false;
  }
  let shared = 0;
  for (const word of a) {
    if (b.has(word)) {
      shared += 1;
    }
  }
  return shared / (a.size + b.size - shared) >= 0.34;
}

function namedAccount(query: string): "work" | "personal" | undefined {
  if (/\bpersonal\b/i.test(query) && /\b(?:calendar|email|e-mail|mail|account|inbox)\b/i.test(query)) {
    return "personal";
  }
  if (/\bwork\b/i.test(query) && /\b(?:calendar|email|e-mail|mail|account|inbox)\b/i.test(query)) {
    return "work";
  }
  return undefined;
}

function accountOf(source: string): "work" | "personal" | undefined {
  if (source.includes("personal")) {
    return "personal";
  }
  if (source.includes("work")) {
    return "work";
  }
  return undefined;
}

/**
 * Rank memories, recent chat, and older chat together. A recent keyword does
 * not hide an older line that matches more of the request. This does not call
 * a model and does not authorize anything.
 */
export function retrieveRelevantContext(query: string): ContextLookup {
  const tokens = nameTokens(query).filter((token) => token.length >= 3 && !STOP.has(token));
  if (tokens.length === 0) {
    return { kind: "none" };
  }
  const names = new Set(
    (query.match(/\p{Lu}[\p{L}\p{N}]*/gu) ?? []).map((token) => token.toLowerCase()).filter((token) => tokens.includes(token)),
  );
  const account = namedAccount(query);
  const evidence = (stagedEvidence.length > 0 ? stagedEvidence : evidenceForTests?.(query) ?? [])
    .slice(0, GMAIL_SNIPPET_LIMIT)
    .filter((item) => !account || accountOf(item.source) === account);
  stagedEvidence = [];
  const seen = new Set<string>();
  const ranked: RankedExcerpt[] = [];
  const add = (text: string, when: number, sourceAccount?: "work" | "personal") => {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean || seen.has(clean)) {
      return;
    }
    const score = scoreExcerpt(clean, tokens, names);
    if (score <= 0) {
      return;
    }
    seen.add(clean);
    ranked.push({ text: clean, score, when, account: sourceAccount });
  };
  for (const memory of searchMemories(tokens.join(" "), 8)) {
    add(memory.content, Date.parse(memory.updated_at) || 0);
  }
  for (const message of getRecentMessages(CONTEXT_MESSAGE_SCAN)) {
    if (message.role !== "tool") {
      add(message.content, message.id);
    }
  }
  for (const message of searchRelevantMessages(tokens, 24)) {
    add(message.content, message.id);
  }
  for (const item of evidence) {
    add(item.text, 0, accountOf(item.source));
  }
  ranked.sort((left, right) => right.score - left.score || right.text.length - left.text.length || right.when - left.when);
  const best = ranked[0];
  const next = ranked[1];
  if (!best) {
    const contact = listCanonicalContacts().find((row) => {
      if (row.confirmed !== 1) {
        return false;
      }
      const hay = wordsOf(`${row.display_name} ${row.emails_json}`);
      return tokens.some((token) => hay.some((word) => wordHit(word, token)));
    });
    return contact ? { kind: "one", summary: clip(`${contact.display_name} ${contact.emails_json}`) } : { kind: "none" };
  }
  if (
    next &&
    next.score === best.score &&
    next.text !== best.text &&
    !sameTopic(best.text, next.text, tokens)
  ) {
    const options = ranked.filter((item) => item.score === best.score).slice(0, 3);
    return {
      kind: "many",
      question:
        "I found more than one match. Which one?\n" +
        options
          .map((item) => `- ${item.account ? `[${item.account}] ` : ""}${clip(item.text, 80)}`)
          .join("\n"),
    };
  }
  const label = best.account ? `[${best.account}] ` : "";
  return { kind: "one", summary: clip(`${label}${best.text}`, 400) };
}
