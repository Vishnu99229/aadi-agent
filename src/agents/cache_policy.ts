/**
 * Which tool results the shared cache may keep, and for how long. Only reads,
 * and only those that are expensive to repeat (a web search, GitHub, Google
 * APIs, document extraction). Anything that writes, sends, books or deletes is
 * never cached, and a successful write by an agent clears that agent's cached
 * reads so a stale answer can't follow a change.
 *
 * Every TTL can be changed with CACHE_TTL_<TOOL>_SECONDS (0 turns that tool's
 * cache off). CACHE_ENABLED=false turns the whole cache off.
 */
export type Freshness = "release" | "research" | "contact" | "calendar" | "gmail" | "static" | "account" | "drive" | "build";

export interface CachePolicy {
  ttlSeconds: number;
  freshness: Freshness;
  /** The tool makes a model call of its own (a web search), so a hit saves one. */
  llmBacked?: boolean;
  /** A readable key from the arguments; otherwise a hash of all of them. */
  keyOf?: (input: Record<string, unknown>) => string | undefined;
  /**
   * Whether the result depends on the arguments alone. A Gmail search that
   * names a person is resolved through remembered choices, so the same words
   * can mean different people: only searches on exact addresses are cached.
   */
  cacheableInput?: (input: Record<string, unknown>) => boolean;
}

/** Every from:/to:/cc: in a Gmail query is an exact address. */
export function addressOnlyQuery(input: Record<string, unknown>): boolean {
  const query = typeof input.query === "string" ? input.query : "";
  const operands = [...query.matchAll(/\b(?:from|to|cc|bcc):\(?([^\s)]+)/gi)].map((match) => match[1]!);
  return operands.every((operand) => operand.includes("@"));
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/\s+/g, " ") : "";
}

export const CACHE_POLICIES: Record<string, CachePolicy> = {
  // Releases change a few times a month: 30 minutes.
  latest_release: {
    ttlSeconds: 30 * 60,
    freshness: "release",
    keyOf: (input) => {
      const repo = text(input.repo).replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/+$/, "");
      return repo || (text(input.project) ? `project:${text(input.project)}` : undefined);
    },
  },
  web_search: { ttlSeconds: 30 * 60, freshness: "research", llmBacked: true, keyOf: (input) => text(input.query) || undefined },
  search_drive: { ttlSeconds: 10 * 60, freshness: "drive" },
  read_drive_file: { ttlSeconds: 10 * 60, freshness: "drive" },
  // A stored document doesn't change under its id.
  read_document: { ttlSeconds: 24 * 60 * 60, freshness: "static" },
  read_email: { ttlSeconds: 10 * 60, freshness: "static" },
  search_emails: { ttlSeconds: 60, freshness: "gmail", cacheableInput: addressOnlyQuery },
  account_status: { ttlSeconds: 5 * 60, freshness: "account" },
  list_accounts: { ttlSeconds: 5 * 60, freshness: "account" },
  resolve_contact: { ttlSeconds: 2 * 60, freshness: "contact", keyOf: (input) => text(input.name) || undefined },
  // A calendar snapshot is only good for a minute.
  list_events: { ttlSeconds: 60, freshness: "calendar" },
  get_build_checks: { ttlSeconds: 60, freshness: "build" },
  get_repo_state: { ttlSeconds: 2 * 60, freshness: "build" },
};

export const CACHEABLE_TOOLS: readonly string[] = Object.keys(CACHE_POLICIES);

/** The extra argument a cacheable tool takes to skip the cache. */
export const FRESH_PROPERTY = {
  type: "boolean",
  description: "Set true only when the latest data matters (something just changed, or Vishnu asked for fresh results). Skips Aadi's shared cache.",
} as const;

export function ttlSeconds(tool: string): number {
  const policy = CACHE_POLICIES[tool];
  if (!policy) {
    return 0;
  }
  const raw = process.env[`CACHE_TTL_${tool.toUpperCase()}_SECONDS`]?.trim();
  if (raw) {
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return policy.ttlSeconds;
}

/** Data that goes stale when something happens in Vishnu's day. */
export const VOLATILE: ReadonlySet<Freshness> = new Set(["gmail", "calendar", "contact", "account", "build"]);

/** His own words asking for the current state ("check again", "any new mail now?"). */
const WANTS_FRESH = /\b(?:again|now|latest|newest|new|just|refresh|re-?check|any updates?|still|yet|right now|currently)\b/i;

export function ownerWantsFresh(ownerText: string | undefined): boolean {
  return typeof ownerText === "string" && WANTS_FRESH.test(ownerText);
}

export function cacheEnabled(): boolean {
  return (process.env.CACHE_ENABLED?.trim().toLowerCase() ?? "true") !== "false";
}
