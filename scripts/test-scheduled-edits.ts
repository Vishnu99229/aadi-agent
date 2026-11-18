// Scheduled emails follow every approved edit, and the worker never sends a stale copy.
// Fake Gmail, fake Telegram, stub models, an in-memory database. Nothing real is sent.
import type { Api } from "grammy";
import type { gmail_v1 } from "googleapis";
import { applyOwnerContextTurn, getPendingAction } from "../src/action_context.ts";
import { setApprovalsTestHooks } from "../src/approvals.ts";
import { sendEmailFromTool, setCommandEmailTestHooks } from "../src/command_email.ts";
import { reviseLinkedDraft } from "../src/context_draft.ts";
import {
  createScheduledSend,
  getScheduledSend,
  getTask,
  listOpenScheduledSends,
  type ScheduledSendRecord,
} from "../src/db.ts";
import { setGoogleAccountForTests, type LoadedGoogleAccount } from "../src/google/auth.ts";
import { setGmailClientForTests } from "../src/google/mail.ts";
import { setCompleteForTests, setRouteModelCompleteForTests, type CompleteParams, type CompleteResult } from "../src/llm.ts";
import { setAgentModelSetting } from "../src/models/agent_models.ts";
import { runScheduledSendTick } from "../src/scheduled_sends.ts";
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
}
const sends: SentMail[] = [];
const drafts = new Map<string, { to: string; cc: string; subject: string; body: string }>();
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

function storeDraft(id: string, raw: string): void {
  drafts.set(id, {
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

const gmail = {
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
        });
        return { data: { id: `sent-${sends.length}` } };
      },
    },
    threads: {
      get: async () => {
        throw Object.assign(new Error("not found"), { response: { status: 404 }, code: 404 });
      },
    },
    drafts: {
      create: async ({ requestBody }: { requestBody: { message: { raw: string } } }) => {
        draftCounter += 1;
        const id = `draft-${draftCounter}`;
        storeDraft(id, Buffer.from(requestBody.message.raw, "base64url").toString("utf8"));
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
        storeDraft(id, Buffer.from(requestBody.message.raw, "base64url").toString("utf8"));
        return { data: { id, message: { id, threadId: `thread-${id}` } } };
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

/** Runs on the first Google account lookup of a fire, after the worker has read its row. */
let duringPrepare: (() => void) | undefined;
const workAccount = { id: "work", tag: "work", label: "work", client: {} } as unknown as LoadedGoogleAccount;
setGoogleAccountForTests(() => {
  if (duringPrepare) {
    const hook = duringPrepare;
    duringPrepare = undefined;
    hook();
  }
  return workAccount;
});
setGmailClientForTests(() => gmail);

const told: string[] = [];
const telegram = {
  sendMessage: async (_chat: unknown, text: string) => {
    told.push(text);
    return { message_id: 900 + told.length, date: 0, chat: { id: 1, type: "private" }, text };
  },
  editMessageText: async (_chat: unknown, _id: unknown, text: string) => {
    told.push(text);
    return true;
  },
} as unknown as Api;
setCommandEmailTestHooks({ telegram });
setApprovalsTestHooks({ telegram, gmailFor: () => gmail });

// ---- models: the Email Agent rewrites, the Command writer writes at send time ----
setAgentModelSetting("email", { primary: "anthropic:haiku", fallbacks: [] });
function emailAgentReply(params: Pick<CompleteParams, "messages">): CompleteResult {
  const facts = params.messages.map((message) => (typeof message.content === "string" ? message.content : "")).join("\n");
  const friday = /friday/i.test(facts) ? " The proposal will be shared Friday." : "";
  return modelReply({ text: JSON.stringify({ subject: "Agent subject", body: `Hi,\n\nHere is where the proposal stands.${friday}` }) });
}
setRouteModelCompleteForTests(async (_spec, params) => emailAgentReply(params));
const writerCalls: CompleteParams[] = [];
/** Runs while the Command writer is composing a copy at send time. */
let duringWrite: (() => void) | undefined;
setCompleteForTests(async (params: CompleteParams): Promise<CompleteResult> => {
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
});

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
});
const say = (chatId: number, text: string) => applyOwnerContextTurn(chatId, text, ++messageId);
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
    { to: [address], instruction: "send the proposal note", send_on: SEND_DAY, send_time: "10:00", subject },
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
  await fire();
  assert(sends.length === before + 1, "one email goes out");
  const sent = sends.at(-1)!;
  assert(sent.to.includes("carol@example.com") && !sent.to.includes("bob@example.com"), `only to Carol, got ${sent.to}`);
  assert(sent.cc.includes("dave@example.com"), "Cc Dave");
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
  const { transitionScheduledSend } = await import("../src/db.ts");
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

console.log = log;
console.log("scheduled edit checks passed.");
