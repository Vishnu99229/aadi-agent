import "dotenv/config";
import { readFile } from "node:fs/promises";

process.env.AADI_DB_PATH = ":memory:";
process.env.LLM_PROVIDER = "claude";
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.OWNER_TELEGRAM_ID = "1";
process.env.CLAUDE_MODEL = "claude-sonnet-test";
process.env.BACKGROUND_MODEL = "claude-haiku-test";
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.DEEPSEEK_API_KEY = "test-deepseek";
process.env.GEMINI_API_KEY = "test-gemini";
process.env.BRIEF_TIME = "08:00";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const {
  CREDIT_FLAG_MS,
  clearLlmBackendFlagsForTests,
  flagLlmBackend,
  formatCreditHealthLine,
  getFallbackChain,
  isLlmBackendFlagged,
} = await import("../src/llm_fallback.ts");
const { complete, setNamedBackendCompleteForTests } = await import(
  "../src/llm.ts"
);

function ok(text: string) {
  return {
    textParts: [text],
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 },
    stopReason: "end_turn",
  };
}

const minimal = {
  system: { cacheable: "Reply with one short line." },
  messages: [{ role: "user" as const, content: "hello" }],
  tools: [] as [],
  skipUsageLog: true,
};

clearLlmBackendFlagsForTests();
const withKeys = getFallbackChain("deepseek");
assert(withKeys[0] === "deepseek", `chain starts with primary: ${withKeys.join(",")}`);
assert(withKeys.indexOf("gemini") === 1, `gemini follows deepseek: ${withKeys.join(",")}`);
assert(
  withKeys.indexOf("haiku") > withKeys.indexOf("gemini"),
  `anthropic after gemini: ${withKeys.join(",")}`,
);
assert(
  withKeys[withKeys.length - 1] === "claude" ||
    withKeys[withKeys.length - 1] === "haiku",
  `anthropic last: ${withKeys.join(",")}`,
);

process.env.FALLBACK_CHAIN = "deepseek,gemini";
assert(
  getFallbackChain("deepseek").join(",") === "deepseek,gemini",
  "FALLBACK_CHAIN override",
);
delete process.env.FALLBACK_CHAIN;

flagLlmBackend("haiku", "credit too low");
assert(isLlmBackendFlagged("haiku"), "haiku flagged");
assert(isLlmBackendFlagged("claude"), "claude flagged with haiku");
const noAnthropic = getFallbackChain("haiku");
assert(!noAnthropic.includes("haiku"), `flagged haiku skipped: ${noAnthropic.join(",")}`);
assert(!noAnthropic.includes("claude"), `flagged claude skipped: ${noAnthropic.join(",")}`);
assert(noAnthropic[0] === "deepseek", `next usable is deepseek: ${noAnthropic.join(",")}`);
clearLlmBackendFlagsForTests();

const before = Date.now();
flagLlmBackend("gemini", "402", before - CREDIT_FLAG_MS - 1_000);
assert(!isLlmBackendFlagged("gemini"), "expired flag is skipped");
assert(getFallbackChain("gemini").includes("gemini"), "expired gemini is usable");
clearLlmBackendFlagsForTests();

const attempted: string[] = [];
setNamedBackendCompleteForTests(async (backend) => {
  attempted.push(backend);
  if (backend === "deepseek" || backend === "gemini") {
    throw new Error(`${backend} down`);
  }
  if (backend === "haiku") {
    return ok("from haiku");
  }
  throw new Error(`${backend} unexpected`);
});
const hopped = await complete({ ...minimal, backend: "deepseek" });
assert(hopped.textParts.join("") === "from haiku", "cascade reaches haiku");
assert(
  attempted.join(",") === "deepseek,gemini,haiku",
  `order was ${attempted.join(",")}, not a Claude jump`,
);
assert(!attempted.includes("claude"), "stopped before Claude once a backend worked");
setNamedBackendCompleteForTests(undefined);
clearLlmBackendFlagsForTests();

const failed: string[] = [];
setNamedBackendCompleteForTests(async (backend) => {
  failed.push(backend);
  throw new Error(`${backend} 402 insufficient balance`);
});
let allFail = "";
try {
  await complete({ ...minimal, backend: "deepseek" });
  throw new Error("expected all backends to fail");
} catch (error) {
  allFail = error instanceof Error ? error.message : String(error);
}
assert(allFail.startsWith("All LLM backends failed:"), allFail);
assert(allFail.includes("deepseek:"), allFail);
assert(allFail.includes("gemini:"), allFail);
assert(!failed.includes("local-gemma"), "local-gemma is never in the default chain");
setNamedBackendCompleteForTests(undefined);
clearLlmBackendFlagsForTests();

flagLlmBackend("haiku", "credit too low");
const skipped: string[] = [];
setNamedBackendCompleteForTests(async (backend) => {
  skipped.push(backend);
  return ok("from deepseek");
});
const afterFlag = await complete({ ...minimal, backend: "haiku" });
assert(afterFlag.textParts.join("") === "from deepseek", "flagged Anthropic skips to deepseek");
assert(
  skipped.join(",") === "deepseek",
  `flagged Anthropic still attempted ${skipped.join(",")}`,
);
assert(!skipped.includes("haiku"), "flagged haiku is never called");
assert(!skipped.includes("claude"), "flagged claude is never called");
setNamedBackendCompleteForTests(undefined);
clearLlmBackendFlagsForTests();

assert(formatCreditHealthLine() === "llm credit: ok", formatCreditHealthLine());
flagLlmBackend("gemini", "402");
assert(
  formatCreditHealthLine().includes("gemini (402)"),
  formatCreditHealthLine(),
);
clearLlmBackendFlagsForTests();

const pdfChain = getFallbackChain("deepseek", { hasPdf: true });
assert(
  pdfChain.every((backend) => backend === "haiku" || backend === "claude"),
  `PDF chain must be Anthropic-only: ${pdfChain.join(",")}`,
);
const imageChain = getFallbackChain("deepseek", { hasImage: true });
assert(!imageChain.includes("deepseek"), `DeepSeek has no vision: ${imageChain.join(",")}`);
assert(imageChain[0] === "gemini", `image chain starts with gemini: ${imageChain.join(",")}`);

const datesSrc = await readFile(new URL("../src/important_dates.ts", import.meta.url), "utf8");
assert(
  !/backend:\s*"haiku"/.test(datesSrc),
  "important_dates must not hardcode haiku",
);
const visionSrc = await readFile(new URL("../src/document_llm.ts", import.meta.url), "utf8");
assert(
  !/IMAGE_VISION_BACKENDS\s*=\s*\["haiku"/.test(visionSrc),
  "vision backends must not start with haiku",
);
assert(
  /getFallbackChain\("gemini"/.test(visionSrc),
  "image vision routes through getFallbackChain(gemini)",
);

console.log(
  `test-llm-fallback: ok chain=${withKeys.join(",")} hopped=${attempted.join(",")}`,
);
