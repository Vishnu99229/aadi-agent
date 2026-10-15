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
const {
  cleanSubjectTitle,
  formatFollowupPanelText,
  formatToLine,
  formatWaitingPhrase,
  neededLine,
  parseAddressList,
} = await import("../src/followup_logic.ts");

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
  formatToLine("priya@pinnacle.in", []) === "To: Priya, Pinnacle",
  "name and company from domain",
);
assert(
  formatToLine("Vishnu <vishnu.rajan294@gmail.com>", []) ===
    "To: (sent to yourself)",
  "self-address label",
);

assert(cleanSubjectTitle("Re: Dialler integration proposal") === "Dialler integration proposal", "strip Re");
assert(formatWaitingPhrase(1) === "waiting 1 day", "singular waiting");
assert(formatWaitingPhrase(3) === "waiting 3 days", "plural waiting");
assert(neededLine("  Please share the proposal  ") === "Please share the proposal", "needed snippet");

const text = formatFollowupPanelText(
  [
    {
      id: 12,
      title: "Dialler integration proposal",
      toLine: "To: Priya Sharma, Pinnacle",
      sentLine: "Sent: Mon 12 Oct, 4:10 pm · waiting 3 days",
      needed: "the signed proposal",
      note: "Snoozed until Sun 18 Oct",
    },
  ],
  "Waiting on",
);
assert(text.includes("1. Dialler integration proposal"), "numbered title");
assert(text.includes("To: Priya Sharma, Pinnacle"), "to line");
assert(text.includes("Needed: the signed proposal"), "needed line");
assert(text.includes("Snoozed until Sun 18 Oct"), "action note");

console.log("Panel and deferred-action checks passed.");
