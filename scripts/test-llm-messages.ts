import "dotenv/config";

process.env.LLM_PROVIDER ??= "claude";
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.OWNER_TELEGRAM_ID ??= "1";
process.env.CLAUDE_MODEL ??= "claude-haiku-4-5";
process.env.ANTHROPIC_API_KEY ??= "test-key";
process.env.BRIEF_TIME ??= "08:00";
process.env.GEMINI_API_KEY ??= "test-key";

const { toOpenRouterMessages } = await import("../src/llm.ts");

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const system = { cacheable: "sys", dynamic: "" };

// Case 1: assistant with text and no tool calls — tool_calls key must be absent.
const emptyToolCallsResult = toOpenRouterMessages(system, [
  { role: "user", content: "hi" },
  { role: "assistant", textParts: ["Hello"], toolCalls: [] },
]);
const assistant1 = emptyToolCallsResult[emptyToolCallsResult.length - 1];
assert(assistant1.role === "assistant", "last message is assistant");
assert(
  !("tool_calls" in assistant1),
  "tool_calls key must be omitted when toolCalls is empty",
);
const serialized = JSON.stringify(assistant1);
assert(
  !serialized.includes("tool_calls"),
  `serialized assistant must not contain tool_calls key: ${serialized}`,
);

// Case 2: assistant with real tool calls — tool_calls key must be present and populated.
const populatedResult = toOpenRouterMessages(system, [
  { role: "user", content: "run" },
  {
    role: "assistant",
    textParts: [],
    toolCalls: [{ id: "t1", name: "foo", input: { x: 1 } }],
  },
]);
const assistant2 = populatedResult[populatedResult.length - 1];
assert(assistant2.role === "assistant", "last message is assistant (case 2)");
assert(
  "tool_calls" in assistant2 && Array.isArray(assistant2.tool_calls),
  "tool_calls present when non-empty",
);
assert(
  (assistant2.tool_calls as unknown[]).length === 1,
  "tool_calls has one entry",
);

console.log("test-llm-messages: OK");
