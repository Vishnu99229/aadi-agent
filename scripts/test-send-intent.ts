// End-to-end send confirmation through the real bot handlers, with a fake
// Telegram client, fake Gmail and a scripted model. Nothing real is sent.
import { setApprovalsTestHooks } from "../src/approvals.ts";
import { bot } from "../src/bot.ts";
import {
  createPendingAction,
  getPendingAction,
  setPendingActionDraftMeta,
  setPendingActionTelegramMessage,
  recordCardRecipients,
  transitionPendingAction,
} from "../src/db.ts";
import { config } from "../src/config.ts";
import { setCompleteForTests } from "../src/llm.ts";
import {
  fakeGmail,
  fakeTelegramApi,
  nextMessageId,
  modelReply,
  type FakeDraftMeta,
  type GmailLog,
  type TelegramLog,
} from "./fakes.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const gmail: GmailLog = { sent: [], created: [] };
const cards: TelegramLog = { sent: [], edited: [] };
const providerDrafts: Record<string, FakeDraftMeta> = {};
setApprovalsTestHooks({
  telegram: fakeTelegramApi(cards),
  gmailFor: () => fakeGmail(gmail, providerDrafts),
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
      result: { message_id: nextMessageId(), date: 0, chat: { id: config.ownerTelegramId, type: "private" }, text },
    } as never;
  }
  return { ok: true, result: true } as never;
});
await bot.init();

let selectedByModel: string | undefined;
let inspectContext: (context: string) => void = () => undefined;
let modelCalls = 0;
setCompleteForTests(async params => {
  if (!params.tools.length) return modelReply({ text: '{"facts":[]}' });
  if (params.messages.at(-1)?.role === "tool") return modelReply({ text: "I checked the draft." });
  modelCalls += 1;
  inspectContext(JSON.stringify(params.system));
  return selectedByModel
    ? modelReply({ tools: [{ name: "confirm_send_pending_draft", input: { draft_id: selectedByModel } }] })
    : modelReply({ text: "There is no draft waiting." });
});

function shownDraft(to: string) {
  const draftId = `draft-${nextMessageId()}`;
  const action = createPendingAction(draftId, null, "work");
  const cardMessage = nextMessageId();
  providerDrafts[draftId] = { to };
  setPendingActionTelegramMessage(action.id, cardMessage);
  setPendingActionDraftMeta(action.id, { toHeader: to, ccHeader: "", subject: "Demo" });
  recordCardRecipients(cardMessage, draftId, to);
  return { actionId: action.id, draftId, cardMessage };
}

async function sayYes(replyTo?: number, chatId = config.ownerTelegramId): Promise<void> {
  const messageId = nextMessageId();
  const date = Math.floor(Date.now() / 1000);
  const telegramChat = { id: chatId, type: "private", first_name: "Vishnu" };
  await bot.handleUpdate({
    update_id: messageId,
    message: {
      message_id: messageId, date, chat: telegramChat, text: "yes",
      from: { id: config.ownerTelegramId, is_bot: false, first_name: "Vishnu" },
      ...(replyTo === undefined ? {} : {
        reply_to_message: {
          message_id: replyTo, date, chat: telegramChat, text: "Email preview",
          from: { id: 999, is_bot: true, first_name: "Aadi" },
        },
      }),
    },
  } as never);
}

const older = shownDraft("Priya <priya@acme.com>");
const newer = shownDraft("Lee <lee@beta.example>");
inspectContext = context => {
  assert(context.includes(`replies to the Send card for draft_id=${older.draftId}`), "the model sees the replied card");
  assert(context.includes(newer.draftId), "the model sees the other live card");
};
selectedByModel = newer.draftId;
await sayYes(older.cardMessage);
assert(gmail.sent.length === 0, "the handler rejects the other draft even if the model picks it");

selectedByModel = older.draftId;
await sayYes(older.cardMessage);
assert(gmail.sent.join() === older.draftId, "yes sends only the replied card's draft");
assert(getPendingAction(older.actionId)?.status === "sent", "delivery is recorded");
assert(getPendingAction(newer.actionId)?.status === "pending", "the other card stays pending");

inspectContext = context => assert(!context.includes(newer.draftId), "an unrelated chat does not see this chat's draft");
selectedByModel = newer.draftId;
await sayYes(newer.cardMessage, config.ownerTelegramId + 1);
assert(gmail.sent.join() === older.draftId, "the same card message ID in a different chat authorizes nothing");

transitionPendingAction(newer.actionId, "pending", "discarded");
inspectContext = context => assert(context.includes("No email draft is waiting"), "there is no live card in the model context");
const before = modelCalls;
await sayYes();
assert(modelCalls > before, "the affirmation reaches the model");
assert(gmail.sent.join() === older.draftId, "yes with no live card sends nothing even if the model supplies a closed ID");

setCompleteForTests(undefined);
console.log("Send confirmation checks passed.");
process.exit(0);
