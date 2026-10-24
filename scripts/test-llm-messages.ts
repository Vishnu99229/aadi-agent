import type { LlmMessage } from "../src/llm.ts";

function ensureTestEnv(): void {
  process.env.AADI_DB_PATH = ":memory:";
  process.env.LLM_PROVIDER ??= "claude";
  process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
  process.env.OWNER_TELEGRAM_ID ??= "1";
  process.env.CLAUDE_MODEL ??= "claude-sonnet-5-5";
  process.env.ANTHROPIC_API_KEY ??= "test-key";
  process.env.BRIEF_TIME ??= "08:00";
}

ensureTestEnv();

const { toOpenRouterMessages } = await import("../src/llm.ts");

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const system = {
  cacheable: "You are Aadi.",
  dynamic: "Current date and time in Asia/Kolkata: Saturday",
};

const messages: LlmMessage[] = [
  { role: "user", content: "What's on today?" },
  {
    role: "assistant",
    textParts: ["Checking the calendar."],
    toolCalls: [],
  },
  { role: "user", content: "And tomorrow?" },
  {
    role: "assistant",
    textParts: [],
    toolCalls: [],
  },
  {
    role: "assistant",
    textParts: ["   ", ""],
    toolCalls: [],
  },
  {
    role: "assistant",
    textParts: ["I'll look that up."],
    toolCalls: [
      {
        id: "call_1",
        name: "list_events",
        input: { account: "personal" },
        execution: "client",
      },
    ],
  },
  {
    role: "tool",
    toolCallId: "call_1",
    content: "No events.",
  },
  {
    role: "tool",
    toolCallId: "call_2",
    content: "missing",
    isError: true,
  },
  {
    role: "assistant",
    textParts: [],
    toolCalls: [
      {
        id: "call_3",
        name: "get_current_time",
        input: {},
        execution: "client",
      },
    ],
  },
];

const formatted = toOpenRouterMessages(system, messages);
const serialized = JSON.parse(JSON.stringify(formatted)) as Array<
  Record<string, unknown>
>;

assert(serialized[0]?.role === "system", "cacheable system prompt stays first");
assert(serialized[0]?.content === "You are Aadi.", "cacheable system text");
assert(serialized[1]?.role === "system", "dynamic system prompt is included");
assert(
  serialized[1]?.content === "Current date and time in Asia/Kolkata: Saturday",
  "dynamic system text",
);

const conversation = serialized.slice(2);
assert(
  conversation.length === 7,
  `expected 7 conversation messages, got ${conversation.length}`,
);
assert(conversation[0]?.role === "user", "user turns are kept");
assert(conversation[0]?.content === "What's on today?", "user text is kept");
assert(conversation[2]?.role === "user", "later user turn stays in place");
assert(
  conversation[2]?.content === "And tomorrow?",
  "empty assistant turns are removed without dropping the next user turn",
);

const historyReply = conversation[1];
assert(historyReply?.role === "assistant", "text-only history reply is kept");
assert(
  historyReply?.content === "Checking the calendar.",
  "text-only assistant content",
);
assert(
  !Object.prototype.hasOwnProperty.call(historyReply, "tool_calls"),
  "empty toolCalls must omit tool_calls",
);

assert(
  conversation.every(
    (message) =>
      !Object.prototype.hasOwnProperty.call(message, "tool_calls") ||
      (Array.isArray(message.tool_calls) && message.tool_calls.length > 0),
  ),
  "no message may serialize tool_calls as an empty array",
);
assert(
  !JSON.stringify(formatted).includes('"tool_calls":[]'),
  "serialized payload must not contain tool_calls: []",
);

const withCall = conversation[3];
assert(withCall?.role === "assistant", "assistant tool call is kept");
assert(withCall?.content === "I'll look that up.", "tool-call text is kept");
assert(Array.isArray(withCall?.tool_calls), "non-empty tool_calls is included");
const toolCalls = withCall?.tool_calls as Array<{
  id: string;
  type: string;
  function: { name: string; arguments: string };
}>;
assert(toolCalls.length === 1, "one tool call");
assert(toolCalls[0]?.id === "call_1", "tool call id");
assert(toolCalls[0]?.type === "function", "tool call type");
assert(toolCalls[0]?.function.name === "list_events", "tool call name");
assert(
  toolCalls[0]?.function.arguments === '{"account":"personal"}',
  "tool call arguments",
);

assert(conversation[4]?.role === "tool", "tool result is kept");
assert(conversation[4]?.content === "No events.", "tool result content");
assert(conversation[4]?.tool_call_id === "call_1", "tool result id");
assert(
  conversation[5]?.content === "Tool error: missing",
  "tool errors keep the error prefix",
);

const callOnly = conversation[6];
assert(callOnly?.role === "assistant", "tool-only assistant message is kept");
assert(callOnly?.content === null, "tool-only assistant content is null");
assert(
  Array.isArray(callOnly?.tool_calls) && callOnly.tool_calls.length === 1,
  "tool-only assistant still sends its tool call",
);

const noDynamic = toOpenRouterMessages(
  { cacheable: "You are Aadi." },
  [
    {
      role: "assistant",
      textParts: [],
      toolCalls: [],
    },
  ],
);
assert(noDynamic.length === 1, "empty assistant turn is dropped entirely");
assert(noDynamic[0]?.role === "system", "only the system prompt remains");

console.log("llm message formatting tests passed");
