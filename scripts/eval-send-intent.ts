// Manual eval, not part of npm test: does the REAL chat model call
// confirm_send_pending_draft for send phrases, and hold back otherwise?
// In-memory DB, fake Telegram and Gmail, and every tool call intercepted,
// so nothing is sent. Needs model API keys from .env.
// Usage: npm run eval:send-intent -- [backend] [runs]
import { setApprovalsTestHooks } from "../src/approvals.ts";
import { runAgent, setToolInterceptorForTests } from "../src/agent.ts";
import {
  claimTelegramMessage,
  createPendingAction,
  saveMessage,
  setPendingActionTelegramMessage,
  transitionPendingAction,
} from "../src/db.ts";
import type { LlmBackend } from "../src/llm.ts";
import { fakeGmail, fakeTelegramApi } from "./fakes.ts";

const backend = (process.argv[2] ?? "deepseek") as LlmBackend;
const runs = Number(process.argv[3] ?? 2);

setApprovalsTestHooks({
  telegram: fakeTelegramApi({ sent: [], edited: [] }),
  gmailFor: () => fakeGmail({ sent: [], created: [] }),
});

saveMessage(
  "user",
  "Draft an email to priya@acme.com saying the demo moves to Thursday 3pm.",
);
saveMessage(
  "assistant",
  "Draft created for priya@acme.com (work). Waiting for your Send tap.",
);
claimTelegramMessage(1, 100);
const draft = createPendingAction("eval-draft", null, "work");
setPendingActionTelegramMessage(draft.id, 101);
const confirmation = { chatId: 1, messageId: 102 };

let calls: string[] = [];
setToolInterceptorForTests((call, turn) => {
  calls.push(`${call.name}@step${turn.iteration}`);
  if (call.name === "confirm_send_pending_draft") {
    return "Sent the draft to Priya.";
  }
  return "Done.";
});

interface Case {
  text: string;
  expectSend: boolean;
}

const withDraft: Case[] = [
  { text: "send it", expectSend: true },
  { text: "send that", expectSend: true },
  { text: "send the email", expectSend: true },
  { text: "go ahead fire it off", expectSend: true },
  { text: "haan bhej do", expectSend: true },
  { text: "send cheyyu", expectSend: true },
  { text: "yeah send that", expectSend: true },
  { text: "change the time to 3pm", expectSend: false },
  { text: "ok", expectSend: false },
  { text: "👍", expectSend: false },
  { text: "hmm", expectSend: false },
  { text: "discard it", expectSend: false },
];

const noDraft: Case[] = [
  { text: "haan bhej do", expectSend: false },
  { text: "send that", expectSend: false },
];

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 70);
}

let failures = 0;

async function runCases(
  title: string,
  cases: Case[],
  draftPending: boolean,
): Promise<void> {
  console.log(`\n${title}`);
  for (const testCase of cases) {
    for (let run = 1; run <= runs; run += 1) {
      calls = [];
      const reply = await runAgent(testCase.text, {
        backend,
        saveUserMessage: false,
        saveAssistantMessage: false,
        sendConfirmation: confirmation,
      });
      const confirmedFirst = calls.includes("confirm_send_pending_draft@step1");
      const anyConfirm = calls.some((name) => name.startsWith("confirm_send_pending_draft"));
      const pass = draftPending
        ? testCase.expectSend
          ? confirmedFirst
          : !anyConfirm
        : /no (email )?drafts?|nothing (was |to )?sen[dt]|no pending/i.test(reply);
      if (!pass) {
        failures += 1;
      }
      const verdict = confirmedFirst ? "SEND " : anyConfirm ? "late " : "hold ";
      console.log(
        `RESULT\t${pass ? "PASS" : "FAIL"}\t${JSON.stringify(testCase.text)}\texpect=${testCase.expectSend ? "send" : "hold"}\tmodel=${verdict}\ttools=[${calls.join(",")}]\treply="${oneLine(reply)}"`,
      );
    }
  }
}

await runCases(`WITH ONE PENDING DRAFT (backend=${backend}, runs=${runs})`, withDraft, true);

transitionPendingAction(draft.id, "pending", "discarded");
// With no draft pending, let the real tool answer: it finds nothing to send.
setToolInterceptorForTests((call, turn) => {
  calls.push(`${call.name}@step${turn.iteration}`);
  return call.name === "confirm_send_pending_draft" ? undefined : "Done.";
});
await runCases(
  "NO PENDING DRAFT (pass = Aadi says there is no draft; a confirm call is harmless, the real tool finds nothing)",
  noDraft,
  false,
);

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAIL`}`);
process.exit(0);
