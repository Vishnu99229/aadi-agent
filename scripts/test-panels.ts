import "dotenv/config";

function ensureTestEnv(): void {
  process.env.LLM_PROVIDER ??= "claude";
  process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
  process.env.OWNER_TELEGRAM_ID ??= "1";
  process.env.CLAUDE_MODEL ??= "claude-haiku-4-5";
  process.env.ANTHROPIC_API_KEY ??= "test-key";
  process.env.BRIEF_TIME ??= "08:00";
}

ensureTestEnv();

const { looksLikeDeferredAction } = await import("../src/deferred_action.ts");
const { isSelfSentRecipient, parseAddressList } = await import("../src/mail_helpers.ts");

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

assert(looksLikeDeferredAction("Let me check the email for you."), "let me check");
assert(looksLikeDeferredAction("I'll look that up."), "I'll look");
assert(looksLikeDeferredAction("I will check the inbox."), "I will check");
assert(looksLikeDeferredAction("Let me find that thread."), "let me find");
assert(!looksLikeDeferredAction("The email is from Priya."), "plain answer is not deferred");

const named = parseAddressList('"Priya Sharma" <priya@pinnacle.in>');
assert(named[0]?.name === "Priya Sharma", "quoted display name");
assert(named[0]?.email === "priya@pinnacle.in", "quoted email");

assert(
  isSelfSentRecipient("vishnu.rajan294@gmail.com"),
  "personal Gmail is self-sent",
);
assert(
  isSelfSentRecipient(
    "Vishnu <vishnu.rajan@epicode.in>, Vishnu <vishnu.rajan294@gmail.com>",
  ),
  "work-to-personal test mail is self-sent",
);
assert(
  !isSelfSentRecipient("Ada <ada@acme.com>"),
  "external recipient is not self-sent",
);

console.log("Deferred-action and address checks passed.");
