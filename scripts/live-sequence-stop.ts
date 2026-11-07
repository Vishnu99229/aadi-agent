/**
 * Do the natural stop phrases reach stop_sequence? The real chat model on invented
 * sequences, in a throwaway database. Gmail and Telegram are stubs: nothing sends.
 */
import "dotenv/config";
import { runAgent } from "../src/agent.ts";
import type { ChatBackend } from "../src/chat_backend.ts";
import {
  activateSalesSequence,
  createProposedSalesSequence,
  listActiveSalesSequences,
  stopActiveSalesSequence,
} from "../src/db.ts";
import { setGoogleAccountForTests, type LoadedGoogleAccount } from "../src/google/auth.ts";
import { setGmailClientForTests } from "../src/google/mail.ts";

if (process.env.AADI_DB_PATH !== ":memory:") {
  throw new Error("live-sequence-stop.ts must run with AADI_DB_PATH=:memory:");
}

const refuse = (): never => {
  throw new Error("no mailbox in this check");
};
const account = { id: "work", tag: "work", label: "work", client: {} } as unknown as LoadedGoogleAccount;
setGoogleAccountForTests(() => account);
setGmailClientForTests(refuse as never);

function seed(people: Array<[string, string, string]>): void {
  for (const row of listActiveSalesSequences()) {
    stopActiveSalesSequence(row.id, "reset");
  }
  for (const [name, email, company] of people) {
    const domain = email.split("@")[1]!;
    const created = createProposedSalesSequence({
      threadId: `live-${Math.random()}`,
      prospectEmail: email,
      prospectDomain: domain,
      prospectKey: email.toLowerCase(),
      prospectName: name,
      prospectCompany: company,
      subject: `Epicode for ${company}`,
      originalMessageId: "x",
      originalSentAt: new Date().toISOString(),
      manualFollowups: 0,
      classifierConfidence: 0.9,
      classifierReason: "pitch",
    })!;
    activateSalesSequence(created.id, {
      nextStepAt: new Date().toISOString(),
      enrolledAt: new Date().toISOString(),
      manualFollowups: 0,
    });
  }
}

const THREE: Array<[string, string, string]> = [
  ["Rajan Mehta", "rajan@alphafoods.example", "Alphafoods"],
  ["Priya Shah", "priya@talkdesk.example", "Talkdesk"],
  ["Omar Ali", "omar@brightbank.example", "Brightbank"],
];
const TWO_RAJANS: Array<[string, string, string]> = [
  ["Rajan Mehta", "rajan@alphafoods.example", "Alphafoods"],
  ["Rajan Iyer", "rajan@betatel.example", "Betatel"],
];

const cases: Array<{
  phrase: string;
  people: Array<[string, string, string]>;
  remaining: number;
}> = [
  { phrase: "stop following up with Rajan", people: THREE, remaining: 2 },
  { phrase: "don't email Talkdesk again", people: THREE, remaining: 2 },
  { phrase: "pause all follow-ups", people: THREE, remaining: 0 },
  { phrase: "stop following up with Rajan", people: TWO_RAJANS, remaining: 2 },
];

const backends = (process.argv[2] ?? "claude").split(",") as ChatBackend[];
let failed = 0;
const log = console.log;
console.log = () => undefined;
for (const backend of backends) {
  log(`\n=== ${backend}`);
  let messageId = 1000;
  for (const item of cases) {
    seed(item.people);
    messageId += 1;
    const reply = await runAgent(item.phrase, {
      skipHistory: true,
      saveUserMessage: false,
      saveAssistantMessage: false,
      backend,
      sendConfirmation: { chatId: 1, messageId },
    });
    const left = listActiveSalesSequences().length;
    const ok = left === item.remaining;
    failed += ok ? 0 : 1;
    log(`${ok ? "ok  " : "FAIL"} "${item.phrase}" (${item.people.length} active -> ${left}, wanted ${item.remaining})`);
    log(`     ${reply.replace(/\s+/g, " ").slice(0, 200)}`);
  }
}
process.exit(failed === 0 ? 0 : 1);
