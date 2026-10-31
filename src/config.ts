import "dotenv/config";
import {
  REQUIRED_ENV_VARS,
  failIfMissingEnv,
  requireOwnerTelegramId,
} from "./security/env_guard.js";

export type LlmProvider = "claude";

function readProvider(): LlmProvider {
  const value = process.env.LLM_PROVIDER?.trim() || "claude";
  if (value === "claude") {
    return value;
  }
  console.error('LLM_PROVIDER must be "claude".');
  process.exit(1);
}

const provider = readProvider();

failIfMissingEnv([...REQUIRED_ENV_VARS]);

const ownerTelegramId = requireOwnerTelegramId();

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
const preMeetingMinutes = (() => {
  const raw = (process.env.PRE_MEETING_MINUTES?.trim() || "15,10,5")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const parsed = raw.map((part) => Number(part));
  if (parsed.some((value) => !Number.isFinite(value) || value <= 0)) {
    console.error(
      "PRE_MEETING_MINUTES must be a comma-separated list of positive numbers, for example 15,10,5.",
    );
    process.exit(1);
  }
  const unique = Array.from(new Set(parsed)).sort((a, b) => b - a);
  if (unique.length === 0) {
    console.error("PRE_MEETING_MINUTES must contain at least one value.");
    process.exit(1);
  }
  return unique;
})();
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

function parseClock(raw: string, label: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(raw.trim());
  const hour = Number(match?.[1]);
  const minute = Number(match?.[2]);
  if (
    !match ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    console.error(`${label} must use 24-hour HH:MM format, for example 10:00.`);
    process.exit(1);
  }
  return hour * 60 + minute;
}

function parseClockRange(
  raw: string,
  fallback: string,
  label: string,
): { startMinutes: number; endMinutes: number } {
  const value = raw.trim() || fallback;
  const match = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(value);
  if (!match) {
    console.error(`${label} must use HH:MM-HH:MM, for example ${fallback}.`);
    process.exit(1);
  }
  const startMinutes = parseClock(match[1]!, label);
  const endMinutes = parseClock(match[2]!, label);
  if (endMinutes <= startMinutes) {
    console.error(`${label} end must be after start.`);
    process.exit(1);
  }
  return { startMinutes, endMinutes };
}

function parsePositiveNumber(raw: string | undefined, fallback: number, label: string): number {
  const value = Number(raw?.trim() || String(fallback));
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`${label} must be a positive number.`);
    process.exit(1);
  }
  return value;
}

function parseNonNegativeNumber(
  raw: string | undefined,
  fallback: number,
  label: string,
): number {
  const value = Number(raw?.trim() || String(fallback));
  if (!Number.isFinite(value) || value < 0) {
    console.error(`${label} must be a non-negative number.`);
    process.exit(1);
  }
  return value;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  const value = raw?.trim().toLowerCase();
  if (!value) {
    return fallback;
  }
  if (value === "true" || value === "1" || value === "yes") {
    return true;
  }
  if (value === "false" || value === "0" || value === "no") {
    return false;
  }
  return fallback;
}

const meetingHours = parseClockRange(
  process.env.MEETING_HOURS ?? "",
  "10:00-18:30",
  "MEETING_HOURS",
);
const meetingBreak = parseClockRange(
  process.env.MEETING_BREAK ?? "",
  "13:00-14:00",
  "MEETING_BREAK",
);
const meetingBufferMinutes = parseNonNegativeNumber(
  process.env.MEETING_BUFFER_MINUTES,
  15,
  "MEETING_BUFFER_MINUTES",
);
const meetingDefaultMinutes = parsePositiveNumber(
  process.env.MEETING_DEFAULT_MINUTES,
  30,
  "MEETING_DEFAULT_MINUTES",
);
const meetingSlotsToOffer = parsePositiveNumber(
  process.env.MEETING_SLOTS_TO_OFFER,
  3,
  "MEETING_SLOTS_TO_OFFER",
);
const meetingMinNoticeHours = parseNonNegativeNumber(
  process.env.MEETING_MIN_NOTICE_HOURS,
  4,
  "MEETING_MIN_NOTICE_HOURS",
);
const meetingHorizonDays = parsePositiveNumber(
  process.env.MEETING_HORIZON_DAYS,
  7,
  "MEETING_HORIZON_DAYS",
);
const autoBookDelayMinutes = parseNonNegativeNumber(
  process.env.AUTO_BOOK_DELAY_MINUTES,
  10,
  "AUTO_BOOK_DELAY_MINUTES",
);
const autoBookDailyCap = parsePositiveNumber(
  process.env.AUTO_BOOK_DAILY_CAP,
  5,
  "AUTO_BOOK_DAILY_CAP",
);
const autoBookMinConfidence = Number(
  process.env.AUTO_BOOK_MIN_CONFIDENCE?.trim() || "0.85",
);
if (
  !Number.isFinite(autoBookMinConfidence) ||
  autoBookMinConfidence < 0 ||
  autoBookMinConfidence > 1
) {
  console.error("AUTO_BOOK_MIN_CONFIDENCE must be between 0 and 1.");
  process.exit(1);
}
const meetingTimezone =
  process.env.MEETING_TIMEZONE?.trim() || "Asia/Kolkata";
const meetingHoldsOnPropose = parseBool(
  process.env.MEETING_HOLDS_ON_PROPOSE,
  false,
);
const autoBook = parseBool(process.env.AUTO_BOOK, true);
const meetingModeRaw = (process.env.MEETING_MODE?.trim().toLowerCase() || "auto");
if (meetingModeRaw !== "auto" && meetingModeRaw !== "assist") {
  console.error("MEETING_MODE must be auto or assist.");
  process.exit(1);
}
const meetingMode = meetingModeRaw as "auto" | "assist";
const autoSendDailyCap = parsePositiveNumber(
  process.env.AUTO_SEND_DAILY_CAP,
  15,
  "AUTO_SEND_DAILY_CAP",
);
const meetingTestSenders = (process.env.MEETING_TEST_SENDERS ?? "")
  .split(",")
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean);

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

/** Gemini 3.6 Flash — ai.google.dev/pricing (OpenAI-compat). */
const GEMINI_FLASH_COST_DEFAULTS: ModelCostRates = {
  inputCostPerMillion: 0.075,
  outputCostPerMillion: 0.3,
  cacheCreationCostPerMillion: 0,
  cacheCreation1hCostPerMillion: 0,
  cacheReadCostPerMillion: 0,
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

/** DeepSeek Flash off-peak (api-docs.deepseek.com/quick_start/pricing). Peak is 2×. */
const DEEPSEEK_FLASH_OFFPEAK_DEFAULTS: ModelCostRates = {
  inputCostPerMillion: 0.15,
  outputCostPerMillion: 0.6,
  cacheCreationCostPerMillion: 0,
  cacheCreation1hCostPerMillion: 0,
  cacheReadCostPerMillion: 0.003,
};

function readCostRates(
  prefix: "LLM" | "BACKGROUND" | "GEMINI" | "DEEPSEEK",
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
  geminiApiKey: process.env.GEMINI_API_KEY?.trim() ?? "",
  // 1.5 Flash is shut down. OpenAI-compat docs currently show gemini-3.8-flash;
  // that id 503'd with high demand on a new key, so the code default is 3.6 Flash
  // (still production, image+PDF). Override with GEMINI_MODEL.
  geminiModel: process.env.GEMINI_MODEL?.trim() || "gemini-3.6-flash",
  deepseekApiKey: process.env.DEEPSEEK_API_KEY?.trim() ?? "",
  // Current DeepSeek API ids (api-docs.deepseek.com). Legacy deepseek-chat /
  // deepseek-reasoner names are retired; override via env if needed.
  deepseekModel: process.env.DEEPSEEK_MODEL?.trim() || "deepseek-flash",
  deepseekReasonerModel:
    process.env.DEEPSEEK_REASONER_MODEL?.trim() || "deepseek-flash",
  sarvamApiKey: process.env.SARVAM_API_KEY?.trim() ?? "",
  localLlmBaseUrl:
    process.env.LOCAL_LLM_BASE_URL?.trim() || "http://127.0.0.1:11434/v1",
  localLlmModel: process.env.LOCAL_LLM_MODEL?.trim() || "gemma4:e4b",
  chatCostRates: readCostRates("LLM", SONNET_55_COST_DEFAULTS),
  backgroundCostRates: readCostRates("BACKGROUND", HAIKU_55_COST_DEFAULTS),
  geminiCostRates: readCostRates("GEMINI", GEMINI_FLASH_COST_DEFAULTS),
  deepseekCostRates: readCostRates("DEEPSEEK", DEEPSEEK_FLASH_OFFPEAK_DEFAULTS),
  localCostRates: ZERO_COST_RATES,
  backupPassword: process.env.BACKUP_PASSWORD?.trim() ?? "",
  googleVisionApiKey: process.env.GOOGLE_VISION_API_KEY?.trim() ?? "",
  cursorApiKey: process.env.CURSOR_API_KEY?.trim() ?? "",
  githubToken: process.env.GITHUB_TOKEN?.trim() ?? "",
  githubOwner: "Vishnu99229",
  githubRepo: "aadi-agent",
  cursorApiBase: "https://api.cursor.com",
  autoDeploy: ["true", "1", "yes"].includes(
    (process.env.AUTO_DEPLOY?.trim().toLowerCase() ?? ""),
  ),
  meetingTimezone,
  meetingHours,
  meetingBreak,
  meetingBufferMinutes,
  meetingDefaultMinutes,
  meetingSlotsToOffer,
  meetingMinNoticeHours,
  meetingHorizonDays,
  meetingHoldsOnPropose,
  autoBook,
  meetingMode,
  autoBookDelayMinutes,
  autoBookDailyCap,
  autoSendDailyCap,
  autoBookMinConfidence,
  meetingTestSenders,
} as const;
