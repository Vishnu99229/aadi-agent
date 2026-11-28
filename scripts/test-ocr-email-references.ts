/** Photo recipients require a structural link and a Send card. Providers are faked. */
import assert from "node:assert/strict";
import type { Api } from "grammy";
import type { gmail_v1 } from "googleapis";
import { setApprovalsTestHooks } from "../src/approvals.ts";
import { sendEmailFromTool, setCommandEmailTestHooks } from "../src/command_email.ts";
import { config } from "../src/config.ts";
import { createDocument, recordConversationParticipants, recordExternalAddress, rememberTelegramDocumentRef, upsertCanonicalContact } from "../src/db.ts";
import { bindPhotoForTurn, photoForTurn, recordOwnerTypedEmailAddresses } from "../src/email_references.ts";
import { setGoogleAccountForTests } from "../src/google/auth.ts";
import { setGmailClientForTests } from "../src/google/mail.ts";
import { setCompleteForTests } from "../src/llm.ts";
import { handler as draftNewEmail } from "../src/tools/draft_new_email.ts";
import { handler as updateDraft } from "../src/tools/update_draft.ts";
import { modelReply, nextMessageId } from "./fakes.ts";

assert.equal(process.env.AADI_DB_PATH, ":memory:");
let gmailDrafts = 0;
let draftUpdates = 0;
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
      update: async ({ id }: { id: string }) => {
        draftUpdates += 1;
        return { data: { id, message: { id, threadId: `thread-${id}` } } };
      },
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
recordExternalAddress(chatId, email, `document:${source.id}`);
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
const unavailable = await sendEmailFromTool(selected, unlinked);
assert.ok(unavailable.includes("photo address is unavailable"));
assert.ok((await draftNewEmail({ to: email, subject: "Hello", body: "Hello." }, unlinked)).includes("photo address is unavailable"));
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
assert.ok((await sendEmailFromTool(selected, linked)).includes("Tap Send to confirm"));
assert.ok(latestDraftRecipient.includes(email));
assert.equal(gmailDrafts, 1);
assert.equal(draftSends + messageSends, 0, "the photo-only address waits on its Send card");

const sameTurn = turn(nextMessageId());
rememberTelegramDocumentRef(chatId, sameTurn.confirmation.messageId, source.id);
assert.deepEqual(bindPhotoForTurn({ ...sameTurn.confirmation, currentPhoto: true })?.emails, [email]);
await draftNewEmail({ to: email, photo_address: email, subject: "Hello", body: "Hello.", send_immediately: true }, sameTurn);
assert.equal(gmailDrafts, 2);
assert.equal(draftSends + messageSends, 0);
assert.equal(cardIds.length, 2);
assert.ok((await draftNewEmail({ to: email, subject: "Hello", body: "Hello." }, unlinked)).includes("photo address is unavailable"));
assert.equal(gmailDrafts, 2, "a stale OCR selection cannot create a draft");

const alice = "alice@example.com";
const oldPhoto = createDocument("older-photo.jpg", "personal", `Email: ${alice}`, null);
recordExternalAddress(chatId, alice, `document:${oldPhoto.id}`);
upsertCanonicalContact({
  nameKey: "alice", displayName: "Alice", emailsJson: JSON.stringify([alice]),
  aliasesJson: "[]", sourcesJson: "[]", confirmed: true, updatedAt: new Date().toISOString(),
});
const aliceTurn = turn(nextMessageId());
assert.equal(photoForTurn(chatId, aliceTurn.confirmation.messageId), undefined);
const drafted = await draftNewEmail({ to: alice, subject: "Hello Alice", body: "Hello." }, aliceTurn);
assert.ok(drafted.includes("Draft created for") && drafted.includes(alice), drafted);
assert.equal(gmailDrafts, 3);
const updated = await updateDraft({ draft_id: "new-3", to: alice, subject: "New subject" }, turn(nextMessageId()));
assert.equal(JSON.parse(updated).draft_id, "new-3");
assert.equal(draftUpdates, 1);
const blockedUpdate = await updateDraft({ draft_id: "new-3", to: email }, turn(nextMessageId()));
assert.ok(blockedUpdate.includes("Not updated"));
assert.equal(draftUpdates, 1);

const typed = "provided@example.com";
const participant = "participant@example.com";
for (const address of [typed, participant]) recordExternalAddress(chatId, address, `document:${oldPhoto.id}`);
recordOwnerTypedEmailAddresses(chatId, `Contact: ${typed}`);
recordConversationParticipants(chatId, [{ email: participant }], "email", "gmail-thread");
for (const address of [typed, participant]) {
  const result = await draftNewEmail({ to: address, subject: "Hello", body: "Hello." }, turn(nextMessageId()));
  assert.ok(result.includes("Draft created for") && result.includes(address), result);
}
assert.equal(gmailDrafts, 5);
assert.equal(draftSends + messageSends, 0);

setCompleteForTests(undefined);
console.log("OCR recipient checks passed.");
