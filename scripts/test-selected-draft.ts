// An Edit tap picks one draft. The next message, and the follow-ups after it, change
// that draft even when a newer draft exists. Driven through the real bot handlers with a
// fake Telegram, fake Gmail and a scripted model. Nothing real is sent.
import type { Api } from "grammy";
import type { gmail_v1 } from "googleapis";
import { focusSelectedDraft, getPendingAction as getChatAction, savePendingAction } from "../src/action_context.ts";
import { handleApprovalCallback, queueDraftApproval, sendPendingDraftByText, setApprovalsTestHooks } from "../src/approvals.ts";
import { bot } from "../src/bot.ts";
import { setGoogleAccountForTests, type LoadedGoogleAccount } from "../src/google/auth.ts";
import { setGmailClientForTests } from "../src/google/mail.ts";
import { setCompleteForTests, setRouteModelCompleteForTests, type CompleteParams, type CompleteResult } from "../src/llm.ts";
import { claimCommandSend, db, getClosedEmailContext, getPendingAction, reconcileClosedEmail, settleDraftDelivery, transitionPendingAction } from "../src/db.ts";
import { handler as confirmDraft } from "../src/tools/confirm_send_pending_draft.ts";
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
const fahimThread = "fahim-incident-thread";
const fahimMailbox = "fahim@msops.example";
const sends: string[] = [];
const createdThreads: Array<string | undefined> = [];
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
      create: async ({ requestBody }: { requestBody: { message: { raw: string; threadId?: string } } }) => {
        counter += 1;
        const id = `draft-${counter}`;
        store(id, requestBody.message.raw);
        createdThreads.push(requestBody.message.threadId);
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
      send: async ({ requestBody }: { requestBody: { id: string } }) => {
        sends.push(requestBody.id);
        drafts.delete(requestBody.id);
        return { data: { id: `sent-${requestBody.id}` } };
      },
      delete: async ({ id }: { id: string }) => { drafts.delete(id); return { data: {} }; },
    },
    messages: {
      get: async ({ id }: { id: string }) => {
        if (id !== "fahim-inbound" && id !== "wrong-thread") throw Object.assign(new Error("missing"), { code: 404 });
        return { data: {
          id, threadId: id === "wrong-thread" ? "another-thread" : fahimThread,
          payload: {
            mimeType: "text/plain",
            headers: [
              { name: "From", value: `Fahim <${fahimMailbox}>` },
              { name: "To", value: "vishnu.rajan@epicode.in" },
              { name: "Subject", value: "Reseller partnership" },
              { name: "Message-ID", value: "<fahim-inbound@example.com>" },
            ],
            body: { data: Buffer.from("Four concerns about the partnership.", "utf8").toString("base64url") },
          },
        } };
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

async function say(text: string, replyTo?: number): Promise<void> {
  const messageId = nextMessageId();
  await bot.handleUpdate({
    update_id: messageId,
    message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 1, type: "private", first_name: "Vishnu" },
      from: { id: 1, is_bot: false, first_name: "Vishnu" },
      text,
      ...(replyTo === undefined ? {} : { reply_to_message: {
        message_id: replyTo, date: Math.floor(Date.now() / 1000),
        chat: { id: 1, type: "private" }, from: { id: 999, is_bot: true, first_name: "Aadi" },
        text: "Draft approval",
      } }),
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

// A sent approval closes the editable email. A later reply uses the recorded thread.
{
  const draftId = "fahim-original";
  const subject = "Reseller partnership";
  const to = `Fahim <${fahimMailbox}>`;
  const staleBody = "The previous offer, not language for a reply.";
  drafts.set(draftId, { to, subject, body: staleBody });
  const actionId = await queueDraftApproval({ draftId, threadId: fahimThread, to, subject, body: staleBody, googleAccount: "work" });
  focusSelectedDraft(1, { draftId, to, subject, body: staleBody, account: "work" });
  const stale = getChatAction(1)!;
  const cardMessageId = getPendingAction(actionId)!.telegram_message_id!;
  await handleApprovalCallback({
    callbackQuery: { data: `approval:send:${actionId}`, message: { message_id: cardMessageId } },
    answerCallbackQuery: async () => true,
    editMessageText: async () => true,
    reply: async () => undefined,
  } as never, "send", actionId);
  assert(sends.join() === draftId && !drafts.has(draftId), "the card delivers the original once");
  assert(!getChatAction(1)?.email, "the card send closes the chat's draft");
  assert(getClosedEmailContext(1)?.threadId === fahimThread && getClosedEmailContext(1)?.status === "sent", "the closed reference keeps the thread");
  savePendingAction(1, stale);
  assert(!getChatAction(1)?.email, "a stale save can't reopen a delivered draft");

  const instructions = "Also mention flexible negotiation, a one-off 24/7 availability exception, APIs and webhooks ready now, and about 300 sequential outbound calls per agent each day.";
  let reads = 0;
  let reachedEmail = false;
  const replyBody = "Hi Fahim,\n\nWe can be flexible on negotiation and make a one-off exception for 24/7 agent availability. APIs and webhooks are ready now. Each agent can make about 300 sequential outbound calls per day.";
  const trace = async (params: CompleteParams): Promise<CompleteResult> => {
    if (!params.tools.length) return modelReply({ text: '{"facts":[]}' });
    const system = JSON.stringify(params.system);
    assert(system.includes(fahimThread) && system.includes(fahimMailbox), "the model received the recorded thread and recipient");
    assert(!system.includes(staleBody), "the old draft body isn't in the recovery context");
    assert(!params.tools.some(tool => "name" in tool && ["send_email", "confirm_send_pending_draft", "book_meeting", "start_sequence"].includes(tool.name)), "recovery cannot send, book, or start a sequence");
    reachedEmail = params.route?.agentId === "email";
    const results = params.messages.filter(message => message.role === "tool");
    if (results.length === 0) {
      reads += 1;
      return modelReply({ tools: [{ name: "read_email", input: { id: "fahim-inbound", account: "work" } }] });
    }
    if (results.length === 1) {
      return modelReply({ tools: [{ name: "draft_reply", input: { email_id: "wrong-thread", body: replyBody } }] });
    }
    if (results.length === 2) {
      return modelReply({ tools: [{ name: "draft_reply", input: { email_id: "fahim-inbound", body: replyBody, send_immediately: true } }] });
    }
    return modelReply({ text: "Here is the reply for your review." });
  };
  setCompleteForTests(trace);
  setRouteModelCompleteForTests(async (_spec, params) => trace(params));
  const replyStart = replies.length;
  const writes = createdThreads.length;
  await say(instructions);
  assert(reachedEmail && reads === 1, "the Email agent reads the latest inbound message");
  assert(createdThreads.length === writes + 1 && createdThreads.at(-1) === fahimThread, "only the reply on Fahim’s thread is drafted");
  assert(sends.join() === draftId, "recovery cannot send even when the model passes send_immediately");
  assert(replies.slice(replyStart).some(line => line.includes("That draft to Fahim went out at")), "delivery history is stated from the recorded send");
  assert(!replies.slice(replyStart).some(line => /couldn't read the current draft|latest OCR photo/i.test(line)), "neither incident dead end is repeated");

  let rejected = false;
  const tryStaleSend = async (params: CompleteParams): Promise<CompleteResult> => {
    if (!params.tools.length) return modelReply({ text: '{"facts":[]}' });
    const toolResult = params.messages.at(-1);
    assert(!params.tools.some(tool => "name" in tool && tool.name === "confirm_send_pending_draft"), "a stale confirmation has no send tool");
    if (toolResult?.role === "tool") {
      rejected = toolResult.isError === true;
      return modelReply({ text: "The card you replied to is closed." });
    }
    return modelReply({ tools: [{ name: "confirm_send_pending_draft", input: { draft_id: bob.id } }] });
  };
  setCompleteForTests(tryStaleSend);
  setRouteModelCompleteForTests(async (_spec, params) => tryStaleSend(params));
  await say("send it", cardMessageId);
  assert(rejected && sends.join() === draftId && drafts.has(bob.id), "a stale text confirmation reaches routing and cannot send a different pending draft");
}

// Direct text send, supersession, discard and missing Gmail each close only their draft.
{
  const address = "lifecycle@example.com";
  const old = await draft(address, "Earlier", "Earlier wording.");
  const original = getChatAction(1)!;
  focusSelectedDraft(81, { draftId: old.id, to: address, subject: "Other mailbox", body: "Kept.", account: "personal" });
  const rollback = db.transaction(() => {
    transitionPendingAction(old.actionId, "pending", "discarded");
    assert(!getChatAction(1)?.email, "the draft closes inside the transition");
    throw new Error("test rollback");
  });
  try { rollback(); } catch (error) { assert((error as Error).message === "test rollback", "closure didn't cause the rollback"); }
  assert(getPendingAction(old.actionId)?.status === "pending" && getChatAction(1)?.email?.draftId === old.id, "status and closure roll back together");
  const current = await draft(address, "Current", "Current wording.");
  assert(getPendingAction(old.actionId)?.status === "superseded" && getClosedEmailContext(1)?.draftId === old.id, "replacement closes only the previous draft");
  assert(getChatAction(81)?.email?.draftId === old.id, "an identical draft ID in another mailbox is unaffected");
  savePendingAction(1, original);
  assert(getChatAction(1)?.email?.draftId === current.id, "the superseded draft can't overwrite its replacement");
  const sent = await sendPendingDraftByText({ chatId: 1, messageId: nextMessageId() }, current.id, { ownTurn: true });
  assert(sent.ok && !getChatAction(1)?.email && getClosedEmailContext(1)?.status === "sent", "text delivery closes the current draft");
  const disposable = await draft(address, "To discard", "No longer needed.");
  await handleApprovalCallback({
    callbackQuery: { data: `approval:discard:${disposable.actionId}` },
    answerCallbackQuery: async () => true,
    editMessageText: async () => true,
    reply: async () => undefined,
  } as never, "discard", disposable.actionId);
  assert(!getChatAction(1)?.email && getClosedEmailContext(1)?.status === "discarded", "discard closes the link");
  const confirmed = await draft(address, "To confirm", "One send.");
  const confirmation = { chatId: 1, messageId: nextMessageId() };
  const outcome = await confirmDraft({ draft_id: confirmed.id }, { iteration: 1, calledTools: [], confirmation, ownTurn: true, userText: "Send this email now." });
  assert(outcome.startsWith("Sent the draft") && !getChatAction(1)?.email, "the confirm tool closes the same chat link");
  const unknown = await draft(address, "Unknown", "Gmail draft disappears.");
  drafts.delete(unknown.id);
  const record = reconcileClosedEmail(1, { account: "work", draftId: unknown.id }, true);
  assert(record?.status === "unknown" && !record.sentAt && !getChatAction(1)?.email, "a missing draft without a delivery record is never described as sent");
}

// An immediate command can settle an exact originating composition without a card.
{
  const chatId = 82;
  const messageId = nextMessageId();
  const key = `msg:${chatId}:${messageId}:${fahimMailbox}`;
  savePendingAction(chatId, {
    action: "send_email", status: "open", confirmChat: chatId, confirmMessage: messageId,
    ownerWords: "Send the reply", updatedAt: new Date().toISOString(),
    email: { account: "work", waiting: "confirm", to: [], cc: [], notes: [] },
  });
  assert(claimCommandSend({ key, account: "work", threadId: fahimThread }), "command has a delivery claim");
  settleDraftDelivery({ account: "work", to: fahimMailbox, commandKey: key, sentMessageId: "cmd-sent" });
  assert(!getChatAction(chatId)?.email && getClosedEmailContext(chatId)?.sentMessageId === "cmd-sent", "command settlement closes the exact originating composition");
}

// A new approval for the same Gmail draft is allowed after a card expires.
{
  const to = "renewed@example.com";
  const subject = "Renew this draft";
  const body = "The original wording.";
  const previous = await draft(to, subject, body);
  assert(transitionPendingAction(previous.actionId, "pending", "expired"), "the previous approval expires");
  assert(!getChatAction(1)?.email && getClosedEmailContext(1)?.status === "expired", "the expired card closes the link");
  const renewed = await queueDraftApproval({ draftId: previous.id, threadId: null, to, subject, body, googleAccount: "work" });
  assert(renewed !== previous.actionId && getPendingAction(renewed)?.status === "pending", "a fresh card approves the same Gmail draft");
  focusSelectedDraft(1, { draftId: previous.id, to, subject, body, account: "work" });
  assert(getChatAction(1)?.email?.draftId === previous.id, "the renewed card can focus the draft again");
}

console.log = log;
console.log("selected draft checks passed.");
