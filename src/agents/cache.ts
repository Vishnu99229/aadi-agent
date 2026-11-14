import { createHash } from "node:crypto";
import { db } from "../db.js";
import { extractRefs } from "./refs.js";
import { CACHE_POLICIES, cacheEnabled, ttlSeconds } from "./cache_policy.js";
import { toolOwnership } from "./registry.js";

/**
 * One cache of expensive read results, shared by every agent. When the
 * Knowledge Agent looked up `latest_release:a2aproject/a2a` five minutes ago,
 * Aadi or the Sales Agent asking the same thing gets that answer without
 * another search.
 *
 * The cache sits behind the dispatcher's checks: a caller only ever sees a
 * cached result for a tool it is itself allowed to call under its own grant.
 * Writes are never cached; a successful write clears the writing agent's
 * cached reads. A tool call with `fresh: true` skips the cache.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_cache (
    cache_key TEXT PRIMARY KEY,
    tool TEXT NOT NULL,
    args_json TEXT NOT NULL,
    result TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    freshness TEXT NOT NULL,
    source_refs_json TEXT NOT NULL,
    created_by TEXT NOT NULL,
    hits INTEGER NOT NULL DEFAULT 0,
    last_hit_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_agent_cache_expires ON agent_cache (expires_at);

  CREATE TABLE IF NOT EXISTS metric_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    tool TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('hit', 'miss', 'bypass', 'invalidate')),
    agent TEXT,
    result_tokens INTEGER NOT NULL DEFAULT 0,
    llm_call_saved INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_metric_cache_created ON metric_cache (created_at);
`);

const MAX_RESULT_CHARS = 60_000;

export interface CacheEntry {
  cacheKey: string;
  tool: string;
  args: Record<string, unknown>;
  result: string;
  createdAt: string;
  expiresAt: string;
  freshness: string;
  sourceRefs: string[];
  createdBy: string;
  hits: number;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key, child]) => key !== "fresh" && child !== undefined && child !== null && child !== "")
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortValue(child)]),
    );
  }
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : value;
}

/** The arguments as compared: keys sorted, blanks and `fresh` dropped, spacing normalized. */
export function normalizeArgs(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (sortValue(input) as Record<string, unknown>) : {};
}

export function cacheKey(tool: string, input: unknown): string {
  const args = normalizeArgs(input);
  const readable = CACHE_POLICIES[tool]?.keyOf?.(args);
  // Arguments other than the readable part still matter (account, max_results).
  const rest = Object.fromEntries(Object.entries(args).filter(([key]) => !["query", "repo", "project", "name"].includes(key)));
  const restPart = Object.keys(rest).length > 0 ? `#${createHash("sha256").update(JSON.stringify(rest)).digest("hex").slice(0, 10)}` : "";
  return readable
    ? `${tool}:${readable}${restPart}`
    : `${tool}:${createHash("sha256").update(JSON.stringify(args)).digest("hex").slice(0, 20)}`;
}

export function isCacheable(tool: string, input?: unknown): boolean {
  const policy = CACHE_POLICIES[tool];
  if (!cacheEnabled() || !policy || ttlSeconds(tool) <= 0 || toolOwnership(tool)?.effect !== "read") {
    return false;
  }
  return input === undefined || !policy.cacheableInput || policy.cacheableInput(normalizeArgs(input));
}

function note(tool: string, outcome: "hit" | "miss" | "bypass" | "invalidate", agent: string | undefined, resultChars = 0): void {
  try {
    db.prepare(
      `INSERT INTO metric_cache (created_at, tool, outcome, agent, result_tokens, llm_call_saved) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      new Date().toISOString(),
      tool,
      outcome,
      agent ?? null,
      Math.ceil(resultChars / 4),
      outcome === "hit" && CACHE_POLICIES[tool]?.llmBacked ? 1 : 0,
    );
  } catch {
    // Counting is never worth an error.
  }
}

/** A live entry, or undefined. Counts the hit or miss. */
export function cacheGet(tool: string, input: unknown, agent?: string, now = Date.now()): CacheEntry | undefined {
  if (!isCacheable(tool, input)) {
    return undefined;
  }
  const key = cacheKey(tool, input);
  const row = db.prepare(`SELECT * FROM agent_cache WHERE cache_key = ?`).get(key) as
    | {
        cache_key: string;
        tool: string;
        args_json: string;
        result: string;
        created_at: string;
        expires_at: string;
        freshness: string;
        source_refs_json: string;
        created_by: string;
        hits: number;
      }
    | undefined;
  if (!row || Date.parse(row.expires_at) <= now) {
    note(tool, "miss", agent);
    return undefined;
  }
  db.prepare(`UPDATE agent_cache SET hits = hits + 1, last_hit_at = ? WHERE cache_key = ?`).run(new Date(now).toISOString(), key);
  note(tool, "hit", agent, row.result.length);
  return {
    cacheKey: row.cache_key,
    tool: row.tool,
    args: JSON.parse(row.args_json) as Record<string, unknown>,
    result: row.result,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    freshness: row.freshness,
    sourceRefs: JSON.parse(row.source_refs_json) as string[],
    createdBy: row.created_by,
    hits: row.hits + 1,
  };
}

let putsSinceSweep = 0;

/** Keeps a successful read result. Returns its key. */
export function cachePut(tool: string, input: unknown, result: string, agent: string, now = Date.now()): string | undefined {
  if (!isCacheable(tool, input) || result.length > MAX_RESULT_CHARS) {
    return undefined;
  }
  putsSinceSweep += 1;
  if (putsSinceSweep >= 100) {
    putsSinceSweep = 0;
    sweepCache(now);
  }
  const key = cacheKey(tool, input);
  const urls = [...result.matchAll(/https?:\/\/[^\s)"'\]]+/g)].map((match) => match[0]).slice(0, 8);
  db.prepare(
    `INSERT INTO agent_cache (cache_key, tool, args_json, result, created_at, expires_at, freshness, source_refs_json, created_by, hits)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(cache_key) DO UPDATE SET
       result = excluded.result, args_json = excluded.args_json, created_at = excluded.created_at,
       expires_at = excluded.expires_at, source_refs_json = excluded.source_refs_json, created_by = excluded.created_by, hits = 0`,
  ).run(
    key,
    tool,
    JSON.stringify(normalizeArgs(input)),
    result,
    new Date(now).toISOString(),
    new Date(now + ttlSeconds(tool) * 1000).toISOString(),
    CACHE_POLICIES[tool]!.freshness,
    JSON.stringify([...urls, ...extractRefs(result)]),
    agent,
  );
  return key;
}

/** A skipped lookup, for the record. */
export function cacheBypassed(tool: string, agent?: string): void {
  if (isCacheable(tool)) {
    note(tool, "bypass", agent);
  }
}

/**
 * Data a write can change. Public research, releases, stored documents and
 * emails by id don't change because Vishnu changed something, so a write
 * doesn't throw those away.
 */
const MUTABLE: ReadonlySet<string> = new Set(["gmail", "calendar", "account", "contact"]);

/** After an agent changes something, its cached reads of changeable data may be stale. */
export function invalidateOwner(owner: string): number {
  const tools = Object.keys(CACHE_POLICIES).filter((tool) => {
    const policy = CACHE_POLICIES[tool]!;
    if (!MUTABLE.has(policy.freshness)) {
      return false;
    }
    // Who someone is can change with a new account or a new email thread.
    return toolOwnership(tool)?.owner === owner || (policy.freshness === "contact" && (owner === "email" || owner === "sales"));
  });
  if (tools.length === 0) {
    return 0;
  }
  const placeholders = tools.map(() => "?").join(", ");
  const removed = db.prepare(`DELETE FROM agent_cache WHERE tool IN (${placeholders})`).run(...tools).changes;
  if (removed > 0) {
    note(tools[0]!, "invalidate", owner);
  }
  return removed;
}

export function sweepCache(now = Date.now()): number {
  return db.prepare(`DELETE FROM agent_cache WHERE expires_at <= ?`).run(new Date(now).toISOString()).changes;
}

export function clearCacheForTests(): void {
  db.exec(`DELETE FROM agent_cache; DELETE FROM metric_cache;`);
}

export interface CacheStats {
  hits: number;
  misses: number;
  bypasses: number;
  hitRate: number | undefined;
  tokensSaved: number;
  llmCallsSaved: number;
}

export function cacheStats(fromIso: string, toIso: string): CacheStats {
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN outcome = 'hit' THEN 1 ELSE 0 END) AS hits,
         SUM(CASE WHEN outcome = 'miss' THEN 1 ELSE 0 END) AS misses,
         SUM(CASE WHEN outcome = 'bypass' THEN 1 ELSE 0 END) AS bypasses,
         SUM(CASE WHEN outcome = 'hit' THEN result_tokens ELSE 0 END) AS tokens,
         SUM(llm_call_saved) AS llm
       FROM metric_cache WHERE created_at >= ? AND created_at < ?`,
    )
    .get(fromIso, toIso) as { hits: number | null; misses: number | null; bypasses: number | null; tokens: number | null; llm: number | null };
  const hits = row.hits ?? 0;
  const misses = row.misses ?? 0;
  return {
    hits,
    misses,
    bypasses: row.bypasses ?? 0,
    hitRate: hits + misses > 0 ? hits / (hits + misses) : undefined,
    tokensSaved: row.tokens ?? 0,
    llmCallsSaved: row.llm ?? 0,
  };
}
