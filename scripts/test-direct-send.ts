import { readFile } from "node:fs/promises";
import {
  queueDraftApproval,
  sendCreatedDraftNow,
  setApprovalsTestHooks,
} from "../src/approvals.ts";
import { getPendingActionForDraft } from "../src/db.ts";
import { setGoogleAccountForTests } from "../src/google/auth.ts";
import { setGmailClientForTests } from "../src/google/mail.ts";
import type { LoadedGoogleAccount } from "../src/google/auth.ts";
import { handler as draftNewEmail } from "../src/tools/draft_new_email.ts";
import type { ToolTurn } from "../src/tools/index.ts";
import {
  fakeGmail,
  fakeTelegramApi,
  nextMessageId,
  type GmailLog,
  type TelegramLog,
} from "./fakes.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const gmailLog: GmailLog = { sent: [], created: [] };
const cards: TelegramLog = { sent: [], edited: [] };
const gmail = fakeGmail(gmailLog);
setGmailClientForTests(() => gmail);
setApprovalsTestHooks({
  telegram: fakeTelegramApi(cards),
  gmailFor: () => gmail,
});

const workAccount = {
  id: "work",
  tag: "work",
  label: "work (Epicode)",
  client: {},
} as unknown as LoadedGoogleAccount;
setGoogleAccountForTests((id) => (id === "work" ? workAccount : undefined));

function ownerTurn(): ToolTurn {
  return {
    iteration: 1,
    calledTools: ["draft_new_email"],
    confirmation: { chatId: 1, messageId: nextMessageId() },
  };
}

function clearLogs(): void {
  gmailLog.sent.length = 0;
  gmailLog.created.length = 0;
  cards.sent.length = 0;
  cards.edited.length = 0;
}

{
  clearLogs();
  const sent = await sendCreatedDraftNow({
    draftId: "draft-direct",
    googleAccount: "work",
    confirmation: { chatId: 1, messageId: nextMessageId() },
  });
  assert(sent.ok === true, "owner-chat send_immediately sends");
  assert(gmailLog.sent.includes("draft-direct"), "Gmail drafts.send ran");
  assert(
    getPendingActionForDraft("draft-direct") === undefined,
    "immediate send does not create a pending action",
  );
  assert(cards.sent.length === 0, "immediate send does not post an approval card");
}

{
  clearLogs();
  const blocked = await sendCreatedDraftNow({
    draftId: "draft-blocked",
    googleAccount: "work",
    confirmation: undefined,
  });
  assert(blocked.ok === false, "no owner-chat confirmation means no send");
  assert(gmailLog.sent.length === 0, "unapproved send does not call Gmail");
}

{
  clearLogs();
  await queueDraftApproval({
    draftId: "draft-review",
    threadId: null,
    to: "priya@acme.com",
    subject: "Demo",
    body: "Hi Priya",
    googleAccount: "work",
  });
  const pending = getPendingActionForDraft("draft-review");
  assert(pending !== undefined && pending.status === "pending", "draft path creates a pending action");
  assert(cards.sent.length === 1, "draft path posts an approval card");
  assert(gmailLog.sent.length === 0, "draft path does not send");
}

{
  clearLogs();
  const reply = await draftNewEmail(
    {
      to: "priya@acme.com",
      subject: "Demo",
      body: "Hi Priya, the demo is Thursday.",
      send_immediately: true,
    },
    ownerTurn(),
  );
  assert(
    reply.includes("Sent to") && reply.includes("priya@acme.com"),
    `send command reports sent, got: ${reply}`,
  );
  assert(gmailLog.sent.length === 1, "send command calls drafts.send");
  assert(
    getPendingActionForDraft(gmailLog.sent[0]!) === undefined,
    "send command leaves no pending action",
  );
  assert(cards.sent.length === 0, "send command posts no approval card");
}

{
  clearLogs();
  const reply = await draftNewEmail(
    {
      to: "priya@acme.com",
      subject: "Demo",
      body: "Hi Priya, the demo is Thursday.",
    },
    ownerTurn(),
  );
  assert(reply.includes("Waiting for your Send tap"), "draft command waits for a tap");
  assert(gmailLog.sent.length === 0, "draft command does not send");
  assert(gmailLog.created.length === 1, "draft command creates a Gmail draft");
  const draftId = /draft_id: (\S+)/.exec(reply)?.[1];
  assert(draftId !== undefined, "draft command returns a draft_id");
  const pending = getPendingActionForDraft(draftId);
  assert(pending !== undefined && pending.status === "pending", "draft command creates a pending action");
  assert(cards.sent.length === 1, "draft command posts an approval card");
}

{
  const newSrc = await readFile(new URL("../src/tools/draft_new_email.ts", import.meta.url), "utf8");
  const replySrc = await readFile(new URL("../src/tools/draft_reply.ts", import.meta.url), "utf8");
  const systemMd = await readFile(new URL("../prompts/system.md", import.meta.url), "utf8");
  const approvalsSrc = await readFile(new URL("../src/approvals.ts", import.meta.url), "utf8");
  assert(newSrc.includes("send_immediately"), "draft_new_email accepts send_immediately");
  assert(replySrc.includes("send_immediately"), "draft_reply accepts send_immediately");
  assert(newSrc.includes("sendCreatedDraftNow"), "draft_new_email can send now");
  assert(replySrc.includes("sendCreatedDraftNow"), "draft_reply can send now");
  assert(!newSrc.includes("buildAutonomyFacts"), "draft_new_email has no autonomy facts");
  assert(!replySrc.includes("buildAutonomyFacts"), "draft_reply has no autonomy facts");
  assert(
    systemMd.includes("Set `send_immediately: true` in the tool call"),
    "system prompt tells the LLM how to distinguish send vs draft",
  );
  assert(!systemMd.includes("5-minute"), "system prompt has no 5-minute auto-send window");
  assert(!systemMd.includes("Autonomy Rules Engine"), "system prompt has no autonomy engine");
  assert(!approvalsSrc.includes("startAutoSendDispatcher"), "auto-send dispatcher is gone");
  assert(!approvalsSrc.includes("evaluateDraft"), "rules engine is gone from approvals");
}

setGoogleAccountForTests(undefined);
setGmailClientForTests(undefined);
setApprovalsTestHooks({});

console.log("Direct send checks passed.");
