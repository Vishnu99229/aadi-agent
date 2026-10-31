import "dotenv/config";

process.env.AADI_DB_PATH = ":memory:";
process.env.LLM_PROVIDER = "claude";
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.OWNER_TELEGRAM_ID = "1";
process.env.CLAUDE_MODEL = "claude-sonnet-test";
process.env.BACKGROUND_MODEL = "claude-haiku-test";
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.DEEPSEEK_API_KEY = "test-deepseek";
process.env.GEMINI_API_KEY = "";
process.env.BRIEF_TIME = "08:00";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const FIXTURE = `Vendor: Pinnacle Communications
Quote for number masking API support.
Due date: 15 November 2026
Amount: ₹48,000 plus GST
Action needed: email procurement the signed quote.`;

const {
  documentExtractionGaps,
  sourceHasDates,
  sourceHasMoney,
  analyzeText,
} = await import("../src/document_llm.ts");
const { deepSeekJsonMode, setCompleteForTests } = await import("../src/llm.ts");

assert(sourceHasDates(FIXTURE), "fixture contains a date");
assert(sourceHasMoney(FIXTURE), "fixture contains a rupee amount");
assert(!sourceHasDates("no calendar facts here"), "plain text has no date");
assert(!sourceHasMoney("AMOUNT DUE with no figure"), "AMOUNT DUE is not money");
assert(
  documentExtractionGaps({ dates: [], money: [] }, FIXTURE).join(",") ===
    "dates,money",
  "empty extraction against fixture is a gap",
);
assert(
  documentExtractionGaps(
    { dates: ["15 November 2026"], money: ["₹48,000"] },
    FIXTURE,
  ).length === 0,
  "filled extraction has no gap",
);
assert(
  documentExtractionGaps({ dates: [], money: [] }, "hello there").length === 0,
  "empty extraction is fine when the source has no date or amount",
);

const schema = {
  type: "object",
  properties: {
    dates: { type: "array", items: { type: "string" } },
    money: { type: "array", items: { type: "string" } },
  },
  required: ["dates", "money"],
};
const mode = deepSeekJsonMode(schema);
assert(mode.responseFormat?.type === "json_object", "DeepSeek uses json_object");
assert(
  !JSON.stringify(mode).includes("json_schema"),
  "DeepSeek must not send json_schema",
);
assert(
  mode.systemExtra?.includes("json") === true,
  "JSON Output prompt includes json",
);
assert(
  mode.systemExtra?.includes("JSON schema") === true,
  "schema is placed in the prompt",
);
assert(deepSeekJsonMode(undefined).responseFormat === undefined, "no schema → no json mode");

let calls = 0;
setCompleteForTests(async () => {
  calls += 1;
  if (calls === 1) {
    return {
      textParts: [
        JSON.stringify({
          tag: "work",
          document_type: "quote",
          summary_bullets: ["Quote"],
          dates: [],
          money: [],
          risks: [],
          action_items: [],
        }),
      ],
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 },
      stopReason: "end_turn" as const,
    };
  }
  return {
    textParts: [
      JSON.stringify({
        tag: "work",
        document_type: "quote",
        summary_bullets: ["Quote"],
        dates: ["15 November 2026"],
        money: ["₹48,000 plus GST"],
        risks: [],
        action_items: [],
      }),
    ],
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 },
    stopReason: "end_turn" as const,
  };
});
const retried = await analyzeText(FIXTURE, "quote");
assert(calls === 2, `empty dates/money must retry once, got ${calls} calls`);
assert(
  retried.dates.some((item) => /15 november 2026/i.test(item)),
  `retry dates=${retried.dates.join(";")}`,
);
assert(
  retried.money.some((item) => /₹/.test(item) && /48,000/.test(item)),
  `retry money=${retried.money.join(";")}`,
);

calls = 0;
const noFacts = await analyzeText("A short note with no calendar or rupees.", "note");
assert(calls === 1, `no date/amount in source must not retry, got ${calls}`);
assert(noFacts.dates.length === 0 && noFacts.money.length === 0, "empty stays empty");
setCompleteForTests(undefined);

console.log("test-deepseek-extract: ok");
