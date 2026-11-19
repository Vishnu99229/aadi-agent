/** The owner's Telegram reference selects one OCR recipient, never an older
 * Gmail draft. All Telegram/Google calls are fakes; nothing is sent. */
import assert from "node:assert/strict";
import { bot } from "../src/bot.ts";
import {
  bindEmailReferenceForTurn,
  emailReferenceForTurn,
  refersToEarlierEmail,
  resolveEmailReference,
} from "../src/email_references.ts";
import {
  createDocument,
  db,
  deleteExpiredDocuments,
  documentRefForTelegramMessage,
  getDocument,
  getPendingActionContext,
  getScheduledSend,
  createScheduledSend,
  rememberTelegramDocumentRef,
} from "../src/db.ts";
import { queueDraftApproval } from "../src/approvals.ts";
import { getPendingAction, savePendingAction } from "../src/action_context.ts";
import { handler as draftNewEmail } from "../src/tools/draft_new_email.ts";
import { handler as draftReply } from "../src/tools/draft_reply.ts";
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
const gmailFor = (account: { id: string }) => ({
  users: {
    drafts: {
      create: async ({ requestBody }: { requestBody: { message: { raw: string } } }) => {
        gmailDrafts++;
        sentAccounts.push(account.id);
        const raw = Buffer.from(requestBody.message.raw, "base64url").toString("utf8");
        latestDraftRecipient = /^To:\s*(.*)$/im.exec(raw)?.[1]?.trim() ?? "";
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
        data: { id, message: { id, threadId: `thread-${id}`, payload: { headers: [{ name: "To", value: "alice@example.com" }, { name: "Subject", value: "Hello" }], mimeType: "text/plain", body: { data: Buffer.from("Hello", "utf8").toString("base64url") } } } },
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
await say("Send an email to the address above about our discussion");
assert.equal(latestSentTo.toLowerCase().includes("info@msopsai.com"), true, latestSentTo);
assert.equal(latestSentTo.toLowerCase().includes("vasanth"), false);
assert.equal(messageSends, sendsBeforeAddress + 1);
assert.equal(draftSends, 0);

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

const personal = await sendEmailFromTool(
  { to: ["personal@example.com"], instruction: "A personal note", account: "personal" },
  { userText: "Send an email to personal@example.com about the note", confirmation: { chatId: 9, messageId: 3 } },
);
assert.match(personal, /Sent to/i);
assert.equal(sentAccounts.includes("message:personal"), true);
const work = await sendEmailFromTool(
  { to: ["work@example.com"], instruction: "A work note", account: "work" },
  { userText: "Send an email to work@example.com about the note", confirmation: { chatId: 9, messageId: 4 } },
);
assert.match(work, /Sent to/i);
assert.equal(sentAccounts.filter((item) => item === "message:work").length >= 1, true);

const once = "draft-once";
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
  { userText: "send it now", confirmation: { chatId: 12, messageId: nextMessageId() } },
);
assert.match(sentNow, /Sent/i);
assert.equal(draftSends + messageSends, beforeOnce + 1);
assert.equal(getScheduledSend(onceSchedule!.id)?.status, "sent");
const again = await sendEmailFromTool(
  { to: ["once@example.com"], instruction: "Send this once" },
  { userText: "send it now", confirmation: { chatId: 12, messageId: nextMessageId() } },
);
assert.match(again, /already|nothing was sent|no draft is waiting/i);
assert.equal(draftSends + messageSends, beforeOnce + 1);

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
