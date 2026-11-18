/**
 * Email, calendar, and scheduled delivery share one chat. These checks drive the
 * real bot, approval cards, and scheduled worker with fake Gmail, Calendar, and
 * Telegram. Nothing here contacts Google.
 */
import assert from "node:assert/strict";
import type { Api } from "grammy";
import type { gmail_v1 } from "googleapis";
import {
  AUTH_TTL_MS,
  authorizationWords,
  explicitEmailField,
  matchOwnerSupplied,
  rememberScheduledSend,
  savePendingAction,
} from "../src/action_context.ts";
import { handleApprovalCallback, setApprovalsTestHooks } from "../src/approvals.ts";
import { bot } from "../src/bot.ts";
import { setCommandEmailTestHooks } from "../src/command_email.ts";
import { rememberContactChoice } from "../src/contacts.ts";
import { retrieveRelevantContext, setContextEvidenceForTests, stageExternalContext } from "../src/context_lookup.ts";
import {
  createScheduledSend,
  getScheduledSend,
  reopenPendingActionForTests,
  saveMessage,
  upsertCalendarEventRef,
} from "../src/db.ts";
import { setGoogleAccountForTests, type LoadedGoogleAccount } from "../src/google/auth.ts";
import { setGmailClientForTests } from "../src/google/mail.ts";
import { setCompleteForTests } from "../src/llm.ts";
import { noteCalendarReference, setOwnerCalendarTestHooks, type OwnerCalendarEvent } from "../src/owner_calendar.ts";
import { fireScheduledSend } from "../src/scheduled_sends.ts";
import { handler as draftNewEmail } from "../src/tools/draft_new_email.ts";
import { modelReply, nextMessageId } from "./fakes.ts";

if (process.env.AADI_DB_PATH !== ":memory:") {
  throw new Error("test-workflow-boundaries.ts must run with AADI_DB_PATH=:memory:");
}

const log = console.log;
console.log = () => undefined;
console.warn = () => undefined;

interface StoredDraft {
  to: string;
  cc: string;
  subject: string;
  body: string;
  account: string;
}
const drafts = new Map<string, StoredDraft>();
let draftSerial = 0;
const draftSends: string[] = [];
const messageSends: Array<{ account: string; raw: string }> = [];
const draftDeletes: string[] = [];
let failNextDraftSend = false;
let holdNextMessage = false;
let releaseMessageSend: () => void = () => undefined;
const headerOf = (raw: string, name: string) =>
  new RegExp(`^${name}: (.*)$`, "im").exec(raw.split(/\r?\n\r?\n/)[0] ?? "")?.[1]?.trim() ?? "";
function bodyOf(raw: string): string {
  const encoded = /Content-Transfer-Encoding: base64\r?\n\r?\n([A-Za-z0-9+/=\r\n]+)/.exec(raw)?.[1];
  return encoded
    ? Buffer.from(encoded.replace(/\s/g, ""), "base64").toString("utf8").trim()
    : raw.split(/\r?\n\r?\n/).slice(1).join("\n").trim();
}
function storeDraft(id: string, rawBase64: string, account: string): void {
  const raw = Buffer.from(rawBase64, "base64url").toString("utf8");
  const previous = drafts.get(id);
  drafts.set(id, {
    to: headerOf(raw, "To"),
    cc: headerOf(raw, "Cc"),
    subject: headerOf(raw, "Subject"),
    body: bodyOf(raw),
    account: previous?.account || account,
  });
}
const gmailFor = (account: LoadedGoogleAccount | string): gmail_v1.Gmail => {
  const accountId = typeof account === "string" ? account : account.id;
  return {
  users: {
    getProfile: async () => ({ data: { emailAddress: "vishnu.rajan@epicode.in" } }),
    settings: { sendAs: { list: async () => ({ data: { sendAs: [] } }) } },
    messages: {
      send: async ({ requestBody }: { requestBody: { raw: string } }) => {
        messageSends.push({ account: accountId, raw: requestBody.raw });
        if (holdNextMessage) {
          holdNextMessage = false;
          await new Promise<void>((resolve) => {
            releaseMessageSend = resolve;
          });
        }
        return { data: { id: `msg-${messageSends.length}` } };
      },
      list: async () => ({ data: { messages: [] } }),
      get: async () => ({ data: { payload: { headers: [] } } }),
    },
    drafts: {
      create: async ({ requestBody }: { requestBody: { message: { raw: string } } }) => {
        draftSerial += 1;
        const id = `draft-${draftSerial}`;
        storeDraft(id, requestBody.message.raw, accountId);
        return { data: { id, message: { id, threadId: `thread-${id}` } } };
      },
      get: async ({ id }: { id: string }) => {
        const draft = drafts.get(id);
        if (!draft) throw Object.assign(new Error("missing"), { code: 404 });
        return {
          data: {
            id,
            message: {
              id,
              threadId: `thread-${id}`,
              payload: {
                headers: [
                  { name: "To", value: draft.to },
                  { name: "Cc", value: draft.cc },
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
        storeDraft(id, requestBody.message.raw, accountId);
        return { data: { id, message: { id, threadId: `thread-${id}` } } };
      },
      delete: async ({ id }: { id: string }) => {
        draftDeletes.push(id);
        drafts.delete(id);
        return { data: {} };
      },
      send: async ({ requestBody }: { requestBody: { id: string } }) => {
        draftSends.push(`${accountId}:${requestBody.id}`);
        if (failNextDraftSend) {
          failNextDraftSend = false;
          throw new Error("socket hang up");
        }
        return { data: { id: `sent-${requestBody.id}` } };
      },
    },
  },
  } as unknown as gmail_v1.Gmail;
};

setGoogleAccountForTests((accountId) => ({ id: accountId, tag: accountId, label: accountId, client: {} }) as LoadedGoogleAccount);
setGmailClientForTests(gmailFor);

const cards: Array<{ text: string; buttons: string[] }> = [];
const telegram = {
  sendMessage: async (_chat: unknown, text: string, extra?: { reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } }) => {
    cards.push({ text, buttons: (extra?.reply_markup?.inline_keyboard ?? []).flat().map((item) => item.callback_data ?? "") });
    return { message_id: nextMessageId(), date: 0, chat: { id: 1, type: "private" }, text };
  },
  editMessageText: async () => true,
} as unknown as Api;
setApprovalsTestHooks({ telegram, gmailFor });
setCommandEmailTestHooks({ telegram });

const replies: string[] = [];
bot.api.config.use(async (_prev, method, payload) => {
  if (method === "getMe") {
    return { ok: true, result: { id: 999, is_bot: true, first_name: "Aadi", username: "aadi_test_bot" } } as never;
  }
  if (method === "sendMessage") {
    replies.push((payload as { text: string }).text);
    return { ok: true, result: { message_id: nextMessageId(), date: 0, chat: { id: 1, type: "private" }, text: replies.at(-1) } } as never;
  }
  return { ok: true, result: true } as never;
});
await bot.init();

const editedIds: string[] = [];
setCompleteForTests(async (params) => {
  const asked = params.messages.map((message) => (typeof message.content === "string" ? message.content : "")).join("\n");
  if (params.jsonSchema) {
    const current = /Current body:\n([\s\S]*?)\n\nVishnu/.exec(asked)?.[1]?.trim() || "Hello";
    const extra = /friday/i.test(asked) ? "\n\nDelivery is Friday." : "";
    return modelReply({ text: JSON.stringify({ subject: "Quarterly update", body: `${current}${extra}` }) });
  }
  const last = params.messages.at(-1);
  if (last?.role === "tool") return modelReply({ text: "Updated the draft." });
  const target = /Revise the existing Gmail draft with ID (\S+)\./.exec(asked)?.[1];
  if (target) {
    editedIds.push(target);
    return modelReply({ tools: [{ name: "update_draft", input: { draft_id: target, body: "Hi,\n\nShorter version." } }] });
  }
  return modelReply({ text: "No tool." });
});

const patches: Array<{ account: string; eventId: string; emails: string[] }> = [];
let guests: Array<{ email?: string | null; displayName?: string | null }> = [
  { email: "nithish@epicode.in", displayName: "Nithish" },
  { email: "sendhil@epicode.in", displayName: "Sendhil" },
];
let calendarLists = 0;
const meeting: OwnerCalendarEvent = {
  accountId: "personal",
  eventId: "evt-personal",
  title: "Catch up",
  start: "",
  attendeeCount: 2,
};
setOwnerCalendarTestHooks({
  list: async () => {
    calendarLists += 1;
    return [meeting];
  },
  getAttendees: async () => guests,
  patch: async (query) => {
    patches.push({
      account: query.event.accountId,
      eventId: query.event.eventId,
      emails: query.attendees.map((person) => (person.email ?? "").toLowerCase()),
    });
    guests = query.attendees.map((person) => ({ email: person.email, displayName: person.email }));
  },
});

function istYesterday(now: Date): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const [year, month, day] = today.split("-").map(Number);
  const utc = new Date(Date.UTC(year!, month! - 1, day!));
  utc.setUTCDate(utc.getUTCDate() - 1);
  return utc.toISOString().slice(0, 10);
}
meeting.start = `${istYesterday(new Date())}T04:30:00.000Z`;
upsertCalendarEventRef({
  chatId: 1,
  eventId: meeting.eventId,
  accountId: "personal",
  title: meeting.title,
  startIso: meeting.start,
  attendees: [
    { name: "Nithish", email: "nithish@epicode.in" },
    { name: "Sendhil", email: "sendhil@epicode.in" },
  ],
  focused: true,
  updatedAt: new Date().toISOString(),
});

async function say(text: string): Promise<void> {
  const before = replies.length;
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
  await new Promise((resolve) => setTimeout(resolve, 20));
  if (replies.length === before) replies.push("");
}
function lastReply(): string {
  return replies.at(-1) ?? "";
}
const turn = (userText: string) => ({
  iteration: 1,
  calledTools: [] as string[],
  userText,
  confirmation: { chatId: 1, messageId: nextMessageId() },
});
async function draft(to: string, subject: string, body: string, account: "work" | "personal" = "work"): Promise<{ id: string; actionId: number }> {
  const result = await draftNewEmail({ to, subject, body, account }, turn(`Draft an email to ${to}`));
  const id = /draft_id:\s*(\S+)/.exec(result)?.[1];
  assert.ok(id, result);
  const button = [...cards].reverse().flatMap((card) => card.buttons).find((data) => data.startsWith("approval:send:"));
  assert.ok(button);
  return { id: id!, actionId: Number(button.split(":").pop()) };
}
function schedule(input: { draftId: string; account: "work" | "personal"; to: string; subject: string; body: string; key: string; remember?: boolean }) {
  const row = createScheduledSend({
    key: input.key,
    sendAt: "2026-11-20T04:30:00.000Z",
    itemText: `Send email to ${input.to} — ${input.subject} — Fri 20 Nov 10:00`,
    tag: input.account,
    request: JSON.stringify({
      kind: "email",
      to: [{ query: input.to, mailbox: { email: input.to, name: input.to.split("@")[0] } }],
      cc: [],
      threadId: null,
      instruction: input.body,
      ownWords: "Schedule this email",
      account: input.account,
      draftId: input.draftId,
      subject: input.subject,
      finalSubject: input.subject,
      finalBody: input.body,
    }),
    confirmChat: 1,
    confirmMessage: 1,
  });
  assert.ok(row);
  if (input.remember !== false) {
    rememberScheduledSend({
      chatId: 1,
      scheduledSendId: row!.id,
      sendAt: row!.send_at,
      to: input.to,
      subject: input.subject,
      account: input.account,
      draftId: input.draftId,
      body: input.body,
    });
  }
  return row!;
}
async function tap(operation: "send" | "discard" | "edit", actionId: number): Promise<string[]> {
  const answers: string[] = [];
  await handleApprovalCallback({
    callbackQuery: { data: `approval:${operation}:${actionId}` },
    answerCallbackQuery: async (text?: unknown) => {
      if (typeof text === "string") answers.push(text);
      else if (text && typeof text === "object" && "text" in text) answers.push(String((text as { text: unknown }).text));
      else answers.push("ok");
    },
    reply: async () => undefined,
  } as never, operation, actionId);
  return answers;
}

assert.deepEqual(explicitEmailField("Add bob@example.com to Cc"), { field: "cc", person: "bob@example.com" });
assert.equal(explicitEmailField("Add Bob to yesterday's meeting with Nithish"), undefined);

const open = await draft("alice@example.com", "Hello", "Hello Alice, the proposal is attached.");
const beforeMeeting = JSON.stringify(drafts.get(open.id));
await say("Add bob@example.com to yesterday's meeting with Nithish.");
assert.equal(patches.length, 1, lastReply());
assert.equal(patches[0]!.account, "personal");
assert.equal(patches[0]!.eventId, "evt-personal");
assert.ok(patches[0]!.emails.includes("bob@example.com"));
assert.equal(JSON.stringify(drafts.get(open.id)), beforeMeeting, "the meeting edit did not change the draft");
assert.equal(draftSends.length, 0);
assert.equal(messageSends.length, 0);

const patchesAfterMeeting = patches.length;
await say("Add bob@example.com to Cc.");
assert.equal(patches.length, patchesAfterMeeting, `calendar was patched: ${lastReply()}`);
assert.match(drafts.get(open.id)!.cc, /bob@example.com/);
assert.match(drafts.get(open.id)!.to, /alice@example.com/);
assert.match(drafts.get(open.id)!.subject, /Hello/);
assert.match(drafts.get(open.id)!.body, /proposal is attached/);
assert.equal(draftSends.length, 0);

const ccBeforeAmbiguous = drafts.get(open.id)!.cc;
const patchesBeforeAmbiguous = patches.length;
await say("Add Carol to that.");
assert.match(lastReply(), /email draft or the meeting/i);
assert.equal(patches.length, patchesBeforeAmbiguous);
assert.equal(drafts.get(open.id)!.cc, ccBeforeAmbiguous);

const older = await draft("older@example.com", "Workshop", "Hi,\n\nThe workshop runs all day with three sessions and lunch.");
const newer = await draft("newer@example.com", "Invoice", "Hi,\n\nThe invoice is due on the 30th.");
const newerBefore = JSON.stringify(drafts.get(newer.id));
const olderEdit = cards.filter((card) => card.text.includes("older@example.com")).flatMap((card) => card.buttons).find((data) => data.startsWith("approval:edit:"));
assert.ok(olderEdit);
await tap("edit", Number(olderEdit!.split(":").pop()));
await say("make it shorter");
assert.equal(editedIds.at(-1), older.id);
assert.match(drafts.get(older.id)!.body, /Shorter version/);
assert.equal(JSON.stringify(drafts.get(newer.id)), newerBefore);
assert.equal(patches.length, patchesBeforeAmbiguous);

const editable = await draft("alice@example.com", "Hello", "Hello Alice, the proposal is attached.");
const scheduledEdit = schedule({
  draftId: editable.id,
  account: "work",
  to: "alice@example.com",
  subject: "Hello",
  body: "Hello Alice, the proposal is attached.",
  key: "edit-after-schedule",
});
await say("Change the subject to Quarterly update.");
await say("mention that delivery is Friday");
await say("Send it to bob@example.com instead.");
const editedRequest = JSON.parse(getScheduledSend(scheduledEdit.id)!.request) as { subject?: string; finalBody?: string; to?: Array<{ mailbox?: { email?: string } }> };
assert.equal(editedRequest.subject, "Quarterly update");
assert.match(editedRequest.finalBody ?? "", /Delivery is Friday/);
assert.equal(editedRequest.to?.[0]?.mailbox?.email, "bob@example.com");
assert.equal(draftSends.length, 0);
assert.equal(messageSends.length, 0);
assert.equal(patches.length, patchesBeforeAmbiguous);

const manual = await draft("alice@example.com", "Manual", "Please send this once.");
const manualSchedule = schedule({
  draftId: manual.id,
  account: "work",
  to: "alice@example.com",
  subject: "Manual",
  body: "Please send this once.",
  key: "manual-then-worker",
});
const manualAnswers = await tap("send", manual.actionId);
assert.deepEqual(draftSends, [`work:${manual.id}`]);
assert.equal(messageSends.length, 0);
assert.equal(getScheduledSend(manualSchedule.id)?.status, "sent");
assert.match(manualAnswers.join(" "), /Sent/);
const workerAfterManual = messageSends.length + draftSends.length;
await fireScheduledSend(getScheduledSend(manualSchedule.id)!, new Date());
assert.equal(messageSends.length + draftSends.length, workerAfterManual, "the worker sent a second copy");
reopenPendingActionForTests(manual.actionId);
const stale = await tap("send", manual.actionId);
assert.equal(draftSends.length, 1, "a stale Send button delivered the email again");
assert.match(stale.join(" "), /already delivered/i);

const workerDraft = await draft("alice@example.com", "Worker", "The worker sends this.");
const workerSchedule = schedule({
  draftId: workerDraft.id,
  account: "work",
  to: "alice@example.com",
  subject: "Worker",
  body: "The worker sends this.",
  key: "worker-then-button",
  remember: false,
});
await fireScheduledSend(workerSchedule, new Date());
assert.equal(messageSends.length, 1);
assert.equal(draftSends.length, 1);
assert.equal(getScheduledSend(workerSchedule.id)?.status, "sent");
const afterWorker = await tap("send", workerDraft.actionId);
assert.equal(draftSends.length, 1);
assert.match(afterWorker.join(" "), /already/i);

const raced = await draft("alice@example.com", "Race", "Only one delivery.");
const racedSchedule = schedule({
  draftId: raced.id,
  account: "work",
  to: "alice@example.com",
  subject: "Race",
  body: "Only one delivery.",
  key: "race-delivery",
  remember: false,
});
holdNextMessage = true;
releaseMessageSend = () => undefined;
const messagesBeforeRace = messageSends.length;
const firing = fireScheduledSend(racedSchedule, new Date());
for (let attempt = 0; attempt < 50 && messageSends.length === messagesBeforeRace; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
assert.equal(messageSends.length, messagesBeforeRace + 1);
const duringRace = await tap("send", raced.actionId);
releaseMessageSend();
await firing;
assert.equal(messageSends.length, messagesBeforeRace + 1);
assert.equal(draftSends.filter((item) => item.endsWith(raced.id)).length, 0, duringRace.join(" "));
assert.equal(getScheduledSend(racedSchedule.id)?.status, "sent");

const cancelled = await draft("alice@example.com", "Cancel", "Do not send.");
const cancelledSchedule = schedule({
  draftId: cancelled.id,
  account: "work",
  to: "alice@example.com",
  subject: "Cancel",
  body: "Do not send.",
  key: "cancel-before-send",
  remember: false,
});
const discarded = await tap("discard", cancelled.actionId);
assert.match(discarded.join(" "), /Discarded/);
assert.equal(getScheduledSend(cancelledSchedule.id)?.status, "cancelled");
assert.ok(draftDeletes.includes(cancelled.id));
const sendsBeforeCancelledFire = messageSends.length;
await fireScheduledSend(getScheduledSend(cancelledSchedule.id)!, new Date());
assert.equal(messageSends.length, sendsBeforeCancelledFire);

const uncertain = await draft("alice@example.com", "Uncertain", "May have gone.");
const uncertainSchedule = schedule({
  draftId: uncertain.id,
  account: "work",
  to: "alice@example.com",
  subject: "Uncertain",
  body: "May have gone.",
  key: "uncertain-send",
  remember: false,
});
failNextDraftSend = true;
const lost = await tap("send", uncertain.actionId);
assert.match(lost.join(" "), /won't try again|already being sent/i);
assert.equal(getScheduledSend(uncertainSchedule.id)?.status, "sending");
const sendsAfterLoss = draftSends.length;
await tap("send", uncertain.actionId);
await fireScheduledSend(getScheduledSend(uncertainSchedule.id)!, new Date());
assert.equal(draftSends.length, sendsAfterLoss);
assert.equal(messageSends.length, sendsBeforeCancelledFire);

const work = await draft("rita@acme.example", "Work note", "From work.");
const personal = await draft("rita@acme.example", "Personal note", "From home.", "personal");
const workSchedule = schedule({ draftId: work.id, account: "work", to: "rita@acme.example", subject: "Work note", body: "From work.", key: "work-rita", remember: false });
const personalSchedule = schedule({ draftId: personal.id, account: "personal", to: "rita@acme.example", subject: "Personal note", body: "From home.", key: "personal-rita", remember: false });
await tap("discard", work.actionId);
assert.equal(getScheduledSend(workSchedule.id)?.status, "cancelled");
assert.equal(getScheduledSend(personalSchedule.id)?.status, "scheduled");
assert.equal(drafts.get(personal.id)?.account, "personal");
const keptStart = meeting.start;
await say("Add bob@example.com to yesterday's meeting with Nithish.");
assert.equal(patches.at(-1)?.account, "personal");
assert.equal(patches.at(-1)?.eventId, "evt-personal");
assert.equal(meeting.start, keptStart);

const pendingBeforeRestart = schedule({
  draftId: personal.id,
  account: "personal",
  to: "rita@acme.example",
  subject: "Personal note",
  body: "From home.",
  key: "survives-restart",
  remember: false,
});
assert.equal(getScheduledSend(pendingBeforeRestart.id)?.status, "scheduled");
assert.match(getScheduledSend(pendingBeforeRestart.id)?.request ?? "", /From home/);

saveMessage("user", "Hardik said Pinnacle wants the proposal on Friday.");
const history = retrieveRelevantContext("remember the discussion with Hardik about Pinnacle");
assert.equal(history.kind, "one");
if (history.kind === "one") assert.match(history.summary, /Pinnacle/);
let evidenceCalls = 0;
setContextEvidenceForTests(() => {
  evidenceCalls += 1;
  return [{ source: "gmail:work", text: "should not be searched" }];
});
const listsBefore = calendarLists;
await stageExternalContext("Add a task about reviewing the proposal");
await noteCalendarReference({ chatId: 1, text: "Add a task about reviewing the proposal" });
assert.equal(evidenceCalls, 0);
assert.equal(calendarLists, listsBefore);
await stageExternalContext("remember the discussion with Hardik about Pinnacle");
assert.equal(evidenceCalls, 1);

rememberContactChoice("Hardik", { name: "Hardik", emails: ["hardik@pinnacle.example"], sources: ["known"] });
const expired = new Date(Date.now() - AUTH_TTL_MS - 60_000).toISOString();
savePendingAction(1, {
  action: "send_email",
  status: "open",
  ownerWords: "send the proposal to Hardik",
  authorizedAt: expired,
  confirmChat: 1,
  confirmMessage: 1,
  updatedAt: new Date().toISOString(),
  ownerSupplied: [{ email: "hardik@pinnacle.example", name: "Hardik", messageId: 1, at: expired }],
  email: {
    to: [{ query: "Hardik", name: "Hardik", email: "hardik@pinnacle.example", resolved: true }],
    cc: [],
    notes: [],
    subject: "Proposal",
    account: "work",
    waiting: "confirm",
  },
}, new Date());
assert.equal(authorizationWords(1, "send it", new Date()), "send it");
const hardik = matchOwnerSupplied(1, "Hardik");
assert.equal(hardik.kind === "one" ? hardik.contact.email : "", "hardik@pinnacle.example");

console.log = log;
console.log("workflow boundary checks passed.");
