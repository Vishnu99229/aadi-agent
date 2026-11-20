/** Greeting name and domain checks. Fake Gmail and fake DNS. Nothing is sent. */
import assert from "node:assert/strict";
import type { Api } from "grammy";
import type { gmail_v1 } from "googleapis";
import { sendEmailFromTool, setCommandEmailTestHooks } from "../src/command_email.ts";
import { composeWithEmailAgent } from "../src/context_draft.ts";
import { createDocument, createMemory, listOpenScheduledSends } from "../src/db.ts";
import {
  outcomeFromLookup,
  setDomainLookupForTests,
  type DomainStatus,
} from "../src/email_grounding.ts";
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
    messages: {
      list: async () => ({ data: { messages: [] } }),
      get: async () => ({ data: { payload: { headers: [] } } }),
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
setCommandEmailTestHooks({
  telegram: { sendMessage: async () => ({ message_id: 1 }) } as unknown as Api,
});
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

console.log("email grounding checks passed");
