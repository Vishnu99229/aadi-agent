import { config } from "./config.js";
import {
  HISTORY_KEEP_MAX,
  TOOL_STUB_MIN_CHARS,
  estimateTokens,
  redactAllSecrets,
} from "./chat_history.js";
import {
  insertMessageEmbedding,
  listMessagesAwaitingEmbedding,
  listSearchableEmbeddings,
  getSetting,
  setSetting,
  type AwaitingEmbedMessage,
} from "./db.js";
import { everyMs, type IntervalJob } from "./scheduler.js";
import { logLlmUsage } from "./usage.js";
import { assertTestSeam } from "./test_seam.js";
import { kolkataDateKey } from "./web_search.js";

export const EMBED_MODEL = "gemini-embedding-2";
export const EMBED_DIMS = 768;
/** Stored on every row. Search compares model and scheme together. */
export const EMBED_SCHEME = "gemini-embedding-2/768/doc-prefix-v1";
export const EMBED_MIN_CHARS = 15;
export { HISTORY_KEEP_MAX };
export const EMBED_BATCH_LIMIT = 16;
export const EMBED_SCAN_LIMIT = 500;
export const EMBED_INTERVAL_MS = 5 * 60 * 1000;
/** Paid-tier text price. https://ai.google.dev/gemini-api/docs/pricing */
export const EMBED_TEXT_USD_PER_MILLION = 0.2;
/**
 * Phone probes: unrelated tops were cricket 0.630, biryani 0.604, Delhi
 * weather 0.580. A real YouTube-bill query scored 0.876 and 0.790, then
 * 0.686. 0.72 sits above that unrelated cluster and the 0.686 neighbor.
 */
export const SEARCH_HISTORY_MIN_SCORE = 0.68;
export const SEARCH_HISTORY_DEFAULT_LIMIT = 8;
export const SEARCH_HISTORY_MAX_LIMIT = 20;
export const SEARCH_HISTORY_NO_MATCH = "No matching past conversation found";

const EMBED_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:batchEmbedContents";
const TOKEN_SETTING_PREFIX = "embed_tokens:";

export function documentEmbedText(redacted: string): string {
  return `title: none | text: ${redacted}`;
}

export function queryEmbedText(query: string): string {
  return `task: search result | query: ${query}`;
}

/** Redact, then cap. This is the only text that may be embedded. */
export function redactForEmbed(content: string): string {
  return redactAllSecrets(content).slice(0, TOOL_STUB_MIN_CHARS);
}

export function floatsToBlob(values: readonly number[]): Buffer {
  const buf = Buffer.allocUnsafe(values.length * 4);
  for (let i = 0; i < values.length; i += 1) {
    buf.writeFloatLE(values[i]!, i * 4);
  }
  return buf;
}

export function blobToFloats(blob: Buffer): number[] {
  const count = Math.floor(blob.length / 4);
  const out = new Array<number>(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = blob.readFloatLE(i * 4);
  }
  return out;
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / Math.sqrt(na * nb);
}

function kolkataStamp(createdAt: string): string {
  const iso = createdAt.includes("T") ? createdAt : `${createdAt.replace(" ", "T")}Z`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return createdAt;
  }
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export interface HistoryHit {
  score: number;
  role: string;
  createdAt: string;
  snippet: string;
}

/** Scores stored rows. Does not write. Excludes the newest kept history rows. */
export async function scoreHistory(query: string, limit: number): Promise<HistoryHit[]> {
  const redacted = redactForEmbed(query.trim());
  if (!redacted || (!config.geminiApiKey && !batchEmbedForTests)) {
    return [];
  }
  const batch = await batchEmbed([queryEmbedText(redacted)]);
  const queryVector = batch.vectors[0];
  if (!queryVector) {
    return [];
  }
  const rows = listSearchableEmbeddings(EMBED_MODEL, EMBED_SCHEME, HISTORY_KEEP_MAX);
  const ranked = rows
    .map((row) => ({
      score: cosine(queryVector, blobToFloats(row.vector)),
      role: row.role,
      createdAt: row.created_at,
      snippet: redactForEmbed(row.content),
    }))
    .filter((hit) => hit.snippet.length > 0)
    .sort((a, b) => b.score - a.score);
  return ranked.slice(0, Math.max(0, limit));
}

export async function searchHistory(query: string, limit: number): Promise<string> {
  const hits = await scoreHistory(query, limit);
  const matched = hits.filter((hit) => hit.score >= SEARCH_HISTORY_MIN_SCORE);
  console.log(
    `search_history: status=${matched.length > 0 ? "ok" : "no_match"} hits=${matched.length}`,
  );
  if (matched.length === 0) {
    return SEARCH_HISTORY_NO_MATCH;
  }
  return matched
    .map((hit) => `${kolkataStamp(hit.createdAt)} · ${hit.role}\n${hit.snippet}`)
    .join("\n\n");
}

export interface MessageEmbedResult {
  embedded: number;
  skippedShort: number;
  tokens: number;
  status: "ok" | "no_key" | "daily_cap" | "http";
  httpStatus?: number;
  ms: number;
}

function tokensUsedToday(now: Date): number {
  const raw = Number(getSetting(`${TOKEN_SETTING_PREFIX}${kolkataDateKey(now)}`) ?? "0");
  if (!Number.isFinite(raw) || raw <= 0) {
    return 0;
  }
  return Math.floor(raw);
}

function addTokensToday(now: Date, tokens: number): void {
  const next = tokensUsedToday(now) + Math.max(0, Math.floor(tokens));
  setSetting(`${TOKEN_SETTING_PREFIX}${kolkataDateKey(now)}`, String(next));
}

function markSkipped(row: AwaitingEmbedMessage): void {
  insertMessageEmbedding({
    messageId: row.id,
    createdAt: row.created_at,
    model: EMBED_MODEL,
    scheme: EMBED_SCHEME,
    dims: EMBED_DIMS,
    vector: null,
    skipReason: "short",
  });
}

interface EmbedBatch {
  vectors: number[][];
  tokens: number;
}

type BatchEmbedFn = (texts: readonly string[]) => Promise<EmbedBatch>;
let batchEmbedForTests: BatchEmbedFn | undefined;

export function setBatchEmbedForTests(fn: BatchEmbedFn | undefined): void {
  assertTestSeam("setBatchEmbedForTests");
  batchEmbedForTests = fn;
}

async function batchEmbed(texts: readonly string[]): Promise<EmbedBatch> {
  if (batchEmbedForTests) {
    return batchEmbedForTests(texts);
  }
  const response = await fetch(EMBED_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": config.geminiApiKey,
    },
    body: JSON.stringify({
      requests: texts.map((text) => ({
        model: `models/${EMBED_MODEL}`,
        content: { parts: [{ text }] },
        output_dimensionality: EMBED_DIMS,
      })),
    }),
  });
  if (!response.ok) {
    await response.arrayBuffer().catch(() => undefined);
    const error = new Error("embed_http");
    error.name = "EmbedHttpError";
    (error as Error & { status: number }).status = response.status;
    throw error;
  }
  const json = (await response.json()) as {
    embeddings?: Array<{ values?: number[] }>;
    usageMetadata?: { promptTokenCount?: number };
  };
  const embeddings = json.embeddings ?? [];
  if (embeddings.length !== texts.length) {
    throw new Error("embed_count");
  }
  const vectors = embeddings.map((item) => {
    const values = item.values;
    if (!values || values.length !== EMBED_DIMS) {
      throw new Error("embed_dims");
    }
    return values;
  });
  const reported = json.usageMetadata?.promptTokenCount;
  const tokens =
    typeof reported === "number" && reported > 0
      ? reported
      : texts.reduce((sum, text) => sum + estimateTokens(text), 0);
  return { vectors, tokens };
}

function httpStatus(error: unknown): number | undefined {
  if (
    error instanceof Error &&
    error.name === "EmbedHttpError" &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    return error.status;
  }
  return undefined;
}

export async function runMessageEmbed(now = new Date()): Promise<MessageEmbedResult> {
  const started = Date.now();
  const rows = listMessagesAwaitingEmbedding(EMBED_SCAN_LIMIT);
  const shorts: AwaitingEmbedMessage[] = [];
  const ready: Array<{ row: AwaitingEmbedMessage; text: string }> = [];
  for (const row of rows) {
    const redacted = redactForEmbed(row.content);
    if (redacted.length < EMBED_MIN_CHARS) {
      shorts.push(row);
      continue;
    }
    if (ready.length < EMBED_BATCH_LIMIT) {
      ready.push({ row, text: documentEmbedText(redacted) });
    }
  }
  for (const row of shorts) {
    markSkipped(row);
  }

  const finish = (
    partial: Omit<MessageEmbedResult, "ms" | "skippedShort">,
  ): MessageEmbedResult => {
    const result: MessageEmbedResult = {
      ...partial,
      skippedShort: shorts.length,
      ms: Date.now() - started,
    };
    if (result.status === "http") {
      console.log(
        `message-embed: provider=gemini status=${result.httpStatus ?? "error"} embedded=0 skipped_short=${result.skippedShort}`,
      );
    } else {
      console.log(
        `message-embed: status=${result.status} embedded=${result.embedded} skipped_short=${result.skippedShort} tokens=${result.tokens} ms=${result.ms}`,
      );
    }
    return result;
  };

  if (ready.length === 0) {
    return finish({ embedded: 0, tokens: 0, status: "ok" });
  }
  if (!config.geminiApiKey && !batchEmbedForTests) {
    return finish({ embedded: 0, tokens: 0, status: "no_key" });
  }

  const used = tokensUsedToday(now);
  const cap = config.embedDailyTokenCap;
  const chosen: Array<{ row: AwaitingEmbedMessage; text: string }> = [];
  let estimate = 0;
  for (const item of ready) {
    const tokens = estimateTokens(item.text);
    if (used + estimate + tokens > cap) {
      break;
    }
    chosen.push(item);
    estimate += tokens;
  }
  if (chosen.length === 0) {
    return finish({ embedded: 0, tokens: 0, status: "daily_cap" });
  }

  let batch: EmbedBatch;
  try {
    batch = await batchEmbed(chosen.map((item) => item.text));
  } catch (error) {
    const status = httpStatus(error);
    return finish({
      embedded: 0,
      tokens: 0,
      status: "http",
      httpStatus: status,
    });
  }

  for (let i = 0; i < chosen.length; i += 1) {
    const item = chosen[i]!;
    insertMessageEmbedding({
      messageId: item.row.id,
      createdAt: item.row.created_at,
      model: EMBED_MODEL,
      scheme: EMBED_SCHEME,
      dims: EMBED_DIMS,
      vector: floatsToBlob(batch.vectors[i]!),
      skipReason: null,
    });
  }
  addTokensToday(now, batch.tokens);
  logLlmUsage({
    task: "embedding",
    model: EMBED_MODEL,
    inputTokens: batch.tokens,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    costUsd: (batch.tokens * EMBED_TEXT_USD_PER_MILLION) / 1_000_000,
  });
  return finish({ embedded: chosen.length, tokens: batch.tokens, status: "ok" });
}

export function registerMessageEmbed(): IntervalJob {
  return everyMs("message-embed", EMBED_INTERVAL_MS, async () => {
    await runMessageEmbed();
  }, { runImmediately: true });
}
