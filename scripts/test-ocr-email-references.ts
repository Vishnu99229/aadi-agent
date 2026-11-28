/** Photo recipients require a structural link and a Send card. Providers are faked. */
import assert from "node:assert/strict";
import type { Api } from "grammy";
import type { gmail_v1 } from "googleapis";
import { setApprovalsTestHooks } from "../src/approvals.ts";
import { sendEmailFromTool, setCommandEmailTestHooks } from "../src/command_email.ts";
import { config } from "../src/config.ts";
import { createDocument, recordKnownRecipient, rememberTelegramDocumentRef } from "../src/db.ts";
import { bindPhotoForTurn, photoForTurn } from "../src/email_references.ts";
import { setGoogleAccountForTests } from "../src/google/auth.ts";
import { setGmailClientForTests } from "../src/google/mail.ts";
import { setCompleteForTests } from "../src/llm.ts";
import { handler as draftNewEmail } from "../src/tools/draft_new_email.ts";
import { modelReply, nextMessageId } from "./fakes.ts";

assert.equal(process.env.AADI_DB_PATH, ":memory:");
let gmailDrafts = 0;
let draftSends = 0;
let messageSends = 0;
let latestDraftRecipient = "";
const draftTo = new Map<string, string>();
const gmailFor = () => ({
  users: {
    drafts: {
      create: async ({ requestBody }: { requestBody: { message: { raw: string } } }) => {
        gmailDrafts++;
        const raw = Buffer.from(requestBody.message.raw, "base64url").toString("utf8");
        latestDraftRecipient = /^To:\s*(.*)$/im.exec(raw)?.[1]?.trim() ?? "";
        draftTo.set(`new-${gmailDrafts}`, latestDraftRecipient);
        return { data: { id: `new-${gmailDrafts}`, message: { id: `new-${gmailDrafts}`, threadId: `thread-${gmailDrafts}` } } };
      },
      send: async ({ requestBody }: { requestBody: { id: string } }) => {
        draftSends++;
        return { data: { id: `sent-${requestBody.id}` } };
      },
      get: async ({ id }: { id: string }) => ({
        data: { id, message: { id, threadId: `thread-${id}`, payload: { headers: [{ name: "To", value: draftTo.get(id) ?? "alice@example.com" }, { name: "Subject", value: "Hello" }], mimeType: "text/plain", body: { data: Buffer.from("Hello", "utf8").toString("base64url") } } } },
      }),
      update: async ({ id }: { id: string }) => ({ data: { id, message: { id, threadId: `thread-${id}` } } }),
      delete: async () => ({ data: {} }),
    },
    messages: {
      send: async () => {
        messageSends++;
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
setGmailClientForTests(gmailFor);

const cardIds: number[] = [];
const telegram = {
  sendMessage: async (_chat: unknown, text: string) => {
    const message_id = nextMessageId();
    cardIds.push(message_id);
    return { message_id, text };
  },
  editMessageText: async () => true,
} as unknown as Api;
setApprovalsTestHooks({ telegram, gmailFor });
setCommandEmailTestHooks({ telegram });
setCompleteForTests(async () => modelReply({ text: JSON.stringify({ subject: "Hello", body: "Thanks for meeting with me." }) }));

const chatId = config.ownerTelegramId;
const email = "info@photo.example";
const source = createDocument("business-card.jpg", "personal", `Contact: ${email}`, null);
const photoMessage = nextMessageId();
rememberTelegramDocumentRef(chatId, photoMessage, source.id);
recordKnownRecipient(email, "fixture");
const words = "Email this address about our meeting";
const selected = { to: [email], instruction: "Thank them for meeting with me", photo_address: email };
const turn = (messageId: number) => ({
  confirmation: { chatId, messageId },
  userText: words,
  ownTurn: true,
  iteration: 1,
  calledTools: [],
});

const unlinked = turn(nextMessageId());
assert.equal(bindPhotoForTurn(unlinked.confirmation), undefined);
assert.equal(photoForTurn(chatId, unlinked.confirmation.messageId), undefined);
assert.match(await sendEmailFromTool(selected, unlinked), /address is unavailable/);
assert.equal(gmailDrafts, 0);
assert.equal(draftSends + messageSends, 0);

const unrelatedReply = turn(nextMessageId());
assert.equal(bindPhotoForTurn({
  ...unrelatedReply.confirmation, replyTo: { message_id: photoMessage },
}), undefined, "only a reply to the actual photo enables the older OCR address");

const linked = turn(nextMessageId());
assert.deepEqual(bindPhotoForTurn({
  ...linked.confirmation, replyTo: { message_id: photoMessage, photo: [{}] },
})?.emails, [email]);
assert.match(await sendEmailFromTool(selected, linked), /Tap Send to confirm/);
assert.ok(latestDraftRecipient.includes(email));
assert.equal(gmailDrafts, 1);
assert.equal(draftSends + messageSends, 0, "even a known photo address waits on a Send card");

const sameTurn = turn(nextMessageId());
rememberTelegramDocumentRef(chatId, sameTurn.confirmation.messageId, source.id);
assert.deepEqual(bindPhotoForTurn({ ...sameTurn.confirmation, currentPhoto: true })?.emails, [email]);
await draftNewEmail({ to: email, photo_address: email, subject: "Hello", body: "Hello.", send_immediately: true }, sameTurn);
assert.equal(gmailDrafts, 2);
assert.equal(draftSends + messageSends, 0);
assert.equal(cardIds.length, 2);
assert.match(await draftNewEmail({ to: email, subject: "Hello", body: "Hello." }, unlinked), /photo address is unavailable/);
assert.equal(gmailDrafts, 2, "a stale OCR selection cannot create a draft");

setCompleteForTests(undefined);
console.log("OCR recipient checks passed.");
