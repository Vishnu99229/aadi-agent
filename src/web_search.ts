import { config, type WebSearchProvider } from "./config.js";
import { getSetting, setSetting } from "./db.js";
import { anthropicCreditBlocked } from "./llm_fallback.js";
import { assertTestSeam } from "./test_seam.js";

const TIME_ZONE = "Asia/Kolkata";
const SETTING_PREFIX = "web_search_count:";
const DEEPSEEK_SEARCH_URL = "https://api.deepseek.com/v1/tools/search";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const MAX_QUERY_CHARS = 128;
const RESULT_COUNT = 5;

export type SearchProviderName = WebSearchProvider;

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchAttempt {
  provider: SearchProviderName;
  status: "ok" | "empty" | "error" | "skipped";
  reason?: string;
}

export type SearchOutcome =
  | {
      ok: true;
      provider: SearchProviderName;
      hits: SearchHit[];
      answer?: string;
      attempts: SearchAttempt[];
    }
  | {
      ok: false;
      reason: "daily_cap" | "no_results";
      attempts: SearchAttempt[];
    };

export type SearchProviderFn = (query: string) => Promise<{
  hits: SearchHit[];
  answer?: string;
}>;

const providers: Record<SearchProviderName, SearchProviderFn> = {
  deepseek: searchDeepSeek,
  gemini: searchGemini,
  claude: searchClaude,
};

let testProviders: Partial<Record<SearchProviderName, SearchProviderFn>> | undefined;
let skipProviders = new Set<SearchProviderName>();

export function setSearchProvidersForTests(
  overrides:
    | Partial<Record<SearchProviderName, SearchProviderFn>>
    | undefined,
): void {
  assertTestSeam("setSearchProvidersForTests");
  testProviders = overrides;
}

export function setSearchSkipProviders(
  names: readonly SearchProviderName[] | undefined,
): void {
  skipProviders = new Set(names ?? []);
}

export function kolkataDateKey(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function countKey(now: Date): string {
  return `${SETTING_PREFIX}${kolkataDateKey(now)}`;
}

export function searchCountToday(now = new Date()): number {
  const raw = getSetting(countKey(now));
  const value = Number(raw ?? "0");
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

function bumpSearchCount(now: Date): number {
  const next = searchCountToday(now) + 1;
  setSetting(countKey(now), String(next));
  return next;
}

export function getSearchOrder(): SearchProviderName[] {
  const fromEnv = (process.env.WEB_SEARCH_ORDER?.trim() || "")
    .split(/[\s,]+/)
    .map((part) => part.trim().toLowerCase())
    .filter((part): part is SearchProviderName =>
      part === "deepseek" || part === "gemini" || part === "claude",
    );
  const order =
    fromEnv.length > 0 ? fromEnv : [...config.webSearchOrder];
  const pinRaw =
    process.env.WEB_SEARCH_PROVIDER?.trim().toLowerCase() ||
    config.webSearchProvider;
  if (pinRaw === "deepseek" || pinRaw === "gemini" || pinRaw === "claude") {
    return [pinRaw, ...order.filter((name) => name !== pinRaw)];
  }
  return order;
}

function clipQuery(query: string): string {
  return [...query.trim()].slice(0, MAX_QUERY_CHARS).join("").trim();
}

function logAttempt(attempt: SearchAttempt, hits = 0): void {
  const extra = attempt.reason ? ` reason=${attempt.reason}` : "";
  console.log(
    `web_search: provider=${attempt.provider} status=${attempt.status} hits=${hits}${extra}`,
  );
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json: unknown = undefined;
  if (text) {
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = undefined;
    }
  }
  return { status: response.status, json };
}

function errorCode(status: number, json: unknown): string {
  if (json && typeof json === "object") {
    const record = json as Record<string, unknown>;
    const nested =
      record.error && typeof record.error === "object"
        ? (record.error as Record<string, unknown>)
        : undefined;
    const code = nested?.code ?? nested?.type ?? record.code;
    if (typeof code === "string" && code.trim()) {
      return `${status}:${code.trim().slice(0, 40)}`;
    }
  }
  return String(status);
}

function asHits(
  rows: Array<{ title?: unknown; url?: unknown; snippet?: unknown }>,
): SearchHit[] {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const url = typeof row.url === "string" ? row.url.trim() : "";
    if (!url || seen.has(url)) {
      continue;
    }
    seen.add(url);
    hits.push({
      title: typeof row.title === "string" && row.title.trim() ? row.title.trim() : url,
      url,
      snippet:
        typeof row.snippet === "string" ? row.snippet.trim().slice(0, 400) : "",
    });
  }
  return hits;
}

async function searchDeepSeek(query: string): Promise<{
  hits: SearchHit[];
  answer?: string;
}> {
  if (!config.deepseekApiKey) {
    throw new Error("skipped:no_key");
  }
  const { status, json } = await postJson(
    DEEPSEEK_SEARCH_URL,
    {
      Authorization: `Bearer ${config.deepseekApiKey}`,
      "Content-Type": "application/json",
    },
    {
      query,
      count: RESULT_COUNT,
      need_content: false,
    },
    15_000,
  );
  if (status !== 200) {
    throw new Error(errorCode(status, json));
  }
  const results =
    json && typeof json === "object" && Array.isArray((json as { results?: unknown }).results)
      ? ((json as { results: Array<Record<string, unknown>> }).results)
      : [];
  return {
    hits: asHits(
      results.map((row) => ({
        title: row.title,
        url: row.url,
        snippet: row.summary ?? row.snippet,
      })),
    ),
  };
}

function geminiGenerateUrl(): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.geminiModel)}:generateContent`;
}

async function searchGemini(query: string): Promise<{
  hits: SearchHit[];
  answer?: string;
}> {
  if (!config.geminiApiKey) {
    throw new Error("skipped:no_key");
  }
  const payload = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `Search the public web for this query. Answer in a few short sentences and cite sources:\n${query}`,
          },
        ],
      },
    ],
    tools: [{ google_search: {} }],
  };
  let status = 0;
  let json: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await postJson(
      geminiGenerateUrl(),
      {
        "x-goog-api-key": config.geminiApiKey,
        "Content-Type": "application/json",
      },
      payload,
      30_000,
    );
    status = response.status;
    json = response.json;
    if (status === 200) {
      break;
    }
    if ((status === 429 || status === 503) && attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      continue;
    }
    throw new Error(errorCode(status, json));
  }
  if (status !== 200) {
    throw new Error(errorCode(status, json));
  }
  const candidate = (
    json as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        groundingMetadata?: {
          webSearchQueries?: string[];
          groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
        };
      }>;
    }
  ).candidates?.[0];
  const chunks = candidate?.groundingMetadata?.groundingChunks ?? [];
  const hits = asHits(
    chunks.map((chunk) => ({
      title: chunk.web?.title,
      url: chunk.web?.uri,
      snippet: "",
    })),
  );
  const answer = candidate?.content?.parts
    ?.map((part) => part.text ?? "")
    .join("\n")
    .trim();
  const searched = hits.length > 0 || (candidate?.groundingMetadata?.webSearchQueries?.length ?? 0) > 0;
  if (!searched) {
    return { hits: [] };
  }
  return { hits, answer: answer || undefined };
}

async function searchClaude(query: string): Promise<{
  hits: SearchHit[];
  answer?: string;
}> {
  if (!config.anthropicApiKey) {
    throw new Error("skipped:no_key");
  }
  if (anthropicCreditBlocked()) {
    throw new Error("skipped:credit");
  }
  const { status, json } = await postJson(
    ANTHROPIC_MESSAGES_URL,
    {
      "x-api-key": config.anthropicApiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    {
      model: config.claudeModel,
      max_tokens: 1024,
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          allowed_callers: ["direct"],
          max_uses: 3,
        },
      ],
      messages: [
        {
          role: "user",
          content: `Search the web for: ${query}. Reply with a short factual summary and the source titles and URLs.`,
        },
      ],
    },
    45_000,
  );
  if (status !== 200) {
    throw new Error(errorCode(status, json));
  }
  const content = Array.isArray((json as { content?: unknown }).content)
    ? ((json as { content: Array<Record<string, unknown>> }).content)
    : [];
  const hits: SearchHit[] = [];
  const texts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
      const citations = Array.isArray(block.citations) ? block.citations : [];
      for (const citation of citations) {
        if (!citation || typeof citation !== "object") {
          continue;
        }
        const row = citation as Record<string, unknown>;
        hits.push(
          ...asHits([
            {
              title: row.title,
              url: row.url,
              snippet: "",
            },
          ]),
        );
      }
    }
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const item of block.content) {
        if (!item || typeof item !== "object") {
          continue;
        }
        const row = item as Record<string, unknown>;
        hits.push(
          ...asHits([
            {
              title: row.title,
              url: row.url,
              snippet: typeof row.page_age === "string" ? row.page_age : "",
            },
          ]),
        );
      }
    }
  }
  const unique = asHits(hits);
  return {
    hits: unique,
    answer: texts.join("\n").trim() || undefined,
  };
}

async function runProvider(
  name: SearchProviderName,
  query: string,
): Promise<{ hits: SearchHit[]; answer?: string }> {
  const override = testProviders?.[name];
  const fn = override ?? providers[name];
  return fn(query);
}

export async function searchWeb(
  query: string,
  options: {
    skipProviders?: readonly SearchProviderName[];
    now?: Date;
    dailyCap?: number;
  } = {},
): Promise<SearchOutcome> {
  const clipped = clipQuery(query);
  const now = options.now ?? new Date();
  const cap = options.dailyCap ?? config.webSearchDailyCap;
  const attempts: SearchAttempt[] = [];
  if (!clipped) {
    return { ok: false, reason: "no_results", attempts };
  }
  if (searchCountToday(now) >= cap) {
    console.log(`web_search: status=daily_cap count=${searchCountToday(now)} cap=${cap}`);
    return { ok: false, reason: "daily_cap", attempts };
  }
  bumpSearchCount(now);

  const skipped = new Set([...skipProviders, ...(options.skipProviders ?? [])]);
  for (const provider of getSearchOrder()) {
    if (skipped.has(provider)) {
      const attempt: SearchAttempt = {
        provider,
        status: "skipped",
        reason: "forced",
      };
      attempts.push(attempt);
      logAttempt(attempt);
      continue;
    }
    if (provider === "claude" && anthropicCreditBlocked()) {
      const attempt: SearchAttempt = {
        provider,
        status: "skipped",
        reason: "credit",
      };
      attempts.push(attempt);
      logAttempt(attempt);
      continue;
    }
    try {
      const result = await runProvider(provider, clipped);
      if (result.hits.length === 0 && !result.answer) {
        const attempt: SearchAttempt = { provider, status: "empty" };
        attempts.push(attempt);
        logAttempt(attempt);
        continue;
      }
      const attempt: SearchAttempt = { provider, status: "ok" };
      attempts.push(attempt);
      logAttempt(attempt, result.hits.length);
      return {
        ok: true,
        provider,
        hits: result.hits,
        answer: result.answer,
        attempts,
      };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      const skippedCall = text.startsWith("skipped:");
      const attempt: SearchAttempt = {
        provider,
        status: skippedCall ? "skipped" : "error",
        reason: text.replace(/^skipped:/, "").slice(0, 40),
      };
      attempts.push(attempt);
      logAttempt(attempt);
    }
  }
  return { ok: false, reason: "no_results", attempts };
}

function sourcesMarker(hits: SearchHit[]): string {
  if (hits.length === 0) {
    return "";
  }
  const lines = hits.map((hit) => `${hit.title} | ${hit.url}`);
  return `---sources---\n${lines.join("\n")}\n---end---`;
}

export function parseSearchSources(content: string): SearchHit[] {
  const match = content.match(/---sources---\n([\s\S]*?)\n---end---/);
  if (!match?.[1]) {
    return [];
  }
  return asHits(
    match[1]
      .split("\n")
      .map((line) => {
        const sep = line.lastIndexOf(" | ");
        if (sep < 0) {
          return { title: line.trim(), url: line.trim() };
        }
        return {
          title: line.slice(0, sep).trim(),
          url: line.slice(sep + 3).trim(),
        };
      }),
  );
}

export function formatReplyCitations(hits: SearchHit[]): string {
  if (hits.length === 0) {
    return "";
  }
  const lines = hits.map((hit) => `- ${hit.title} — ${hit.url}`);
  return `Sources:\n${lines.join("\n")}`;
}

function urlKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

export function withSearchCitations(reply: string, hits: SearchHit[]): string {
  if (hits.length === 0) {
    return reply;
  }
  const missing = hits.filter((hit) => !reply.includes(urlKey(hit.url)));
  if (missing.length === 0) {
    return reply;
  }
  const block = formatReplyCitations(missing);
  if (!block) {
    return reply;
  }
  if (/\bSources:/i.test(reply)) {
    const extra = missing.map((hit) => `- ${hit.title} — ${hit.url}`).join("\n");
    return `${reply.trim()}\n${extra}`;
  }
  return `${reply.trim()}\n\n${block}`;
}

export function formatSearchToolResult(outcome: SearchOutcome): string {
  if (!outcome.ok) {
    if (outcome.reason === "daily_cap") {
      return `Not searched: reached today's search limit (${config.webSearchDailyCap}).`;
    }
    const detail = outcome.attempts
      .map((attempt) => `${attempt.provider}:${attempt.status}${attempt.reason ? `:${attempt.reason}` : ""}`)
      .join("; ");
    return `Not searched: no provider returned results${detail ? ` (${detail})` : ""}.`;
  }
  const lines: string[] = [`Search ok via ${outcome.provider}.`];
  if (outcome.answer) {
    lines.push("", outcome.answer.trim());
  }
  if (outcome.hits.length > 0) {
    lines.push("", "Results:");
    outcome.hits.forEach((hit, index) => {
      lines.push(`${index + 1}. ${hit.title}`, `URL: ${hit.url}`);
      if (hit.snippet) {
        lines.push(`Summary: ${hit.snippet}`);
      }
    });
    lines.push("", sourcesMarker(outcome.hits));
  }
  lines.push(
    "",
    "Cite these sources in your reply (title and URL). Do not invent extra sources. If the results do not answer the question, say so.",
  );
  return lines.join("\n");
}
