import { config, type ModelCostRates } from "./config.js";
import {
  insertUsageLog,
  listUsageLogs,
  type UsageLogRow,
} from "./db.js";

const TIME_ZONE = "Asia/Kolkata";
const HAIKU_LONG_CONTEXT_TOKENS = 100_000;

export const USAGE_TASKS = [
  "chat",
  "brief",
  "document",
  "contract_review",
  "drafting",
  "meeting_brief",
  "account_status",
  "memory_extraction",
  "classification",
  "other",
] as const;

export type UsageTask = (typeof USAGE_TASKS)[number];

export type EffortLevel = "low" | "medium" | "high";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number;
  cacheWrite1hTokens?: number;
  cacheReadTokens?: number;
  /** When true, inputTokens already includes cache write + read. */
  inputIncludesCacheTokens?: boolean;
}

export function isUsageTask(value: string): value is UsageTask {
  return (USAGE_TASKS as readonly string[]).includes(value);
}

export function isHaiku55Model(model: string): boolean {
  return /haiku-5-5/i.test(model);
}

export function isDeepSeekModel(model: string): boolean {
  return /deepseek/i.test(model) || model === config.deepseekModel;
}

/**
 * DeepSeek off-peak (api-docs.deepseek.com/quick_start/pricing):
 * peak is 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday.
 * All other hours (including weekends) are off-peak (half price).
 */
export function isDeepSeekOffPeak(now = new Date()): boolean {
  const day = now.getUTCDay();
  if (day === 0 || day === 6) {
    return true;
  }
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const morningPeak = minutes >= 60 && minutes < 4 * 60;
  const middayPeak = minutes >= 6 * 60 && minutes < 10 * 60;
  return !morningPeak && !middayPeak;
}

/** Milliseconds until the next DeepSeek off-peak instant, or 0 if already off-peak. */
export function msUntilDeepSeekOffPeak(now = new Date()): number {
  if (isDeepSeekOffPeak(now)) {
    return 0;
  }
  const endHour = now.getUTCHours() < 4 ? 4 : 10;
  const end = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    endHour,
    0,
    0,
    0,
  );
  return Math.max(0, end - now.getTime());
}

export function promptLengthTokens(usage: TokenUsage): number {
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  if (usage.inputIncludesCacheTokens) {
    return usage.inputTokens;
  }
  return usage.inputTokens + cacheWrite + cacheRead;
}

function with1hWriteRate(rates: ModelCostRates): ModelCostRates {
  if (rates.cacheCreation1hCostPerMillion > 0) {
    return rates;
  }
  return {
    ...rates,
    cacheCreation1hCostPerMillion: rates.inputCostPerMillion * 2,
  };
}

export function ratesForModel(
  model: string,
  promptTokens: number,
  now = new Date(),
): ModelCostRates {
  if (isHaiku55Model(model) || model === config.backgroundModel) {
    const base = with1hWriteRate(config.backgroundCostRates);
    if (promptTokens <= HAIKU_LONG_CONTEXT_TOKENS) {
      return base;
    }
    return {
      inputCostPerMillion: base.inputCostPerMillion * 5,
      outputCostPerMillion: base.outputCostPerMillion * 5,
      cacheCreationCostPerMillion: base.cacheCreationCostPerMillion * 5,
      cacheCreation1hCostPerMillion: base.cacheCreation1hCostPerMillion * 5,
      cacheReadCostPerMillion: base.cacheReadCostPerMillion * 5,
    };
  }
  if (/gemma/i.test(model) || model === config.gemmaCloudModel) {
    return with1hWriteRate(config.gemmaCloudCostRates);
  }
  if (isDeepSeekModel(model)) {
    const base = with1hWriteRate(config.deepseekCostRates);
    if (isDeepSeekOffPeak(now)) {
      return base;
    }
    return {
      inputCostPerMillion: base.inputCostPerMillion * 2,
      outputCostPerMillion: base.outputCostPerMillion * 2,
      cacheCreationCostPerMillion: base.cacheCreationCostPerMillion * 2,
      cacheCreation1hCostPerMillion: base.cacheCreation1hCostPerMillion * 2,
      cacheReadCostPerMillion: base.cacheReadCostPerMillion * 2,
    };
  }
  return with1hWriteRate(config.chatCostRates);
}

export function estimateLlmCostUsd(
  usage: TokenUsage,
  model: string,
): number {
  const rates = ratesForModel(model, promptLengthTokens(usage));
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const cacheWrite1h = Math.min(usage.cacheWrite1hTokens ?? 0, cacheWrite);
  const cacheWrite5m = cacheWrite - cacheWrite1h;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const regularInput = usage.inputIncludesCacheTokens
    ? Math.max(0, usage.inputTokens - cacheWrite - cacheRead)
    : usage.inputTokens;
  return (
    (regularInput * rates.inputCostPerMillion +
      usage.outputTokens * rates.outputCostPerMillion +
      cacheWrite5m * rates.cacheCreationCostPerMillion +
      cacheWrite1h * rates.cacheCreation1hCostPerMillion +
      cacheRead * rates.cacheReadCostPerMillion) /
    1_000_000
  );
}

export function logLlmUsage(entry: {
  task: UsageTask;
  model: string;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  costUsd: number;
}): void {
  insertUsageLog({
    timestamp: new Date().toISOString(),
    task: entry.task,
    model: entry.model,
    input_tokens: Math.max(0, Math.round(entry.inputTokens)),
    cache_write_tokens: Math.max(0, Math.round(entry.cacheWriteTokens)),
    cache_read_tokens: Math.max(0, Math.round(entry.cacheReadTokens)),
    output_tokens: Math.max(0, Math.round(entry.outputTokens)),
    cost_usd: entry.costUsd,
  });
}

export function logAnthropicUsage(
  task: UsageTask,
  model: string,
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation?: {
      ephemeral_1h_input_tokens?: number;
    } | null;
  },
): number {
  return logTokenUsage(task, model, {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    cacheWrite1hTokens: usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
  });
}

export function logTokenUsage(
  task: UsageTask,
  model: string,
  usage: TokenUsage,
): number {
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const inputTokens = usage.inputIncludesCacheTokens
    ? Math.max(0, usage.inputTokens - cacheWriteTokens - cacheReadTokens)
    : usage.inputTokens;
  const costUsd = estimateLlmCostUsd(usage, model);
  logLlmUsage({
    task,
    model,
    inputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    outputTokens: usage.outputTokens,
    costUsd,
  });
  return costUsd;
}

function kolkataYmd(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function startOfKolkataDay(ymd: string): Date {
  return new Date(`${ymd}T00:00:00+05:30`);
}

function addCalendarDays(ymd: string, days: number): string {
  const date = startOfKolkataDay(ymd);
  date.setUTCDate(date.getUTCDate() + days);
  return kolkataYmd(date);
}

export interface CostWindow {
  label: string;
  fromIso: string;
  toIso: string;
}

export function costWindows(now = new Date()): CostWindow[] {
  const today = kolkataYmd(now);
  const tomorrow = addCalendarDays(today, 1);
  const weekStart = addCalendarDays(today, -6);
  const monthStart = `${today.slice(0, 7)}-01`;
  const toIso = now.toISOString();
  return [
    {
      label: "Today",
      fromIso: startOfKolkataDay(today).toISOString(),
      toIso,
    },
    {
      label: "Last 7 days",
      fromIso: startOfKolkataDay(weekStart).toISOString(),
      toIso,
    },
    {
      label: "This month",
      fromIso: startOfKolkataDay(monthStart).toISOString(),
      toIso: startOfKolkataDay(tomorrow).toISOString(),
    },
  ];
}

function money(value: number): string {
  if (value === 0) {
    return "$0.00";
  }
  if (value < 0.01) {
    return `$${value.toFixed(4)}`;
  }
  return `$${value.toFixed(2)}`;
}

function cacheHitRate(rows: UsageLogRow[]): number | null {
  let cacheRead = 0;
  let totalInput = 0;
  for (const row of rows) {
    cacheRead += row.cache_read_tokens;
    totalInput +=
      row.input_tokens + row.cache_write_tokens + row.cache_read_tokens;
  }
  if (totalInput <= 0) {
    return null;
  }
  return cacheRead / totalInput;
}

function percent(value: number | null): string {
  if (value === null) {
    return "n/a";
  }
  return `${Math.round(value * 100)}%`;
}

function summarize(rows: UsageLogRow[]): string[] {
  if (rows.length === 0) {
    return ["  (no LLM calls logged)"];
  }
  const byTask = new Map<string, UsageLogRow[]>();
  for (const row of rows) {
    const list = byTask.get(row.task) ?? [];
    list.push(row);
    byTask.set(row.task, list);
  }
  const lines: string[] = [];
  const tasks = [...byTask.keys()].sort();
  for (const task of tasks) {
    const taskRows = byTask.get(task) ?? [];
    const taskCost = taskRows.reduce((sum, row) => sum + row.cost_usd, 0);
    lines.push(
      `  ${task}: ${taskRows.length} calls, ${money(taskCost)}, cache hit ${percent(cacheHitRate(taskRows))}`,
    );
    const byModel = new Map<string, UsageLogRow[]>();
    for (const row of taskRows) {
      const list = byModel.get(row.model) ?? [];
      list.push(row);
      byModel.set(row.model, list);
    }
    for (const model of [...byModel.keys()].sort()) {
      const modelRows = byModel.get(model) ?? [];
      const modelCost = modelRows.reduce((sum, row) => sum + row.cost_usd, 0);
      lines.push(
        `    ${model}: ${modelRows.length} calls, ${money(modelCost)}`,
      );
    }
  }
  return lines;
}

export function formatCostReport(now = new Date()): string {
  const sections = [`Aadi LLM cost (${TIME_ZONE})`, ""];
  for (const window of costWindows(now)) {
    const rows = listUsageLogs(window.fromIso, window.toIso);
    const total = rows.reduce((sum, row) => sum + row.cost_usd, 0);
    sections.push(`${window.label} — ${money(total)}`);
    sections.push(...summarize(rows));
    sections.push("");
  }
  sections.push(
    "Cache hit rate is cache_read ÷ (uncached input + cache writes + cache reads). Counts only; no message content is stored.",
  );
  return sections.join("\n").trim();
}
