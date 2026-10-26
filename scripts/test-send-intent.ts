// End-to-end send confirmation through the real bot handlers, with a fake
// Telegram client, fake Gmail and a scripted model. Nothing real is sent.
import { readFile } from "node:fs/promises";
import { setApprovalsTestHooks } from "../src/approvals.ts";
import { setToolInterceptorForTests } from "../src/agent.ts";
import { bot } from "../src/bot.ts";
import {
  claimTelegramMessage,
  createPendingAction,
  getPendingAction,
  listMemories,
  setPendingActionTelegramMessage,
  transitionPendingAction,
} from "../src/db.ts";
import { setCompleteForTests } from "../src/llm.ts";
import { isSendDraftCommand } from "../src/send_triggers.ts";
import {
  fakeGmail,
  fakeTelegramApi,
  nextMessageId,
  scriptedModel,
  type GmailLog,
  type ScriptedStep,
  type TelegramLog,
} from "./fakes.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const SEND_PHRASES = [
  "send it",
  "send that",
  "send the email",
  "go ahead fire it off",
  "haan bhej do",
  "send cheyyu",
];

const gmail: GmailLog = { sent: [], created: [] };
const cards: TelegramLog = { sent: [], edited: [] };
setApprovalsTestHooks({
  telegram: fakeTelegramApi(cards),
  gmailFor: () => fakeGmail(gmail),
});

// Chat replies from the bot itself go through bot.api; record them instead.
const chat: string[] = [];
bot.api.config.use(async (_prev, method, payload) => {
  if (method === "getMe") {
    return {
      ok: true,
      result: { id: 999, is_bot: true, first_name: "Aadi", username: "aadi_test_bot" },
    } as never;
  }
  if (method === "sendMessage") {
    const text = (payload as { text: string }).text;
    chat.push(text);
    return {
      ok: true,
      result: { message_id: nextMessageId(), date: 0, chat: { id: 1, type: "private" }, text },
    } as never;
  }
  return { ok: true, result: true } as never;
});
await bot.init();

// The scripted model stands in for the real one: CI checks the plumbing and
// the guards; `npm run eval:send-intent` checks the real model's judgment.
let background = '{"facts":[]}';
const model = scriptedModel((text): ScriptedStep => {
  if (SEND_PHRASES.includes(text)) {
    return { tools: [{ name: "confirm_send_pending_draft" }] };
  }
  if (text === "change the time to 3pm") {
    return { tools: [{ name: "update_draft", input: { draft_id: "x", body: "3pm" } }] };
  }
  if (text.startsWith("draft an email")) {
    return {
      tools: [
        {
          name: "draft_new_email",
          input: { to: "priya@acme.com", subject: "Demo", body: "Hi Priya,\n\nVishnu" },
        },
      ],
    };
  }
  return { text: "Send it, or want to change something?" };
}, () => background);
setCompleteForTests(model.fake);

// Only confirm_send_pending_draft runs for real (against fake Gmail); other
// tools are answered here so no Google account is touched.
setToolInterceptorForTests((call) => {
  if (call.name === "confirm_send_pending_draft") {
    return undefined;
  }
  if (call.name === "draft_new_email") {
    return "Draft created for priya@acme.com (work). Waiting for your Send tap.";
  }
  return "Draft updated.";
});

const created: number[] = [];

function shownDraft(): number {
  claimTelegramMessage(1, nextMessageId());
  const action = createPendingAction(`draft-${nextMessageId()}`, null, "work");
  setPendingActionTelegramMessage(action.id, nextMessageId());
  created.push(action.id);
  return action.id;
}

function clearPending(): void {
  for (const id of created) {
    transitionPendingAction(id, "pending", "discarded");
  }
}

async function say(text: string): Promise<string[]> {
  const before = chat.length;
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
  return chat.slice(before);
}

// 1. Every phrase sends the pending draft, through the same dispatch as Send.
for (const phrase of SEND_PHRASES) {
  clearPending();
  const id = shownDraft();
  const draftId = getPendingAction(id)!.draft_id!;
  const sentBefore = gmail.sent.length;
  const modelCallsBefore = model.chatCalls();
  const replies = await say(phrase);
  assert(gmail.sent.length === sentBefore + 1, `"${phrase}" sends exactly one draft`);
  assert(gmail.sent.at(-1) === draftId, `"${phrase}" sends the pending draft`);
  assert(getPendingAction(id)!.status === "sent", `"${phrase}" marks the draft sent`);
  assert(replies.some((line) => line.includes("Sent the draft")), `"${phrase}" confirms in chat`);
  if (phrase === "send it") {
    assert(model.chatCalls() === modelCallsBefore, '"send it" takes the fast path');
  }
}

// 2. With no pending draft, nothing sends and Aadi says so.
clearPending();
for (const phrase of SEND_PHRASES) {
  const sentBefore = gmail.sent.length;
  const replies = await say(phrase);
  assert(gmail.sent.length === sentBefore, `"${phrase}" with no draft sends nothing`);
  assert(
    replies.some((line) => line.includes("No draft is waiting")),
    `"${phrase}" with no draft says none is waiting`,
  );
}

// 3. An edit request never sends.
{
  clearPending();
  const id = shownDraft();
  const sentBefore = gmail.sent.length;
  await say("change the time to 3pm");
  assert(gmail.sent.length === sentBefore, "edit request sends nothing");
  assert(getPendingAction(id)!.status === "pending", "edited draft stays pending");
}

// 4. Ambiguous replies ask instead of sending, and miss the fast path.
for (const text of ["ok", "👍"]) {
  clearPending();
  const id = shownDraft();
  const sentBefore = gmail.sent.length;
  assert(!isSendDraftCommand(text), `"${text}" is not the fast path`);
  const replies = await say(text);
  assert(gmail.sent.length === sentBefore, `"${text}" sends nothing`);
  assert(getPendingAction(id)!.status === "pending", `"${text}" leaves the draft pending`);
  assert(
    replies.includes("Send it, or want to change something?"),
    `"${text}" asks what to do`,
  );
}

// 5. Voice notes take the same path: the transcript goes to handleUserText,
// and the voice handler has no send logic of its own.
{
  const botSrc = await readFile(new URL("../src/bot.ts", import.meta.url), "utf8");
  const voiceStart = botSrc.indexOf('bot.on("message:voice"');
  const voiceEnd = botSrc.indexOf("async function answerDocumentCaption");
  const voiceHandler = botSrc.slice(voiceStart, voiceEnd);
  assert(voiceStart >= 0 && voiceEnd > voiceStart, "voice handler found");
  assert(
    voiceHandler.includes("handleUserText(ctx, ctx.from.id, transcript)"),
    "voice transcript goes through handleUserText",
  );
  assert(
    !/sendPendingDraftByText|isSendDraftCommand|confirm_send/.test(voiceHandler),
    "voice handler has no separate send path",
  );
}

// 6. Creating a draft sends exactly one chat confirmation; memory stays silent
// even when the extractor returns a fact.
{
  clearPending();
  background = JSON.stringify({
    facts: [
      {
        content: "Aadi plans to email Priya about the demo",
        category: "plan",
        tag: "work",
        event_date: null,
        weight: "important",
        update_of_id: null,
      },
    ],
  });
  const memoriesBefore = listMemories().length;
  const replies = await say("draft an email to priya@acme.com about the demo");
  background = '{"facts":[]}';
  assert(replies.length === 1, `draft request sends exactly one chat message (got ${replies.length})`);
  assert(replies[0]!.startsWith("Draft created"), "that message is the draft confirmation");
  assert(
    !chat.some((line) => /^(Updated|Noted):/.test(line)),
    "no memory confirmation line ever reaches chat",
  );
  assert(listMemories().length === memoriesBefore + 1, "the memory was still saved, silently");
}

setCompleteForTests(undefined);
setToolInterceptorForTests(undefined);
console.log("Send intent checks passed.");
process.exit(0);
