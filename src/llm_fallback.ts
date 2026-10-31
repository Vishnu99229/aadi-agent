import { config } from "./config.js";
import {
  deleteAllLlmBackendFlags,
  deleteLlmBackendFlag,
  getLlmBackendFlag,
  listLlmBackendFlags,
  upsertLlmBackendFlag,
} from "./db.js";
import { assertTestSeam } from "./test_seam.js";

export type LlmBackend =
  | "claude"
  | "haiku"
  | "gemini"
  | "local-gemma"
  | "deepseek"
  | "deepseek-reasoner";

export const CREDIT_FLAG_MS = 6 * 60 * 60 * 1000;

const DEFAULT_REST: LlmBackend[] = [
  "deepseek",
  "gemini",
  "haiku",
  "claude",
];

const memory = new Map<string, { reason: string; flaggedAt: number }>();

function isLlmBackend(value: string): value is LlmBackend {
  return (
    value === "claude" ||
    value === "haiku" ||
    value === "gemini" ||
    value === "deepseek" ||
    value === "deepseek-reasoner" ||
    value === "local-gemma"
  );
}

export function isAnthropicBackend(backend: LlmBackend): boolean {
  return backend === "claude" || backend === "haiku";
}

export function backendHasKey(backend: LlmBackend): boolean {
  switch (backend) {
    case "claude":
    case "haiku":
      return Boolean(config.anthropicApiKey);
    case "gemini":
      return Boolean(config.geminiApiKey);
    case "deepseek":
    case "deepseek-reasoner":
      return Boolean(config.deepseekApiKey);
    case "local-gemma":
      return false;
  }
}

export function isCreditOrAuthError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /credit balance is too low|insufficient.?credit|insufficient.?balance|\b402\b|invalid api key|authentication|unauthorized/i.test(
    text,
  );
}

export function shortBackendReason(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .trim();
  if (/credit balance is too low/i.test(text)) {
    return "credit too low";
  }
  const code = text.match(/\b(401|402|403|429)\b/);
  if (code) {
    return code[1]!;
  }
  return text.slice(0, 80);
}

function restChain(): LlmBackend[] {
  const raw = process.env.FALLBACK_CHAIN?.trim();
  if (!raw) {
    return DEFAULT_REST;
  }
  const parsed = raw
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter((part): part is LlmBackend => Boolean(part) && isLlmBackend(part));
  return parsed.length > 0 ? parsed : DEFAULT_REST;
}

export function isLlmBackendFlagged(
  backend: LlmBackend,
  now = Date.now(),
): boolean {
  const mem = memory.get(backend);
  if (mem) {
    if (now - mem.flaggedAt < CREDIT_FLAG_MS) {
      return true;
    }
    memory.delete(backend);
  }
  const row = getLlmBackendFlag(backend);
  if (!row) {
    return false;
  }
  const flaggedAt = Date.parse(row.flagged_at);
  if (!Number.isFinite(flaggedAt) || now - flaggedAt >= CREDIT_FLAG_MS) {
    return false;
  }
  memory.set(backend, { reason: row.reason, flaggedAt });
  return true;
}

export function anthropicCreditBlocked(now = Date.now()): boolean {
  return isLlmBackendFlagged("haiku", now) || isLlmBackendFlagged("claude", now);
}

export function flagLlmBackend(
  backend: LlmBackend,
  reason: string,
  now = Date.now(),
): void {
  const trimmed = reason.replace(/\s+/g, " ").trim().slice(0, 80);
  memory.set(backend, { reason: trimmed, flaggedAt: now });
  upsertLlmBackendFlag(backend, trimmed, new Date(now).toISOString());
  if (isAnthropicBackend(backend)) {
    const other = backend === "haiku" ? "claude" : "haiku";
    memory.set(other, { reason: trimmed, flaggedAt: now });
    upsertLlmBackendFlag(other, trimmed, new Date(now).toISOString());
  }
}

export function listActiveCreditFlags(
  now = Date.now(),
): Array<{ backend: string; reason: string; flaggedAt: number }> {
  const out: Array<{ backend: string; reason: string; flaggedAt: number }> = [];
  for (const row of listLlmBackendFlags()) {
    const flaggedAt = Date.parse(row.flagged_at);
    if (!Number.isFinite(flaggedAt) || now - flaggedAt >= CREDIT_FLAG_MS) {
      continue;
    }
    out.push({ backend: row.backend, reason: row.reason, flaggedAt });
  }
  return out;
}

export function formatCreditHealthLine(now = Date.now()): string {
  const flags = listActiveCreditFlags(now);
  if (flags.length === 0) {
    return "llm credit: ok";
  }
  return `llm credit: ${flags
    .map((flag) => `${flag.backend} (${flag.reason})`)
    .join(", ")}`;
}

export function supportsVision(backend: LlmBackend): boolean {
  return backend === "gemini" || isAnthropicBackend(backend);
}

export function isBackendUsable(backend: LlmBackend, now = Date.now()): boolean {
  if (!backendHasKey(backend)) {
    return false;
  }
  if (isAnthropicBackend(backend) && anthropicCreditBlocked(now)) {
    return false;
  }
  return !isLlmBackendFlagged(backend, now);
}

export function getFallbackChain(
  primary: LlmBackend,
  options: { hasImage?: boolean; hasPdf?: boolean } = {},
  now = Date.now(),
): LlmBackend[] {
  const ordered: LlmBackend[] = [];
  for (const backend of [primary, ...restChain()]) {
    if (ordered.includes(backend)) {
      continue;
    }
    if (!isBackendUsable(backend, now)) {
      continue;
    }
    if (options.hasPdf && !isAnthropicBackend(backend)) {
      continue;
    }
    if (options.hasImage && !supportsVision(backend)) {
      continue;
    }
    ordered.push(backend);
  }
  return ordered;
}

export function clearLlmBackendFlagsForTests(): void {
  assertTestSeam("clearLlmBackendFlagsForTests");
  memory.clear();
  deleteAllLlmBackendFlags();
}

export function unflagLlmBackendForTests(backend: LlmBackend): void {
  assertTestSeam("unflagLlmBackendForTests");
  memory.delete(backend);
  deleteLlmBackendFlag(backend);
}
