/** Greeting name and domain checks. Fake Gmail and fake DNS. Nothing is sent. */
import assert from "node:assert/strict";
import type { Api } from "grammy";
import type { gmail_v1 } from "googleapis";
import { setApprovalsTestHooks } from "../src/approvals.ts";
import { sendEmailFromTool, setCommandEmailTestHooks } from "../src/command_email.ts";
import { writeCommandEmail } from "../src/command_writer.ts";
import { composeWithEmailAgent } from "../src/context_draft.ts";
import { createDocument, createMemory, listOpenScheduledSends } from "../src/db.ts";
import {
  fromNameForAddress,
  neutralGreeting,
  outcomeFromLookup,
  setDomainLookupForTests,
  type DomainStatus,
} from "../src/email_grounding.ts";
import { handler as draftReply } from "../src/tools/draft_reply.ts";
import { setGoogleAccountForTests } from "../src/google/auth.ts";
import { setGmailClientForTests } from "../src/google/mail.ts";
import { setCompleteForTests } from "../src/llm.ts";
import { rememberContactChoice } from "../src/contacts.ts";
import { modelReply } from "./fakes.ts";

if (process.env.AADI_DB_PATH !== ":memory:") {
  throw new Error("email grounding tests must use :memory: database");
}

assert.equal(outcomeFromLookup("timeout", "no"), "unknown");
assert.equal(outcomeFromLookup("no", "timeout"), "unknown");
assert.equal(outcomeFromLookup("no", "no"), "no");
assert.equal(outcomeFromLookup("yes", "timeout"), "yes");

let sends = 0;
let lastBody = "";
let lastPrompt = "";
const gmail = {
  users: {
    getProfile: async () => ({ data: { emailAddress: "vishnu@epicode.in" } }),
    settings: { sendAs: { list: async () => ({ data: { sendAs: [] } }) } },
    threads: {
      get: async () => ({
        data: {
          messages: [{
            id: "m1",
            internalDate: "1",
            payload: {
              headers: [
                { name: "From", value: "Jeff Comstock <jeff@acme.com>" },
                { name: "Subject", value: "Hello" },
              ],
              mimeType: "text/plain",
              body: { data: Buffer.from("Hello", "utf8").toString("base64url") },
            },
          }],
        },
      }),
    },
    messages: {
      list: async () => ({ data: { messages: [] } }),
      get: async () => ({
        data: {
          id: "reply-1",
          threadId: "thread-jeff",
          payload: {
            headers: [
              { name: "From", value: "Jeff Comstock <jeff@acme.com>" },
              { name: "To", value: "vishnu@epicode.in" },
              { name: "Subject", value: "Hello" },
              { name: "Message-ID", value: "<jeff-1@acme.com>" },
            ],
          },
        },
      }),
      send: async ({ requestBody }: { requestBody: { raw: string } }) => {
        sends += 1;
        const raw = Buffer.from(requestBody.raw, "base64url").toString("utf8");
        const encoded = /Content-Transfer-Encoding: base64\r?\n\r?\n([A-Za-z0-9+/=\r\n]+)/.exec(raw)?.[1] ?? "";
        lastBody = Buffer.from(encoded.replace(/\s/g, ""), "base64").toString("utf8");
        return { data: { id: `msg-${sends}` } };
      },
    },
    drafts: { create: async () => ({ data: { id: "d", message: { id: "d" } } }) },
  },
} as unknown as gmail_v1.Gmail;
setGoogleAccountForTests((id) => ({ id, tag: id, label: id, client: {} }) as never);
setGmailClientForTests(() => gmail);
const telegram = { sendMessage: async () => ({ message_id: 1 }) } as unknown as Api;
setCommandEmailTestHooks({ telegram });
setApprovalsTestHooks({ telegram, gmailFor: () => gmail });
setCompleteForTests(async (params) => {
  lastPrompt = params.messages.map((message) => (typeof message.content === "string" ? message.content : "")).join("\n");
  return modelReply({
    text: JSON.stringify({ subject: "Following up", body: "Hi Nithish,\n\nWe met at the Bangalore tech event." }),
  });
});
setDomainLookupForTests(async (domain): Promise<DomainStatus> => {
  if (domain === "sarkvision.com") return "no";
  if (domain === "timeout.example") return "unknown";
  return "yes";
});

createMemory({ content: "Contact name is Nithish", category: "person", tag: "work", source: "auto" });

{
  const before = sends;
  const sent = await sendEmailFromTool(
    { to: ["contact@sargvision.com"], instruction: "Tell him we met at the Bangalore tech event and I am with Epicode." },
    {
      userText: "Send to contact@sargvision.com saying we met at the Bangalore tech event and I am with Epicode",
      confirmation: { chatId: 1, messageId: 1 },
    },
  );
  assert.match(sent, /Sent to/i);
  assert.equal(sends, before + 1);
  assert.match(lastBody, /^Hi Sargvision team,/);
  assert.doesNotMatch(lastBody, /Hi Nithish/);
  assert.match(lastPrompt, /RECIPIENT NAME: none, use a neutral greeting/);
  assert.doesNotMatch(lastPrompt, /Contact name is Nithish/);
}

rememberContactChoice("Jeff", { name: "Jeff Comstock", emails: ["jeff@example.com"], sources: ["known"] });
{
  const sent = await sendEmailFromTool(
    { to: ["jeff@example.com"], instruction: "the deck is ready" },
    {
      userText: "Send an email to jeff@example.com saying the deck is ready",
      confirmation: { chatId: 1, messageId: 2 },
    },
  );
  assert.match(sent, /Sent to/i);
  assert.match(lastBody, /^Hi Jeff/);
  assert.doesNotMatch(lastBody, /Hi Nithish/);
  assert.match(lastPrompt, /RECIPIENT NAME: Jeff Comstock/);
}

{
  const sent = await sendEmailFromTool(
    { to: ["priya@example.com"], instruction: "the deck is ready" },
    {
      userText: "Tell Priya at priya@example.com that the deck is ready",
      confirmation: { chatId: 1, messageId: 3 },
    },
  );
  assert.match(sent, /Sent to/i);
  assert.match(lastBody, /^Hi Priya,/);
  assert.doesNotMatch(lastBody, /Hi Nithish/);
}

createDocument("card.jpg", "work", "contact@sargvision.com\nSARGVISION INTELLIGENCE PVT. LTD.", null);
{
  const before = sends;
  const scheduledBefore = listOpenScheduledSends().length;
  const future = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
  const refused = await sendEmailFromTool(
    {
      to: ["contact@sarkvision.com"],
      instruction: "we met at the Bangalore tech event",
      send_on: future,
      send_time: "10:00",
    },
    {
      userText: "Send to contact@sarkvision.com tomorrow at 10 AM",
      confirmation: { chatId: 1, messageId: 4 },
    },
  );
  assert.match(refused, /Not sent: sarkvision\.com doesn't accept email\. Did you mean contact@sargvision\.com\?/);
  assert.equal(sends, before);
  assert.equal(listOpenScheduledSends().length, scheduledBefore);
}

{
  const before = sends;
  const sent = await sendEmailFromTool(
    { to: ["user@timeout.example"], instruction: "hello there" },
    {
      userText: "Send an email to user@timeout.example saying hello there",
      confirmation: { chatId: 1, messageId: 5 },
    },
  );
  assert.match(sent, /Sent to/i);
  assert.equal(sends, before + 1);
}

{
  const draft = await composeWithEmailAgent(
    "Write one email. To: contact@sargvision.com\nInstruction: we met at the Bangalore tech event",
    {
      ownWords: "Draft an email to contact@sargvision.com saying we met at the Bangalore tech event",
      toEmail: "contact@sargvision.com",
    },
  );
  assert.match(draft.body, /^Hi Sargvision team,/);
  assert.doesNotMatch(draft.body, /Hi Nithish/);
  assert.match(lastPrompt, /RECIPIENT NAME: none, use a neutral greeting/);
}

assert.equal(fromNameForAddress(["Jeff Comstock <jeff@acme.com>", "Other Person <other@acme.com>"], "jeff@acme.com"), "Jeff Comstock");
assert.equal(fromNameForAddress(["Vishnu Rajan <vishnu@epicode.in>"], "jeff@acme.com"), undefined);
for (const domain of ["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com", "rediffmail.com"]) {
  assert.equal(neutralGreeting(`contact@${domain}`), "Hi,", domain);
}
assert.equal(neutralGreeting("contact@sargvision.com"), "Hi Sargvision team,");

{
  const written = await writeCommandEmail({
    gmail,
    ownWords: "Reply to the thread and say thanks",
    instruction: "say thanks",
    recipientNames: ["jeff@acme.com"],
    recipientAddresses: ["jeff@acme.com"],
    threadId: "thread-jeff",
    now: new Date("2026-11-20T08:00:00Z"),
  });
  assert.match(written.body, /^Hi Jeff Comstock,/);
  assert.doesNotMatch(written.body, /Hi Nithish/);
  assert.match(lastPrompt, /RECIPIENT NAME: Jeff Comstock/);
}

{
  let drafted = "";
  const previous = gmail.users.drafts.create;
  gmail.users.drafts.create = async ({ requestBody }: { requestBody: { message: { raw: string } } }) => {
    const raw = Buffer.from(requestBody.message.raw, "base64url").toString("utf8");
    const encoded = /Content-Transfer-Encoding: base64\r?\n\r?\n([A-Za-z0-9+/=\r\n]+)/.exec(raw)?.[1] ?? "";
    drafted = Buffer.from(encoded.replace(/\s/g, ""), "base64").toString("utf8");
    return { data: { id: "reply-draft", message: { id: "reply-draft", threadId: "thread-jeff" } } };
  };
  const created = await draftReply(
    { email_id: "reply-1", body: "Hi Nithish,\n\nThanks for writing.", account: "work" },
    { iteration: 1, calledTools: [], userText: "Reply in this thread and say thanks", confirmation: { chatId: 1, messageId: 9 } },
  );
  gmail.users.drafts.create = previous;
  assert.match(created, /reply-draft/);
  assert.match(drafted, /^Hi Jeff Comstock,/);
  assert.doesNotMatch(drafted, /Hi Nithish/);
}

{
  const before = sends;
  const sent = await sendEmailFromTool(
    { to: ["contact@gmail.com"], instruction: "the notes from today" },
    {
      userText: "Send an email to contact@gmail.com saying the notes from today",
      confirmation: { chatId: 1, messageId: 8 },
    },
  );
  assert.match(sent, /Sent to/i);
  assert.equal(sends, before + 1);
  assert.match(lastBody, /^Hi,/);
  assert.doesNotMatch(lastBody, /Gmail team/);
}

console.log("email grounding checks passed");
