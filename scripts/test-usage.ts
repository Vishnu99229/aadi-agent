import "dotenv/config";

function ensureTestEnv(): void {
  process.env.LLM_PROVIDER ??= "claude";
  process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
  process.env.OWNER_TELEGRAM_ID ??= "1";
  process.env.CLAUDE_MODEL ??= "claude-sonnet-5-5";
  process.env.ANTHROPIC_API_KEY ??= "test-key";
  process.env.BRIEF_TIME ??= "08:00";
}

ensureTestEnv();

const { deleteUsageLogsByTimestamp, insertUsageLog } = await import(
  "../src/db.ts"
);
const {
  costWindows,
  estimateLlmCostUsd,
  formatCostReport,
  ratesForModel,
} = await import("../src/usage.ts");
const { applyTaskBackend, getTaskBackend } = await import(
  "../src/chat_backend.ts"
);

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const haikuCheap = ratesForModel("claude-haiku-5-5", 1_000);
assert(haikuCheap.inputCostPerMillion === 0.1, "haiku ≤100K input $0.10");
assert(haikuCheap.outputCostPerMillion === 0.5, "haiku ≤100K output $0.50");
assert(haikuCheap.cacheCreationCostPerMillion === 0.125, "haiku 5m write");
assert(haikuCheap.cacheCreation1hCostPerMillion === 0.2, "haiku 1h write");
assert(haikuCheap.cacheReadCostPerMillion === 0.01, "haiku cache read");

const haikuLong = ratesForModel("claude-haiku-5-5", 100_001);
assert(haikuLong.inputCostPerMillion === 0.5, "haiku >100K input $0.50");
assert(haikuLong.outputCostPerMillion === 2.5, "haiku >100K output $2.50");
assert(haikuLong.cacheReadCostPerMillion === 0.05, "haiku >100K cache read");

const sonnet = ratesForModel("claude-sonnet-5-5", 8_000);
assert(sonnet.inputCostPerMillion === 2, "sonnet input");
assert(sonnet.cacheCreation1hCostPerMillion === 4, "sonnet 1h write");
assert(sonnet.cacheReadCostPerMillion === 0.1, "sonnet cache read 5%");

const uncached = estimateLlmCostUsd(
  { inputTokens: 1_000_000, outputTokens: 0 },
  "claude-sonnet-5-5",
);
assert(Math.abs(uncached - 2) < 1e-9, `sonnet 1M input is $2, got ${uncached}`);

const cached = estimateLlmCostUsd(
  {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 1_000_000,
  },
  "claude-sonnet-5-5",
);
assert(Math.abs(cached - 0.1) < 1e-9, `sonnet 1M cache read is $0.10, got ${cached}`);

const now = new Date("2026-10-15T12:00:00+05:30");
const windows = costWindows(now);
assert(windows[0]?.label === "Today", "today window");
assert(windows[0]?.fromIso.startsWith("2026-10-14T18:30:00"), windows[0]?.fromIso ?? "");
assert(windows[2]?.fromIso.startsWith("2026-09-30T18:30:00"), "month starts 1 Oct IST");

const stamps = [
  "2026-10-15T06:00:00.000Z",
  "2026-10-15T07:00:00.000Z",
  "2026-10-10T06:00:00.000Z",
];
try {
  insertUsageLog({
    timestamp: stamps[0]!,
    task: "chat",
    model: "claude-sonnet-5-5",
    input_tokens: 900,
    cache_write_tokens: 100,
    cache_read_tokens: 4000,
    output_tokens: 200,
    cost_usd: 0.0123,
  });
  insertUsageLog({
    timestamp: stamps[1]!,
    task: "chat",
    model: "claude-haiku-5-5",
    input_tokens: 200,
    cache_write_tokens: 0,
    cache_read_tokens: 800,
    output_tokens: 80,
    cost_usd: 0.001,
  });
  insertUsageLog({
    timestamp: stamps[2]!,
    task: "brief",
    model: "claude-sonnet-5-5",
    input_tokens: 5000,
    cache_write_tokens: 2000,
    cache_read_tokens: 0,
    output_tokens: 800,
    cost_usd: 0.04,
  });

  const report = formatCostReport(now);
  assert(report.includes("Today"), "report today");
  assert(report.includes("claude-sonnet-5-5"), "sonnet in report");
  assert(report.includes("claude-haiku-5-5"), "haiku in report");
  assert(report.includes("cache hit"), "cache hit rate");
  assert(report.includes("Last 7 days"), "seven days");
  assert(report.includes("This month"), "month");
} finally {
  for (const stamp of stamps) {
    deleteUsageLogsByTimestamp(stamp);
  }
}

const before = getTaskBackend("chat");
const switched = applyTaskBackend("chat", "haiku");
assert(switched.switched, "haiku switch");
assert(getTaskBackend("chat") === "haiku", "chat is haiku");
applyTaskBackend("chat", before);

console.log("Usage and cost checks passed.");
