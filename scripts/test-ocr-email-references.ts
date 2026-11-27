/** The owner's Telegram reference selects one OCR recipient, never an older
 * Gmail draft. All Telegram/Google calls are fakes; nothing is sent. */
import assert from "node:assert/strict";
import { bot } from "../src/bot.ts";
import {
  bindEmailReferenceForTurn,
  classifyOwnerEmailIntent,
  emailReferenceForTurn,
  isNegativeSendCommand,
  refersToEarlierEmail,
  resolveEmailReference,
} from "../src/email_references.ts";
import {
  notASendCommand,
  parseOwnerEmailSendAt,
  splitOwnerEmailCommand,
} from "../src/command_logic.ts";
import { commandIntents } from "../src/command_intent.ts";
import {
  createDocument,
  db,
  deleteExpiredDocuments,
  documentRefForTelegramMessage,
  getDocument,
  getPendingActionContext,
  getScheduledSend,
  createScheduledSend,
  listOpenScheduledSends,
  recordKnownRecipient,
  rememberTelegramDocumentRef,
} from "../src/db.ts";
import { queueDraftApproval } from "../src/approvals.ts";
import { getPendingAction, savePendingAction } from "../src/action_context.ts";
import { handler as draftNewEmail } from "../src/tools/draft_new_email.ts";
import { handler as draftReply } from "../src/tools/draft_reply.ts";
import { handler as confirmDraft } from "../src/tools/confirm_send_pending_draft.ts";
import { handler as updateDraft } from "../src/tools/update_draft.ts";
import { sendEmailFromTool, setCommandEmailTestHooks } from "../src/command_email.ts";
import { rememberContactChoice } from "../src/contacts.ts";
import { setGoogleAccountForTests } from "../src/google/auth.ts";
import { setGmailClientForTests } from "../src/google/mail.ts";
import { setApprovalsTestHooks } from "../src/approvals.ts";
import { setCompleteForTests } from "../src/llm.ts";
import { modelReply } from "./fakes.ts";
import type { Api } from "grammy";
import type { gmail_v1 } from "googleapis";
import { nextMessageId } from "./fakes.ts";

if (process.env.AADI_DB_PATH !== ":memory:") {
  throw new Error("OCR recipient tests must use :memory: database");
}

let gmailDrafts = 0;
let draftSends = 0;
let messageSends = 0;
let latestDraftRecipient = "";
let latestDraftCc = "";
let latestDraftSubject = "";
let latestDraftBody = "";
let latestSentTo = "";
let latestSentCc = "";
const sentAccounts: string[] = [];
// Like Gmail, each draft goes to whoever its MIME (or its queued card) says.
const draftTo = new Map<string, string>();
const gmailFor = (account: { id: string }) => ({
  users: {
    drafts: {
      create: async ({ requestBody }: { requestBody: { message: { raw: string } } }) => {
        gmailDrafts++;
        sentAccounts.push(account.id);
        const raw = Buffer.from(requestBody.message.raw, "base64url").toString("utf8");
        latestDraftRecipient = /^To:\s*(.*)$/im.exec(raw)?.[1]?.trim() ?? "";
        draftTo.set(`new-${gmailDrafts}`, latestDraftRecipient);
        latestDraftCc = /^Cc:\s*(.*)$/im.exec(raw)?.[1]?.trim() ?? "";
        latestDraftSubject = /^Subject:\s*(.*)$/im.exec(raw)?.[1]?.trim() ?? "";
        const encoded = /Content-Transfer-Encoding: base64\r?\n\r?\n([A-Za-z0-9+/=\r\n]+)/.exec(raw)?.[1];
        latestDraftBody = encoded
          ? Buffer.from(encoded.replace(/\s/g, ""), "base64").toString("utf8").trim()
          : raw.split(/\r?\n\r?\n/).slice(1).join("\n").trim();
        return { data: { id: `new-${gmailDrafts}`, message: { id: `new-${gmailDrafts}`, threadId: `thread-${gmailDrafts}` } } };
      },
      send: async ({ requestBody }: { requestBody: { id: string } }) => {
        draftSends++;
        sentAccounts.push(`send:${account.id}:${requestBody.id}`);
        return { data: { id: `sent-${requestBody.id}` } };
      },
      get: async ({ id }: { id: string }) => ({
        data: { id, message: { id, threadId: `thread-${id}`, payload: { headers: [{ name: "To", value: draftTo.get(id) ?? "alice@example.com" }, { name: "Subject", value: "Hello" }], mimeType: "text/plain", body: { data: Buffer.from("Hello", "utf8").toString("base64url") } } } },
      }),
      update: async ({ id }: { id: string }) => ({ data: { id, message: { id, threadId: `thread-${id}` } } }),
      delete: async () => ({ data: {} }),
    },
    messages: {
      send: async ({ requestBody }: { requestBody: { raw: string } }) => {
        messageSends++;
        const raw = Buffer.from(requestBody.raw, "base64url").toString("utf8");
        latestSentTo = /^To:\s*(.*)$/im.exec(raw)?.[1]?.trim() ?? "";
        latestSentCc = /^Cc:\s*(.*)$/im.exec(raw)?.[1]?.trim() ?? "";
        sentAccounts.push(`message:${account.id}`);
        return { data: { id: `msg-${messageSends}` } };
      },
      list: async () => ({ data: { messages: [] } }),
      get: async () => ({ data: { payload: { headers: [] } } }),
    },
    getProfile: async () => ({ data: { emailAddress: "vishnu@example.com" } }),
    settings: { sendAs: { list: async () => ({ data: { sendAs: [] } }) } },
  },
}) as unknown as gmail_v1.Gmail;
setGoogleAccountForTests((id) => ({ id, tag: id, label: id, client: {} }) as never);
setGmailClientForTests((account) => gmailFor(account));

const replies: string[] = [];
const cardIds: number[] = [];
const telegram = {
  sendMessage: async (_chat: unknown, text: string) => {
    const message_id = nextMessageId();
    cardIds.push(message_id);
    return { message_id, text };
  },
  editMessageText: async () => true,
} as unknown as Api;
setApprovalsTestHooks({ telegram, gmailFor: (account) => gmailFor({ id: account }) });
setCommandEmailTestHooks({ telegram });
bot.api.config.use(async (_prev, method, payload) => {
  if (method === "getMe") {
    return { ok: true, result: { id: 999, is_bot: true, first_name: "Aadi" } } as never;
  }
  if (method === "sendMessage") {
    const text = (payload as { text: string }).text;
    replies.push(text);
    return { ok: true, result: { message_id: nextMessageId(), date: 0, chat: { id: 1, type: "private" }, text } } as never;
  }
  return { ok: true, result: true } as never;
});
await bot.init();
setCompleteForTests(async (params) => {
  const facts = params.messages.map((message) => (typeof message.content === "string" ? message.content : "")).join("\n");
  const enjoyed = /enjoyed our meeting/i.test(facts);
  return modelReply({
    text: JSON.stringify({
      subject: enjoyed ? "Glad we met" : "Our discussion",
      body: enjoyed
        ? "I enjoyed our meeting and would like to continue the conversation."
        : "Hello, following up on our discussion.",
    }),
  });
});

const sarg = createDocument("sargvision.jpg", "personal", "Contact: contact@sargvision.com", null);
const msops = createDocument("msopsai.jpg", "personal", "MsOpsAi | info@msopsai.com | Bangalore", null);
rememberTelegramDocumentRef(1, 101, sarg.id);
rememberTelegramDocumentRef(1, 102, msops.id);

const now = Date.now();
assert.deepEqual(
  resolveEmailReference({ chatId: 1, ownerText: "Get the email id from the above message, and draft the email", now }),
  { kind: "one", email: "info@msopsai.com", documentId: msops.id },
);
assert.deepEqual(
  resolveEmailReference({
    chatId: 1,
    ownerText: "Refer the email in this",
    replyTo: { message_id: 101, text: "contact@sargvision.com" },
    now,
  }),
  { kind: "one", email: "contact@sargvision.com", documentId: sarg.id },
);
assert.deepEqual(
  resolveEmailReference({
    chatId: 1, ownerText: "Use the email in this OCR answer",
    replyTo: { message_id: 101, text: "Corrected OCR address: corrected@sargvision.com" }, now,
  }),
  { kind: "one", email: "corrected@sargvision.com", documentId: sarg.id },
);
assert.equal(resolveEmailReference({ chatId: 2, ownerText: "Use the email above", now }).kind, "missing");
assert.equal(resolveEmailReference({ chatId: 1, ownerText: "Use the email above", now: now + 31 * 60_000 }).kind, "missing");
assert.equal(resolveEmailReference({ chatId: 1, ownerText: "Draft an email to John", now }).kind, "none");
assert.equal(refersToEarlierEmail("any email from Pinnacle this week?"), false);
assert.equal(refersToEarlierEmail("Find my earlier email about KYC"), false);
assert.equal(refersToEarlierEmail("make that email shorter"), false);
assert.equal(refersToEarlierEmail("Cancel the scheduled email above"), false);
assert.equal(refersToEarlierEmail("Don't send the email above"), false);
assert.equal(refersToEarlierEmail("send it", true), false);
assert.equal(refersToEarlierEmail("Get the email from the above photo"), true);
assert.equal(refersToEarlierEmail("Draft an email to the address in the photo saying please send me the proposal"), true);
assert.deepEqual(
  resolveEmailReference({
    chatId: 1,
    ownerText: "Refer the email in this",
    replyTo: { message_id: 90, text: "OCR result: contact@sargvision.com" },
    now,
  }),
  { kind: "one", email: "contact@sargvision.com" },
);

const several = createDocument("multiple.jpg", "personal", "one@example.org and two@example.org", null);
rememberTelegramDocumentRef(1, 105, several.id);
assert.deepEqual(
  resolveEmailReference({ chatId: 1, ownerText: "Use the email above", now }),
  { kind: "many", emails: ["one@example.org", "two@example.org"] },
);

// Same request that produced the unrelated Vasanth draft in the screenshot.
// The bot must ask for the missing email purpose and leave Gmail untouched.
rememberTelegramDocumentRef(1, 106, msops.id);
savePendingAction(1, {
  action: "draft_email", status: "open", ownerWords: "Draft Vasanth",
  confirmChat: 1, confirmMessage: 77, updatedAt: new Date().toISOString(),
  email: {
    to: [{ query: "Vasanth", name: "Vasanth", email: "vasanth.kumar@teleapps.com", resolved: true }],
    cc: [], notes: [], account: "work", waiting: "confirm", draftId: "draft-vasanth",
  },
});
async function say(text: string, quote?: { message_id: number; text: string }, chatId = 1): Promise<void> {
  const messageId = nextMessageId();
  await bot.handleUpdate({
    update_id: messageId,
    message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: "private", first_name: "Vishnu" },
      from: { id: 1, is_bot: false, first_name: "Vishnu" },
      text,
      ...(quote ? { reply_to_message: {
        ...quote, from: { id: 999, is_bot: true, first_name: "Aadi" },
        chat: { id: chatId, type: "private" }, date: Math.floor(Date.now() / 1000),
      } } : {}),
    },
  } as never);
}
{
  const unseenChat = 627;
  const before = replies.length;
  await say("What did he say in his latest email?", undefined, unseenChat);
  await say("Show me the email address in the above message", undefined, unseenChat);
  assert.equal(replies.slice(before).length, 2, "both requests without a real Telegram reference reach routing");
  assert.ok(replies.slice(before).every(line => !line.includes("latest OCR photo")));
  await say("Show me the email address in this message", { message_id: nextMessageId(), text: "No address here." }, unseenChat);
  assert.match(replies.at(-1) ?? "", /couldn't find an email address in that message or the latest OCR photo/i);
}
await say("Get the email id from the above message, and draft the email");
assert.match(replies.at(-1) ?? "", /info@msopsai\.com.*what should the email say/i);
assert.equal(getPendingAction(1)?.email?.to[0]?.email, "info@msopsai.com");
assert.equal(getPendingAction(1)?.email?.draftId, undefined, "unrelated Vasanth draft must not be reused");
assert.equal(gmailDrafts, 0);

bindEmailReferenceForTurn(1, 554, "info@msopsai.com");
const refusedOldReply = await draftReply({ email_id: "old-vasanth-message", body: "Old conversation" }, {
  iteration: 1, calledTools: [], userText: "Draft an email to the address above about our meeting", confirmation: { chatId: 1, messageId: 554 },
});
assert.match(refusedOldReply, /Not drafted.*info@msopsai\.com/);
const refusedOldUpdate = await updateDraft({ draft_id: "draft-vasanth", body: "Old conversation" }, {
  iteration: 1, calledTools: [], userText: "Draft an email to the address above about our meeting", confirmation: { chatId: 1, messageId: 554 },
});
assert.match(refusedOldUpdate, /Not updated.*info@msopsai\.com/);
assert.equal(gmailDrafts, 0);

await say("Refer the email in this", { message_id: 101, text: "OCR: contact@sargvision.com" });
assert.match(replies.at(-1) ?? "", /contact@sargvision\.com/);
assert.equal(getPendingAction(1)?.email?.to[0]?.email, "info@msopsai.com", "a read-only question must not change the pending email");
await say("Draft an email to the email in this message", { message_id: 101, text: "OCR: contact@sargvision.com" });
assert.equal(getPendingAction(1)?.email?.to[0]?.email, "contact@sargvision.com");

// A model that still tries to use the older Gmail recipient is blocked at
// BOTH tool boundaries. An explicit selected recipient, not OCR text itself,
// is the only authority to decide which recipient it may address.
bindEmailReferenceForTurn(1, 555, "info@msopsai.com");
assert.equal(emailReferenceForTurn(1, 555), "info@msopsai.com");
const refusedDraft = await draftNewEmail({
  to: "vasanth.kumar@teleapps.com", subject: "Old BTS thread", body: "Old body",
}, { iteration: 1, calledTools: [], userText: "Draft an email to the address above about our meeting", confirmation: { chatId: 1, messageId: 555 } });
assert.match(refusedDraft, /Not drafted.*info@msopsai\.com/);
assert.equal(gmailDrafts, 0);

bindEmailReferenceForTurn(1, 556, "info@msopsai.com");
const refusedSend = await sendEmailFromTool({
  to: ["vasanth.kumar@teleapps.com"], instruction: "Follow up about the event",
}, { iteration: 1, calledTools: [], userText: "Send an email to the address above about the event", confirmation: { chatId: 1, messageId: 556 } });
assert.match(refusedSend, /Not sent.*info@msopsai\.com/);
assert.equal(gmailDrafts, 0);
assert.equal(getPendingActionContext(1) !== undefined, true);

bindEmailReferenceForTurn(1, 557, "info@msopsai.com");
const approvedDraft = await draftNewEmail({
  to: "the email above", subject: "Following up after Bengaluru Tech Summit",
  body: "Hello, I enjoyed meeting you at the event. Would you like to discuss the next steps?",
}, { iteration: 1, calledTools: [], userText: "Draft an email to the email above about our Bengaluru Tech Summit conversation", confirmation: { chatId: 1, messageId: 557 } });
assert.match(approvedDraft, /Draft created for .*info@msopsai\.com/);
assert.match(latestDraftRecipient, /info@msopsai\.com/);
assert.equal(gmailDrafts, 1);

// If a scheduled command cannot resolve its recipient, keep the intended
// wording and send time for the owner's later explicit choice. Never send it.
const future = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10);
const delayed = await sendEmailFromTool({
  to: ["the person in this photo"],
  instruction: "Thank you for meeting us at Bengaluru Tech Summit. Let's arrange a call.",
  subject: "Following up",
  send_on: future, send_time: "10:00",
}, {
  userText: `Schedule email to the email above on ${future} at 10:00`,
  confirmation: { chatId: 3, messageId: 558 },
});
assert.match(delayed, /Not scheduled.*kept the email wording and scheduled time/i);
assert.equal(getPendingAction(3)?.action, "send_email");
assert.equal(getPendingAction(3)?.email?.purpose?.includes("Bengaluru Tech Summit"), true);
const keptTime = getPendingAction(3)?.email?.sendAt;
assert.ok(keptTime);
rememberTelegramDocumentRef(3, 109, sarg.id);
await say("Refer the email in this", { message_id: 109, text: "OCR: contact@sargvision.com" }, 3);
assert.match(replies.at(-1) ?? "", /contact@sargvision\.com.*kept the previously requested wording and time/i);
assert.equal(getPendingAction(3)?.email?.to[0]?.email, "contact@sargvision.com");
assert.equal(getPendingAction(3)?.email?.sendAt, keptTime);
assert.equal(getPendingAction(3)?.email?.purpose?.includes("Bengaluru Tech Summit"), true);
assert.equal(gmailDrafts, 1);
assert.equal(getPendingAction(3)?.email?.needsFreshAuthorization, true);
assert.equal(getPendingAction(3)?.authorizedAt, undefined);
const beforeQuestion = messageSends + draftSends;
const question = await sendEmailFromTool(
  { to: ["contact@sargvision.com"], instruction: "Thank you for meeting us.", send_on: future, send_time: "10:00" },
  { userText: "What time is it?", confirmation: { chatId: 3, messageId: 900 } },
);
assert.match(question, /does not schedule or send/i);
assert.equal(messageSends + draftSends, beforeQuestion);

const sendsBeforeAddress = messageSends;
const draftsBeforeAddress = gmailDrafts;
await say("Send an email to the address above about our discussion");
// C: he has never emailed this OCR address, so it's new: a card, nothing sent. The
// card's draft still goes to the referenced address, never the old thread's.
assert.equal(messageSends, sendsBeforeAddress, "a new OCR address is never sent directly");
assert.equal(gmailDrafts, draftsBeforeAddress + 1, "its card has a draft");
assert.equal(latestDraftRecipient.toLowerCase().includes("info@msopsai.com"), true, latestDraftRecipient);
assert.equal(latestDraftRecipient.toLowerCase().includes("vasanth"), false);
assert.match(replies.join("\n"), /New address: info@msopsai\.com\. Tap Send to confirm\./);
assert.equal(draftSends, 0);
// From here on he has emailed both (as if he had tapped Send), so the address-choice
// cases below keep sending directly; what they check is which address is used.
recordKnownRecipient("info@msopsai.com", "test");
recordKnownRecipient("alice.copied@example.com", "test");

const oldDraft = "draft-old-scheduled";
await queueDraftApproval({
  draftId: oldDraft,
  threadId: null,
  to: "old-scheduled@example.com",
  subject: "Old schedule",
  body: "This is the older scheduled draft.",
  googleAccount: "work",
});
const oldSchedule = createScheduledSend({
  key: "old-scheduled-draft",
  sendAt: new Date(Date.now() + 86_400_000).toISOString(),
  itemText: "Send email to old — Old schedule — tomorrow",
  tag: "work",
  request: JSON.stringify({
    kind: "email",
    draftId: oldDraft,
    account: "work",
    to: [{ query: "old-scheduled@example.com", mailbox: { email: "old-scheduled@example.com", name: "Old" } }],
    cc: [],
    threadId: null,
    instruction: "Older wording",
    ownWords: "Schedule the old draft",
    subject: "Old schedule",
    finalSubject: "Old schedule",
    finalBody: "This is the older scheduled draft.",
  }),
  confirmChat: 1,
  confirmMessage: 1,
});
assert.ok(oldSchedule);
savePendingAction(1, {
  action: "send_email",
  status: "open",
  ownerWords: "Schedule the old draft",
  confirmChat: 1,
  confirmMessage: 1,
  updatedAt: new Date().toISOString(),
  email: {
    to: [{ query: "old-scheduled@example.com", name: "Old", email: "old-scheduled@example.com", resolved: true }],
    cc: [],
    notes: [],
    purpose: "Older wording",
    subject: "Old schedule",
    account: "work",
    waiting: "confirm",
    draftId: oldDraft,
    scheduledSendId: oldSchedule!.id,
  },
}, new Date());
const sendsBeforeNew = messageSends;
const draftSendsBeforeNew = draftSends;
await say("Send an email to the address above now about our discussion");
assert.match(latestSentTo, /info@msopsai\.com/i);
assert.doesNotMatch(latestSentTo, /old-scheduled@example\.com/i);
assert.equal(messageSends, sendsBeforeNew + 1);
assert.equal(draftSends, draftSendsBeforeNew, "the older scheduled draft must not be dispatched");
assert.equal(getScheduledSend(oldSchedule!.id)?.status, "scheduled");

rememberContactChoice("Alice", { name: "Alice", emails: ["alice.copied@example.com"], sources: ["known"] });
const sendsBeforeCc = messageSends;
await say("Send an email to the address above about the launch and Cc Alice");
assert.match(latestSentTo, /info@msopsai\.com/i);
assert.match(latestSentCc, /alice\.copied@example\.com/i);
assert.equal(messageSends, sendsBeforeCc + 1);
assert.equal(draftSends, draftSendsBeforeNew);

const draftsBeforeCompose = gmailDrafts;
await say("Draft an email to the address above saying I enjoyed our meeting");
assert.equal(gmailDrafts, draftsBeforeCompose + 1);
assert.equal(latestDraftSubject, "Glad we met");
assert.match(latestDraftBody, /enjoyed our meeting/i);
assert.doesNotMatch(latestDraftBody, /Draft an email to the address above/);
assert.match(latestDraftRecipient, /info@msopsai\.com/i);
assert.equal(messageSends, sendsBeforeCc + 1);

const sendsBeforeSchedule = messageSends;
await say("Use this email and schedule it tomorrow at 10", { message_id: 101, text: "OCR: contact@sargvision.com" });
assert.equal(getPendingAction(1)?.email?.to[0]?.email, "contact@sargvision.com");
assert.ok(getPendingAction(1)?.email?.sendAt);
assert.equal(messageSends, sendsBeforeSchedule, "scheduling a referenced address does not send immediately");

db.prepare("UPDATE pending_actions SET status = 'discarded' WHERE status = 'pending' AND type = 'send_draft'").run();
const cardDraft = "draft-card";
await queueDraftApproval({
  draftId: cardDraft,
  threadId: null,
  to: "alice@example.com",
  subject: "Original",
  body: "Original body",
  googleAccount: "work",
});
const cardMessage = cardIds.at(-1)!;
// Even a model call naming the right card must honor a veto or delivery hold.
for (const userText of [
  "Send the draft about the renewal, don't send it till I check",
  "Send the draft about the renewal, send it tomorrow",
]) {
  const before = draftSends;
  const result = await confirmDraft({ draft_id: cardDraft }, {
    userText, confirmation: { chatId: 1, messageId: nextMessageId() }, iteration: 1, calledTools: [],
  });
  assert.match(result, /^Not sent:/);
  assert.equal(draftSends, before);
}

const sendsBeforeCard = draftSends;
await say("send it", { message_id: cardMessage, text: "Draft waiting for approval\nTo: alice@example.com\nSubject: Original" });
assert.equal(sentAccounts.filter((item) => item === `send:work:${cardDraft}`).length, 1);
await say("send it");
assert.equal(sentAccounts.filter((item) => item === `send:work:${cardDraft}`).length, 1, "a stale send confirmation must not send the same draft again");

savePendingAction(4, {
  action: "send_email",
  status: "open",
  ownerWords: "Schedule the note",
  confirmChat: 4,
  confirmMessage: 1,
  updatedAt: new Date().toISOString(),
  email: {
    to: [{ query: "info@msopsai.com", name: "", email: "info@msopsai.com", resolved: true }],
    cc: [],
    notes: [],
    purpose: "Our discussion",
    subject: "Discussion",
    account: "work",
    waiting: "confirm",
    scheduledSendId: undefined,
  },
});
const scheduled = createScheduledSend({
  key: "ocr-cancel",
  sendAt: new Date(Date.now() + 86_400_000).toISOString(),
  itemText: "Send email to info — Discussion — tomorrow",
  tag: "work",
  request: JSON.stringify({
    kind: "email",
    to: [{ query: "info@msopsai.com", mailbox: { email: "info@msopsai.com", name: "Info" } }],
    cc: [],
    threadId: null,
    instruction: "Our discussion",
    ownWords: "Schedule it",
    account: "work",
    subject: "Discussion",
    finalBody: "Our discussion",
    finalSubject: "Discussion",
  }),
  confirmChat: 4,
  confirmMessage: 1,
});
assert.ok(scheduled);
savePendingAction(4, {
  ...getPendingAction(4)!,
  email: { ...getPendingAction(4)!.email!, scheduledSendId: scheduled!.id },
}, new Date());
await say("Don't send the email above", { message_id: 102, text: "OCR: info@msopsai.com" }, 4);
assert.equal(getScheduledSend(scheduled!.id)?.status, "cancelled");
assert.equal(messageSends, sendsBeforeSchedule);

const draftOnly = await sendEmailFromTool(
  { to: ["alice@example.com"], instruction: "Hello" },
  { userText: "Draft the email", confirmation: { chatId: 8, messageId: 1 } },
);
assert.match(draftOnly, /Not sent: he asked for a draft/);
const scheduleOnly = await sendEmailFromTool(
  { to: ["alice@example.com"], instruction: "Hello" },
  { userText: "Schedule it", confirmation: { chatId: 8, messageId: 2 } },
);
assert.match(scheduleOnly, /nothing went out immediately/i);
assert.equal(messageSends, sendsBeforeSchedule);

// These check which account sends: people he has emailed before, on his own turn
// (dispatch's mark, which these direct calls stand in for).
recordKnownRecipient("personal@example.com", "test");
recordKnownRecipient("work@example.com", "test");
const personal = await sendEmailFromTool(
  { to: ["personal@example.com"], instruction: "A personal note", account: "personal" },
  { userText: "Send an email to personal@example.com about the note", confirmation: { chatId: 9, messageId: 3 }, ownTurn: true },
);
assert.match(personal, /Sent to/i);
assert.equal(sentAccounts.includes("message:personal"), true);
const work = await sendEmailFromTool(
  { to: ["work@example.com"], instruction: "A work note", account: "work" },
  { userText: "Send an email to work@example.com about the note", confirmation: { chatId: 9, messageId: 4 }, ownTurn: true },
);
assert.match(work, /Sent to/i);
assert.equal(sentAccounts.filter((item) => item === "message:work").length >= 1, true);

const once = "draft-once";
draftTo.set(once, "once@example.com");
await queueDraftApproval({
  draftId: once,
  threadId: null,
  to: "once@example.com",
  subject: "Once",
  body: "Send this once",
  googleAccount: "work",
});
const onceSchedule = createScheduledSend({
  key: "send-now-once",
  sendAt: new Date(Date.now() + 86_400_000).toISOString(),
  itemText: "Send email to once — Once — tomorrow",
  tag: "work",
  request: JSON.stringify({
    kind: "email", draftId: once, account: "work",
    to: [{ query: "once@example.com", mailbox: { email: "once@example.com", name: "Once" } }],
    cc: [], threadId: null, instruction: "Send this once", ownWords: "Schedule it",
    subject: "Once", finalSubject: "Once", finalBody: "Send this once",
  }),
  confirmChat: 12,
  confirmMessage: 1,
});
assert.ok(onceSchedule);
savePendingAction(12, {
  action: "send_email", status: "open", ownerWords: "Schedule it",
  confirmChat: 12, confirmMessage: 1, updatedAt: new Date().toISOString(),
  email: {
    to: [{ query: "once@example.com", name: "Once", email: "once@example.com", resolved: true }],
    cc: [], notes: [], purpose: "Send this once", subject: "Once", account: "work",
    waiting: "confirm", draftId: once, scheduledSendId: onceSchedule!.id,
  },
}, new Date());
const beforeOnce = draftSends + messageSends;
const sentNow = await sendEmailFromTool(
  { to: ["once@example.com"], instruction: "Send this once" },
  { userText: "send it now", confirmation: { chatId: 12, messageId: nextMessageId() }, ownTurn: true },
);
assert.match(sentNow, /Sent/i);
assert.equal(draftSends + messageSends, beforeOnce + 1);
assert.equal(getScheduledSend(onceSchedule!.id)?.status, "sent");
assert.equal(getPendingAction(12)?.email, undefined, "the tool closes the chat link after delivering the scheduled draft");
const again = await sendEmailFromTool(
  { to: ["once@example.com"], instruction: "Send this once" },
  { userText: "send it now", confirmation: { chatId: 12, messageId: nextMessageId() }, ownTurn: true },
);
assert.match(again, /already|nothing was sent|no draft is waiting/i);
assert.equal(draftSends + messageSends, beforeOnce + 1);

function tomorrowIso(hhmm: string): string {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const [year, month, day] = today.split("-").map(Number);
  const next = new Date(Date.UTC(year!, month! - 1, day!));
  next.setUTCDate(next.getUTCDate() + 1);
  return new Date(`${next.toISOString().slice(0, 10)}T${hhmm}:00+05:30`).toISOString();
}

function latestSchedule(chatId: number) {
  return listOpenScheduledSends()
    .filter((row) => row.confirm_chat === chatId)
    .sort((a, b) => a.id - b.id)
    .at(-1);
}

async function ocrSay(chatId: number, text: string): Promise<void> {
  rememberTelegramDocumentRef(chatId, 102, msops.id);
  await say(text, { message_id: 102, text: "OCR: info@msopsai.com" }, chatId);
}

{
  const photo = "Draft an email to the address in the photo saying please send me the proposal";
  const invoice = "Write an email to the address above saying please send the invoice";
  const cancelBody = "Draft an email to the address above saying we had to cancel the order";
  const jeffDraft = "Draft an email to Jeff saying please send me the deck";
  assert.equal(splitOwnerEmailCommand("send that email to Jeff").content, "");
  assert.equal(splitOwnerEmailCommand("schedule that for tomorrow at 5 pm").content, "");
  assert.equal(splitOwnerEmailCommand("tell him that the call moved to 5 pm").content, "that the call moved to 5 pm");
  assert.equal(classifyOwnerEmailIntent(photo), "draft");
  assert.equal(notASendCommand(photo), "he asked for a draft");
  assert.equal(classifyOwnerEmailIntent(invoice), "draft");
  assert.equal(classifyOwnerEmailIntent(cancelBody), "draft");
  assert.equal(isNegativeSendCommand(cancelBody), false);
  assert.equal(notASendCommand(jeffDraft), "he asked for a draft");
  assert.deepEqual([...commandIntents(jeffDraft)], ["draft"]);
  const trailingSend = "Draft an email to Jeff about pricing and send it";
  assert.equal(classifyOwnerEmailIntent(trailingSend), "draft");
  assert.equal(notASendCommand(trailingSend), "he asked for a draft");
  const scheduledThat = parseOwnerEmailSendAt("schedule that for tomorrow at 5 pm");
  assert.equal(scheduledThat && "sendTime" in scheduledThat ? scheduledThat.sendTime : "", "17:00");
  assert.equal(parseOwnerEmailSendAt("tell him that the call moved to 5 pm"), undefined);
  assert.equal(parseOwnerEmailSendAt("Send an email to the address above saying the call is on 2026-11-25 at 10:00"), undefined);
  assert.equal(
    parseOwnerEmailSendAt("Schedule an email on 2026-11-25 at 0 am saying hello") &&
      "refused" in (parseOwnerEmailSendAt("Schedule an email on 2026-11-25 at 0 am saying hello") ?? {}),
    true,
  );
}

{
  const draftsBefore = gmailDrafts;
  const sendsBefore = messageSends + draftSends;
  const scheduledBefore = listOpenScheduledSends().length;
  await ocrSay(40, "Draft an email to the address in the photo saying please send me the proposal");
  assert.equal(gmailDrafts, draftsBefore + 1, "photo draft creates a Gmail draft");
  assert.equal(messageSends + draftSends, sendsBefore, "photo draft must not send");
  assert.equal(listOpenScheduledSends().length, scheduledBefore, "photo draft must not schedule");
  assert.match(latestDraftRecipient, /info@msopsai\.com/i);
}

{
  const draftsBefore = gmailDrafts;
  const sendsBefore = messageSends + draftSends;
  await ocrSay(41, "Write an email to the address above saying please send the invoice");
  assert.equal(gmailDrafts, draftsBefore + 1, "write ... saying send is a draft");
  assert.equal(messageSends + draftSends, sendsBefore);
}

{
  const draftsBefore = gmailDrafts;
  const sendsBefore = messageSends + draftSends;
  await ocrSay(42, "Draft an email to the address above saying we had to cancel the order");
  assert.equal(gmailDrafts, draftsBefore + 1, "cancel in the body stays a draft");
  assert.equal(messageSends + draftSends, sendsBefore);
  assert.equal(getPendingAction(42)?.action, "draft_email");
}

{
  const sendsBefore = messageSends + draftSends;
  const refused = await sendEmailFromTool(
    { to: ["Jeff"], instruction: "please send me the deck" },
    { userText: "Draft an email to Jeff saying please send me the deck", confirmation: { chatId: 43, messageId: 1 } },
  );
  assert.match(refused, /Not sent: he asked for a draft/);
  assert.equal(messageSends + draftSends, sendsBefore);
}

rememberContactChoice("Jeff", { name: "Jeff", emails: ["jeff@example.com"], sources: ["known"] });
rememberContactChoice("Munil", { name: "Munil", emails: ["munil@example.com"], sources: ["known"] });
rememberContactChoice("Dorothy", { name: "Dorothy", emails: ["dorothy@example.com"], sources: ["known"] });
// These check what his words ask for, so they are people he has emailed before, and
// each call stands in for dispatch's own-turn mark.
for (const email of ["jeff@example.com", "munil@example.com", "dorothy@example.com"]) {
  recordKnownRecipient(email, "test");
}

{
  const sendsBefore = messageSends;
  const scheduledBefore = listOpenScheduledSends().length;
  const sent = await sendEmailFromTool(
    { to: ["Jeff"], instruction: "the proposal is ready" },
    { userText: "Send Jeff an email saying the proposal is ready", confirmation: { chatId: 44, messageId: 1 }, ownTurn: true },
  );
  assert.match(sent, /Sent to/i);
  assert.equal(messageSends, sendsBefore + 1);
  assert.equal(listOpenScheduledSends().length, scheduledBefore);
  assert.match(latestSentTo, /jeff@example\.com/i);
}

{
  const sendsBefore = messageSends;
  const sent = await sendEmailFromTool(
    { to: ["Munil"], instruction: "the pricing call" },
    { userText: "Email Munil about the pricing call", confirmation: { chatId: 45, messageId: 1 }, ownTurn: true },
  );
  assert.match(sent, /Sent to/i);
  assert.equal(messageSends, sendsBefore + 1);
  assert.match(latestSentTo, /munil@example\.com/i);
}

{
  const sendsBefore = messageSends;
  const scheduledBefore = listOpenScheduledSends().length;
  const sent = await sendEmailFromTool(
    { to: ["Dorothy"], instruction: "thanks, we'll share the deck tomorrow" },
    { userText: "Reply to Dorothy saying thanks, we'll share the deck tomorrow", confirmation: { chatId: 46, messageId: 1 }, ownTurn: true },
  );
  assert.match(sent, /Sent to/i);
  assert.equal(messageSends, sendsBefore + 1);
  assert.equal(listOpenScheduledSends().length, scheduledBefore, "tomorrow in the body must not schedule");
  assert.match(latestSentTo, /dorothy@example\.com/i);
}

{
  const sendsBefore = messageSends + draftSends;
  await ocrSay(47, "Send an email to the address above tomorrow at 6 pm saying hello");
  assert.equal(messageSends + draftSends, sendsBefore, "command-part tomorrow must schedule, not send now");
  assert.equal(latestSchedule(47)?.send_at, tomorrowIso("18:00"));
}

{
  const sendsBefore = messageSends + draftSends;
  await ocrSay(48, "Schedule an email to the address above for tomorrow at 6 pm saying our meeting is tomorrow at 10");
  assert.equal(messageSends + draftSends, sendsBefore);
  assert.equal(latestSchedule(48)?.send_at, tomorrowIso("18:00"));
}

{
  const sendsBefore = messageSends + draftSends;
  await ocrSay(49, `Schedule an email to the address above on ${future} at 5:30 pm saying hello`);
  assert.equal(messageSends + draftSends, sendsBefore);
  assert.equal(latestSchedule(49)?.send_at, new Date(`${future}T17:30:00+05:30`).toISOString());
}

{
  const sendsBefore = messageSends + draftSends;
  await ocrSay(50, `Schedule an email to the address above on ${future} at 12 am saying hello`);
  assert.equal(latestSchedule(50)?.send_at, new Date(`${future}T00:00:00+05:30`).toISOString());
  await ocrSay(51, `Schedule an email to the address above on ${future} at 12 pm saying hello`);
  assert.equal(latestSchedule(51)?.send_at, new Date(`${future}T12:00:00+05:30`).toISOString());
  const scheduledBefore = listOpenScheduledSends().length;
  await ocrSay(52, `Schedule an email to the address above on ${future} at 17:30 pm saying hello`);
  assert.match(replies.at(-1) ?? "", /doesn't make sense|day and time/i);
  assert.equal(messageSends + draftSends, sendsBefore);
  assert.equal(listOpenScheduledSends().length, scheduledBefore, "contradictory 17:30 pm must not schedule");
  assert.equal(latestSchedule(52), undefined);
}

{
  const sendsBefore = messageSends;
  const scheduledBefore = listOpenScheduledSends().length;
  await ocrSay(53, "Send an email to the address above saying the call is on 2026-11-25 at 10:00");
  assert.equal(messageSends, sendsBefore + 1, "a date in the body must send now");
  assert.equal(listOpenScheduledSends().length, scheduledBefore);
  assert.match(latestSentTo, /info@msopsai\.com/i);
}

{
  const sendsBefore = messageSends;
  const scheduledBefore = listOpenScheduledSends().length;
  await ocrSay(54, "Send an email to the address above about our meeting tomorrow at 10:00");
  assert.equal(messageSends, sendsBefore + 1, "about tomorrow is content, not a schedule");
  assert.equal(listOpenScheduledSends().length, scheduledBefore);
}

{
  const sendsBefore = messageSends + draftSends;
  const scheduledBefore = listOpenScheduledSends().length;
  await ocrSay(55, "Schedule an email to the address above saying our meeting is tomorrow at 10");
  assert.match(replies.at(-1) ?? "", /day and time/i);
  assert.equal(messageSends + draftSends, sendsBefore);
  assert.equal(listOpenScheduledSends().length, scheduledBefore);
}

{
  const sendsBefore = messageSends;
  await ocrSay(56, "Send an email to the address above ki the call is on 2026-11-25 at 10:00");
  assert.equal(messageSends, sendsBefore + 1, "Hindi ki keeps the date in the body");
}

{
  const sendsBefore = messageSends;
  const scheduledBefore = listOpenScheduledSends().length;
  await ocrSay(57, "Send an email to the address above, the call is on 2026-11-25 at 10:00 ennu parayu");
  assert.equal(messageSends, sendsBefore + 1, "Malayalam ennu never becomes the send time");
  assert.equal(listOpenScheduledSends().length, scheduledBefore);
}

{
  const draftsBefore = gmailDrafts;
  const sendsBefore = messageSends + draftSends;
  await ocrSay(58, "Send an email to the address above about the launch and Bcc Jeff");
  assert.match(replies.at(-1) ?? "", /Bcc/i);
  assert.equal(gmailDrafts, draftsBefore);
  assert.equal(messageSends + draftSends, sendsBefore);
}

{
  const before = [gmailDrafts, draftSends, messageSends];
  const userText = "Send an email to Jeff saying hi, send it tomorrow at 9 am";
  const turn = { userText, confirmation: { chatId: 59, messageId: nextMessageId() }, iteration: 1, calledTools: [] };
  const args = { subject: "Hello", body: "Hi", send_immediately: true };
  for (const result of [
    await draftNewEmail({ ...args, to: "jeff@example.com" }, turn),
    await draftReply({ ...args, email_id: "thread" }, turn),
  ]) {
    assert.equal(result, "Not sent: you mentioned when to send it. Tell me the day and time and I'll schedule it.");
  }
  assert.deepEqual([gmailDrafts, draftSends, messageSends], before);
}

for (const [userText, recipient] of [
  ["Tell Jeff by email that the deck is ready", "Jeff"],
  ["Send Jeff an email that the call is at 5 pm", "Jeff"],
  ["Email Munil that we'll meet tomorrow", "Munil"],
  ["send that email to Jeff", "Jeff"],
] as const) {
  assert.ok(commandIntents(userText).includes("send"), userText);
  const before = messageSends + draftSends;
  const result = await sendEmailFromTool(
    { to: [recipient], instruction: "Hello" },
    { userText, confirmation: { chatId: 60, messageId: nextMessageId() }, ownTurn: true },
  );
  assert.match(result, /^Sent to/);
  assert.equal(messageSends + draftSends, before + 1);
  assert.equal(latestSentTo.includes(`${recipient.toLowerCase()}@example.com`), true);
  assert.equal(latestSchedule(60), undefined);
}

{
  const before = messageSends + draftSends;
  const sendOn = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(tomorrowIso("18:00")));
  const wording = "Email Jeff about the renewal and schedule it for tomorrow at 6 pm";
  assert.equal(parseOwnerEmailSendAt(wording), undefined);
  await sendEmailFromTool(
    { to: ["Jeff"], instruction: "The renewal", send_on: sendOn, send_time: "18:00" },
    { userText: wording, confirmation: { chatId: 61, messageId: nextMessageId() }, ownTurn: true },
  );
  assert.equal(latestSchedule(61)?.send_at, tomorrowIso("18:00"));
  assert.equal(messageSends + draftSends, before);
}

{
  const chatId = 62;
  const before = messageSends + draftSends;
  savePendingAction(chatId, {
    action: "send_email", status: "open", ownerWords: "Email Jeff", authorizedAt: new Date().toISOString(),
    confirmChat: chatId, confirmMessage: 1, updatedAt: new Date().toISOString(),
    email: { to: [{ query: "Jeff", name: "Jeff", email: "jeff@example.com", resolved: true }],
      cc: [], notes: [], purpose: "The deck", account: "work", waiting: "confirm" },
  });
  const send = (userText: string, timing = {}) => sendEmailFromTool(
    { to: ["Jeff"], instruction: "The deck", ...timing }, { userText, confirmation: { chatId, messageId: nextMessageId() }, ownTurn: true },
  );
  await send("tell him that the call moved to 5 pm");
  assert.equal(latestSchedule(chatId), undefined);
  assert.equal(messageSends + draftSends, before);
  const words = "schedule that for tomorrow at 5 pm";
  const parsed = parseOwnerEmailSendAt(words);
  assert.ok(parsed && "sendTime" in parsed);
  await send(words, { send_on: parsed.sendOn, send_time: parsed.sendTime });
  assert.equal(latestSchedule(chatId)?.send_at, tomorrowIso("17:00"));
  assert.equal(messageSends + draftSends, before);
}

db.pragma("foreign_keys = ON");
const expired = createDocument("old.jpg", "work", "old@example.com", null);
const kept = createDocument("new.jpg", "work", "new@example.com", null);
db.prepare("UPDATE documents SET created_at = datetime('now', '-8 days') WHERE id = ?").run(expired.id);
rememberTelegramDocumentRef(11, 1, expired.id);
rememberTelegramDocumentRef(11, 2, kept.id);
assert.doesNotThrow(() => deleteExpiredDocuments());
assert.equal(getDocument(expired.id), undefined);
assert.equal(documentRefForTelegramMessage(11, 1, 0), undefined);
assert.equal(getDocument(kept.id)?.extracted_text, "new@example.com");
assert.equal(documentRefForTelegramMessage(11, 2, 0), kept.id);

console.log("OCR referenced email checks passed");
