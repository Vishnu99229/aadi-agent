import { readFile } from "node:fs/promises";
import { runAgent, setToolInterceptorForTests } from "../src/agent.ts";
import {
  discardPendingDraftByText,
  queueDraftApproval,
  resendDraftCard,
  sendPendingDraftByText,
  setApprovalsTestHooks,
} from "../src/approvals.ts";
import { setCompleteForTests } from "../src/llm.ts";
import { modelReply, scriptedModel } from "./fakes.ts";
import {
  createPendingAction,
  getPendingAction,
  getPendingActionForDraft,
  setPendingActionDraftMeta,
  setPendingActionTelegramMessage,
  setPendingActionTimestampsForTests,
  transitionPendingAction,
} from "../src/db.ts";
import {
  fakeGmail,
  fakeTelegramApi,
  nextMessageId,
  type GmailLog,
  type TelegramLog,
} from "./fakes.ts";
import {
  definition as confirmDef,
  handler as confirmHandler,
} from "../src/tools/confirm_send_pending_draft.ts";
import { handler as discardHandler } from "../src/tools/discard_pending_draft.ts";
import { handler as resendHandler } from "../src/tools/resend_draft_card.ts";
import type { ToolTurn } from "../src/tools/index.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const gmail: GmailLog = { sent: [], created: [], deleted: [] };
const cards: TelegramLog = { sent: [], edited: [] };
setApprovalsTestHooks({
  telegram: fakeTelegramApi(cards),
  gmailFor: () => fakeGmail(gmail),
});

const chatId = 1;
const created: number[] = [];

function sqliteHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600_000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
}

function showDraft(
  draftId: string,
  meta: { to: string; cc?: string; subject: string },
): number {
  const action = createPendingAction(draftId, null, "work");
  setPendingActionTelegramMessage(action.id, nextMessageId());
  setPendingActionDraftMeta(action.id, {
    toHeader: meta.to,
    ccHeader: meta.cc ?? "",
    subject: meta.subject,
  });
  created.push(action.id);
  return action.id;
}

function clear(): void {
  for (const id of created) {
    const row = getPendingAction(id);
    if (row?.status === "pending") {
      transitionPendingAction(id, "pending", "discarded");
    }
  }
  created.length = 0;
  gmail.sent.length = 0;
  gmail.deleted?.splice(0);
}

function ownerTurn(messageId: number, extra: Partial<ToolTurn> = {}): ToolTurn {
  return {
    iteration: 1,
    calledTools: ["confirm_send_pending_draft"],
    confirmation: { chatId, messageId },
    ...extra,
  };
}

const aspirare = {
  to: "satyapramod@aspirare.in",
  cc: "ashwini@epicode.in, sendhil@epicode.in",
  subject: "Reminder: Epicode <> Aspirare call today at 11:30 am",
};

// Four pending: named recipient sends only the Aspirare draft.
{
  clear();
  showDraft("sujoy-a", { to: "sujoy@x.com", subject: "One" });
  showDraft("sujoy-b", { to: "sujoy@x.com", subject: "Two" });
  showDraft("ashwini-old", { to: "ashwini@epicode.in", subject: "Hi" });
  const satya = showDraft("satya-draft", aspirare);
  setPendingActionTimestampsForTests(satya, {
    createdAt: sqliteHoursAgo(0.2),
    updatedAt: sqliteHoursAgo(0.1),
  });
  const messageId = nextMessageId();
  const result = await confirmHandler(
    { draft_id: "satya-draft" },
    ownerTurn(messageId),
  );
  assert(gmail.sent.length === 1 && gmail.sent[0] === "satya-draft", "Aspirare draft is the only one sent");
  assert(result.includes("Sent the draft"), "confirm reports sent");
  assert(getPendingAction(satya)!.status === "sent", "Satyapramod row is sent");
}

// "send the latest" / fast path: most recently edited.
{
  clear();
  const first = showDraft("d-old", { to: "a@x.com", subject: "A" });
  const second = showDraft("d-new", { to: "b@x.com", subject: "B" });
  setPendingActionTimestampsForTests(first, {
    createdAt: sqliteHoursAgo(2),
    updatedAt: sqliteHoursAgo(2),
  });
  setPendingActionTimestampsForTests(second, {
    createdAt: sqliteHoursAgo(1.5),
    updatedAt: sqliteHoursAgo(0.2),
  });
  const sent = await sendPendingDraftByText({
    chatId,
    messageId: nextMessageId(),
  });
  assert(sent.ok && gmail.sent.at(-1) === "d-new", "send it picks the most recently edited");
}

// One clearly latest among four: send it.
{
  clear();
  showDraft("p1", { to: "sujoy@x.com", subject: "s1" });
  showDraft("p2", { to: "sujoy@x.com", subject: "s2" });
  showDraft("p3", { to: "ashwini@epicode.in", subject: "s3" });
  const latest = showDraft("p4", aspirare);
  for (const id of created.slice(0, 3)) {
    setPendingActionTimestampsForTests(id, {
      createdAt: sqliteHoursAgo(2),
      updatedAt: sqliteHoursAgo(2),
    });
  }
  setPendingActionTimestampsForTests(latest, {
    createdAt: sqliteHoursAgo(1),
    updatedAt: sqliteHoursAgo(0.05),
  });
  const sent = await sendPendingDraftByText({
    chatId,
    messageId: nextMessageId(),
  });
  assert(sent.ok && gmail.sent.at(-1) === "p4", "one clearly latest sends");
}

// Two equally recent: ask.
{
  clear();
  const left = showDraft("eq-a", { to: "a@x.com", subject: "A" });
  const right = showDraft("eq-b", { to: "b@x.com", subject: "B" });
  const ts = sqliteHoursAgo(0.1);
  setPendingActionTimestampsForTests(left, { createdAt: ts, updatedAt: ts });
  setPendingActionTimestampsForTests(right, { createdAt: ts, updatedAt: ts });
  const asked = await sendPendingDraftByText({
    chatId,
    messageId: nextMessageId(),
  });
  assert(!asked.ok && asked.message.includes("Which one"), "equal recency asks which");
  assert(gmail.sent.filter((id) => id === "eq-a" || id === "eq-b").length === 0, "neither equal draft sent");
}

// Editing in place: same draft_id stays one pending row and becomes latest.
{
  clear();
  const older = showDraft("keep-old", { to: "old@x.com", subject: "Old" });
  await queueDraftApproval({
    draftId: "edit-me",
    threadId: null,
    to: "everyone@epicode.in, satyapramod@aspirare.in",
    subject: aspirare.subject,
    body: "Hi",
    googleAccount: "work",
  });
  const pending = getPendingActionForDraft("edit-me");
  assert(pending !== undefined, "first queue created a pending row");
  created.push(pending!.id);
  setPendingActionTimestampsForTests(older, {
    createdAt: sqliteHoursAgo(1),
    updatedAt: sqliteHoursAgo(1),
  });
  await queueDraftApproval({
    draftId: "edit-me",
    threadId: null,
    to: aspirare.to,
    cc: aspirare.cc,
    subject: aspirare.subject,
    body: "Hi Satyapramod",
    googleAccount: "work",
  });
  assert(
    getPendingActionForDraft("edit-me")!.id === pending!.id,
    "edit refreshes the same pending row",
  );
  assert(
    getPendingActionForDraft("edit-me")!.to_header === aspirare.to,
    "To is updated in place",
  );
  const sent = await sendPendingDraftByText({
    chatId,
    messageId: nextMessageId(),
  });
  assert(sent.ok && gmail.sent.at(-1) === "edit-me", "edited draft is treated as latest");
  assert(getPendingAction(older)!.status === "pending", "pre-edit sibling stays pending");
}

// 3-hour stale drafts do not count.
{
  clear();
  const stale = showDraft("stale", { to: "sujoy@x.com", subject: "Old" });
  const fresh = showDraft("fresh", aspirare);
  setPendingActionTimestampsForTests(stale, {
    createdAt: sqliteHoursAgo(4),
    updatedAt: sqliteHoursAgo(4),
  });
  setPendingActionTimestampsForTests(fresh, {
    createdAt: sqliteHoursAgo(0.2),
    updatedAt: sqliteHoursAgo(0.2),
  });
  const sent = await sendPendingDraftByText({
    chatId,
    messageId: nextMessageId(),
  });
  assert(sent.ok && gmail.sent.at(-1) === "fresh", "stale draft is ignored");
  assert(getPendingAction(stale)!.status === "expired", "untouched 3h draft expires");
}

// discard and resend with valid ids; refuse invalid.
{
  clear();
  showDraft("keep", aspirare);
  const drop = showDraft("drop-me", { to: "sujoy@x.com", subject: "Bye" });
  const confirmation = { chatId, messageId: nextMessageId() };
  const discarded = await discardHandler(
    { draft_id: "drop-me" },
    { iteration: 1, calledTools: ["discard_pending_draft"], confirmation },
  );
  assert(discarded.includes("Discarded"), "discard reports success");
  assert(getPendingAction(drop)!.status === "discarded", "discarded row status");
  assert(gmail.deleted?.includes("drop-me"), "Gmail draft deleted");

  const forgedDiscard = await discardHandler(
    { draft_id: "nope" },
    { iteration: 1, calledTools: ["discard_pending_draft"], confirmation },
  );
  assert(forgedDiscard.startsWith("Not discarded"), "invalid discard id refused");

  const resent = await resendHandler(
    { draft_id: "keep" },
    { iteration: 1, calledTools: ["resend_draft_card"], confirmation },
  );
  assert(resent.includes("Posted a fresh approval card"), "resend posts a card");
  const forgedResend = await resendHandler(
    { draft_id: "nope" },
    { iteration: 1, calledTools: ["resend_draft_card"], confirmation },
  );
  assert(forgedResend.startsWith("Not resent"), "invalid resend id refused");
}

// Forged / same-turn id: no send.
{
  clear();
  const confirmation = { chatId, messageId: nextMessageId() };
  const forged = await confirmHandler(
    { draft_id: "forged" },
    ownerTurn(confirmation.messageId),
  );
  assert(/not in the pending set|No draft is waiting/i.test(forged), "forged id refused");
  assert(gmail.sent.length === 0, "forged id sends nothing");

  const createdThisTurn = createPendingAction("this-turn", null, "work");
  created.push(createdThisTurn.id);
  setPendingActionTelegramMessage(createdThisTurn.id, nextMessageId());
  setPendingActionDraftMeta(createdThisTurn.id, {
    toHeader: "x@y.com",
    ccHeader: "",
    subject: "Nope",
  });
  const tooNew = await confirmHandler(
    { draft_id: "this-turn" },
    ownerTurn(confirmation.messageId),
  );
  assert(
    /not in the pending set|No draft is waiting/i.test(tooNew),
    "draft created this turn cannot be sent",
  );
  assert(getPendingAction(createdThisTurn.id)!.status === "pending", "same-turn draft stays pending");

  const okHeld = await confirmHandler(
    { draft_id: "this-turn" },
    ownerTurn(confirmation.messageId, { userText: "ok" }),
  );
  assert(/ambiguous/i.test(okHeld), '"ok" is refused even with a draft_id');
  assert(gmail.sent.length === 0, '"ok" sends nothing');
}

assert(
  (confirmDef.inputSchema.required ?? []).includes("draft_id"),
  "confirm tool requires draft_id",
);

const systemMd = await readFile(new URL("../prompts/system.md", import.meta.url), "utf8");
assert(
  systemMd.includes("Never claim you did something a tool did not confirm"),
  "honesty rule is in the system prompt",
);
assert(
  systemMd.includes("I can't do that"),
  "honesty rule tells Aadi to say it cannot",
);

{
  const honesty = scriptedModel((text) => {
    if (/flight/i.test(text)) {
      return {
        text: "I can't do that. Closest I can do is set a reminder, or put it on the calendar.",
      };
    }
    return { text: "ok" };
  });
  setCompleteForTests(honesty.fake);
  const called: string[] = [];
  setToolInterceptorForTests((call) => {
    called.push(call.name);
    return "should not run";
  });
  const reply = await runAgent("book me a flight to Delhi tomorrow", {
    saveUserMessage: false,
    saveAssistantMessage: false,
    skipHistory: true,
  });
  assert(/I can't do that/i.test(reply), "no-matching-tool reply says I can't do that");
  assert(/remind|calendar/i.test(reply), "no-matching-tool reply names a closest alternative");
  assert(called.length === 0, "no tool ran for a capability that does not exist");
  setCompleteForTests(undefined);
  setToolInterceptorForTests(undefined);
}

{
  setToolInterceptorForTests(undefined);
  setCompleteForTests(async (params) => {
    if (params.tools.length === 0) {
      return modelReply({ text: '{"facts":[]}' });
    }
    const last = params.messages.at(-1);
    if (last?.role === "tool") {
      assert(
        last.isError === true && /Unknown tool: book_flight/i.test(last.content),
        "hallucinated tool is reported as unknown",
      );
      return modelReply({
        text: "I can't do that. Closest I can do is set a reminder.",
      });
    }
    return modelReply({ tools: [{ name: "book_flight", input: {} }] });
  });
  const reply = await runAgent("book me a flight to Delhi tomorrow", {
    saveUserMessage: false,
    saveAssistantMessage: false,
    skipHistory: true,
  });
  assert(/I can't do that/i.test(reply), "unknown-tool follow-up says I can't do that");
  assert(/remind/i.test(reply), "unknown-tool follow-up names a closest alternative");
  assert(gmail.sent.length === 0, "honesty path sends no draft");
  setCompleteForTests(undefined);
}

console.log("Pending draft checks passed.");
