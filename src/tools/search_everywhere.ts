import type { LlmTool } from "../llm.js";
import { config } from "../config.js";
import { redactAllSecrets } from "../chat_history.js";
import { listDocuments, searchMemories, searchNotes, searchRelevantMessages } from "../db.js";
import { scoreHistory, SEARCH_HISTORY_MIN_SCORE, type HistoryHit } from "../embeddings.js";
import { searchDriveFiles, type DriveSearchHit } from "../google/drive.js";
import { assertTestSeam } from "../test_seam.js";
import { handler as searchEmails } from "./search_emails.js";
import type { ToolTurn } from "./index.js";

/**
 * One lookup across everything Vishnu keeps: saved notes, past chat, long-term
 * memories, uploaded documents, Drive file names and Gmail (both accounts).
 * Read-only. Every source runs in parallel with its own timeout, and a source
 * that fails is listed as failed rather than failing the lookup. Every string
 * in the answer is redacted, so no OTP, password or card number comes back.
 */
export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "search_everywhere",
  description:
    'Look something up everywhere at once: saved notes, past chat, long-term memories, uploaded documents, Google Drive file names and Gmail (both accounts). Call it first for "find my notes on X", "what did <person> say about X" and "where is the X doc". Returns, per source, how many matched and up to 3 hits, then which sources were checked and which failed. Read-only.',
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: 'What to look for, in a few words, without the person\'s name: "pricing", "Shriram BRD".',
      },
      person: {
        type: "string",
        description: 'Optional: who it is from or about, as Vishnu named them: "Munil".',
      },
    },
    required: ["query"],
  },
};

export const SEARCH_EVERYWHERE_SOURCE_TIMEOUT_MS = 10_000;
export const SEARCH_EVERYWHERE_MAX_CHARS = 3_000;
const SNIPPET_CHARS = 200;
const GMAIL_MAX_PER_ACCOUNT = 10;

export interface EmailHit {
  account?: string;
  from?: string;
  to?: string;
  subject?: string;
  date?: string;
  snippet?: string;
}

interface Hit {
  title: string;
  date?: string;
  who?: string;
  snippet?: string;
}

interface SourceResult {
  count: number;
  /** "20+" when a provider cap was reached. */
  countText?: string;
  hits: Hit[];
  /** True when nothing matched every word and the hits match only some. */
  partial?: boolean;
  note?: string;
}

type SourceName = "Notes" | "Chat history" | "Memories" | "Documents" | "Drive" | "Gmail";
const SOURCES: readonly SourceName[] = ["Notes", "Chat history", "Memories", "Documents", "Drive", "Gmail"];

interface Seams {
  gmail?: (query: string) => Promise<EmailHit[]>;
  drive?: (query: string) => Promise<DriveSearchHit[]>;
  semanticHistory?: (query: string) => Promise<HistoryHit[]>;
  timeoutMs?: number;
}
let seams: Seams = {};

/** Replaces the networked sources (Gmail, Drive, meaning search) and the timeout. */
export function setSearchEverywhereForTests(next: Seams | undefined): void {
  assertTestSeam("setSearchEverywhereForTests");
  seams = next ?? {};
}

// ---------------------------------------------------------------- redaction

/** What redactAllSecrets leaves: "your OTP is 482913", "verification code 551204", "PIN is 4821". */
function redactCodes(text: string): string {
  return text
    .replace(/\b(otp|code|pin|passcode|security code|verification(?: code)?|login code)\b([^\d\n]{0,20})\d{4,8}\b/gi, "$1$2[redacted]")
    .replace(/\b\d{4,8}\b(?=[^.\n]{0,40}\b(?:code|pin|verify|verification)\b)/gi, "[redacted]");
}

export function redactForLookup(text: string): string {
  return redactCodes(redactAllSecrets(text));
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// ---------------------------------------------------------------- matching

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "about", "from", "that", "this", "what", "did", "say", "said", "my", "on", "of", "to", "in",
  "find", "notes", "note", "where", "is", "are", "was", "any", "all", "our", "his", "her", "their", "can", "you",
]);

function wordsOf(text: string): string[] {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => word.length >= 2 && !STOP_WORDS.has(word));
  return [...new Set(words)].slice(0, 6);
}

function matchedWords(text: string, words: readonly string[]): string[] {
  const lower = text.toLowerCase();
  return words.filter((word) => new RegExp(`(?<![\\p{L}\\p{N}])${word}`, "iu").test(lower));
}

/** Items matching every word, or else those matching the most words, marked partial. */
function rank<T>(items: readonly T[], textOf: (item: T) => string, words: readonly string[]): { items: T[]; partial: boolean } {
  if (words.length === 0) {
    return { items: [], partial: false };
  }
  const scored = items.map((item) => ({ item, score: matchedWords(textOf(item), words).length })).filter((entry) => entry.score > 0);
  if (scored.length === 0) {
    return { items: [], partial: false };
  }
  const best = Math.max(...scored.map((entry) => entry.score));
  return { items: scored.filter((entry) => entry.score === best).map((entry) => entry.item), partial: best < words.length };
}

/** The part of the text around the first matched word. */
function around(text: string, words: readonly string[], max = SNIPPET_CHARS): string {
  const lower = text.toLowerCase();
  const at = words.map((word) => lower.indexOf(word)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, at - 60);
  return `${start > 0 ? "…" : ""}${clip(text.slice(start), max)}`;
}

function counted(items: number, partial: boolean): Pick<SourceResult, "count" | "partial"> {
  return partial ? { count: 0, partial: true } : { count: items, partial: false };
}

// ---------------------------------------------------------------- sources

function notesSource(words: readonly string[]): SourceResult {
  const seen = new Map<number, ReturnType<typeof searchNotes>[number]>();
  for (const word of words.slice(0, 4)) {
    for (const note of searchNotes(word)) {
      seen.set(note.id, note);
    }
  }
  const ranked = rank([...seen.values()], (note) => `${note.title} ${note.people} ${note.content}`, words);
  return {
    ...counted(ranked.items.length, ranked.partial),
    hits: ranked.items.slice(0, 3).map((note) => ({
      title: note.title,
      date: note.created_at,
      who: note.people || undefined,
      snippet: around(note.content, words),
    })),
  };
}

const NEGATIVE_LOOKUP = /\b(?:couldn['’]t|could not|didn['’]t|did not|no)\b[^.\n]{0,40}\b(?:find|found|match(?:es|ing)?)\b/i;

async function historySource(query: string, words: readonly string[], ownQuestion: string): Promise<SourceResult> {
  const own = ownQuestion.trim().toLowerCase();
  const keyword = searchRelevantMessages(words, 24).filter(
    // His own question, and Aadi's earlier "couldn't find it", are not what he's looking for.
    (row) => row.content.trim().toLowerCase() !== own && !NEGATIVE_LOOKUP.test(row.content),
  );
  const ranked = rank(keyword, (row) => row.content, words);
  let semantic: HistoryHit[] = [];
  let note: string | undefined;
  const meaning = seams.semanticHistory ?? (config.geminiApiKey ? (text: string) => scoreHistory(text, 8) : undefined);
  if (meaning) {
    try {
      semantic = (await meaning(query)).filter((hit) => hit.score >= SEARCH_HISTORY_MIN_SCORE && !NEGATIVE_LOOKUP.test(hit.snippet));
    } catch {
      note = "search by meaning failed; words only";
    }
  } else {
    note = "words only (no embedding key)";
  }
  const keywordHits: Hit[] = ranked.partial
    ? []
    : ranked.items.map((row) => ({ title: "chat", date: row.created_at, snippet: around(row.content, words) }));
  const semanticHits: Hit[] = semantic
    .filter((hit) => !keywordHits.some((existing) => existing.snippet?.includes(hit.snippet.slice(0, 40))))
    .map((hit) => ({ title: "chat", date: hit.createdAt, who: hit.role === "user" ? "you" : "Aadi", snippet: clip(hit.snippet, SNIPPET_CHARS) }));
  const hits = [...keywordHits, ...semanticHits];
  if (hits.length === 0 && ranked.partial) {
    return {
      count: 0,
      partial: true,
      hits: ranked.items.slice(0, 3).map((row) => ({ title: "chat", date: row.created_at, snippet: around(row.content, words) })),
      ...(note ? { note } : {}),
    };
  }
  return { count: hits.length, hits: hits.slice(0, 3), ...(note ? { note } : {}) };
}

function memoriesSource(words: readonly string[]): SourceResult {
  const ranked = rank(searchMemories(words.join(" "), 20), (memory) => memory.content, words);
  return {
    ...counted(ranked.items.length, ranked.partial),
    hits: ranked.items.slice(0, 3).map((memory) => ({
      title: `${memory.category} memory`,
      date: memory.event_date ?? memory.updated_at,
      snippet: clip(memory.content, SNIPPET_CHARS),
    })),
  };
}

function documentsSource(words: readonly string[]): SourceResult {
  const ranked = rank(listDocuments(200), (doc) => `${doc.file_name} ${doc.extracted_text}`, words);
  return {
    ...counted(ranked.items.length, ranked.partial),
    hits: ranked.items.slice(0, 3).map((doc) => ({
      title: `${doc.file_name} (document #${doc.id})`,
      date: doc.created_at,
      snippet: around(doc.extracted_text, words),
    })),
    note: "uploads are kept 7 days",
  };
}

async function driveSource(query: string, words: readonly string[]): Promise<SourceResult> {
  const search = seams.drive ?? ((text: string) => searchDriveFiles(text, 5));
  let files = await search(query);
  if (files.length === 0 && words.length > 1) {
    // Drive matches file names only: try the words one by one.
    const byWord = await Promise.all(words.slice(0, 3).map((word) => search(word)));
    files = [...new Map(byWord.flat().map((file) => [file.id || file.name, file])).values()];
  }
  const ranked = rank(files, (file) => file.name, words);
  return {
    ...counted(ranked.items.length, ranked.partial),
    hits: ranked.items.slice(0, 3).map((file) => ({ title: file.name, date: file.modifiedTime, snippet: file.webViewLink || undefined })),
    note: "file names only",
  };
}

async function gmailSearch(query: string): Promise<EmailHit[]> {
  if (seams.gmail) {
    return seams.gmail(query);
  }
  // No turn: a name that matches several people is searched as written, never asked about here.
  const text = await searchEmails({ query, max_results: GMAIL_MAX_PER_ACCOUNT });
  if (!text.trim().startsWith("[")) {
    return [];
  }
  return JSON.parse(text) as EmailHit[];
}

function threadOf(subject: string | undefined): string {
  return (subject ?? "(no subject)").replace(/^(?:\s*(?:re|fwd?|fw)\s*:\s*)+/i, "").trim() || "(no subject)";
}

function threads(emails: readonly EmailHit[]): Array<{ subject: string; messages: EmailHit[] }> {
  const grouped = new Map<string, EmailHit[]>();
  for (const email of emails) {
    const key = threadOf(email.subject);
    grouped.set(key, [...(grouped.get(key) ?? []), email]);
  }
  return [...grouped.entries()].map(([subject, messages]) => ({ subject, messages })).sort((a, b) => b.messages.length - a.messages.length);
}

function capped(emails: readonly EmailHit[]): boolean {
  const perAccount = new Map<string, number>();
  for (const email of emails) {
    perAccount.set(email.account ?? "", (perAccount.get(email.account ?? "") ?? 0) + 1);
  }
  return [...perAccount.values()].some((count) => count >= GMAIL_MAX_PER_ACCOUNT);
}

function messages(emails: readonly EmailHit[]): string {
  return `${emails.length}${capped(emails) ? "+" : ""} message${emails.length === 1 ? "" : "s"}`;
}

async function gmailSource(query: string, person: string | undefined): Promise<SourceResult> {
  const who = person ? (/\s/.test(person) ? `"${person}"` : person) : "";
  const attempts = person ? [`from:${who} ${query}`, `to:${who} ${query}`, query] : [query];
  let emails: EmailHit[] = [];
  const tried: string[] = [];
  for (const attempt of attempts) {
    tried.push(attempt);
    emails = await gmailSearch(attempt);
    if (emails.length > 0) {
      break;
    }
  }
  const used = tried.at(-1)!;
  const list = tried.map((attempt) => `"${attempt}"`).join(", then ");
  let note = person ? (emails.length > 0 ? `tried ${list}; matched by "${used}"` : `tried ${list}: none matched`) : undefined;
  if (person && used !== attempts[0]) {
    // He didn't say it in mail. The closest thing: every thread with that person, and whether they replied.
    const [fromThem, toThem] = await Promise.all([gmailSearch(`from:${who}`), gmailSearch(`to:${who}`)]);
    const withThem = threads([...fromThem, ...toThem]);
    const closest =
      withThem.length === 0
        ? `no mail from or to ${person} at all`
        : `${withThem.length === 1 ? "the only thread" : `${withThem.length} threads`} with ${person}: ${withThem
            .slice(0, 2)
            .map((thread) => `"${thread.subject}"`)
            .join(", ")}; ${messages(toThem)} to ${person}, ${messages(fromThem)} from ${person}${fromThem.length === 0 ? " (no reply from them)" : ""}`;
    note = `${note}. Closest: ${closest}`;
  }
  const grouped = threads(emails);
  return {
    count: emails.length,
    ...(capped(emails) ? { countText: `${emails.length}+` } : {}),
    hits: grouped.slice(0, 3).map((thread) => {
      const latest = thread.messages[0]!;
      return {
        title: `${thread.subject}${thread.messages.length > 1 ? ` (${thread.messages.length} messages)` : ""}`,
        date: latest.date,
        who: latest.from,
        snippet: clip(latest.snippet ?? "", SNIPPET_CHARS),
      };
    }),
    ...(note ? { note } : {}),
  };
}

// ---------------------------------------------------------------- the lookup

async function withTimeout<T>(run: () => Promise<T> | T, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(run),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000} s`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function render(
  header: string,
  results: Array<{ name: SourceName; result?: SourceResult; error?: string }>,
  snippetChars: number,
  hitsPerSource: number,
): string {
  const lines = [header];
  const ok = results.filter((entry) => entry.result);
  const failed = results.filter((entry) => entry.error);
  lines.push(`Sources checked: ${ok.map((entry) => entry.name).join(", ") || "none"}`);
  lines.push(`Sources that failed: ${failed.map((entry) => `${entry.name} (${entry.error})`).join(", ") || "none"}`);
  // Full matches first, then partial ones and closest finds, then empty sources, so a cap drops the least useful.
  const weight = (r: SourceResult): number => (r.count > 0 ? 2 : r.hits.length > 0 || /Closest:/.test(r.note ?? "") ? 1 : 0);
  const ordered = [...ok].sort((a, b) => weight(b.result!) - weight(a.result!));
  for (const { name, result } of ordered) {
    const r = result!;
    const count = r.partial ? `0 full matches; closest partly match` : `${r.countText ?? r.count} match${r.count === 1 ? "" : "es"}`;
    lines.push("", `${name}: ${count}${r.note ? ` (${r.note})` : ""}`);
    for (const hit of r.hits.slice(0, hitsPerSource)) {
      const meta = [hit.date ? clip(hit.date, 31) : "", hit.who ? clip(hit.who, 60) : ""].filter(Boolean).join(" · ");
      lines.push(`- ${clip(hit.title, 110)}${meta ? ` [${meta}]` : ""}`);
      if (hit.snippet && snippetChars > 0) {
        lines.push(`  ${clip(hit.snippet, snippetChars)}`);
      }
    }
  }
  return lines.join("\n");
}

export async function handler(input: unknown, turn?: ToolTurn): Promise<string> {
  const values = input as { query?: unknown; person?: unknown };
  const query = typeof values.query === "string" ? values.query.trim() : "";
  if (!query) {
    throw new Error("query must be a non-empty string.");
  }
  const person = typeof values.person === "string" && values.person.trim() ? values.person.trim() : undefined;
  const words = wordsOf(query);
  const withPerson = person ? [...new Set([...wordsOf(person), ...words])] : words;
  const timeoutMs = seams.timeoutMs ?? SEARCH_EVERYWHERE_SOURCE_TIMEOUT_MS;
  const runs: Record<SourceName, () => Promise<SourceResult> | SourceResult> = {
    Notes: () => notesSource(withPerson),
    "Chat history": () => historySource(person ? `${person} ${query}` : query, withPerson, turn?.userText ?? ""),
    Memories: () => memoriesSource(withPerson),
    Documents: () => documentsSource(words),
    Drive: () => driveSource(query, words),
    Gmail: () => gmailSource(query, person),
  };
  const results = await Promise.all(
    SOURCES.map(async (name) => {
      try {
        return { name, result: await withTimeout(runs[name], timeoutMs) };
      } catch (error) {
        return { name, error: error instanceof Error && /timed out/.test(error.message) ? error.message : "failed" };
      }
    }),
  );
  const header = `Looked up "${query}"${person ? ` with ${person}` : ""}.`;
  let text = "";
  for (const [snippetChars, hitsPerSource] of [[SNIPPET_CHARS, 3], [120, 3], [80, 2], [0, 2]] as const) {
    text = redactForLookup(render(header, results, snippetChars, hitsPerSource));
    if (text.length <= SEARCH_EVERYWHERE_MAX_CHARS) {
      break;
    }
  }
  return text.length > SEARCH_EVERYWHERE_MAX_CHARS ? `${text.slice(0, SEARCH_EVERYWHERE_MAX_CHARS - 1)}…` : text;
}
