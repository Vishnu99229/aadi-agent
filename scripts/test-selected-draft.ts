// An Edit tap picks one draft. The next message, and the follow-ups after it, change
// that draft even when a newer draft exists. Driven through the real bot handlers with a
// fake Telegram, fake Gmail and a scripted model. Nothing real is sent.
import type { Api } from "grammy";
import type { gmail_v1 } from "googleapis";
import { getPendingAction as getChatAction } from "../src/action_context.ts";
import { handleApprovalCallback, setApprovalsTestHooks } from "../src/approvals.ts";
import { bot } from "../src/bot.ts";
import { setGoogleAccountForTests, type LoadedGoogleAccount } from "../src/google/auth.ts";
import { setGmailClientForTests } from "../src/google/mail.ts";
import { setCompleteForTests, type CompleteParams, type CompleteResult } from "../src/llm.ts";
import { handler as draftNewEmail } from "../src/tools/draft_new_email.ts";
import { modelReply, nextMessageId } from "./fakes.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

if (process.env.AADI_DB_PATH !== ":memory:") {
  throw new Error("test-selected-draft.ts must run with AADI_DB_PATH=:memory:");
}

const log = console.log;
console.log = () => undefined;
console.error = () => undefined;
console.warn = () => undefined;

// ---- fake Gmail drafts ----
const drafts = new Map<string, { to: string; subject: string; body: string }>();
let counter = 0;
const headerOf = (raw: string, name: string) =>
  new RegExp(`^${name}: (.*)$`, "im").exec(raw.split(/\r?\n\r?\n/)[0] ?? "")?.[1]?.trim() ?? "";
function bodyOf(raw: string): string {
  const encoded = /Content-Transfer-Encoding: base64\r?\n\r?\n([A-Za-z0-9+/=\r\n]+)/.exec(raw)?.[1];
  return encoded
    ? Buffer.from(encoded.replace(/\s/g, ""), "base64").toString("utf8").trim()
    : raw.split(/\r?\n\r?\n/).slice(1).join("\n").trim();
}
function store(id: string, rawBase64: string): void {
  const raw = Buffer.from(rawBase64, "base64url").toString("utf8");
  drafts.set(id, { to: headerOf(raw, "To"), subject: headerOf(raw, "Subject"), body: bodyOf(raw) });
}
const gmail = {
  users: {
    getProfile: async () => ({ data: { emailAddress: "vishnu.rajan@epicode.in" } }),
    settings: { sendAs: { list: async () => ({ data: { sendAs: [{ sendAsEmail: "vishnu.rajan@epicode.in", isDefault: true, signature: "" }] } }) } },
    drafts: {
      create: async ({ requestBody }: { requestBody: { message: { raw: string } } }) => {
        counter += 1;
        const id = `draft-${counter}`;
        store(id, requestBody.message.raw);
        return { data: { id, message: { id, threadId: `thread-${id}` } } };
      },
      get: async ({ id }: { id: string }) => {
        const draft = drafts.get(id);
        if (!draft) {
          throw Object.assign(new Error("missing"), { code: 404 });
        }
        return {
          data: {
            id,
            message: {
              id,
              threadId: `thread-${id}`,
              payload: {
                headers: [
                  { name: "To", value: draft.to },
                  { name: "Subject", value: draft.subject },
                ],
                mimeType: "text/plain",
                body: { data: Buffer.from(draft.body, "utf8").toString("base64url") },
              },
            },
          },
        };
      },
      update: async ({ id, requestBody }: { id: string; requestBody: { message: { raw: string } } }) => {
        store(id, requestBody.message.raw);
        return { data: { id, message: { id, threadId: `thread-${id}` } } };
      },
      send: async () => {
        throw new Error("nothing is sent in this test");
      },
    },
  },
} as unknown as gmail_v1.Gmail;
const workAccount = { id: "work", tag: "work", label: "work", client: {} } as unknown as LoadedGoogleAccount;
setGoogleAccountForTests(() => workAccount);
setGmailClientForTests(() => gmail);

// ---- fake Telegram: approval cards and the bot's own replies ----
const cards: Array<{ text: string; buttons: string[] }> = [];
const telegram = {
  sendMessage: async (_chat: unknown, text: string, extra?: { reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } }) => {
    cards.push({ text, buttons: (extra?.reply_markup?.inline_keyboard ?? []).flat().map((item) => item.callback_data ?? "") });
    return { message_id: nextMessageId(), date: 0, chat: { id: 1, type: "private" }, text };
  },
  editMessageText: async (_chat: unknown, _id: unknown, text: string, extra?: { reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } }) => {
    cards.push({ text, buttons: (extra?.reply_markup?.inline_keyboard ?? []).flat().map((item) => item.callback_data ?? "") });
    return true;
  },
} as unknown as Api;
setApprovalsTestHooks({ telegram, gmailFor: () => gmail });

const replies: string[] = [];
bot.api.config.use(async (_prev, method, payload) => {
  if (method === "getMe") {
    return { ok: true, result: { id: 999, is_bot: true, first_name: "Aadi", username: "aadi_test_bot" } } as never;
  }
  if (method === "sendMessage") {
    const text = (payload as { text: string }).text;
    replies.push(text);
    return { ok: true, result: { message_id: nextMessageId(), date: 0, chat: { id: 1, type: "private" }, text } } as never;
  }
  return { ok: true, result: true } as never;
});
await bot.init();

// ---- models: the edit agent calls update_draft on the draft it was given; the Email
//      Agent rewrites from the facts it is shown ----
const editedIds: string[] = [];
setCompleteForTests(async (params: CompleteParams): Promise<CompleteResult> => {
  if (params.jsonSchema) {
    const facts = params.messages.map((message) => (typeof message.content === "string" ? message.content : "")).join("\n");
    const venue = /venue/i.test(facts) ? " The venue is the Indiranagar office." : "";
    const current = /Current body:\n([\s\S]*?)\n\nVishnu's correction/.exec(facts)?.[1]?.trim() ?? "Hi,";
    return modelReply({ text: JSON.stringify({ subject: "ignored", body: `${current}${venue}` }) });
  }
  if (params.tools.length === 0) {
    return modelReply({ text: '{"facts":[]}' });
  }
  const last = params.messages.at(-1);
  if (last?.role === "tool") {
    return modelReply({ text: "Updated the draft." });
  }
  const asked = params.messages.map((message) => (typeof message.content === "string" ? message.content : "")).join("\n");
  const target = /Revise the existing Gmail draft with ID (\S+)\./.exec(asked)?.[1];
  if (target) {
    editedIds.push(target);
    return modelReply({ tools: [{ name: "update_draft", input: { draft_id: target, body: "Hi,\n\nShorter version." } }] });
  }
  return modelReply({ text: "Okay." });
});

async function say(text: string): Promise<void> {
  const messageId = nextMessageId();
  await bot.handleUpdate({
    update_id: messageId,
    message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 1, type: "private", first_name: "Vishnu" },
      from: { id: 1, is_bot: false, first_name: "Vishnu" },
      text,
    },
  } as never);
  await new Promise((resolve) => setTimeout(resolve, 30));
}

const turn = (userText: string) => ({ iteration: 1, calledTools: [] as string[], userText, confirmation: { chatId: 1, messageId: nextMessageId() } });
async function draft(to: string, subject: string, body: string): Promise<{ id: string; actionId: number }> {
  const result = await draftNewEmail({ to, subject, body }, turn(`Draft an email to ${to}`));
  const id = /draft_id:\s*(\S+)/.exec(result)![1]!;
  const card = [...cards].reverse().find((item) => item.text.includes(to))!;
  const edit = card.buttons.find((data) => data.startsWith("approval:edit:"))!;
  return { id, actionId: Number(edit.split(":").pop()) };
}

// Two drafts: Alice's first, then Bob's, which is now the chat's open email.
const alice = await draft("alice@example.com", "Workshop", "Hi Alice,\n\nThe workshop runs all day with three sessions and lunch.");
const bob = await draft("bob@example.com", "Invoice", "Hi Bob,\n\nThe invoice is due on the 30th.");
const bobBefore = JSON.stringify(drafts.get(bob.id));
assert(getChatAction(1)?.email?.draftId === bob.id, "Bob's newer draft is the chat's open email");

// 1. Edit tapped on Alice's older card: "make it shorter" changes Alice's draft, not Bob's.
const tapped: string[] = [];
await handleApprovalCallback(
  {
    answerCallbackQuery: async (text?: unknown) => {
      tapped.push(typeof text === "string" ? text : "ok");
    },
    reply: async (text: string) => {
      tapped.push(text);
    },
  } as never,
  "edit",
  alice.actionId,
);
assert(tapped.some((text) => /change in this draft/i.test(text)), "the Edit tap asks what to change");
await say("make it shorter");
assert(editedIds.length === 1 && editedIds[0] === alice.id, `the selected draft is the one revised, got ${editedIds.join(",")}`);
assert(drafts.get(alice.id)!.body.startsWith("Hi,\n\nShorter version."), `Alice's draft changed, got ${drafts.get(alice.id)!.body}`);
assert(JSON.stringify(drafts.get(bob.id)) === bobBefore, "Bob's newer draft is untouched");
assert(getChatAction(1)?.email?.draftId === alice.id, "the chat's open email is now Alice's draft");

// 2. The follow-up after the edit changes the same selected draft.
await say("also mention the venue");
assert(/venue is the Indiranagar office/.test(drafts.get(alice.id)!.body), `the follow-up revised Alice's draft, got ${drafts.get(alice.id)!.body}`);
assert(drafts.get(alice.id)!.body.startsWith("Hi,\n\nShorter version."), "starting from the edited wording, not a stale copy");
assert(JSON.stringify(drafts.get(bob.id)) === bobBefore, "Bob's draft is still untouched");
assert(drafts.get(alice.id)!.to.includes("alice@example.com"), "and Alice's draft still goes to Alice");

// 3. An Edit tap on Bob's card moves the focus back to Bob.
await handleApprovalCallback({ answerCallbackQuery: async () => undefined, reply: async () => undefined } as never, "edit", bob.actionId);
await say("make it shorter");
assert(editedIds.at(-1) === bob.id && drafts.get(bob.id)!.body.startsWith("Hi,\n\nShorter version."), "the newly selected draft is the one changed");
assert(getChatAction(1)?.email?.draftId === bob.id, "and becomes the open email");

console.log = log;
console.log("selected draft checks passed.");
