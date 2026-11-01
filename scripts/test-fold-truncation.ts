import {
  TOOL_STUB_MIN_CHARS,
  buildSummarizerInput,
} from "../src/chat_history.ts";
import type { StoredMessage } from "../src/db.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function msg(
  id: number,
  role: StoredMessage["role"],
  content: string,
): StoredMessage {
  return {
    id,
    role,
    content,
    created_at: "2026-10-31T00:00:00Z",
    tool_name: role === "tool" ? "read_email" : null,
  };
}

function withSentinel(length: number, at: number, sentinel: string): string {
  const start = "n".repeat(at);
  const rest = "n".repeat(Math.max(0, length - at - sentinel.length));
  return `${start}${sentinel}${rest}`.slice(0, length);
}

function testAssistantSentinelInsideNewCap(): void {
  const sentinel = "SENTINEL_FOLD_00042";
  const content = withSentinel(1200, 1000, sentinel);
  const output = buildSummarizerInput([msg(1, "assistant", content)], "");
  assert(output.includes(sentinel), "1200-char assistant sentinel at ~1000 reaches the model");
}

function testUserSentinelPastCap(): void {
  const sentinel = "SENTINEL_PAST_CAP";
  const content = withSentinel(3000, 2000, sentinel);
  const output = buildSummarizerInput([msg(1, "user", content)], "");
  assert(!output.includes(sentinel), "sentinel at ~2000 is past the 1500-char cap");
}

function testPreviousSummaryToggle(): void {
  const withPrev = buildSummarizerInput(
    [msg(1, "user", "hello")],
    "prev-summary-marker",
  );
  assert(
    withPrev.includes("Previous summary:\nprev-summary-marker\n\n"),
    "non-empty previous summary is included",
  );
  const withoutPrev = buildSummarizerInput([msg(1, "user", "hello")], "");
  assert(
    !withoutPrev.includes("Previous summary:"),
    "empty previous summary is omitted",
  );
}

function testToolCap(): void {
  const inside = "SENTINEL_TOOL_INSIDE";
  const shortTool = withSentinel(1400, 1000, inside);
  const shortOut = buildSummarizerInput([msg(1, "tool", shortTool)], "");
  assert(
    shortOut.includes(inside),
    "tool ≤1500 is not sliced (slice is a no-op)",
  );

  const past = "SENTINEL_TOOL_PAST";
  const longTool = withSentinel(2000, 1600, past);
  const longOut = buildSummarizerInput([msg(1, "tool", longTool)], "");
  assert(!longOut.includes(past), "tool >1500 that slips through is still capped");
  const toolLine = longOut.split("\n").find((line) => line.startsWith("tool: "));
  assert(toolLine !== undefined, "tool line is present");
  assert(
    toolLine!.slice("tool: ".length).length === TOOL_STUB_MIN_CHARS,
    `tool body capped at ${TOOL_STUB_MIN_CHARS}, got ${toolLine!.slice("tool: ".length).length}`,
  );
}

function testRolePrefixes(): void {
  const output = buildSummarizerInput(
    [
      msg(1, "user", "u"),
      msg(2, "assistant", "a"),
      msg(3, "tool", "t"),
    ],
    "",
  );
  assert(output.includes("user: u"), 'prefix is "user: "');
  assert(output.includes("assistant: a"), 'prefix is "assistant: "');
  assert(output.includes("tool: t"), 'prefix is "tool: "');
}

function testSecretsRedacted(): void {
  const output = buildSummarizerInput(
    [
      msg(
        1,
        "user",
        "sk-ant-api03-notarealkey password hunter2 OTP 123456",
      ),
    ],
    "",
  );
  assert(!output.includes("hunter2"), "password value is redacted");
  assert(!output.includes("123456"), "OTP digits are redacted");
}

function main(): void {
  assert(TOOL_STUB_MIN_CHARS === 1500, "per-message cap matches stub length 1500");
  testAssistantSentinelInsideNewCap();
  testUserSentinelPastCap();
  testPreviousSummaryToggle();
  testToolCap();
  testRolePrefixes();
  testSecretsRedacted();
  console.log("test-fold-truncation: ok");
}

main();
