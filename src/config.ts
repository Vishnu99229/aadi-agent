import "dotenv/config";

export type LlmProvider = "claude" | "cloud-gemma";

function readProvider(): LlmProvider {
  const value = process.env.LLM_PROVIDER?.trim() || "claude";
  if (value === "claude" || value === "cloud-gemma") {
    return value;
  }
  console.error('LLM_PROVIDER must be either "claude" or "cloud-gemma".');
  process.exit(1);
}

const provider = readProvider();

const requiredEnvVars = [
  "TELEGRAM_BOT_TOKEN",
  "OWNER_TELEGRAM_ID",
  "BRIEF_TIME",
  "ANTHROPIC_API_KEY",
  "CLAUDE_MODEL",
  ...(provider === "cloud-gemma" ? (["OPENROUTER_API_KEY"] as const) : []),
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
const followupAfterHours = Number(
  process.env.FOLLOWUP_AFTER_HOURS?.trim() || "72",
);
const followupScanTime =
  process.env.FOLLOWUP_SCAN_TIME?.trim() || "10:00";
const followupScanTimeMatch = /^(\d{2}):(\d{2})$/.exec(followupScanTime);
const followupScanHour = Number(followupScanTimeMatch?.[1]);
const followupScanMinute = Number(followupScanTimeMatch?.[2]);
const billScanTime = process.env.BILL_SCAN_TIME?.trim() || "09:00";
const billScanTimeMatch = /^(\d{2}):(\d{2})$/.exec(billScanTime);
const billScanHour = Number(billScanTimeMatch?.[1]);
const billScanMinute = Number(billScanTimeMatch?.[2]);
const weeklyReviewTime = process.env.WEEKLY_REVIEW_TIME?.trim() || "19:00";
const weeklyReviewTimeMatch = /^(\d{2}):(\d{2})$/.exec(weeklyReviewTime);
const weeklyReviewHour = Number(weeklyReviewTimeMatch?.[1]);
const weeklyReviewMinute = Number(weeklyReviewTimeMatch?.[2]);
const preMeetingMinutes = Number(
  process.env.PRE_MEETING_MINUTES?.trim() || "15",
);
const skipInternalRaw =
  process.env.SKIP_INTERNAL_RECURRING?.trim().toLowerCase() ?? "";
const skipInternalRecurring =
  skipInternalRaw !== "false" &&
  skipInternalRaw !== "0" &&
  skipInternalRaw !== "no";
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

if (!Number.isFinite(followupAfterHours) || followupAfterHours <= 0) {
  console.error("FOLLOWUP_AFTER_HOURS must be a positive number.");
  process.exit(1);
}

if (
  !followupScanTimeMatch ||
  followupScanHour < 0 ||
  followupScanHour > 23 ||
  followupScanMinute < 0 ||
  followupScanMinute > 59
) {
  console.error(
    "FOLLOWUP_SCAN_TIME must use 24-hour HH:MM format, for example 10:00.",
  );
  process.exit(1);
}

if (
  !billScanTimeMatch ||
  billScanHour < 0 ||
  billScanHour > 23 ||
  billScanMinute < 0 ||
  billScanMinute > 59
) {
  console.error("BILL_SCAN_TIME must use 24-hour HH:MM format, for example 09:00.");
  process.exit(1);
}

if (
  !weeklyReviewTimeMatch ||
  weeklyReviewHour < 0 ||
  weeklyReviewHour > 23 ||
  weeklyReviewMinute < 0 ||
  weeklyReviewMinute > 59
) {
  console.error(
    "WEEKLY_REVIEW_TIME must use 24-hour HH:MM format, for example 19:00.",
  );
  process.exit(1);
}

if (!Number.isFinite(preMeetingMinutes) || preMeetingMinutes <= 0) {
  console.error("PRE_MEETING_MINUTES must be a positive number.");
  process.exit(1);
}

export interface ModelCostRates {
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  cacheCreationCostPerMillion: number;
  /** 1-hour cache writes; 2× base input when unset in env. */
  cacheCreation1hCostPerMillion: number;
  cacheReadCostPerMillion: number;
}

/** Claude Sonnet 5.5 — platform.claude.com/docs/en/about-claude/pricing */
const SONNET_55_COST_DEFAULTS: ModelCostRates = {
  inputCostPerMillion: 2,
  outputCostPerMillion: 10,
  cacheCreationCostPerMillion: 2.5,
  cacheCreation1hCostPerMillion: 4,
  cacheReadCostPerMillion: 0.1,
};

/** Claude Haiku 5.5 (prompts up to 100K tokens) */
const HAIKU_55_COST_DEFAULTS: ModelCostRates = {
  inputCostPerMillion: 0.1,
  outputCostPerMillion: 0.5,
  cacheCreationCostPerMillion: 0.125,
  cacheCreation1hCostPerMillion: 0.2,
  cacheReadCostPerMillion: 0.01,
};

/** OpenRouter google/gemma-4-31b-it — openrouter.ai/google/gemma-4-31b-it */
const GEMMA_CLOUD_COST_DEFAULTS: ModelCostRates = {
  inputCostPerMillion: 0.09,
  outputCostPerMillion: 0.34,
  cacheCreationCostPerMillion: 0,
  cacheCreation1hCostPerMillion: 0,
  cacheReadCostPerMillion: 0.05,
};

const ZERO_COST_RATES: ModelCostRates = {
  inputCostPerMillion: 0,
  outputCostPerMillion: 0,
  cacheCreationCostPerMillion: 0,
  cacheCreation1hCostPerMillion: 0,
  cacheReadCostPerMillion: 0,
};

function readRate(name: string, fallback: number): number {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) {
    return fallback;
  }

  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0) {
    console.error(`${name} must be a non-negative number.`);
    process.exit(1);
  }

  return value;
}

function readCostRates(
  prefix: "LLM" | "BACKGROUND" | "GEMMA_CLOUD",
  defaults: ModelCostRates,
): ModelCostRates {
  return {
    inputCostPerMillion: readRate(
      `${prefix}_INPUT_COST_PER_MILLION`,
      defaults.inputCostPerMillion,
    ),
    outputCostPerMillion: readRate(
      `${prefix}_OUTPUT_COST_PER_MILLION`,
      defaults.outputCostPerMillion,
    ),
    cacheCreationCostPerMillion: readRate(
      `${prefix}_CACHE_CREATION_COST_PER_MILLION`,
      defaults.cacheCreationCostPerMillion,
    ),
    cacheCreation1hCostPerMillion: readRate(
      `${prefix}_CACHE_CREATION_1H_COST_PER_MILLION`,
      defaults.cacheCreation1hCostPerMillion,
    ),
    cacheReadCostPerMillion: readRate(
      `${prefix}_CACHE_READ_COST_PER_MILLION`,
      defaults.cacheReadCostPerMillion,
    ),
  };
}

export const config = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN!,
  ownerTelegramId,
  googleSheetId,
  briefTime,
  briefHour,
  briefMinute,
  followupAfterHours,
  followupScanTime,
  followupScanHour,
  followupScanMinute,
  billScanTime,
  billScanHour,
  billScanMinute,
  weeklyReviewTime,
  weeklyReviewHour,
  weeklyReviewMinute,
  preMeetingMinutes,
  skipInternalRecurring,
  llmProvider: provider,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  claudeModel: process.env.CLAUDE_MODEL ?? "",
  backgroundModel:
    process.env.BACKGROUND_MODEL?.trim() || "claude-haiku-5-5",
  openRouterApiKey: process.env.OPENROUTER_API_KEY ?? "",
  openRouterModel: process.env.OPENROUTER_MODEL ?? "",
  sarvamApiKey: process.env.SARVAM_API_KEY?.trim() ?? "",
  gemmaCloudModel:
    process.env.GEMMA_CLOUD_MODEL?.trim() || "google/gemma-4-31b-it",
  localLlmBaseUrl:
    process.env.LOCAL_LLM_BASE_URL?.trim() || "http://127.0.0.1:11434/v1",
  localLlmModel: process.env.LOCAL_LLM_MODEL?.trim() || "gemma4:e4b",
  chatCostRates: readCostRates("LLM", SONNET_55_COST_DEFAULTS),
  backgroundCostRates: readCostRates("BACKGROUND", HAIKU_55_COST_DEFAULTS),
  gemmaCloudCostRates: readCostRates("GEMMA_CLOUD", GEMMA_CLOUD_COST_DEFAULTS),
  localCostRates: ZERO_COST_RATES,
  backupPassword: process.env.BACKUP_PASSWORD?.trim() ?? "",
  cursorApiKey: process.env.CURSOR_API_KEY?.trim() ?? "",
  githubToken: process.env.GITHUB_TOKEN?.trim() ?? "",
  githubOwner: "Vishnu99229",
  githubRepo: "aadi-agent",
  cursorApiBase: "https://api.cursor.com",
} as const;
