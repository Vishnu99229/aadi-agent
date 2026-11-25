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
// Each created draft goes to whoever its raw MIME says, the way Gmail keeps it.
const draftMeta: Record<string, { to?: string; cc?: string; subject?: string }> = {};
const base = fakeGmail(gmailLog, draftMeta);
// He has emailed priya@acme.com before (Sent), so she is known; anyone else is new.
const knownAddresses = new Set(["priya@acme.com"]);
const baseDrafts = (base.users as unknown as { drafts: Record<string, (input: never) => Promise<{ data: { id: string } }>> }).drafts;
const gmail = {
  users: {
    ...(base.users as object),
    drafts: {
      ...baseDrafts,
      create: async (input: { requestBody: { message: { raw: string } } }) => {
        const result = await baseDrafts.create!(input as never);
        const raw = Buffer.from(input.requestBody.message.raw, "base64url").toString("utf8");
        draftMeta[result.data.id] = { to: /^To: (.*)$/im.exec(raw)?.[1]?.trim() ?? "", cc: /^Cc: (.*)$/im.exec(raw)?.[1]?.trim() };
        return result;
      },
    },
    messages: {
      list: async ({ q }: { q: string }) => {
        const address = /to:([^\s)]+)/.exec(q)?.[1] ?? "";
        return { data: { messages: knownAddresses.has(address) ? [{ id: `known-${address}`, threadId: "k" }] : [] } };
      },
      get: async ({ id }: { id: string }) => ({
        data: { id, threadId: "k", labelIds: ["SENT"], payload: { headers: [{ name: "To", value: id.replace(/^known-/, "") }] } },
      }),
    },
  },
} as unknown as typeof base;
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

function ownerTurn(userText = "send priya@acme.com an email about the demo", ownTurn = true): ToolTurn {
  return {
    iteration: 1,
    calledTools: ["draft_new_email"],
    confirmation: { chatId: 1, messageId: nextMessageId() },
    userText,
    // Dispatch marks his own chat turn; these tests stand in for it.
    ownTurn,
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
    ownTurn: true,
    userText: "send priya@acme.com an email about the demo",
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
    ownTurn: true,
    userText: "send priya@acme.com an email about the demo",
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

// ---- C: send_immediately only sends when every recipient is known ----
{
  clearLogs();
  const reply = await draftNewEmail(
    { to: "newbie@new-co.com", subject: "Hi", body: "Hi there.", send_immediately: true },
    ownerTurn("send newbie@new-co.com an email saying hi"),
  );
  assert(gmailLog.sent.length === 0, `a new address is never sent directly: ${reply}`);
  assert(reply.includes("New address: newbie@new-co.com. Tap Send to confirm."), `he's told why: ${reply}`);
  const cardFor = /draft_id: (\S+)/.exec(reply)?.[1] ?? "";
  assert(getPendingActionForDraft(cardFor)?.status === "pending", `the card is shown and waits: ${reply}`);
}
{
  // PR #27: "draft ... please send me the proposal" is a draft, never a send.
  clearLogs();
  const reply = await draftNewEmail(
    { to: "priya@acme.com", subject: "Proposal", body: "Please send me the proposal.", send_immediately: true },
    ownerTurn("draft an email to priya@acme.com saying please send me the proposal"),
  );
  assert(gmailLog.sent.length === 0 && getPendingActionForDraft(/draft_id: (\S+)/.exec(reply)?.[1] ?? "")?.status === "pending", `"draft" never sends: ${reply}`);
}
{
  // A delegated goal (not his own turn): a card, even for a known address.
  clearLogs();
  const reply = await draftNewEmail(
    { to: "priya@acme.com", subject: "Demo", body: "Hi Priya.", send_immediately: true },
    ownerTurn("send priya@acme.com an email about the demo", false),
  );
  assert(gmailLog.sent.length === 0 && getPendingActionForDraft(/draft_id: (\S+)/.exec(reply)?.[1] ?? "")?.status === "pending", `a delegated goal only gets a card: ${reply}`);
}

setGoogleAccountForTests(undefined);
setGmailClientForTests(undefined);
setApprovalsTestHooks({});

console.log("Direct send checks passed.");
