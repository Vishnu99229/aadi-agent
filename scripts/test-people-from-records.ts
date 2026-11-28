// PR A1: people come from the conversation's records, closed emails are data, and a
// second email to someone Aadi just emailed always asks first. The 26-27 Nov incidents,
// replayed against the real handlers with a fake Gmail and Telegram. Nothing real is sent.
import type { Api, Context } from "grammy";
import type { gmail_v1 } from "googleapis";
import { clearPendingAction, focusSelectedDraft, savePendingAction } from "../src/action_context.ts";
import { handleApprovalCallback, queueDraftApproval, sendCreatedDraftNow, sendPendingDraftByText, setApprovalsTestHooks } from "../src/approvals.ts";
import { resolveCommandAttendee, scheduledSendVerdict, sendEmailFromTool, setCommandEmailTestHooks, type CommandRequest } from "../src/command_email.ts";
import { config } from "../src/config.ts";
import { renderConfirmCard } from "../src/confirm_cards.ts";
import { closedDraftMiss, closedEmailFacts } from "../src/context_draft.ts";
import { noteShownPeople } from "../src/conversation_people.ts";
import {
  createDocument,
  rememberTelegramDocumentRef,
  claimCommandSend,
  conversationParticipants,
  createDocument,
  getClosedEmailContext,
  getPendingAction,
  getScheduledSend,
  linkTelegramMessageParticipants,
  listOpenScheduledSends,
  recordCommandSendSent,
  recordConversationParticipants,
  recordExternalAddress,
  recordKnownRecipient,
} from "../src/db.ts";
import { bindPhotoForTurn } from "../src/email_references.ts";
import { fireScheduledSend } from "../src/scheduled_sends.ts";
import { setDomainLookupForTests } from "../src/email_grounding.ts";
import { setGoogleAccountForTests, type LoadedGoogleAccount } from "../src/google/auth.ts";
import { setGmailClientForTests } from "../src/google/mail.ts";
import { setCompleteForTests, type CompleteParams, type CompleteResult } from "../src/llm.ts";
import { recentSendsFor, setRecentSendGuardForTests } from "../src/recent_sends.ts";
import { noteRepliedPeople, resolvePersonFromFacts } from "../src/recipient_facts.ts";
import { cardReason, decideSendAction, recentSendLine } from "../src/security/send_decision.ts";
import { setSequenceTestHooks, startSequenceFromTool } from "../src/sequences.ts";
import { handler as readEmail } from "../src/tools/read_email.ts";
import { modelReply } from "./fakes.ts";
import { readFile } from "node:fs/promises";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

if (process.env.AADI_DB_PATH !== ":memory:") {
  throw new Error("test-people-from-records.ts must run with AADI_DB_PATH=:memory:");
}

const log = console.log;
console.log = () => undefined;
console.error = () => undefined;
console.warn = () => undefined;

const ME = "vishnu.rajan@epicode.in";
const settings = config as unknown as Record<string, unknown>;
settings.sendOnCommandEnabled = true;
settings.sequencesEnabled = true;

// ---- a small Gmail: mail, drafts and sends ----
interface Mail { id: string; threadId: string; from: string; to: string; cc?: string; subject: string; body: string; sent?: boolean; at: number }
const world: Mail[] = [];
let mailCounter = 0;
function mail(input: Omit<Mail, "id" | "at">): Mail {
  mailCounter += 1;
  const item = { ...input, id: `m${mailCounter}`, at: Date.now() - 60_000 + mailCounter };
  world.push(item);
  return item;
}
function toGmail(item: Mail): gmail_v1.Schema$Message {
  return {
    id: item.id, threadId: item.threadId, internalDate: String(item.at),
    labelIds: item.sent ? ["SENT"] : ["INBOX"], snippet: item.body.slice(0, 80),
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: item.from }, { name: "To", value: item.to }, { name: "Cc", value: item.cc ?? "" },
        { name: "Subject", value: item.subject }, { name: "Message-ID", value: `<${item.id}@mail.example>` },
        { name: "Date", value: new Date(item.at).toUTCString() },
      ].filter((header) => header.value !== ""),
      body: { data: Buffer.from(item.body, "utf8").toString("base64url") },
    },
  };
}
function search(q: string): Mail[] {
  const terms = [...q.matchAll(/\b(?:to|cc|bcc|from):"?([^\s")]+)"?/g)].map((match) => match[1]!.toLowerCase());
  return world
    .filter((item) => (!/\bin:sent\b/.test(q) || item.sent) &&
      (terms.length === 0 || terms.some((term) => `${item.from} ${item.to} ${item.cc ?? ""}`.toLowerCase().includes(term))))
    .sort((left, right) => right.at - left.at);
}

interface Draft { to: string; cc: string; subject: string; body: string; threadId?: string }
const drafts = new Map<string, Draft>();
const draftSends: string[] = [];
const messageSends: Array<{ to: string; cc: string }> = [];
/** Holds Gmail's message send open, to put another send in the middle of one. */
let holdSends: Promise<void> | undefined;
let onSendStarted: (() => void) | undefined;
let draftCounter = 0;
const headerOf = (raw: string, name: string) =>
  new RegExp(`^${name}: (.*)$`, "im").exec(raw.split(/\r?\n\r?\n/)[0] ?? "")?.[1]?.trim() ?? "";
function draftPayload(id: string) {
  const draft = drafts.get(id);
  if (!draft) throw Object.assign(new Error("missing"), { code: 404 });
  return {
    data: {
      id,
      message: {
        id: `msg-${id}`, threadId: draft.threadId ?? `t-${id}`,
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "To", value: draft.to }, { name: "Cc", value: draft.cc }, { name: "Subject", value: draft.subject },
          ].filter((header) => header.value !== ""),
          body: { data: Buffer.from(draft.body, "utf8").toString("base64url") },
        },
      },
    },
  };
}
function gmailFake(): gmail_v1.Gmail {
  return {
    users: {
      getProfile: async () => ({ data: { emailAddress: ME } }),
      settings: { sendAs: { list: async () => ({ data: { sendAs: [{ sendAsEmail: ME, isDefault: true, signature: "" }] } }) } },
      messages: {
        list: async ({ q, maxResults }: { q: string; maxResults?: number }) => ({
          data: { messages: search(q).slice(0, maxResults ?? 25).map((item) => ({ id: item.id, threadId: item.threadId })) },
        }),
        get: async ({ id }: { id: string }) => {
          const found = world.find((item) => item.id === id);
          if (!found) throw Object.assign(new Error("missing"), { code: 404 });
          return { data: toGmail(found) };
        },
        send: async ({ requestBody }: { requestBody: { raw: string } }) => {
          onSendStarted?.();
          if (holdSends) await holdSends;
          const raw = Buffer.from(requestBody.raw, "base64url").toString("utf8");
          messageSends.push({ to: headerOf(raw, "To"), cc: headerOf(raw, "Cc") });
          return { data: { id: `sent-${messageSends.length}` } };
        },
      },
      threads: {
        get: async ({ id }: { id: string }) => {
          const messages = world.filter((item) => item.threadId === id).map(toGmail);
          if (messages.length === 0) throw Object.assign(new Error("not found"), { response: { status: 404 } });
          return { data: { id, messages } };
        },
      },
      drafts: {
        create: async ({ requestBody }: { requestBody: { message: { raw: string; threadId?: string } } }) => {
          draftCounter += 1;
          const id = `draft-${draftCounter}`;
          const raw = Buffer.from(requestBody.message.raw, "base64url").toString("utf8");
          drafts.set(id, { to: headerOf(raw, "To"), cc: headerOf(raw, "Cc"), subject: headerOf(raw, "Subject"), body: "Hi,\n\nA note.", threadId: requestBody.message.threadId });
          return { data: { id, message: { id: `msg-${id}`, threadId: requestBody.message.threadId ?? `t-${id}` } } };
        },
        get: async ({ id }: { id: string }) => draftPayload(id),
        update: async ({ id }: { id: string }) => draftPayload(id),
        delete: async ({ id }: { id: string }) => { drafts.delete(id); return { data: {} }; },
        send: async ({ requestBody }: { requestBody: { id: string } }) => {
          const draft = drafts.get(requestBody.id)!;
          draftSends.push(requestBody.id);
          drafts.delete(requestBody.id);
          // Gmail now has it in Sent, on its thread.
          const sent = mail({ threadId: draft.threadId ?? `t-${requestBody.id}`, from: `Vishnu <${ME}>`, to: draft.to, cc: draft.cc, subject: draft.subject, body: draft.body, sent: true });
          return { data: { id: sent.id, threadId: sent.threadId } };
        },
      },
    },
  } as unknown as gmail_v1.Gmail;
}
const gmail = gmailFake();
const workAccount = { id: "work", tag: "work", label: "work (Epicode)", client: {} } as unknown as LoadedGoogleAccount;
const personalAccount = { id: "personal", tag: "personal", label: "personal (Gmail)", client: {} } as unknown as LoadedGoogleAccount;
setGoogleAccountForTests((id) => (id === "personal" ? personalAccount : workAccount));
setGmailClientForTests(() => gmail);
setDomainLookupForTests(async () => "yes");

// ---- Telegram: every card and its buttons ----
let telegramId = 2000;
const told: Array<{ id: number; text: string; buttons: string[] }> = [];
const telegram = {
  sendMessage: async (_chat: unknown, text: string, extra?: { reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } }) => {
    telegramId += 1;
    told.push({ id: telegramId, text, buttons: (extra?.reply_markup?.inline_keyboard ?? []).flat().map((item) => item.callback_data ?? "") });
    return { message_id: telegramId, date: 0, chat: { id: 1, type: "private" }, text };
  },
  editMessageText: async () => true,
} as unknown as Api;
setApprovalsTestHooks({ telegram, gmailFor: () => gmail });
setCommandEmailTestHooks({ telegram });
setSequenceTestHooks({ telegram });

setCompleteForTests(async (params: CompleteParams): Promise<CompleteResult> => {
  if (params.task === "command_send") {
    return modelReply({ text: JSON.stringify({ subject: "Following up from BTS", body: "Hi Ashwin,\n\nFollowing up from BTS." }) });
  }
  return modelReply({ text: '{"facts":[]}' });
});

let messageCounter = 3000;
const ownTurn = (chatId: number, userText: string) => {
  messageCounter += 1;
  return { userText, confirmation: { chatId, messageId: messageCounter }, ownTurn: true };
};
function tapCtx(data: string, messageId: number) {
  const alerts: string[] = [];
  const ctx = {
    callbackQuery: { data, message: { message_id: messageId } },
    answerCallbackQuery: async (input?: unknown) => {
      alerts.push(typeof input === "string" ? input : String((input as { text?: string } | undefined)?.text ?? ""));
      return true;
    },
    editMessageText: async () => true,
    reply: async () => undefined,
  } as unknown as Context;
  return { ctx, alerts };
}
const sendButton = (card: { buttons: string[] }) => card.buttons.find((data) => data.startsWith("approval:send:"))!;

// ---- 1. The decision: a recent send to a To recipient is always a card ----
{
  const sentAt = "2026-11-26T06:34:35.000Z"; // 12:04 IST
  const recent = [{ email: "ashwin.kumar@logosys.cloud", name: "Ashwin Kumar", sentAt }];
  const plain = decideSendAction({ intent: "send", ownTurn: true, recipients: ["ashwin.kumar@logosys.cloud"], known: new Set(["ashwin.kumar@logosys.cloud"]) });
  assert(plain.action === "send", "a known address with no recent send goes out");
  const repeat = decideSendAction({ intent: "send", ownTurn: true, recipients: ["ashwin.kumar@logosys.cloud"], known: new Set(["ashwin.kumar@logosys.cloud"]), recentSends: recent });
  assert(repeat.action === "card" && repeat.recentSends?.length === 1, "a recent send to the same person makes it a card");
  assert(cardReason(repeat, "Ashwin Kumar") === "You emailed Ashwin Kumar at 12:04. Send another? Tap Send to confirm.", `the card says so: ${cardReason(repeat, "x")}`);
  assert(recentSendLine([...recent, { email: "ashwini@epicode.in", name: "", sentAt }]) === "You emailed Ashwin Kumar at 12:04 and ashwini@epicode.in at 12:04. Send another?", "two people are both named");
  const other = decideSendAction({ intent: "send", ownTurn: true, recipients: ["someone@else.example"], known: new Set(["someone@else.example"]), recentSends: recent });
  assert(other.action === "send", "a recent send to someone else doesn't hold this one");
  const card = renderConfirmCard({ kind: "schedule_confirm", scheduleId: 1, to: "Ashwin Kumar <ashwin.kumar@logosys.cloud>", cc: "", headline: "Held, not sent: x\nTap Confirm to send it.", recentSends: recent });
  assert(card.text.startsWith("You emailed Ashwin Kumar at 12:04. Send another?"), "a schedule's card shows it too");
}

// ---- 2. Records: Aadi's own sends, To only, and what a card already warned about ----
setRecentSendGuardForTests(true);
{
  claimCommandSend({ key: "k-ash-direct", account: "work", threadId: null, to: "Ash Direct <ash.direct@guard.example>" });
  recordCommandSendSent("k-ash-direct", "sent-direct");
  claimCommandSend({ key: "k-cc-only", account: "work", threadId: null, to: "Someone <someone@guard.example>" });
  recordCommandSendSent("k-cc-only", "sent-cc");
  const found = recentSendsFor(["ash.direct@guard.example"]);
  assert(found.length === 1 && found[0]!.name === "Ash Direct", "a direct command send is a recent send to its To");
  assert(recentSendsFor(["nobody@guard.example"]).length === 0, "others aren't");
  assert(recentSendsFor(["ash.direct@guard.example"], new Map([["ash.direct@guard.example", found[0]!.sentAt]])).length === 0, "a card that showed this send acknowledges it");
  assert(recentSendsFor(["ash.direct@guard.example"], new Map([["ash.direct@guard.example", "2000-01-01T00:00:00.000Z"]])).length === 1, "an older warning doesn't cover a newer send");
  assert(recentSendsFor(["ash.direct@guard.example"], new Map(), new Date(Date.now() + 31 * 60_000)).length === 0, "after 30 minutes it no longer counts");
  setRecentSendGuardForTests(false);
  assert(recentSendsFor(["ash.direct@guard.example"]).length === 0, "the in-memory test seam can switch it off");
  setRecentSendGuardForTests(true);
}

// ---- 3. Ashwin, 26 Nov: send the draft, then "start follow-ups", then "send it" again ----
{
  const chat = config.ownerTelegramId;
  const to = "Ashwin Kumar <ashwin.kumar@logosys.cloud>";
  const cc = "Ashwini <ashwini@epicode.in>";
  const subject = "Following up from BTS - Epicode voice AI and contact center";
  drafts.set("d-ash", { to, cc, subject, body: "Hi Ashwin,\n\nGreat meeting you at BTS.", threadId: "t-ash" });
  const actionId = await queueDraftApproval({ draftId: "d-ash", threadId: null, to, cc, subject, body: "Hi Ashwin,\n\nGreat meeting you at BTS.", googleAccount: "work" });
  focusSelectedDraft(chat, { draftId: "d-ash", to, cc, subject, body: "Hi Ashwin,", account: "work" });
  // 12:04 "sent it and put three more follow ups": the draft he was shown goes out.
  const first = ownTurn(chat, "sent it and put three more follow ups");
  const sent = await sendPendingDraftByText(first.confirmation, "d-ash", { ownTurn: true });
  assert(sent.ok && draftSends.join() === "d-ash", `the shown draft is sent once: ${sent.message}`);
  assert(getPendingAction(actionId)?.status === "sent", "and recorded as sent");
  assert(getClosedEmailContext(chat)?.to?.includes("ashwin.kumar@logosys.cloud"), "the chat's closed email is Ashwin's");

  // 12:06 "start 3 follow-ups for Ashwin gap every 2 day", the model passes "Ashwin Kumar".
  const sequence = await startSequenceFromTool("Ashwin Kumar", { ...ownTurn(chat, "start 3 follow-ups for Ashwin gap every 2 day"), modelCalled: true }, telegram);
  assert(!sequence.includes('no email to "Ashwin gap"'), `the person comes from the records, not a misread name: ${sequence}`);
  assert(!/found no email/i.test(sequence), `the email that just went out is found: ${sequence}`);

  // 12:07 "yes please send it and start the 3 follow up": whatever path it takes, no
  // second email goes to Ashwin.
  const before = messageSends.length + draftSends.length;
  const again = await sendEmailFromTool({ to: ["ashwin kumar"], instruction: "follow up on BTS" }, ownTurn(chat, "yes please send it and start the 3 follow up"));
  assert(messageSends.length + draftSends.length === before, `nothing else goes out: ${again}`);
  assert(!again.includes("isn't a name or address"), `he isn't refused for not repeating the name: ${again}`);

  // A fresh command to email him again, three minutes later: a card that says so.
  const cardsBefore = told.length;
  const repeat = await sendEmailFromTool({ to: ["Ashwin Kumar"], instruction: "say we met at BTS" }, ownTurn(chat, "email Ashwin Kumar saying we met at BTS"));
  assert(messageSends.length + draftSends.length === before, `a second email to him is never silent: ${repeat}`);
  assert(/You emailed Ashwin Kumar at \d\d:\d\d\. Send another\?/.test(repeat), `the reply names the earlier send: ${repeat}`);
  const card = told.slice(cardsBefore).find((item) => item.text.includes("You emailed Ashwin Kumar"));
  assert(card && sendButton(card), "and the card shows it with its Send button");
  // His tap on that very card confirms the second email.
  const actionOf = Number(sendButton(card).split(":").pop());
  const { ctx } = tapCtx(sendButton(card), card.id);
  await handleApprovalCallback(ctx, "send", actionOf);
  assert(messageSends.length + draftSends.length === before + 1, "a tap on the card that warned him sends it");
}

// ---- 4. Mukesh: a card posted before another email went to him can't send silently ----
{
  const to = "mukesh <mukesh@excellentcyber.in>";
  drafts.set("d-muk", { to, cc: "", subject: "Following up from BTS", body: "Hi Mukesh," });
  const actionId = await queueDraftApproval({ draftId: "d-muk", threadId: null, to, subject: "Following up from BTS", body: "Hi Mukesh,", googleAccount: "personal" });
  const firstCard = told.at(-1)!;
  assert(!firstCard.text.includes("You emailed"), "no warning before anything went to him");
  // Meanwhile an email to Mukesh went out from the work mailbox.
  claimCommandSend({ key: "k-mukesh", account: "work", threadId: null, to });
  recordCommandSendSent("k-mukesh", "sent-mukesh");
  const sendsBefore = draftSends.length;
  const { ctx, alerts } = tapCtx(sendButton(firstCard), firstCard.id);
  await handleApprovalCallback(ctx, "send", actionId);
  assert(draftSends.length === sendsBefore, "the older card's tap sends nothing");
  assert(alerts.some((text) => /You emailed mukesh at \d\d:\d\d\. Send another\?/.test(text)), `he's told why: ${alerts.join(" | ")}`);
  const fresh = told.at(-1)!;
  assert(fresh.id !== firstCard.id && fresh.text.startsWith("You emailed mukesh at"), "a new card says so");
  const second = tapCtx(sendButton(fresh), fresh.id);
  await handleApprovalCallback(second.ctx, "send", actionId);
  assert(draftSends.length === sendsBefore + 1 && draftSends.at(-1) === "d-muk", "his tap on the card that warned him sends it, once");
}

// ---- 5. A scheduled email at fire time waits for his Confirm ----
{
  const request: CommandRequest = {
    to: [{ query: "mukesh", mailbox: { email: "mukesh@excellentcyber.in", name: "mukesh" } }],
    cc: [], threadId: null, instruction: "x", ownWords: "x", account: "work",
    confirmedRecipients: ["mukesh@excellentcyber.in"],
  };
  const held = await scheduledSendVerdict(request);
  assert(held.action === "card" && (held.recentSends?.length ?? 0) === 1, "a scheduled email to someone just emailed is held");
  const latest = recentSendsFor(["mukesh@excellentcyber.in"])[0]!;
  const confirmed = await scheduledSendVerdict({ ...request, recentSendsConfirmed: { "mukesh@excellentcyber.in": latest.sentAt } });
  assert(confirmed.action === "send", "his Confirm on the card that named that send lets it go");
}

// ---- 6. Bharat, 27 Nov: a reply to the meeting brief, "Send him...", "Yes" ----
{
  const chat = 12;
  const brief = 7001;
  linkTelegramMessageParticipants(brief, "event", "evt-bharat", [{ email: "bharat@modernsolutions.example", name: "bharat" }]);
  noteRepliedPeople(chat, brief); // his reply: "Reminder that I'm waiting on the bridge..."
  const sendHim = ownTurn(chat, "Send him a quick quick message.");
  const resolved = await resolvePersonFromFacts("Bharat", { chatId: chat, messageId: sendHim.confirmation.messageId, ownerText: sendHim.userText });
  assert(resolved.kind === "one" && resolved.mailbox.email === "bharat@modernsolutions.example", "Bharat comes from the meeting he replied to");
  const yes = ownTurn(chat, "Yes");
  const onYes = await resolvePersonFromFacts("Bharat", { chatId: chat, messageId: yes.confirmation.messageId, ownerText: yes.userText });
  assert(onYes.kind === "one" && onYes.mailbox.email === "bharat@modernsolutions.example", "and still on his \"Yes\", with no name in it");
  const before = messageSends.length;
  const result = await sendEmailFromTool({ to: ["Bharat"], instruction: "I'm on the video link waiting for you" }, sendHim);
  assert(!result.includes("isn't a name or address"), `the name needn't be in his words: ${result}`);
  assert(result.includes("New address: bharat@modernsolutions.example") && messageSends.length === before, `a never-emailed address still gets the card: ${result}`);
}

// ---- 7. Only headers, attendees and his own words: never a body or a photo's text ----
{
  const chat = 13;
  mail({ threadId: "t-kavya", from: "Kavya Rao <kavya@inbound.example>", to: ME, subject: "Intro", body: "Please write to Rohan at rohan.body@only.example" });
  const read = ownTurn(chat, "what did Kavya send?");
  await readEmail({ id: world.at(-1)!.id }, { ...read, iteration: 1, calledTools: [] });
  const context = (text: string) => ({ chatId: chat, messageId: (messageCounter += 1), ownerText: text });
  const kavya = await resolvePersonFromFacts("Kavya", context("reply to her"));
  assert(kavya.kind === "one" && kavya.mailbox.email === "kavya@inbound.example", "the email's sender (a header) is a fact");
  const bodyName = await resolvePersonFromFacts("Rohan", context("send it to the person in that email"));
  assert(bodyName.kind === "none", "a name only in the body is not");
  const bodyAddress = await resolvePersonFromFacts("rohan.body@only.example", context("send it to the person in that email"));
  assert(bodyAddress.kind === "none" && bodyAddress.reason === "address_not_known", "nor an address only in the body");
  createDocument("card.jpg", "work", "Sales lead: Priyanka, ocr.only@photo.example", null);
  const ocr = await resolvePersonFromFacts("ocr.only@photo.example", context("email the person on that card"));
  assert(ocr.kind === "none", "an address only in a photo's text is not");
  const typed = await resolvePersonFromFacts("ocr.only@photo.example", context("email ocr.only@photo.example saying hi"));
  assert(typed.kind === "one", "unless he wrote it himself");
  recordConversationParticipants(chat, [{ email: "sam.a@one.example", name: "Sam Ahuja" }, { email: "sam.b@two.example", name: "Sam Bose" }], "email", "search");
  const many = await resolvePersonFromFacts("Sam", context("email Sam"));
  assert(many.kind === "many" && many.options.length === 2, "two people of that name: he's asked which");
  const nobody = await resolvePersonFromFacts("Zubin", context("email Zubin"));
  assert(nobody.kind === "none" && nobody.reason === "no_match", "nobody: he's asked who");
}

// ---- 8. Forwarded and delegated turns: no facts recorded, no send ----
{
  noteShownPeople({ ownTurn: false, confirmation: { chatId: 14 } }, [{ email: "x@forwarded.example", name: "X" }], "email", "fwd");
  assert(conversationParticipants(14, "2000-01-01T00:00:00.000Z").length === 0, "a read off his own turn records nobody");
  const before = messageSends.length + draftSends.length;
  const forwarded = await sendEmailFromTool({ to: ["kavya@inbound.example"], instruction: "x" }, { userText: "send Kavya a note" });
  assert(forwarded.startsWith("Not sent") && forwarded.includes("own message"), `a forwarded message can't send: ${forwarded}`);
  const delegated = await sendEmailFromTool(
    { to: ["delegated@typed.example"], instruction: "x" },
    { ...ownTurn(15, "email delegated@typed.example saying hi"), ownTurn: false },
  );
  assert(delegated.includes("Tap Send to confirm.") && messageSends.length + draftSends.length === before, `a delegated goal gets a card, never a send: ${delegated}`);
}

// ---- 9. A closed email is data: no note, no narrowed tools ----
{
  const reference = { account: "work" as const, draftId: "d-old", status: "sent" as const, to: "Ashwin Kumar <ashwin.kumar@logosys.cloud>", threadId: "t-old", sentAt: "2026-11-27 06:23:07" };
  const miss = closedDraftMiss(reference);
  assert(!("notice" in miss) && miss.scope === undefined, "a closed draft adds no note to his reply and narrows nothing");
  const facts = closedEmailFacts(reference);
  assert(facts.includes("data only") && facts.includes("11:53") && facts.includes("t-old"), "its record reaches the model as data");
  assert(closedEmailFacts(reference, reference) === "", "and only once");
  const bot = await readFile(new URL("../src/bot.ts", import.meta.url), "utf8");
  assert(!bot.includes("looksLikeEmailContext(userText)") && !/repl\(\?:y\|ied\|ies\)/.test(bot), "no word trigger names the closed email");
  assert(!bot.includes("focusMessageId === previous") && !bot.includes("replyDraftThread"), "no focus rule and no thread scoping");
}

// ---- 10. Two commands to the same known person at once: one email and one card ----
{
  const chat = 20;
  const address = "both.at.once@known.example";
  recordKnownRecipient(address, "test");
  const before = messageSends.length;
  const results = await Promise.all([
    sendEmailFromTool({ to: [address], instruction: "say hello" }, ownTurn(chat, `email ${address} saying hello`)),
    sendEmailFromTool({ to: [address], instruction: "say hello again" }, ownTurn(chat, `email ${address} saying hello again`)),
  ]);
  assert(messageSends.length === before + 1, `two commands at once send one email: ${results.join(" | ")}`);
  assert(results.filter((result) => result.startsWith("Sent to")).length === 1, `one of them is sent: ${results.join(" | ")}`);
  assert(results.some((result) => /You emailed .+ at \d\d:\d\d\. Send another\?/.test(result)), `the other is the card: ${results.join(" | ")}`);
}

// ---- 11. A Retry while that send is still going out: the card, not a second email ----
{
  const chat = 21;
  const address = "retry.during@known.example";
  recordKnownRecipient(address, "test");
  let letGmailFinish!: () => void;
  holdSends = new Promise<void>((resolve) => { letGmailFinish = resolve; });
  const started = new Promise<void>((resolve) => { onSendStarted = resolve; });
  const before = messageSends.length;
  const first = sendEmailFromTool({ to: [address], instruction: "say hello" }, ownTurn(chat, `email ${address} saying hello`));
  await started;
  onSendStarted = undefined;
  // His Retry: the same words as a new turn, decided while Gmail is still sending.
  const retry = sendEmailFromTool({ to: [address], instruction: "say hello" }, ownTurn(chat, `email ${address} saying hello`));
  await new Promise((resolve) => setTimeout(resolve, 300));
  letGmailFinish();
  holdSends = undefined;
  const [firstResult, retryResult] = await Promise.all([first, retry]);
  assert(firstResult.startsWith("Sent to") && messageSends.length === before + 1, `the first goes out once: ${firstResult}`);
  assert(/You emailed .+ at \d\d:\d\d\. Send another\?/.test(retryResult), `the Retry is the card: ${retryResult}`);
}

// ---- 12. A scheduled email firing right after a manual one waits for his Confirm ----
{
  const chat = 22;
  const address = "scheduled.after@known.example";
  recordKnownRecipient(address, "test");
  const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(Date.now() + 24 * 60 * 60 * 1000));
  const scheduled = await sendEmailFromTool(
    { to: [address], instruction: "say hello", send_on: tomorrow, send_time: "10:00", subject: "Hello" },
    ownTurn(chat, `email ${address} tomorrow at 10 am saying hello`),
  );
  const row = listOpenScheduledSends().find((item) => item.request.includes(address));
  assert(row && row.status === "scheduled", `it is scheduled: ${scheduled}`);
  const before = messageSends.length;
  // The manual email (from another chat here, so the schedule's open context can't touch
  // it: the guard reads the send records, wherever they came from).
  const manual = await sendEmailFromTool({ to: [address], instruction: "quick note" }, ownTurn(26, `email ${address} saying quick note`));
  assert(manual.startsWith("Sent to") && messageSends.length === before + 1, `the manual email goes out: ${manual}`);
  const cardsBefore = told.length;
  await fireScheduledSend(getScheduledSend(row.id)!, new Date());
  assert(messageSends.length === before + 1, "the scheduled one doesn't follow it out");
  assert(getScheduledSend(row.id)?.status === "held", "it is held for his Confirm");
  assert(told.slice(cardsBefore).some((card) => /You emailed .+ at \d\d:\d\d\. Send another\?/.test(card.text)), "on a card that says why");
}

// ---- 13. A draft sent at once with no card is a recent send the guard can see ----
{
  const address = "immediate.draft@known.example";
  recordKnownRecipient(address, "test");
  drafts.set("d-now", { to: `Imm Ediate <${address}>`, cc: "", subject: "Now", body: "Hi,\n\nNow." });
  settings.sendOnCommandEnabled = false;
  const result = await sendCreatedDraftNow({
    draftId: "d-now", googleAccount: "work", confirmation: { chatId: 23, messageId: (messageCounter += 1) },
    ownTurn: true, userText: `send ${address} the note now`,
  });
  settings.sendOnCommandEnabled = true;
  assert(result.ok, `it goes out: ${JSON.stringify(result)}`);
  assert(recentSendsFor([address]).length === 1, "and is recorded where the recent-send check reads");
}

// ---- 14. "Email this address" on a photo: the card, even for an address he knows ----
{
  const chat = 24;
  const address = "photo.known@known.example";
  recordKnownRecipient(address, "test");
  const turn = ownTurn(chat, "email this address saying we met at BTS");
  const photo = createDocument("business-card.jpg", "personal", address, null);
  rememberTelegramDocumentRef(chat, turn.confirmation.messageId, photo.id);
  bindPhotoForTurn({ ...turn.confirmation, currentPhoto: true });
  const before = messageSends.length;
  const result = await sendEmailFromTool({ to: [address], photo_address: address, instruction: "say we met at BTS" }, turn);
  assert(result.includes(`New address: ${address}. Tap Send to confirm.`) && messageSends.length === before, `a photo's address gets the card: ${result}`);
}

// ---- 15. A photo's address is never an attendee or an invitee unless he types it ----
{
  const chat = 25;
  const address = "ocr.attendee@photo.example";
  recordExternalAddress(chat, address, "document:2");
  // An open email made from that photo lists it as a resolved recipient.
  savePendingAction(chat, {
    action: "send_email", status: "open", ownerWords: "", confirmChat: chat, confirmMessage: 1, updatedAt: new Date().toISOString(),
    email: { to: [{ query: address, name: "", email: address, resolved: true }], cc: [], notes: [], purpose: "x", account: "work", waiting: "confirm" },
  });
  const context = (text: string) => ({ chatId: chat, messageId: (messageCounter += 1), ownerText: text });
  const attendee = await resolveCommandAttendee(address, context("add him to the standup"));
  assert("refused" in attendee, `never added from the photo: ${JSON.stringify(attendee)}`);
  const invite = await resolvePersonFromFacts(address, context("book a meeting with him"));
  assert(invite.kind === "none", "nor invited to a meeting");
  const typedAttendee = await resolveCommandAttendee(address, context(`add ${address} to the standup`));
  assert("email" in typedAttendee && typedAttendee.email === address, "his typed address is added");
  const typedInvite = await resolvePersonFromFacts(address, context(`book a meeting with ${address}`));
  assert(typedInvite.kind === "one", "and invited");
  // The photo's record stays; only the open email is put away before he types it.
  clearPendingAction(chat);
  const typedEmail = await sendEmailFromTool({ to: [address], instruction: "say hi" }, ownTurn(chat, `email ${address} saying hi`));
  assert(typedEmail.includes(`New address: ${address}`), `and a typed email to it goes through the card as any new address: ${typedEmail}`);
}

setRecentSendGuardForTests(false);
log("people from records: ok");
