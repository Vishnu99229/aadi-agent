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
  getPendingActionContext,
  rememberTelegramDocumentRef,
} from "../src/db.ts";
import { getPendingAction, savePendingAction } from "../src/action_context.ts";
import { handler as draftNewEmail } from "../src/tools/draft_new_email.ts";
import { handler as draftReply } from "../src/tools/draft_reply.ts";
import { handler as updateDraft } from "../src/tools/update_draft.ts";
import { sendEmailFromTool } from "../src/command_email.ts";
import { setGoogleAccountForTests } from "../src/google/auth.ts";
import { setGmailClientForTests } from "../src/google/mail.ts";
import { setApprovalsTestHooks } from "../src/approvals.ts";
import type { Api } from "grammy";
import type { gmail_v1 } from "googleapis";
import { nextMessageId } from "./fakes.ts";

if (process.env.AADI_DB_PATH !== ":memory:") {
  throw new Error("OCR recipient tests must use :memory: database");
}

let gmailDrafts = 0;
let latestDraftRecipient = "";
const gmail = {
  users: {
    drafts: { create: async ({ requestBody }: { requestBody: { message: { raw: string } } }) => {
      gmailDrafts++;
      const raw = Buffer.from(requestBody.message.raw, "base64url").toString("utf8");
      latestDraftRecipient = /^To:\s*(.*)$/im.exec(raw)?.[1]?.trim() ?? "";
      return { data: { id: `new-${gmailDrafts}` } };
    } },
    messages: { send: async () => { throw new Error("must not send"); } },
    settings: { sendAs: { list: async () => ({ data: { sendAs: [] } }) } },
  },
} as unknown as gmail_v1.Gmail;
setGoogleAccountForTests((id) => ({ id, tag: id, label: id, client: {} }) as never);
setGmailClientForTests(() => gmail);

const replies: string[] = [];
const telegram = {
  sendMessage: async (_chat: unknown, text: string) => ({ message_id: nextMessageId(), text }),
} as unknown as Api;
setApprovalsTestHooks({ telegram, gmailFor: () => gmail });
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

console.log("OCR referenced email checks passed");
