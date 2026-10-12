import "dotenv/config";

export type LlmProvider = "claude" | "openrouter";

const provider = process.env.LLM_PROVIDER?.trim();

if (provider !== "claude" && provider !== "openrouter") {
  console.error('LLM_PROVIDER must be either "claude" or "openrouter".');
  process.exit(1);
}

const providerEnvVars =
  provider === "claude"
    ? (["ANTHROPIC_API_KEY", "CLAUDE_MODEL"] as const)
    : (["OPENROUTER_API_KEY", "OPENROUTER_MODEL"] as const);

const requiredEnvVars = [
  "TELEGRAM_BOT_TOKEN",
  "OWNER_TELEGRAM_ID",
  "BRIEF_TIME",
  ...providerEnvVars,
] as const;

const missingEnvVars = requiredEnvVars.filter(
  (name) => !process.env[name]?.trim(),
);

if (missingEnvVars.length > 0) {
  console.error(
    `Missing required environment variables: ${missingEnvVars.join(", ")}. Copy .env.example to .env and fill in each value.`,
  );
  process.exit(1);
}

const ownerTelegramId = Number(process.env.OWNER_TELEGRAM_ID);

if (!Number.isSafeInteger(ownerTelegramId) || ownerTelegramId <= 0) {
  console.error(
    "OWNER_TELEGRAM_ID must be a positive integer. Update it in your .env file.",
  );
  process.exit(1);
}

const briefTime = process.env.BRIEF_TIME!;
const briefTimeMatch = /^(\d{2}):(\d{2})$/.exec(briefTime);
const briefHour = Number(briefTimeMatch?.[1]);
const briefMinute = Number(briefTimeMatch?.[2]);
const rawGoogleSheetId = process.env.GOOGLE_SHEET_ID?.trim();
const googleSheetId =
  rawGoogleSheetId && rawGoogleSheetId.toLowerCase() !== "none"
    ? rawGoogleSheetId
    : undefined;

if (
  !briefTimeMatch ||
  briefHour < 0 ||
  briefHour > 23 ||
  briefMinute < 0 ||
  briefMinute > 59
) {
  console.error("BRIEF_TIME must use 24-hour HH:MM format, for example 08:00.");
  process.exit(1);
}

function readRate(name: string): number {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) {
    return 0;
  }

  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0) {
    console.error(`${name} must be a non-negative number.`);
    process.exit(1);
  }

  return value;
}

export const config = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN!,
  ownerTelegramId,
  googleSheetId,
  briefTime,
  briefHour,
  briefMinute,
  llmProvider: provider,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  claudeModel: process.env.CLAUDE_MODEL ?? "",
  openRouterApiKey: process.env.OPENROUTER_API_KEY ?? "",
  openRouterModel: process.env.OPENROUTER_MODEL ?? "",
  sarvamApiKey: process.env.SARVAM_API_KEY?.trim() ?? "",
  inputCostPerMillion: readRate("LLM_INPUT_COST_PER_MILLION"),
  outputCostPerMillion: readRate("LLM_OUTPUT_COST_PER_MILLION"),
  cacheCreationCostPerMillion: readRate(
    "LLM_CACHE_CREATION_COST_PER_MILLION",
  ),
  cacheReadCostPerMillion: readRate("LLM_CACHE_READ_COST_PER_MILLION"),
} as const;
