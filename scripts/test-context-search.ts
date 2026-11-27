// Gmail is searched for context only when a message asks about the past. Cancellations,
// meeting-time answers, task updates and draft edits make no Gmail search at all.
// Real bot handlers, fake Telegram, fake Gmail (every call counted), scripted model.
import type { gmail_v1 } from "googleapis";
import { clearPendingAction, getPendingAction, savePendingAction } from "../src/action_context.ts";
import { setApprovalsTestHooks } from "../src/approvals.ts";
import { bot } from "../src/bot.ts";
import { wantsHistoricalContext } from "../src/context_lookup.ts";
import { createScheduledSend, createTask, getScheduledSend, getTask } from "../src/db.ts";
import { setGoogleAccountForTests, type LoadedGoogleAccount } from "../src/google/auth.ts";
import { setGmailClientForTests } from "../src/google/mail.ts";
import { setCompleteForTests, type CompleteParams, type CompleteResult } from "../src/llm.ts";
import { setOwnerMeetingTestHooks } from "../src/owner_meeting.ts";
import { handler as draftNewEmail } from "../src/tools/draft_new_email.ts";
import { fakeTelegramApi, modelReply, nextMessageId } from "./fakes.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

if (process.env.AADI_DB_PATH !== ":memory:") {
  throw new Error("test-context-search.ts must run with AADI_DB_PATH=:memory:");
}

const log = console.log;
console.log = () => undefined;
console.error = () => undefined;
console.warn = () => undefined;

// ---- fake Gmail, one per mailbox, recording every call ----
const calls: string[] = [];
const searchQueries: Array<{ account: string; q: string }> = [];
let gmailDown = false;
const drafts = new Map<string, { to: string; subject: string; body: string }>();
let counter = 0;
const SEARCH = /:(?:messages\.list|messages\.get|threads\.get|threads\.list)$/;

function decode(rawBase64: string): { to: string; subject: string; body: string } {
  const raw = Buffer.from(rawBase64, "base64url").toString("utf8");
  const header = (name: string) => new RegExp(`^${name}: (.*)$`, "im").exec(raw.split(/\r?\n\r?\n/)[0] ?? "")?.[1]?.trim() ?? "";
  const encoded = /Content-Transfer-Encoding: base64\r?\n\r?\n([A-Za-z0-9+/=\r\n]+)/.exec(raw)?.[1];
  const body = encoded ? Buffer.from(encoded.replace(/\s/g, ""), "base64").toString("utf8").trim() : "";
  return { to: header("To"), subject: header("Subject"), body };
}

function mailbox(account: "work" | "personal"): gmail_v1.Gmail {
  const note = (method: string) => calls.push(`${account}:${method}`);
  const mail: Record<string, { subject: string; from: string; snippet: string }> = {
    "hardik-1": { subject: "Pinnacle reseller panel", from: "Hardik Singh <hardik@pinnacle.example>", snippet: "Reseller panel, consumption tracking and reporting." },
    "kyc-1": { subject: "KYC flows", from: "Raghavendra KV <raghavendra.kv@tenxpipe.com>", snippet: "Automated KYC for the dialer." },
  };
  return {
    users: {
      getProfile: async () => {
        note("getProfile");
        return { data: { emailAddress: "vishnu.rajan@epicode.in" } };
      },
      settings: {
        sendAs: {
          list: async () => {
            note("sendAs.list");
            return { data: { sendAs: [{ sendAsEmail: "vishnu.rajan@epicode.in", isDefault: true, signature: "" }] } };
          },
        },
      },
      messages: {
        list: async ({ q }: { q: string }) => {
          note("messages.list");
          searchQueries.push({ account, q });
          if (gmailDown) {
            throw new Error("gmail unavailable");
          }
          const ids = account === "work"
            ? Object.keys(mail).filter((id) => q.toLowerCase().split(/\s+/).some((word) => id.startsWith(word.replace(/[^a-z]/g, "")) && word.length >= 3))
            : [];
          return { data: { messages: ids.map((id) => ({ id, threadId: id })) } };
        },
        get: async ({ id }: { id: string }) => {
          note("messages.get");
          const item = mail[id]!;
          return {
            data: {
              id,
              threadId: id,
              snippet: item.snippet,
              labelIds: ["INBOX"],
              payload: { headers: [{ name: "Subject", value: item.subject }, { name: "From", value: item.from }] },
            },
          };
        },
        send: async () => {
          note("messages.send");
          throw new Error("nothing is sent in this test");
        },
      },
      threads: {
        get: async () => {
          note("threads.get");
          throw Object.assign(new Error("not found"), { code: 404 });
        },
      },
      drafts: {
        create: async ({ requestBody }: { requestBody: { message: { raw: string } } }) => {
          note("drafts.create");
          counter += 1;
          const id = `draft-${counter}`;
          drafts.set(id, decode(requestBody.message.raw));
          return { data: { id, message: { id, threadId: `thread-${id}` } } };
        },
        get: async ({ id }: { id: string }) => {
          note("drafts.get");
          const draft = drafts.get(id)!;
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
          note("drafts.update");
          drafts.set(id, decode(requestBody.message.raw));
          return { data: { id, message: { id, threadId: `thread-${id}` } } };
        },
        delete: async ({ id }: { id: string }) => {
          note("drafts.delete");
          drafts.delete(id);
          return { data: {} };
        },
      },
    },
  } as unknown as gmail_v1.Gmail;
}
const work = mailbox("work");
const personal = mailbox("personal");
const workAccount = { id: "work", tag: "work", label: "work", client: {} } as unknown as LoadedGoogleAccount;
const personalAccount = { id: "personal", tag: "personal", label: "personal", client: {} } as unknown as LoadedGoogleAccount;
setGoogleAccountForTests((id) => (id === "personal" ? personalAccount : workAccount));
setGmailClientForTests((account) => (account.id === "personal" ? personal : work));
setApprovalsTestHooks({ telegram: fakeTelegramApi({ sent: [], edited: [] }), gmailFor: (account) => (account === "personal" ? personal : work) });

let booked = 0;
setOwnerMeetingTestHooks({
  loadBusy: async () => [],
  insertCommand: async () => {
    booked += 1;
    return { id: `event-${booked}`, hangoutLink: "https://meet.example/x" };
  },
});

// ---- the bot's own replies ----
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

const getChatEmail = () => getPendingAction(1)?.email;
const getChatStatus = () => getPendingAction(1)?.status;

// ---- scripted model ----
let taskId = 0;
/** Prompts that carried found history to the model. */
const prompts: string[] = [];
setCompleteForTests(async (params: CompleteParams): Promise<CompleteResult> => {
  if (params.jsonSchema) {
    const facts = params.messages.map((message) => (typeof message.content === "string" ? message.content : "")).join("\n");
    const body = /Current body:\n([\s\S]*?)\n\nVishnu's correction/.exec(facts)?.[1]?.split("\n").slice(0, -1).join("\n") ?? "Hi,";
    return modelReply({ text: JSON.stringify({ subject: "Plan", body }) });
  }
  if (params.tools.length === 0) {
    return modelReply({ text: '{"facts":[]}' });
  }
  if (params.messages.at(-1)?.role === "tool") {
    return modelReply({ text: "Done." });
  }
  // Decide from his latest message, as a model would, not from older turns in the history.
  const asked =
    [...params.messages]
      .reverse()
      .find((message) => message.role === "user" && typeof message.content === "string" && !message.content.startsWith("Vishnu's message looks like a command"))
      ?.content as string | undefined ?? "";
  if (asked.includes("Cancel tomorrow's email to Raghavendra")) {
    return modelReply({ tools: [{ name: "cancel_scheduled_send", input: { target: "Raghavendra" } }] });
  }
  if (asked.includes("Mark the KYC follow-up task done")) {
    return modelReply({ tools: [{ name: "complete_task", input: { id: taskId } }] });
  }
  const history = /<history>\n([\s\S]*?)\n<\/history>/.exec(asked)?.[1];
  if (asked.includes("Remember my discussion with Hardik") && history) {
    prompts.push(asked);
    return modelReply({ text: `From what I found: ${history}` });
  }
  if (asked.includes("Find my earlier email about KYC with Raghavendra")) {
    return modelReply({ tools: [{ name: "search_emails", input: { query: "kyc raghavendra", account: "work" } }] });
  }
  return modelReply({ text: "Okay." });
});

async function say(text: string): Promise<string[]> {
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
  await new Promise((resolve) => setTimeout(resolve, 30));
  return replies.slice(before);
}

function scheduleToRaghavendra(key: string): number {
  const sendAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const row = createScheduledSend({
    key,
    sendAt,
    itemText: "Send email to Raghavendra — Proposal — tomorrow 10:00",
    tag: "work",
    request: JSON.stringify({
      to: [{ query: "Raghavendra", mailbox: { email: "raghavendra.kv@tenxpipe.com", name: "Raghavendra KV" } }],
      cc: [],
      threadId: null,
      instruction: "Send the proposal.",
      ownWords: "send Raghavendra the proposal tomorrow",
      account: "work",
      subject: "Proposal",
    }),
    confirmChat: 1,
    confirmMessage: 1,
  });
  return row!.id;
}

// 0. The intent check itself.
assert(wantsHistoricalContext("Remember my discussion with Hardik about Pinnacle?"), "a memory question searches");
assert(wantsHistoricalContext("Draft a follow-up based on what happened with Acme"), "a follow-up from history searches");
for (const local of [
  "Cancel tomorrow's email to Raghavendra",
  "Cancel the follow-up email to Hardik",
  "Mark the KYC follow-up task done",
  "Make that draft shorter",
  "3pm tomorrow",
  "Find my earlier email about KYC with Raghavendra",
]) {
  assert(!wantsHistoricalContext(local), `"${local}" needs no Gmail context search`);
}

// 1. A cancellation checks local scheduled sends only.
{
  const id = scheduleToRaghavendra("cancel-1");
  const from = calls.length;
  await say("Cancel tomorrow's email to Raghavendra");
  assert(getScheduledSend(id)!.status === "cancelled", "the scheduled email is cancelled");
  assert(calls.length === from, `no Gmail call at all, got ${calls.slice(from).join(", ")}`);
}

// 2. A task update stays local, even when the task is a follow-up: it completes the task
//    and is not read as a request to start a follow-up sequence.
{
  taskId = createTask("Send the KYC follow-up checklist", "work").id;
  const from = calls.length;
  const said = await say("Mark the KYC follow-up task done");
  assert(getTask(taskId)!.status === "done", `the task is done, got ${said.join(" | ")}`);
  assert(!said.some((text) => /sequence/i.test(text)), `nothing about a sequence, got ${said.join(" | ")}`);
  assert(calls.length === from, `no Gmail call at all, got ${calls.slice(from).join(", ")}`);
}

// 3. A meeting-time answer books from the pending meeting.
{
  savePendingAction(1, {
    action: "create_meeting",
    status: "open",
    ownerWords: "Book a meeting with raghavendra.kv@tenxpipe.com",
    confirmChat: 1,
    confirmMessage: 1,
    updatedAt: new Date().toISOString(),
    meeting: {
      title: "KYC walkthrough",
      calendar: "work",
      waiting: "time",
      resolutionAttempts: {},
      attendees: [{ query: "raghavendra.kv@tenxpipe.com", name: "Raghavendra", email: "raghavendra.kv@tenxpipe.com", resolved: true }],
    },
  });
  const from = calls.length;
  const said = await say("3pm tomorrow");
  assert(booked === 1, `the meeting is booked, got ${said.join(" | ")}`);
  // Only the booking safeguard's own-address check (never invite himself) touches Gmail.
  const made = calls.slice(from);
  assert(made.every((call) => /:(?:getProfile|sendAs\.list)$/.test(call)), `no Gmail search, got ${made.join(", ")}`);
}

// 4. A draft edit reads and writes only that draft.
{
  clearPendingAction(1);
  await draftNewEmail(
    { to: "raghavendra.kv@tenxpipe.com", subject: "Plan", body: "Hi,\n\nThe plan.\nThe KYC steps.\nA closing line." },
    { iteration: 1, calledTools: [], userText: "Draft an email to raghavendra.kv@tenxpipe.com", confirmation: { chatId: 1, messageId: nextMessageId() } },
  );
  const from = calls.length;
  await say("Make that draft shorter");
  const made = calls.slice(from);
  assert(made.includes("work:drafts.update"), `the draft is revised, got ${made.join(", ")}`);
  assert(!made.some((call) => SEARCH.test(call)), `but nothing is searched, got ${made.join(", ")}`);
  assert(drafts.get(`draft-${counter}`)!.body.startsWith("Hi,\n\nThe plan.\nThe KYC steps."), "from the draft itself");
}

// 5. A question about the past searches both mailboxes, within the existing limits.
{
  clearPendingAction(1);
  const from = searchQueries.length;
  const said = await say("Remember my discussion with Hardik about Pinnacle?");
  const searched = searchQueries.slice(from);
  assert(searched.some((item) => item.account === "work") && searched.some((item) => item.account === "personal"), `both mailboxes are searched, got ${JSON.stringify(searched)}`);
  assert(searched.every((item) => /hardik/i.test(item.q) && /pinnacle/i.test(item.q)), "for the words he used");
  assert(prompts.length === 1 && /<history>[\s\S]*Pinnacle reseller panel[\s\S]*<\/history>/.test(prompts[0]!), "the model is given what was found, marked as data");
  assert(said.some((text) => /Pinnacle reseller panel/.test(text)), `and answers from it, got ${said.join(" | ")}`);
  assert(!said.some((text) => /remembered or forgotten/.test(text)), "a recall question is not treated as a memory to save");
}

// 6. Naming a mailbox searches only that one.
{
  clearPendingAction(1);
  const from = searchQueries.length;
  await say("Remember my discussion with Hardik in my personal email?");
  const searched = searchQueries.slice(from);
  assert(searched.length > 0 && searched.every((item) => item.account === "personal"), `only the personal mailbox, got ${JSON.stringify(searched)}`);
}

// 7. "Find my earlier email" is the search tool's job, on the mailbox it names, with no extra context search.
{
  clearPendingAction(1);
  const from = searchQueries.length;
  const said = await say("Find my earlier email about KYC with Raghavendra");
  const searched = searchQueries.slice(from);
  assert(searched.length === 1 && searched[0]!.account === "work" && /kyc/i.test(searched[0]!.q), `one search on the work mailbox, got ${JSON.stringify(searched)}`);
  assert(said.length > 0, "and he gets an answer");
}

// 8. When Gmail fails, the question still gets an answer and local commands still work.
{
  clearPendingAction(1);
  gmailDown = true;
  const said = await say("Remember my discussion with Hardik about Pinnacle?");
  assert(said.length > 0, "he still gets a reply");
  const id = scheduleToRaghavendra("cancel-2");
  const from = calls.length;
  const cancelled = await say("Cancel tomorrow's email to Raghavendra");
  assert(getScheduledSend(id)!.status === "cancelled", `a cancellation still works, got ${cancelled.join(" | ")}`);
  assert(calls.length === from, "without touching Gmail");
  gmailDown = false;
}

// 9. With a draft to Raghavendra open, "cancel tomorrow's email to Raghavendra" means the
//    scheduled one. The open draft is a different email and is left alone; a cancel naming
//    someone else leaves it too; "cancel that email" is the one that cancels it.
{
  clearPendingAction(1);
  await draftNewEmail(
    { to: "raghavendra.kv@tenxpipe.com", subject: "Notes", body: "Hi,\n\nMeeting notes." },
    { iteration: 1, calledTools: [], userText: "Draft an email to raghavendra.kv@tenxpipe.com", confirmation: { chatId: 1, messageId: nextMessageId() } },
  );
  const draftId = `draft-${counter}`;
  const id = scheduleToRaghavendra("cancel-3");
  const from = calls.length;
  await say("Cancel tomorrow's email to Raghavendra");
  assert(getScheduledSend(id)!.status === "cancelled", "the scheduled email is the one cancelled");
  assert(drafts.has(draftId) && getChatEmail()?.draftId === draftId && getChatStatus() === "open", "the open draft is a different email, and stays");
  assert(calls.length === from, "with no Gmail call");

  await say("Cancel the email to Bob");
  assert(drafts.has(draftId) && getChatStatus() === "open", "a cancel naming someone else leaves Raghavendra's draft alone");

  const said = await say("Cancel that email");
  assert(said.some((text) => /Cancelled that email/.test(text)), `"that email" is the open draft, got ${said.join(" | ")}`);
  assert(!drafts.has(draftId) && getChatStatus() === "cancelled" && !getChatEmail(), "cancellation closes the chat's draft link");
}

// 10. A finished email is not the open one: "cancel that email" can't delete its draft.
{
  clearPendingAction(1);
  await draftNewEmail(
    { to: "raghavendra.kv@tenxpipe.com", subject: "Done", body: "Hi,\n\nAll set." },
    { iteration: 1, calledTools: [], userText: "Draft an email to raghavendra.kv@tenxpipe.com", confirmation: { chatId: 1, messageId: nextMessageId() } },
  );
  const draftId = `draft-${counter}`;
  savePendingAction(1, { ...getPendingAction(1)!, status: "done" });
  const said = await say("Cancel that email");
  assert(drafts.has(draftId), "the finished email's draft is not deleted");
  assert(!said.some((text) => /Cancelled that email/.test(text)), `and nothing claims it was cancelled, got ${said.join(" | ")}`);
}

console.log = log;
console.log("context search checks passed.");
