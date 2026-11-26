// Scheduled emails follow every approved edit, and the worker never sends a stale copy.
// Fake Gmail, fake Telegram, stub models, an in-memory database. Nothing real is sent.
import type { Api, Context } from "grammy";
import type { gmail_v1 } from "googleapis";
import { applyOwnerContextTurn, focusSelectedDraft, getPendingAction } from "../src/action_context.ts";
import { queueDraftApproval, setApprovalsTestHooks } from "../src/approvals.ts";
import { sendEmailFromTool, setCommandEmailTestHooks } from "../src/command_email.ts";
import { publishReadyDraft, reviseLinkedDraft } from "../src/context_draft.ts";
import {
  createScheduledSend,
  getScheduledSend,
  getPendingAction as getApprovalActionById,
  getTask,
  listOpenScheduledSends,
  listScheduledSendsForDraft,
  recordKnownRecipient,
  transitionScheduledSend,
  type ScheduledSendRecord,
} from "../src/db.ts";
import { setGoogleAccountForTests, type LoadedGoogleAccount } from "../src/google/auth.ts";
import { setGmailClientForTests } from "../src/google/mail.ts";
import { setCompleteForTests, setRouteModelCompleteForTests, type CompleteParams, type CompleteResult } from "../src/llm.ts";
import { setAgentModelSetting } from "../src/models/agent_models.ts";
import { handleScheduledSendCallback, runScheduledSendTick } from "../src/scheduled_sends.ts";
import { handler as draftNewEmail } from "../src/tools/draft_new_email.ts";
import { handler as updateDraft } from "../src/tools/update_draft.ts";
import { modelReply } from "./fakes.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    process.stderr.write(`${logged.slice(-15).join("\n")}\n`);
    throw new Error(message);
  }
}

if (process.env.AADI_DB_PATH !== ":memory:") {
  throw new Error("test-scheduled-edits.ts must run with AADI_DB_PATH=:memory:");
}

const log = console.log;
const logged: string[] = [];
const record = (...items: unknown[]): void => {
  logged.push(items.join(" "));
};
console.log = record;
console.error = record;
console.warn = record;

const ME = "vishnu.rajan@epicode.in";

// ---- fake Gmail: drafts in place, sent mail recorded, two people called Lata ----
interface SentMail {
  to: string;
  cc: string;
  subject: string;
  body: string;
  threadId?: string;
  inReplyTo: string;
}
const sends: SentMail[] = [];
type StoredDraft = {
  to: string;
  cc: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
  threadId?: string;
};
/** Threads he can reply to. Raghavendra wrote "Voice AI Discussion". */
const threads = new Map([
  [
    "voice-thread",
    {
      subject: "Voice AI Discussion",
      from: "Raghavendra KV <raghavendra.kv@tenxpipe.com>",
      messageId: "<voice-1@tenxpipe.com>",
    },
  ],
]);
/** Each mailbox keeps its own drafts, as Gmail does. */
const mailboxes = { work: new Map<string, StoredDraft>(), personal: new Map<string, StoredDraft>() };
const drafts = mailboxes.work;
let draftCounter = 0;
/** Runs inside Gmail's send call: the worker has already claimed the row. */
let duringSend: (() => Promise<void>) | undefined;

function headerOf(raw: string, name: string): string {
  const block = raw.split(/\r?\n\r?\n/)[0] ?? "";
  return new RegExp(`^${name}: (.*)$`, "im").exec(block)?.[1]?.trim() ?? "";
}

function bodyOf(raw: string): string {
  const encoded = /Content-Transfer-Encoding: base64\r?\n\r?\n([A-Za-z0-9+/=\r\n]+)/.exec(raw)?.[1];
  if (encoded) {
    return Buffer.from(encoded.replace(/\s/g, ""), "base64").toString("utf8").trim();
  }
  return raw.split(/\r?\n\r?\n/).slice(1).join("\n").trim();
}

function storeDraft(store: Map<string, StoredDraft>, id: string, raw: string, threadId?: string): void {
  store.set(id, {
    inReplyTo: headerOf(raw, "In-Reply-To") || undefined,
    references: headerOf(raw, "References") || undefined,
    threadId: threadId ?? `thread-${id}`,
    to: headerOf(raw, "To"),
    cc: headerOf(raw, "Cc"),
    subject: headerOf(raw, "Subject"),
    body: bodyOf(raw),
  });
}

let lataSearches = 0;
const latas = [
  { id: "lata-1", from: "Lata Rao <lata@one.example>" },
  { id: "lata-2", from: "Lata Menon <lata.m@two.example>" },
];

function mailbox(account: "work" | "personal"): gmail_v1.Gmail {
  const drafts = mailboxes[account];
  const prefix = account === "work" ? "draft" : "pdraft";
  return {
  users: {
    getProfile: async () => ({ data: { emailAddress: ME } }),
    settings: {
      sendAs: { list: async () => ({ data: { sendAs: [{ sendAsEmail: ME, isDefault: true, signature: "" }] } }) },
    },
    messages: {
      list: async ({ q }: { q: string }) => {
        const lata = /\blata\b/i.test(q);
        lataSearches += lata ? 1 : 0;
        return { data: { messages: lata ? latas.map((item) => ({ id: item.id, threadId: item.id })) : [] } };
      },
      get: async ({ id }: { id: string }) => {
        const hit = latas.find((item) => item.id === id)!;
        return {
          data: {
            id,
            threadId: id,
            labelIds: ["INBOX"],
            payload: { headers: [{ name: "From", value: hit.from }, { name: "To", value: ME }] },
          },
        };
      },
      send: async ({ requestBody }: { requestBody: { raw: string } }) => {
        if (duringSend) {
          const hook = duringSend;
          duringSend = undefined;
          await hook();
        }
        const raw = Buffer.from(requestBody.raw, "base64url").toString("utf8");
        sends.push({
          to: headerOf(raw, "To"),
          cc: headerOf(raw, "Cc"),
          subject: headerOf(raw, "Subject"),
          body: bodyOf(raw),
          threadId: (requestBody as { threadId?: string }).threadId,
          inReplyTo: headerOf(raw, "In-Reply-To"),
        });
        return { data: { id: `sent-${sends.length}` } };
      },
    },
    threads: {
      get: async ({ id }: { id: string }) => {
        const thread = threads.get(id);
        if (!thread) {
          throw Object.assign(new Error("not found"), { response: { status: 404 }, code: 404 });
        }
        return {
          data: {
            id,
            messages: [
              {
                id: `${id}-1`,
                threadId: id,
                labelIds: ["INBOX"],
                internalDate: "1700000000000",
                payload: {
                  headers: [
                    { name: "From", value: thread.from },
                    { name: "To", value: ME },
                    { name: "Subject", value: thread.subject },
                    { name: "Message-ID", value: thread.messageId },
                  ],
                },
              },
            ],
          },
        };
      },
    },
    drafts: {
      create: async ({ requestBody }: { requestBody: { message: { raw: string; threadId?: string } } }) => {
        draftCounter += 1;
        const id = `${prefix}-${draftCounter}`;
        storeDraft(drafts, id, Buffer.from(requestBody.message.raw, "base64url").toString("utf8"), requestBody.message.threadId);
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
              threadId: draft.threadId,
              payload: {
                headers: [
                  { name: "To", value: draft.to },
                  { name: "Cc", value: draft.cc },
                  { name: "Subject", value: draft.subject },
                  ...(draft.inReplyTo ? [{ name: "In-Reply-To", value: draft.inReplyTo }] : []),
                  ...(draft.references ? [{ name: "References", value: draft.references }] : []),
                ],
                mimeType: "text/plain",
                body: { data: Buffer.from(draft.body, "utf8").toString("base64url") },
              },
            },
          },
        };
      },
      update: async ({ id, requestBody }: { id: string; requestBody: { message: { raw: string; threadId?: string } } }) => {
        // Without a thread id, Gmail files the draft in a new thread of its own.
        const threadId = requestBody.message.threadId ?? `new-thread-${id}`;
        storeDraft(drafts, id, Buffer.from(requestBody.message.raw, "base64url").toString("utf8"), threadId);
        return { data: { id, message: { id, threadId } } };
      },
      delete: async ({ id }: { id: string }) => {
        drafts.delete(id);
        return { data: {} };
      },
      send: async () => {
        throw new Error("a scheduled email must not send the Gmail draft");
      },
    },
  },
  } as unknown as gmail_v1.Gmail;
}
const gmail = mailbox("work");
const personalGmail = mailbox("personal");

/** Runs on the first Google account lookup of a fire, after the worker has read its row. */
let duringPrepare: (() => void) | undefined;
const workAccount = { id: "work", tag: "work", label: "work", client: {} } as unknown as LoadedGoogleAccount;
const personalAccount = { id: "personal", tag: "personal", label: "personal", client: {} } as unknown as LoadedGoogleAccount;
setGoogleAccountForTests((id) => {
  if (duringPrepare) {
    const hook = duringPrepare;
    duringPrepare = undefined;
    hook();
  }
  return id === "personal" ? personalAccount : workAccount;
});
setGmailClientForTests((account) => (account.id === "personal" ? personalGmail : gmail));

const told: string[] = [];
/** Every Confirm button posted, newest last, as its callback data. */
const confirmButtons: string[] = [];
const telegram = {
  sendMessage: async (_chat: unknown, text: string, extra?: { reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } }) => {
    told.push(text);
    for (const button of (extra?.reply_markup?.inline_keyboard ?? []).flat()) {
      if (button.callback_data?.startsWith("cmdsend:confirmsched:")) {
        confirmButtons.push(button.callback_data);
      }
    }
    return { message_id: 900 + told.length, date: 0, chat: { id: 1, type: "private" }, text };
  },
  editMessageText: async (_chat: unknown, _id: unknown, text: string) => {
    told.push(text);
    return true;
  },
} as unknown as Api;
setCommandEmailTestHooks({ telegram });
setApprovalsTestHooks({ telegram, gmailFor: (account) => (account === "personal" ? personalGmail : gmail) });

// ---- models: the Email Agent rewrites, the Command writer writes at send time ----
setAgentModelSetting("email", { primary: "anthropic:haiku", fallbacks: [] });
/** What the Email Agent was shown, newest last. */
const agentFacts: string[] = [];
const KYC_DRAFT =
  "Hi Raghavendra,\n\nEpicode can integrate with your dialer.\nWe will automate the KYC requirements: document capture and identity verification.\nHappy to start with a two-week pilot.";

/** Revises exactly the body it is shown, so a stale or missing body shows up in the result. */
function reviseShown(facts: string): string | undefined {
  const shown = /Current body:\n([\s\S]*?)\n\nVishnu's correction:\n([\s\S]*?)\n\n/.exec(facts);
  if (!shown) {
    return undefined;
  }
  const lines = shown[1]!.trimEnd().split("\n");
  const correction = shown[2]!.trim();
  if (/shorter/i.test(correction)) {
    return lines.slice(0, -1).join("\n");
  }
  if (/formal/i.test(correction)) {
    return lines.join("\n").replace(/^Hi /, "Dear ");
  }
  return `${lines.join("\n")}\n${correction.replace(/^(?:add this point:|mention that)\s*/i, "")}`;
}

function emailAgentReply(params: Pick<CompleteParams, "messages">): CompleteResult {
  const facts = params.messages.map((message) => (typeof message.content === "string" ? message.content : "")).join("\n");
  agentFacts.push(facts);
  if (/dialer|KYC/i.test(facts)) {
    return modelReply({ text: JSON.stringify({ subject: "Dialer and KYC", body: reviseShown(facts) ?? KYC_DRAFT }) });
  }
  const friday = /friday/i.test(facts) ? " The proposal will be shared Friday." : "";
  return modelReply({ text: JSON.stringify({ subject: "Agent subject", body: `Hi,\n\nHere is where the proposal stands.${friday}` }) });
}
setRouteModelCompleteForTests(async (_spec, params) => emailAgentReply(params));
const writerCalls: CompleteParams[] = [];
/** Runs while the Command writer is composing a copy at send time. */
let duringWrite: (() => void) | undefined;
const standardModel = async (params: CompleteParams): Promise<CompleteResult> => {
  if (params.task === "command_send") {
    writerCalls.push(params);
    if (duringWrite) {
      const hook = duringWrite;
      duringWrite = undefined;
      hook();
    }
    const asked = JSON.stringify(params.messages);
    const line = /Revised plan/.test(asked) ? "The revised plan is below." : "The note he asked for.";
    return modelReply({ text: JSON.stringify({ subject: "Writer subject", body: `Hi,\n\n${line}` }) });
  }
  if (params.task === "drafting") {
    return emailAgentReply(params);
  }
  return modelReply({ text: '{"facts":[]}' });
};
setCompleteForTests(standardModel);

// ---- time: two days out, 10:00 in Kolkata ----
const DAY_MS = 24 * 60 * 60 * 1000;
const istDate = (at: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(at);
const atIst = (date: string, time: string) => new Date(`${date}T${time}:00+05:30`);
const SEND_DAY = istDate(new Date(Date.now() + 2 * DAY_MS));
const FIRE = atIst(SEND_DAY, "10:01");

let messageId = 100;
const turnIn = (chatId: number, userText: string) => ({
  iteration: 1,
  calledTools: [] as string[],
  userText,
  confirmation: { chatId, messageId: ++messageId },
  // Dispatch marks his own chat turn; these direct calls stand in for it.
  ownTurn: true,
});
const say = (chatId: number, text: string) => applyOwnerContextTurn(chatId, text, ++messageId);
// C: the emails scheduled straight from his words (no draft card first) are to people he
// has emailed before; these cases are about edits reaching the schedule, not new addresses.
for (const email of ["priya@example.com", "gita@example.com", "jaya@example.com", "alice@example.com"]) {
  recordKnownRecipient(email, "test");
}
const requestOf = (id: number) =>
  JSON.parse(getScheduledSend(id)!.request) as {
    to: Array<{ query: string; mailbox: { email: string } }>;
    cc: Array<{ mailbox: { email: string } }>;
    subject?: string;
    finalSubject?: string;
    finalBody?: string;
    draftId?: string;
  };

/** A Gmail draft to this address, then "send it at 10" in the same chat. */
async function draftThenSchedule(chatId: number, address: string, subject: string): Promise<{ draftId: string; row: ScheduledSendRecord }> {
  const created = await draftNewEmail(
    { to: address, subject, body: "Hi,\n\nA first note about the proposal." },
    turnIn(chatId, `Draft an email to ${address} about the proposal`),
  );
  const draftId = /draft_id:\s*(\S+)/.exec(created)?.[1];
  assert(draftId, `the draft is created, got ${created}`);
  const words = `send it to ${address} on ${SEND_DAY} at 10am`;
  const scheduled = await sendEmailFromTool(
    { to: [address], instruction: "send the proposal note", send_on: SEND_DAY, send_time: "10:00", subject, draft_id: draftId },
    turnIn(chatId, words),
  );
  assert(scheduled.startsWith("Scheduled:"), `it is scheduled, got ${scheduled}`);
  const row = listOpenScheduledSends().sort((left, right) => right.id - left.id)[0]!;
  assert(requestOf(row.id).draftId === draftId, "the schedule is bound to the draft");
  return { draftId, row };
}

async function fire(): Promise<void> {
  await runScheduledSendTick(FIRE);
}

/** The newest Confirm button posted for this scheduled send. */
function latestConfirm(id: number): string {
  const data = confirmButtons.filter((item) => item.startsWith(`cmdsend:confirmsched:${id}:`)).at(-1);
  assert(data, `a Confirm card was posted for ${id}`);
  return data!;
}

/** His tap on a Confirm button (by default the newest card's). */
async function tapConfirmFor(id: number, data = latestConfirm(id)): Promise<string[]> {
  const edits: string[] = [];
  await handleScheduledSendCallback({
    callbackQuery: { data },
    answerCallbackQuery: async () => true,
    editMessageText: async (text: string) => {
      edits.push(text);
      return true;
    },
  } as unknown as Context);
  return edits;
}

// 1. The example: schedule for 10, change the subject, then mention Friday, then edit the
//    body by hand. The email at 10 carries the subject and the last body he approved.
{
  const chat = 1;
  const address = "raghavendra.kv@tenxpipe.com";
  const { draftId, row } = await draftThenSchedule(chat, address, "Proposal");

  const retitled = say(chat, "Change the subject to Proposal timeline");
  assert(retitled.subjectUpdate === "Proposal timeline", "a subject change is recognised");
  await updateDraft({ draft_id: draftId, subject: retitled.subjectUpdate }, turnIn(chat, "Change the subject to Proposal timeline"));
  assert(requestOf(row.id).subject === "Proposal timeline", "the scheduled subject changes");
  assert(drafts.get(draftId)!.subject === "Proposal timeline", "and the draft's");

  const friday = say(chat, "Also mention that the proposal will be shared Friday");
  assert(friday.reviseEmail, "a content correction becomes a rewrite");
  const revised = await reviseLinkedDraft(chat, friday.reviseEmail);
  assert(revised === "Updated the draft. The scheduled copy matches it.", `the rewrite reaches the schedule, got ${revised}`);
  let stored = requestOf(row.id);
  assert(stored.finalSubject === "Proposal timeline" && /shared Friday/.test(stored.finalBody ?? ""), "the finalized copy has both revisions");

  // Codex P2: a later ordinary update_draft must replace the finalized body, not append to
  // an instruction that the finalized copy overrides.
  const handBody = "Hi Raghavendra,\n\nThe proposal will be shared Friday, with pricing in a separate note.";
  const edited = await updateDraft({ draft_id: draftId, body: handBody }, turnIn(chat, "use this wording"));
  assert(JSON.parse(edited).schedule === "synced", `update_draft reports the scheduled copy, got ${edited}`);
  stored = requestOf(row.id);
  assert(stored.finalBody === handBody, "the finalized body is the one he just approved");
  assert(told.at(-1)!.includes("The scheduled email was updated to match this draft."), "the refreshed card says so");

  // A later subject-only edit by hand also beats the finalized subject.
  await updateDraft({ draft_id: draftId, subject: "Proposal on Friday" }, turnIn(chat, "subject: Proposal on Friday"));
  assert(requestOf(row.id).finalSubject === "Proposal on Friday", "the finalized subject follows a subject-only edit");

  const writes = writerCalls.length;
  await fire();
  assert(sends.length === 1, `one email goes out, got ${sends.length}`);
  assert(sends[0]!.to.includes(address), "to Raghavendra");
  assert(sends[0]!.subject === "Proposal on Friday", `with the last subject, got ${sends[0]!.subject}`);
  assert(sends[0]!.body.startsWith(handBody), `with the last approved body, got ${sends[0]!.body}`);
  assert(writerCalls.length === writes, "a finalized copy is not rewritten at send time");
  assert(getScheduledSend(row.id)!.status === "sent" && getTask(row.task_id)!.status === "done", "recorded as sent");
  await runScheduledSendTick(new Date(FIRE.getTime() + 60_000));
  assert(sends.length === 1, "it never goes twice");
}

// 2. Edits after scheduling from the Edit button (no chat turn), and recipient and Cc corrections.
{
  const chat = 2;
  const { draftId, row } = await draftThenSchedule(chat, "bob@example.com", "Invoice");
  await reviseLinkedDraft(chat, "mention that the invoice is due Friday");
  assert(typeof requestOf(row.id).finalBody === "string", "a contextual rewrite finalized the copy");

  // An Edit tap runs update_draft without a chat confirmation.
  const tapBody = "Hi Carol,\n\nThe invoice is due on the 30th.";
  const tapped = await updateDraft({ draft_id: draftId, body: tapBody, subject: "Invoice due date" });
  assert(JSON.parse(tapped).schedule === "synced", `an Edit-tap edit reaches the schedule, got ${tapped}`);
  const corrected = await updateDraft({ draft_id: draftId, to: "Carol Iyer <carol@example.com>", cc: ["dave@example.com"] });
  assert(JSON.parse(corrected).schedule === "synced", "the recipient correction reaches it too");
  const stored = requestOf(row.id);
  assert(stored.to.length === 1 && stored.to[0]!.mailbox.email === "carol@example.com", "the scheduled To is Carol only");
  assert(stored.to[0]!.query === "carol@example.com", "and the send-time check looks up her exact address");
  assert(stored.cc.length === 1 && stored.cc[0]!.mailbox.email === "dave@example.com", "the Cc follows");
  assert(stored.finalBody === tapBody && stored.finalSubject === "Invoice due date", "body and subject follow");

  const before = sends.length;
  // C: Carol and Dave came in by an edit after he confirmed the schedule, and he has
  // never emailed them: at send time it is held for his Confirm, not sent.
  const toldBefore = told.length;
  await fire();
  assert(sends.length === before, "nothing goes out to the new addresses");
  assert(getScheduledSend(row.id)!.status === "held", "it is held");
  assert(
    told.slice(toldBefore).some((text) => text.includes("New address: carol@example.com, dave@example.com. Tap Confirm to send it.")),
    `he is told why: ${told.slice(toldBefore).join(" | ")}`,
  );
  // Codex P1: the people change while it's held (another edit adds Erin). The card he was
  // shown named Carol and Dave only, so its Confirm confirms nothing and sends nothing.
  const shownCard = latestConfirm(row.id);
  const addedErin = await updateDraft({ draft_id: draftId, cc: ["dave@example.com", "erin@example.com"] });
  assert(JSON.parse(addedErin).schedule === "synced", "the held schedule takes the edit");
  assert(requestOf(row.id).cc.some((slot) => slot.mailbox.email === "erin@example.com"), "Erin is on it now");
  const toldBeforeStale = told.length;
  const staleEdits = await tapConfirmFor(row.id, shownCard);
  assert(getScheduledSend(row.id)!.status === "held", "the old card's Confirm leaves it held");
  assert(sends.length === before, "and sends nothing");
  assert(staleEdits.some((text) => text.startsWith("Not confirmed: the people on it changed")), `the old card says why: ${staleEdits.join(" | ")}`);
  assert(
    told.slice(toldBeforeStale).some((text) => text.includes("It now goes to carol@example.com, dave@example.com, erin@example.com.") && text.includes("New address: carol@example.com, dave@example.com, erin@example.com.")),
    `a fresh card shows who now: ${told.slice(toldBeforeStale).join(" | ")}`,
  );
  assert(latestConfirm(row.id) !== shownCard, "with its own Confirm");
  await tapConfirmFor(row.id, shownCard);
  assert(getScheduledSend(row.id)!.status === "held", "the old card stays out of date");
  // His Confirm tap on the fresh card puts it back on the schedule, once; a second tap does nothing.
  const tapConfirm = () => tapConfirmFor(row.id);
  await tapConfirm();
  assert(getScheduledSend(row.id)!.status === "scheduled", "Confirm schedules it again");
  await tapConfirm();
  await fire();
  assert(sends.length === before + 1, "one email goes out");
  const sent = sends.at(-1)!;
  assert(sent.to.includes("carol@example.com") && !sent.to.includes("bob@example.com"), `only to Carol, got ${sent.to}`);
  assert(sent.cc.includes("dave@example.com") && sent.cc.includes("erin@example.com"), `Cc Dave and Erin, got ${sent.cc}`);
  assert(sent.subject === "Invoice due date" && sent.body.startsWith(tapBody), "with the edited subject and body");
}

// 3. A scheduled email with no Gmail draft: a subject change, then subject and content together.
{
  const chat = 3;
  const address = "priya@example.com";
  const scheduled = await sendEmailFromTool(
    { to: [address], instruction: "Share the roadmap and ask for feedback.", send_on: SEND_DAY, send_time: "10:00", subject: "Roadmap" },
    turnIn(chat, `email ${address} on ${SEND_DAY} at 10am about the roadmap`),
  );
  assert(scheduled.startsWith("Scheduled:"), `scheduled, got ${scheduled}`);
  const row = listOpenScheduledSends().sort((left, right) => right.id - left.id)[0]!;
  assert(!requestOf(row.id).draftId && getPendingAction(chat)?.email?.scheduledSendId === row.id, "no draft, linked by chat");

  const retitled = say(chat, "Change the subject to Roadmap review");
  assert(retitled.handled && /subject is now "Roadmap review"/.test(retitled.text ?? ""), `he is told, got ${retitled.text}`);
  assert(requestOf(row.id).subject === "Roadmap review", "the scheduled subject changes without a draft");

  const both = say(chat, "Change the subject to Roadmap and pricing and mention that the proposal will be shared Friday");
  assert(both.subjectUpdate === "Roadmap and pricing", `the subject is split from the rewrite, got ${both.subjectUpdate}`);
  assert(both.reviseEmail === "mention that the proposal will be shared Friday", `and the rest is a rewrite, got ${both.reviseEmail}`);
  const revised = await reviseLinkedDraft(chat, both.reviseEmail, new Date(), { subject: both.subjectUpdate });
  assert(revised === "Updated the scheduled email.", `got ${revised}`);

  const before = sends.length;
  await fire();
  const sent = sends.at(-1)!;
  assert(sends.length === before + 1, "one email");
  assert(sent.subject === "Roadmap and pricing" && /shared Friday/.test(sent.body), `both revisions go out, got ${sent.subject} / ${sent.body}`);
}

// 4. Changes while the worker prepares a finalized copy: the stale copy is thrown away and
//    the latest saved version goes out, once, to the corrected recipient only.
{
  const chat = 4;
  const { draftId, row } = await draftThenSchedule(chat, "erin@example.com", "Kickoff");
  await updateDraft({ draft_id: draftId, body: "Hi Erin,\n\nKickoff is Monday." }, turnIn(chat, "edit"));
  duringPrepare = () => {
    const turn = say(chat, "Send it to frank@example.com instead");
    assert(/frank@example.com/.test(turn.text ?? ""), `the correction lands mid-prepare, got ${turn.text}`);
    assert(!/Too late/.test(turn.text ?? ""), "it is not too late while preparing");
  };
  const before = sends.length;
  await fire();
  assert(!duringPrepare, "the change happened while preparing");
  // C: Frank is new and came in by a correction, so the latest version is held for his
  // Confirm: nothing goes to Erin, nor to Frank unconfirmed.
  assert(sends.length === before, `nothing goes out before Confirm, got ${sends.length - before}`);
  assert(getScheduledSend(row.id)!.status === "held", "it is held for Confirm");
  await tapConfirmFor(row.id);
  await fire();
  assert(sends.length === before + 1, `exactly one email, got ${sends.length - before}`);
  const sent = sends.at(-1)!;
  assert(sent.to.includes("frank@example.com") && !sent.to.includes("erin@example.com"), `only the corrected recipient, got ${sent.to}`);
  assert(sent.body.startsWith("Hi Erin,\n\nKickoff is Monday."), "with the saved body");
  assert(logged.some((line) => line.includes(`Scheduled send ${row.id}: changed while preparing`)), "the stale copy was discarded");
  assert(getScheduledSend(row.id)!.status === "sent", "recorded once");
  await runScheduledSendTick(new Date(FIRE.getTime() + 60_000));
  assert(sends.length === before + 1, "and not again");
}

// 5. A change while the Command writer is composing a copy from instructions.
{
  const chat = 5;
  const address = "gita@example.com";
  await sendEmailFromTool(
    { to: [address], instruction: "Share the plan.", send_on: SEND_DAY, send_time: "10:00", subject: "Plan" },
    turnIn(chat, `email ${address} on ${SEND_DAY} at 10am about the plan`),
  );
  const row = listOpenScheduledSends().sort((left, right) => right.id - left.id)[0]!;
  duringWrite = () => {
    const turn = say(chat, "Change the subject to Revised plan");
    assert(turn.handled && !/Too late/.test(turn.text ?? ""), "a subject change while writing is accepted");
  };
  const writes = writerCalls.length;
  const before = sends.length;
  await fire();
  assert(writerCalls.length === writes + 2, `the stale copy is rewritten from the new version, got ${writerCalls.length - writes} writes`);
  assert(sends.length === before + 1, "one email");
  assert(sends.at(-1)!.subject === "Revised plan", `with the new subject, got ${sends.at(-1)!.subject}`);
  assert(getScheduledSend(row.id)!.status === "sent", "recorded");
}

// 6. A correction while recipients are being re-checked does not get overwritten by a hold.
{
  // C: both are people he has emailed before; this case is about the ambiguity race.
  recordKnownRecipient("lata@one.example", "test");
  recordKnownRecipient("zed@example.com", "test");
  const created = createScheduledSend({
    key: "hold-race",
    sendAt: atIst(SEND_DAY, "10:00").toISOString(),
    itemText: "Send email to Lata — Notes",
    tag: "work",
    request: JSON.stringify({
      to: [{ query: "Lata", mailbox: { email: "lata@one.example", name: "Lata Rao" } }],
      cc: [],
      threadId: null,
      instruction: "Send the notes.",
      ownWords: "send Lata the notes",
      account: "work",
      subject: "Notes",
      finalSubject: "Notes",
      finalBody: "Hi,\n\nThe notes.",
    }),
    confirmChat: 6,
    confirmMessage: 1,
  });
  assert(created, "row made");
  const { writeScheduledCopy } = await import("../src/db.ts");
  duringPrepare = () => {
    assert(writeScheduledCopy(created.id, { to: [{ name: "Lata Rao", email: "lata@one.example" }], body: "Hi,\n\nThe updated notes." }).ok, "saved");
    assert(writeScheduledCopy(created.id, { to: [{ name: "Zed", email: "zed@example.com" }] }).ok, "retargeted");
  };
  const before = sends.length;
  const toldBefore = told.length;
  const searches = lataSearches;
  await fire();
  assert(lataSearches > searches, "the stale copy found two Latas and tried to hold");
  assert(!told.slice(toldBefore).some((text) => text.startsWith("Held, not sent")), "the stale ambiguity does not hold the corrected row");
  assert(getScheduledSend(created.id)!.status === "sent", "the corrected row went out instead");
  assert(sends.length === before + 1 && sends.at(-1)!.to.includes("zed@example.com"), `it goes to the corrected address, got ${sends.at(-1)?.to}`);
  assert(sends.at(-1)!.body.startsWith("Hi,\n\nThe updated notes."), "with the saved body");
}

// 7. After the claim: every correction is refused clearly and changes nothing.
{
  const chat = 7;
  const { draftId, row } = await draftThenSchedule(chat, "hari@example.com", "Contract");
  const approved = "Hi Hari,\n\nThe contract is ready.";
  await updateDraft({ draft_id: draftId, body: approved }, turnIn(chat, "edit"));
  const replies: string[] = [];
  duringSend = async () => {
    assert(getScheduledSend(row.id)!.status === "sending", "Gmail is called only after the claim");
    const draftBefore = { ...drafts.get(draftId)! };
    const requestBefore = getScheduledSend(row.id)!.request;
    replies.push(say(chat, "Change the subject to Contract v2").text ?? "");
    replies.push(say(chat, "Also mention the signing deadline is Monday").text ?? "");
    replies.push(say(chat, "Send it to ivy@example.com instead").text ?? "");
    replies.push(await updateDraft({ draft_id: draftId, body: "late body" }, turnIn(chat, "late edit")));
    replies.push(await updateDraft({ draft_id: draftId, subject: "late subject" }));
    replies.push(say(chat, "Don't send that email").text ?? "");
    assert(JSON.stringify(drafts.get(draftId)) === JSON.stringify(draftBefore), "the Gmail draft is unchanged");
    assert(getScheduledSend(row.id)!.request === requestBefore, "the claimed request is unchanged");
  };
  const before = sends.length;
  await fire();
  assert(replies.length === 6, "every correction was tried after the claim");
  for (const reply of replies) {
    assert(/^Too late/.test(reply), `a late correction is refused, got ${reply}`);
    assert(!/Updated|Using|now says|Cancelled/.test(reply), `and never acknowledged, got ${reply}`);
  }
  assert(/already being sent/.test(replies[0]!), "it says the email is going out");
  assert(/Too late to cancel/.test(replies[5]!), "a cancel says it is too late");
  assert(sends.length === before + 1, "one email");
  const sent = sends.at(-1)!;
  assert(sent.to.includes("hari@example.com") && !sent.to.includes("ivy@example.com"), "to the claimed recipient only");
  assert(sent.subject === "Contract" && sent.body.startsWith(approved), "with the claimed content");
  assert(getScheduledSend(row.id)!.status === "sent", "recorded");

  const afterSent = await updateDraft({ draft_id: draftId, body: "later still" });
  assert(/^Too late/.test(afterSent) && /already went out/.test(afterSent), `after it went out, too, got ${afterSent}`);
  assert(/already went out/.test(say(chat, "make it shorter").text ?? ""), "a rewrite after it went out is refused");
  await runScheduledSendTick(new Date(FIRE.getTime() + 60_000));
  assert(sends.length === before + 1, "no second send");
}

// 8. A writer failure does not bring back a send he cancelled meanwhile.
{
  const chat = 8;
  const address = "jaya@example.com";
  await sendEmailFromTool(
    { to: [address], instruction: "Share the plan.", send_on: SEND_DAY, send_time: "10:00", subject: "Plan" },
    turnIn(chat, `email ${address} on ${SEND_DAY} at 10am about the plan`),
  );
  const row = listOpenScheduledSends().sort((left, right) => right.id - left.id)[0]!;
  setCompleteForTests(async (params: CompleteParams): Promise<CompleteResult> => {
    if (params.task === "command_send") {
      transitionScheduledSend(row.id, ["scheduled", "held"], "cancelled");
      throw new Error("writer down");
    }
    if (params.task === "drafting") {
      return emailAgentReply(params);
    }
    return modelReply({ text: '{"facts":[]}' });
  });
  const before = sends.length;
  const toldBefore = told.length;
  await fire();
  assert(getScheduledSend(row.id)!.status === "cancelled", `a cancel during a failed write stays cancelled, got ${getScheduledSend(row.id)!.status}`);
  assert(!told.slice(toldBefore).some((text) => text.includes("keep trying")), "and he isn't told it will retry");
  await runScheduledSendTick(new Date(FIRE.getTime() + 20 * 60_000));
  assert(sends.length === before, "nothing is sent");
}

setCompleteForTests(standardModel);

const newestOpen = () => listOpenScheduledSends().sort((left, right) => right.id - left.id)[0]!;

// 9. Two emails to the same person in different mailboxes stay independent: editing or
//    cancelling one never touches the other.
{
  const chat = 9;
  const created = await draftNewEmail(
    { to: "alice@example.com", subject: "Work plan", body: "Hi Alice,\n\nThe work plan." },
    turnIn(chat, "Draft an email to alice@example.com about the work plan"),
  );
  const workDraft = /draft_id:\s*(\S+)/.exec(created)![1]!;
  const scheduled = await sendEmailFromTool(
    { to: ["alice@example.com"], instruction: "Wish her a happy birthday.", send_on: SEND_DAY, send_time: "10:00", subject: "Birthday", account: "personal" },
    turnIn(chat, `email alice@example.com from my personal account on ${SEND_DAY} at 10am wishing her a happy birthday`),
  );
  assert(scheduled.startsWith("Scheduled:"), `the personal email is scheduled, got ${scheduled}`);
  const personal = newestOpen();
  const personalRequest = getScheduledSend(personal.id)!.request;
  assert(!requestOf(personal.id).draftId, "a shared recipient does not bind the work draft");
  assert(!getPendingAction(chat)?.email?.draftId, "the chat's email is the personal one, with no draft");

  const edited = await updateDraft({ draft_id: workDraft, body: "Hi Alice,\n\nThe revised work plan." }, turnIn(chat, "edit the work plan"));
  assert(!JSON.parse(edited).schedule, `editing the work draft reports no schedule, got ${edited}`);
  assert(getScheduledSend(personal.id)!.request === personalRequest, "and the personal email is unchanged");

  // Focused on the work draft, "cancel that email" retires that draft only.
  const draft = drafts.get(workDraft)!;
  focusSelectedDraft(chat, { draftId: workDraft, to: draft.to, subject: draft.subject, body: draft.body, account: "work" });
  const cancelled = say(chat, "cancel that email");
  assert(cancelled.retireDraftId === workDraft, "the work draft is the one cancelled");
  assert(getScheduledSend(personal.id)!.status === "scheduled", "the personal email stays scheduled");

  // Account isolation in the lookup itself: the same draft id in two mailboxes.
  for (const [key, account] of [["iso-work", "work"], ["iso-personal", "personal"]] as const) {
    createScheduledSend({
      key,
      sendAt: atIst(SEND_DAY, "23:00").toISOString(),
      itemText: `Send email to Iso — ${account}`,
      tag: account,
      request: JSON.stringify({ to: [], cc: [], instruction: "x", draftId: "same-id", account }),
      confirmChat: chat,
      confirmMessage: 1,
    });
  }
  assert(listScheduledSendsForDraft("same-id", "work").every((row) => row.item_text.endsWith("work")), "a draft id never reaches another mailbox's schedule");
  assert(listScheduledSendsForDraft("same-id", "personal").length === 1, "each mailbox sees only its own");
  for (const row of listOpenScheduledSends().filter((item) => item.item_text.startsWith("Send email to Iso"))) {
    transitionScheduledSend(row.id, ["scheduled"], "cancelled");
  }

  const before = sends.length;
  await fire();
  assert(sends.length === before + 1 && sends.at(-1)!.subject === "Birthday", "the personal email goes out on its own terms");
}

// 10. A named draft that isn't verified is refused: wrong mailbox, or different people.
{
  const chat = 10;
  const created = await draftNewEmail(
    { to: "ben@example.com", subject: "Quote", body: "Hi Ben,\n\nThe quote." },
    turnIn(chat, "Draft an email to ben@example.com with the quote"),
  );
  const workDraft = /draft_id:\s*(\S+)/.exec(created)![1]!;
  const open = listOpenScheduledSends().length;
  const otherMailbox = await sendEmailFromTool(
    { to: ["ben@example.com"], instruction: "send the quote", send_on: SEND_DAY, send_time: "10:00", account: "personal", draft_id: workDraft },
    turnIn(chat, `send it to ben@example.com from my personal account on ${SEND_DAY} at 10am`),
  );
  assert(/^Not scheduled: I couldn't find that draft in your personal mailbox/.test(otherMailbox), `a draft from another mailbox is refused, got ${otherMailbox}`);
  const otherPeople = await sendEmailFromTool(
    { to: ["cara@example.com"], instruction: "send the quote", send_on: SEND_DAY, send_time: "10:00", draft_id: workDraft },
    turnIn(chat, `send it to cara@example.com on ${SEND_DAY} at 10am`),
  );
  assert(/^Not scheduled: that draft is addressed to .*ben@example\.com/.test(otherPeople), `a draft to other people is refused, got ${otherPeople}`);
  assert(listOpenScheduledSends().length === open, "neither made a schedule");
}

// 11. Independent drafts: only the scheduled draft follows edits to its Gmail id.
{
  const chat = 11;
  const { draftId: first, row } = await draftThenSchedule(chat, "dan@example.com", "Offer");
  const second = /draft_id:\s*(\S+)/.exec(
    await draftNewEmail({ to: "lunch@example.com", subject: "Lunch", body: "Hi,\n\nLunch on Friday?" }, turnIn(chat, "Draft an email to lunch@example.com about lunch")),
  )![1]!;
  const kept = getScheduledSend(row.id)!.request;
  await updateDraft({ draft_id: second, body: "Hi,\n\nLunch on Saturday?" });
  assert(getScheduledSend(row.id)!.request === kept, "editing the other draft leaves the schedule alone");
  await updateDraft({ draft_id: first, body: "Hi Dan,\n\nThe offer is attached below in text." });
  assert(requestOf(row.id).finalBody === "Hi Dan,\n\nThe offer is attached below in text.", "editing the scheduled draft reaches it");
  transitionScheduledSend(row.id, ["scheduled"], "cancelled");
}

// Replacing a pending draft also cancels any queued delivery of that draft.
{
  const chat = 11;
  const { draftId, row } = await draftThenSchedule(chat, "dan@example.com", "First note");
  const replaced = await draftNewEmail(
    { to: "dan@example.com", subject: "New note", body: "Hi Dan,\n\nHere is the latest note." },
    turnIn(chat, "Draft an email to dan@example.com with the latest note"),
  );
  assert(replaced.includes("Replaced your earlier draft to Dan."), `replacement is visible, got ${replaced}`);
  assert(getScheduledSend(row.id)?.status === "cancelled", "the replaced draft's schedule cannot still deliver it");
  assert((await updateDraft({ draft_id: draftId, body: "An old copy." })) === "That draft was replaced by a newer one.", "the older draft cannot be revived by editing it");
}

// Recipient overlap uses parsed mailboxes, so an email in a display name cannot
// cancel an unrelated scheduled delivery.
{
  const chat = 11;
  const { row: formerSchedule } = await draftThenSchedule(chat, "former@example.com", "Former recipient");
  const queueRawTo = async (to: string, subject: string) => {
    const created = await gmail.users.drafts.create({
      userId: "me",
      requestBody: { message: { raw: Buffer.from(`To: ${to}\r\nSubject: ${subject}\r\n\r\nHi,\n\nA note.`).toString("base64url") } },
    });
    const actionId = await queueDraftApproval({
      draftId: created.data.id!, threadId: null, to, subject,
      body: "Hi,\n\nA note.", googleAccount: "work",
    });
    return { actionId };
  };
  const actualRecipient = await queueRawTo("current@example.net", "Current recipient");
  const quotedDraft = await queueRawTo('"former@example.com" <current@example.net>', "Quoted name");
  assert(getScheduledSend(formerSchedule.id)?.status === "scheduled" &&
    getApprovalActionById(actualRecipient.actionId)?.status === "superseded" && getApprovalActionById(quotedDraft.actionId)?.status === "pending",
    `parsed recipient matching keeps the former schedule and replaces current only: former schedule=${getScheduledSend(formerSchedule.id)?.status}, current=${getApprovalActionById(actualRecipient.actionId)?.status}, quoted=${getApprovalActionById(quotedDraft.actionId)?.status}`);
  transitionScheduledSend(formerSchedule.id, ["scheduled"], "cancelled");
}

// 12. Edits made before scheduling are what the scheduled email sends.
{
  const chat = 12;
  const created = await draftNewEmail(
    { to: "esha@example.com", subject: "Draft subject", body: "Hi Esha,\n\nFirst wording." },
    turnIn(chat, "Draft an email to esha@example.com"),
  );
  const draftId = /draft_id:\s*(\S+)/.exec(created)![1]!;
  await updateDraft({ draft_id: draftId, subject: "Final subject", body: "Hi Esha,\n\nThe wording he settled on." });
  const scheduled = await sendEmailFromTool(
    { to: ["esha@example.com"], instruction: "send the draft", send_on: SEND_DAY, send_time: "10:00", draft_id: draftId },
    turnIn(chat, `send it to esha@example.com on ${SEND_DAY} at 10am`),
  );
  assert(scheduled.includes("Final subject"), `the scheduled item shows the draft's subject, got ${scheduled}`);
  const row = newestOpen();
  assert(requestOf(row.id).finalBody === "Hi Esha,\n\nThe wording he settled on.", "the copy is the edited draft");
  assert(getPendingAction(chat)?.email?.draftId === draftId && getPendingAction(chat)?.email?.scheduledSendId === row.id, "the chat's email is that draft and its schedule");
  const writes = writerCalls.length;
  const before = sends.length;
  await fire();
  const sent = sends.at(-1)!;
  assert(sends.length === before + 1 && sent.subject === "Final subject" && sent.body.startsWith("Hi Esha,\n\nThe wording he settled on."), `the edits before scheduling go out, got ${sent.subject} / ${sent.body}`);
  assert(writerCalls.length === writes, "and nothing is rewritten at send time");
}

// 13. A sent email stays as sent. Edits are refused, and a new draft is independent.
{
  const chat = 13;
  const { draftId, row } = await draftThenSchedule(chat, "farah@example.com", "Agenda");
  await updateDraft({ draft_id: draftId, body: "Hi Farah,\n\nThe agenda." }, turnIn(chat, "edit"));
  await fire();
  const sentRow = getScheduledSend(row.id)!;
  assert(sentRow.status === "sent", "it went out");
  const sentCount = sends.length;
  const draftBefore = JSON.stringify(drafts.get(draftId));

  const late = await updateDraft({ draft_id: draftId, body: "Hi Farah,\n\nA changed agenda." }, turnIn(chat, "change it"));
  assert(/already went out/.test(late) && /stays as it was sent/.test(late) && /draft a new email/.test(late), `an edit after sending is refused and offers a new draft, got ${late}`);
  assert(JSON.stringify(drafts.get(draftId)) === draftBefore, "the draft is untouched");
  const shorter = say(chat, "make it shorter");
  assert(/already went out/.test(shorter.text ?? ""), "a contextual rewrite is refused too");
  const after = getScheduledSend(row.id)!;
  assert(after.request === sentRow.request && after.sent_message_id === sentRow.sent_message_id && after.status === "sent", "the sent record never changes");

  const followUp = /draft_id:\s*(\S+)/.exec(
    await draftNewEmail({ to: "farah@example.com", subject: "Agenda follow-up", body: "Hi Farah,\n\nOne more item." }, turnIn(chat, "Draft a new email to farah@example.com with one more item")),
  )![1]!;
  assert(followUp !== draftId, "a new draft is created");
  assert(!getPendingAction(chat)?.email?.scheduledSendId, "it is not tied to the sent email");
  const edited = await updateDraft({ draft_id: followUp, body: "Hi Farah,\n\nOne more item, and a question." }, turnIn(chat, "edit"));
  assert(edited.startsWith("{") && !JSON.parse(edited).schedule, `the new draft can be edited freely, got ${edited}`);
  const revised = await reviseLinkedDraft(chat, "mention that the proposal will be shared Friday");
  assert(revised === "Updated the draft.", `and rewritten, got ${revised}`);
  assert(getScheduledSend(row.id)!.request === sentRow.request, "the sent record still never changes");
  await runScheduledSendTick(new Date(FIRE.getTime() + 60_000));
  assert(sends.length === sentCount, "nothing is resent");
}

// 14. A generated draft is the email from creation on: each revision starts from the draft
//     Gmail holds, so "make it shorter" keeps the KYC requirements.
{
  const chat = 14;
  const before = draftCounter;
  say(chat, "Draft an email to Raghavendra.");
  say(chat, "raghavendra.kv@tenxpipe.com");
  const ready = say(chat, "Raghavendra wants dialer integration and automated KYC flows.");
  assert(ready.publishDraft, "the context is ready to draft");
  const posted = await publishReadyDraft(chat);
  assert(posted.posted && posted.draftId && draftCounter === before + 1, "one draft is created");
  const draftId = posted.draftId;
  assert(drafts.get(draftId)!.body.startsWith(KYC_DRAFT), "Gmail holds the generated email");
  let email = getPendingAction(chat)?.email;
  assert(email?.draftId === draftId && email.account === "work", "the chat's email is that draft, in the work mailbox");
  assert(email.to[0]?.email === "raghavendra.kv@tenxpipe.com", "to Raghavendra");
  assert(email.notes.some((note) => note === `Current draft:\n${KYC_DRAFT}`), "the generated body survives creation");
  assert(email.notes.some((note) => /automated KYC flows/.test(note)), "and so do the facts he gave");

  const shorter = say(chat, "Make it shorter");
  assert(shorter.reviseEmail, "make it shorter is a revision");
  assert((await reviseLinkedDraft(chat, shorter.reviseEmail)) === "Updated the draft.", "it is revised");
  assert(agentFacts.at(-1)!.includes(KYC_DRAFT), "the Email Agent saw the whole current draft");
  const short = drafts.get(draftId)!.body;
  assert(/KYC requirements: document capture and identity verification/.test(short), `the KYC requirements stay, got ${short}`);
  assert(!/two-week pilot/.test(short), "and it is shorter");

  const added = say(chat, "Add this point: pricing is per verified customer");
  await reviseLinkedDraft(chat, added.reviseEmail!);
  assert(agentFacts.at(-1)!.includes("Current body:\nHi Raghavendra,\n\nEpicode can integrate with your dialer.\nWe will automate the KYC requirements"), "the next revision starts from the shortened draft");
  assert(/KYC requirements/.test(drafts.get(draftId)!.body) && /pricing is per verified customer/.test(drafts.get(draftId)!.body), "both the requirements and the new point are there");

  // An Edit-tap edit outside this chat: Gmail's copy is still what the next revision reads,
  // and its To line is not put back to an older one.
  const outside = "Hi Raghavendra,\n\nWe will automate the KYC requirements for your branches.";
  await updateDraft({ draft_id: draftId, body: outside, to: "Raghavendra KV <raghu@tenxpipe.com>" });
  const formal = say(chat, "Change the wording to be more formal");
  await reviseLinkedDraft(chat, formal.reviseEmail!);
  assert(agentFacts.at(-1)!.includes(`Current body:\n${outside}`), "the revision reads the draft as saved, not the chat's older copy");
  const now = drafts.get(draftId)!;
  assert(now.body.startsWith("Dear Raghavendra,\n\nWe will automate the KYC requirements for your branches."), `the saved draft is the one revised, got ${now.body}`);
  assert(now.to.includes("raghu@tenxpipe.com") && !now.to.includes("raghavendra.kv@"), `the draft's To line stays as saved, got ${now.to}`);
  email = getPendingAction(chat)?.email;
  assert(email?.to[0]?.email === "raghu@tenxpipe.com" && email.draftId === draftId, "the chat follows the saved draft's people and id");
  assert(draftCounter === before + 1, "every revision updated the same draft");
}

// 15. Scheduled replies: an unchanged subject stays "Re:" in the thread; a subject he changes
//     goes out exactly, as a new conversation, and the card, record and email all agree.
{
  const raghav = "raghavendra.kv@tenxpipe.com";
  const scheduleReply = async (chat: number, extra: Record<string, unknown> = {}) => {
    const result = await sendEmailFromTool(
      { to: [raghav], instruction: "Reply with the integration plan.", thread_id: "voice-thread", send_on: SEND_DAY, send_time: "10:00", ...extra },
      turnIn(chat, `reply to ${raghav} on ${SEND_DAY} at 10am with the integration plan`),
    );
    assert(result.startsWith("Scheduled:"), `the reply is scheduled, got ${result}`);
    return newestOpen();
  };
  const itemSubject = (row: ScheduledSendRecord) => getScheduledSend(row.id)!.item_text.split(" — ")[1];
  /** A reply draft as draft_reply leaves it: in the thread, with its approval card. */
  const replyDraft = async (body: string): Promise<string> => {
    const created = await gmail.users.drafts.create({
      userId: "me",
      requestBody: {
        message: {
          threadId: "voice-thread",
          raw: Buffer.from(
            `To: Raghavendra KV <${raghav}>\r\nSubject: Re: Voice AI Discussion\r\nIn-Reply-To: <voice-1@tenxpipe.com>\r\nReferences: <voice-1@tenxpipe.com>\r\n\r\n${body}`,
          ).toString("base64url"),
        },
      },
    });
    const draftId = created.data.id!;
    await queueDraftApproval({
      draftId,
      threadId: "voice-thread",
      to: `Raghavendra KV <${raghav}>`,
      subject: "Re: Voice AI Discussion",
      body,
      googleAccount: "work",
    });
    return draftId;
  };

  // a. Unchanged: "Re:", the thread, and the reply headers.
  {
    const row = await scheduleReply(151);
    assert(requestOf(row.id).subject === "Re: Voice AI Discussion", "a reply keeps the thread's subject");
    const before = sends.length;
    await fire();
    const sent = sends.at(-1)!;
    assert(sends.length === before + 1, "one reply");
    assert(sent.subject === "Re: Voice AI Discussion" && sent.threadId === "voice-thread" && sent.inReplyTo === "<voice-1@tenxpipe.com>", `it stays in the thread, got ${JSON.stringify(sent)}`);
    await runScheduledSendTick(new Date(FIRE.getTime() + 60_000));
    assert(sends.length === before + 1, "and never goes twice");
  }

  // b. Changed in chat, with no draft: his exact subject, as a new conversation.
  {
    const chat = 152;
    const row = await scheduleReply(chat);
    const changed = say(chat, "Change the subject to Dialer and KYC Automation Proposal");
    assert(/subject is now "Dialer and KYC Automation Proposal"/.test(changed.text ?? "") && /new conversation/.test(changed.text ?? ""), `he is told it starts a new conversation, got ${changed.text}`);
    assert(itemSubject(row) === "Dialer and KYC Automation Proposal", "the scheduled item shows the new subject");
    assert(getTask(row.task_id)!.text === getScheduledSend(row.id)!.item_text, "and so does the task");
    const before = sends.length;
    await fire();
    const sent = sends.at(-1)!;
    assert(sends.length === before + 1 && sent.subject === "Dialer and KYC Automation Proposal", `the new subject goes out exactly, got ${sent.subject}`);
    assert(!sent.threadId && !sent.inReplyTo, `as a new conversation, got ${JSON.stringify(sent)}`);
    assert(/new conversation/.test(told.at(-1) ?? ""), "and the sent notice says so");
  }

  // c. A reply draft scheduled by id, then re-subjected: draft, card, record and email agree.
  {
    const chat = 153;
    const draftId = await replyDraft("Hi Raghavendra,\n\nHere is the integration plan.");
    const row = await scheduleReply(chat, { draft_id: draftId });
    assert(requestOf(row.id).draftId === draftId && requestOf(row.id).subject === "Re: Voice AI Discussion", "bound, still a reply");
    assert(!(JSON.parse(getScheduledSend(row.id)!.request) as { subjectEdited?: boolean }).subjectEdited, "the unchanged subject is not an edit");

    // A body-only edit keeps it in the thread.
    await updateDraft({ draft_id: draftId, body: "Hi Raghavendra,\n\nHere is the full integration plan." }, turnIn(chat, "edit"));
    assert(drafts.get(draftId)!.inReplyTo === "<voice-1@tenxpipe.com>" && drafts.get(draftId)!.threadId === "voice-thread", "a body edit stays a reply");

    const result = await updateDraft({ draft_id: draftId, subject: "Dialer and KYC Automation Proposal" }, turnIn(chat, "change the subject"));
    const card = told.at(-1)!;
    assert(/Subject: Dialer and KYC Automation Proposal/.test(card), "the card shows the new subject");
    assert(/new conversation, not as a reply in the original thread/.test(card), `the card says it starts a new conversation, got ${card}`);
    assert(JSON.parse(result).new_conversation, "and so does the tool result");
    const draft = drafts.get(draftId)!;
    assert(draft.subject === "Dialer and KYC Automation Proposal" && !draft.inReplyTo && draft.threadId !== "voice-thread", `the Gmail draft is a new conversation too, got ${JSON.stringify(draft)}`);
    const stored = requestOf(row.id);
    assert(stored.finalSubject === "Dialer and KYC Automation Proposal" && itemSubject(row) === stored.finalSubject, "the scheduled record agrees");

    const before = sends.length;
    await fire();
    const sent = sends.at(-1)!;
    assert(sends.length === before + 1, "one email");
    assert(sent.subject === stored.finalSubject && sent.subject === draft.subject, "the email sent has the same subject as the draft, card and record");
    assert(!sent.threadId && !sent.inReplyTo, "and is not forced into the old thread");
    assert(sent.body.startsWith("Hi Raghavendra,\n\nHere is the full integration plan."), "with the approved body");
  }

  // d. A reply draft whose subject he changed before scheduling goes out the same way.
  {
    const chat = 154;
    const draftId = await replyDraft("Hi Raghavendra,\n\nThe proposal.");
    await updateDraft({ draft_id: draftId, subject: "Pilot proposal" });
    const row = await scheduleReply(chat, { draft_id: draftId });
    assert(requestOf(row.id).subject === "Pilot proposal" && itemSubject(row) === "Pilot proposal", "his subject is scheduled, not the thread's");
    await fire();
    const sent = sends.at(-1)!;
    assert(sent.subject === "Pilot proposal" && !sent.threadId && !sent.inReplyTo, `it goes out as he wrote it, got ${JSON.stringify(sent)}`);
  }

  // Owner authorization still applies to scheduled replies.
  const unowned = await sendEmailFromTool(
    { to: [raghav], instruction: "x", thread_id: "voice-thread", send_on: SEND_DAY },
    { userText: `reply to ${raghav} on ${SEND_DAY}` },
  );
  assert(unowned.startsWith("Not sent") && unowned.includes("own message"), "only his own message can schedule a reply");
}

console.log = log;
console.log("scheduled edit checks passed.");
