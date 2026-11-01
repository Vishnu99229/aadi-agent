import { buildSummarizerInput } from "../src/chat_history.ts";
import type { StoredMessage } from "../src/db.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function msg(content: string): StoredMessage {
  return {
    id: 1,
    role: "user",
    content,
    created_at: "2026-11-01T00:00:00Z",
    tool_name: null,
  };
}

function fold(content: string): string {
  return buildSummarizerInput([msg(content)], "");
}

function assertSecretRedacted(secret: string, label: string): void {
  const output = fold(`please remember ${secret}`);
  assert(!output.includes(secret), `${label}: secret still in output`);
  assert(output.includes("[redacted]"), `${label}: missing [redacted]`);
}

function main(): void {
  assertSecretRedacted(
    "sk-ant-api03-XXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "anthropic",
  );
  assertSecretRedacted(
    "sk-abcdef0123456789abcdef0123456789",
    "deepseek-hex",
  );
  assertSecretRedacted(
    "ghp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "github-pat-classic",
  );
  assertSecretRedacted(
    "gho_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "github-oauth",
  );
  assertSecretRedacted(
    "ghs_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "github-app",
  );
  assertSecretRedacted("crsr_XXXXXXXXXXXXXXXXXXXXXXXXXXXX", "cursor");
  assertSecretRedacted(
    "Authorization: Bearer XXXXXXXXXXXXXXXX",
    "bearer",
  );
  assertSecretRedacted("password hunter2", "password");
  assertSecretRedacted("OTP 123456", "otp");
  assertSecretRedacted("card 4111 1111 1111 1111", "card");

  const control = "the meeting is at 3pm";
  const controlOut = fold(control);
  assert(controlOut.includes(control), "control sentence must pass through");
  assert(!controlOut.includes("[redacted]"), "control must not be redacted");

  console.log("test-summarizer-redaction: ok");
}

main();
