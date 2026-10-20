const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "cursor", pattern: /crsr_[A-Za-z0-9_-]+/g },
  { name: "bearer", pattern: /Bearer\s+\S+/gi },
  { name: "github", pattern: /ghp_[A-Za-z0-9]+/g },
  { name: "github_pat", pattern: /github_pat_[A-Za-z0-9_]+/g },
  { name: "anthropic", pattern: /sk-ant-[A-Za-z0-9_-]+/g },
  { name: "deepseek", pattern: /sk-[a-f0-9]{32}/gi },
];

export const REQUIRED_ENV_VARS = [
  "TELEGRAM_BOT_TOKEN",
  "OWNER_TELEGRAM_ID",
  "BRIEF_TIME",
  "ANTHROPIC_API_KEY",
  "CLAUDE_MODEL",
] as const;

export function envValue(name: string): string {
  return process.env[name]?.trim() ?? "";
}

export function missingRequiredEnv(names: readonly string[]): string[] {
  return names.filter((name) => envValue(name) === "");
}

export function failIfMissingEnv(names: readonly string[]): void {
  const missing = missingRequiredEnv(names);
  if (missing.length === 0) {
    return;
  }
  console.error(
    `Missing required environment variables: ${missing.join(", ")}. Copy .env.example to .env and fill in each value.`,
  );
  process.exit(1);
}

export function parseOwnerTelegramId(raw: string): number | undefined {
  const ownerTelegramId = Number(raw.trim());
  if (!Number.isSafeInteger(ownerTelegramId) || ownerTelegramId <= 0) {
    return undefined;
  }
  return ownerTelegramId;
}

export function requireOwnerTelegramId(): number {
  const parsed = parseOwnerTelegramId(envValue("OWNER_TELEGRAM_ID"));
  if (parsed === undefined) {
    console.error(
      "OWNER_TELEGRAM_ID must be a positive integer. Update it in your .env file.",
    );
    process.exit(1);
  }
  return parsed;
}

export function redactSecrets(text: string): string {
  let cleaned = text;
  for (const item of SECRET_PATTERNS) {
    cleaned = cleaned.replace(item.pattern, "[redacted]");
  }
  return cleaned;
}
