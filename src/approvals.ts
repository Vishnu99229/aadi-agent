import { Api, InlineKeyboard, type Context } from "grammy";
import { google, type gmail_v1 } from "googleapis";
import { config } from "./config.js";
import {
  createPendingAction,
  getExpiredPendingActions,
  getPendingAction,
  getPendingActionForDraft,
  setPendingActionTelegramMessage,
  transitionPendingAction,
  type PendingAction,
} from "./db.js";
import { getGoogleClientFor } from "./google/auth.js";
import { allowSendDraft } from "./security/send_approval.js";
import { parseAddressList } from "./followup_logic.js";

const PREVIEW_LIMIT = 3800;
const EXPIRY_SWEEP_MS = 60 * 60 * 1000;

const telegram = new Api(config.telegramBotToken);
const activeActions = new Set<number>();
const editingActionByUser = new Map<number, number>();
const sendOnlyActions = new Set<number>();

type AfterDraftSend = (
  draftId: string,
  sentMessageId: string,
) => Promise<void>;
let afterDraftSend: AfterDraftSend | undefined;

export function setAfterDraftSend(handler: AfterDraftSend): void {
  afterDraftSend = handler;
}

export interface DraftApprovalPreview {
  draftId: string;
  threadId: string;
  to: string;
  subject: string;
  body: string;
  googleAccount: "personal" | "work";
  extraLines?: string[];
}

export interface DraftEditContext {
  actionId: number;
  draftId: string;
  body: string;
}

function keyboard(actionId: number, sendOnly = false): InlineKeyboard {
  if (sendOnly) {
    return new InlineKeyboard()
      .text("Send", `approval:send:${actionId}`)
      .row()
      .text("Cancel", `approval:discard:${actionId}`);
  }
  return new InlineKeyboard()
    .text("Send", `approval:send:${actionId}`)
    .text("Edit", `approval:edit:${actionId}`)
    .text("Discard", `approval:discard:${actionId}`);
}

function truncate(text: string, limit: number): string {
  const characters = Array.from(text);
  return characters.length <= limit
    ? text
    : `${characters.slice(0, limit).join("")}\n[preview truncated]`;
}

function previewText(preview: DraftApprovalPreview): string {
  const mailbox =
    preview.googleAccount === "work" ? "work (Epicode)" : "personal (Gmail)";
  const extra = (preview.extraLines ?? []).filter((line) => line.trim());
  const prefix = [
    "Draft waiting for approval",
    "",
    `Account: ${mailbox}`,
    `To: ${preview.to}`,
    `Subject: ${preview.subject}`,
    ...(extra.length ? ["", ...extra] : []),
    "",
  ].join("\n");

  return `${prefix}${truncate(preview.body, PREVIEW_LIMIT - prefix.length)}`;
}

function createdAtMs(action: PendingAction): number {
  return new Date(`${action.created_at.replace(" ", "T")}Z`).getTime();
}

function isExpired(action: PendingAction): boolean {
  return Date.now() - createdAtMs(action) >= 24 * 60 * 60 * 1000;
}

function callbackMessageText(ctx: Context): string {
  const message = ctx.callbackQuery?.message;
  return message && "text" in message
    ? (message.text ?? "Draft approval")
    : "Draft approval";
}

async function showStatus(
  ctx: Context,
  status: "Sent" | "Discarded" | "Expired",
): Promise<void> {
  await ctx.editMessageText(`${callbackMessageText(ctx)}\n\nStatus: ${status}`, {
    reply_markup: new InlineKeyboard(),
  });
}

async function expireAction(action: PendingAction): Promise<boolean> {
  if (
    action.status !== "pending" ||
    !transitionPendingAction(action.id, "pending", "expired")
  ) {
    return false;
  }

  editingActionByUser.forEach((actionId, userId) => {
    if (actionId === action.id) {
      editingActionByUser.delete(userId);
    }
  });
  console.log(`Approval action ${action.id}: status -> expired`);

  if (action.telegram_message_id) {
    try {
      await telegram.editMessageText(
        config.ownerTelegramId,
        action.telegram_message_id,
        "Draft approval expired.",
        { reply_markup: new InlineKeyboard() },
      );
    } catch {
      console.log(`Approval action ${action.id}: expiry preview update failed`);
    }
  }

  return true;
}

export async function queueDraftApproval(
  preview: DraftApprovalPreview,
  options: { sendOnly?: boolean } = {},
): Promise<number> {
  let action = getPendingActionForDraft(preview.draftId);

  if (action && isExpired(action)) {
    await expireAction(action);
    action = undefined;
  }

  if (!action) {
    action = createPendingAction(
      preview.draftId,
      preview.threadId,
      preview.googleAccount,
    );
  }

  const text = previewText(preview);
  if (options.sendOnly) {
    sendOnlyActions.add(action.id);
  } else {
    sendOnlyActions.delete(action.id);
  }
  const markup = keyboard(action.id, sendOnlyActions.has(action.id));
  if (action.telegram_message_id) {
    try {
      await telegram.editMessageText(
        config.ownerTelegramId,
        action.telegram_message_id,
        text,
        { reply_markup: markup },
      );
      console.log(`Approval action ${action.id}: preview updated`);
      return action.id;
    } catch {
      console.log(`Approval action ${action.id}: preview replacement failed`);
    }
  }

  const message = await telegram.sendMessage(config.ownerTelegramId, text, {
    reply_markup: markup,
  });
  setPendingActionTelegramMessage(action.id, message.message_id);
  console.log(`Approval action ${action.id}: preview sent`);
  return action.id;
}

async function currentPendingAction(
  ctx: Context,
  actionId: number,
): Promise<PendingAction | undefined> {
  const action = getPendingAction(actionId);

  if (!action) {
    await ctx.answerCallbackQuery({
      text: "This approval no longer exists.",
      show_alert: true,
    });
    return undefined;
  }

  if (action.status === "pending" && isExpired(action)) {
    await expireAction(action);
    await showStatus(ctx, "Expired").catch(() => undefined);
    await ctx.answerCallbackQuery("Expired");
    return undefined;
  }

  if (action.status !== "pending") {
    const status =
      action.status === "sent"
        ? "Sent"
        : action.status === "discarded"
          ? "Discarded"
          : "Expired";
    await showStatus(ctx, status).catch(() => undefined);
    await ctx.answerCallbackQuery(`Already ${status.toLowerCase()}.`);
    return undefined;
  }

  return action;
}

type SendOutcome =
  | { ok: true }
  | { ok: false; reason: "send_failed" | "status_update_failed" };

async function performDraftSend(action: PendingAction): Promise<SendOutcome> {
  let sentMessageId: string | undefined;
  try {
    const auth = await getGoogleClientFor(action.google_account);
    const gmail = google.gmail({ version: "v1", auth });
    const sent = await gmail.users.drafts.send({
      userId: "me",
      requestBody: { id: action.draft_id },
    });
    sentMessageId = sent.data.id ?? undefined;
  } catch {
    console.log(`Approval action ${action.id}: send failed; status -> pending`);
    return { ok: false, reason: "send_failed" };
  }
  if (sentMessageId && afterDraftSend) {
    try {
      await afterDraftSend(action.draft_id, sentMessageId);
    } catch {
      console.log(`Approval action ${action.id}: after-send hook failed`);
    }
  }
  if (!transitionPendingAction(action.id, "pending", "sent")) {
    console.log(`Approval action ${action.id}: sent; status update failed`);
    return { ok: false, reason: "status_update_failed" };
  }
  console.log(`Approval action ${action.id}: status -> sent`);
  return { ok: true };
}

async function sendDraft(ctx: Context, action: PendingAction): Promise<void> {
  allowSendDraft({
    callbackData: ctx.callbackQuery?.data,
    actionId: action.id,
    actionStatus: action.status,
  });
  const outcome = await performDraftSend(action);
  if (!outcome.ok) {
    const text =
      outcome.reason === "send_failed"
        ? "Sending failed. The draft is still pending; please try again."
        : "The draft was sent, but its approval status could not be updated.";
    await ctx.answerCallbackQuery({ text, show_alert: true });
    return;
  }
  await showStatus(ctx, "Sent").catch(() => {
    console.log(`Approval action ${action.id}: sent preview update failed`);
  });
  await ctx.answerCallbackQuery("Sent").catch(() => undefined);
}

async function fetchDraftRecipientLabel(
  action: PendingAction,
): Promise<string> {
  try {
    const auth = await getGoogleClientFor(action.google_account);
    const gmail = google.gmail({ version: "v1", auth });
    const draft = await gmail.users.drafts.get({
      userId: "me",
      id: action.draft_id,
      format: "metadata",
    });
    const header =
      draft.data.message?.payload?.headers?.find(
        (item: { name?: string | null; value?: string | null }) =>
          (item.name ?? "").toLowerCase() === "to",
      )?.value ?? "";
    const addresses = parseAddressList(header);
    if (addresses.length === 0) {
      return "the recipient";
    }
    const first = addresses[0]!;
    return first.name || first.email;
  } catch {
    return "the recipient";
  }
}

export interface TextSendDraftResult {
  ok: boolean;
  message: string;
}

// Owner-authorized send via typed command. Runs before the LLM so no
// agent path can trigger it; owner-lock already fenced the chat.
export async function sendPendingDraftByText(
  action: PendingAction,
): Promise<TextSendDraftResult> {
  if (action.status === "pending" && isExpired(action)) {
    await expireAction(action);
    return {
      ok: false,
      message: "That draft expired. Draft it again if you still want to send.",
    };
  }
  if (action.status !== "pending") {
    return { ok: false, message: `That draft is already ${action.status}.` };
  }
  if (activeActions.has(action.id)) {
    return { ok: false, message: "That draft is already being sent." };
  }
  activeActions.add(action.id);
  try {
    const recipient = await fetchDraftRecipientLabel(action);
    const outcome = await performDraftSend(action);
    if (!outcome.ok) {
      return {
        ok: false,
        message:
          outcome.reason === "send_failed"
            ? "Sending failed. The draft is still pending; please try again."
            : "The draft was sent, but its approval status could not be updated.",
      };
    }
    if (action.telegram_message_id) {
      try {
        await telegram.editMessageText(
          config.ownerTelegramId,
          action.telegram_message_id,
          "Draft approval\n\nStatus: Sent",
          { reply_markup: new InlineKeyboard() },
        );
      } catch {
        console.log(
          `Approval action ${action.id}: text-send preview update failed`,
        );
      }
    }
    return { ok: true, message: `Sending the draft to ${recipient}...` };
  } finally {
    activeActions.delete(action.id);
  }
}

async function discardDraft(
  ctx: Context,
  action: PendingAction,
): Promise<void> {
  try {
    const auth = await getGoogleClientFor(action.google_account);
    const gmail = google.gmail({ version: "v1", auth });
    await gmail.users.drafts.delete({
      userId: "me",
      id: action.draft_id,
    });
  } catch {
    console.log(
      `Approval action ${action.id}: discard failed; status -> pending`,
    );
    await ctx.answerCallbackQuery({
      text: "Discarding failed. The draft is still pending; please try again.",
      show_alert: true,
    });
    return;
  }

  if (!transitionPendingAction(action.id, "pending", "discarded")) {
    console.log(`Approval action ${action.id}: discarded; status update failed`);
    await ctx.answerCallbackQuery({
      text: "The draft was discarded, but its approval status could not be updated.",
      show_alert: true,
    });
    return;
  }

  console.log(`Approval action ${action.id}: status -> discarded`);
  await showStatus(ctx, "Discarded").catch(() => {
    console.log(`Approval action ${action.id}: discard preview update failed`);
  });
  await ctx.answerCallbackQuery("Discarded").catch(() => undefined);
}

export async function handleApprovalCallback(
  ctx: Context,
  operation: "send" | "edit" | "discard",
  actionId: number,
): Promise<void> {
  const action = await currentPendingAction(ctx, actionId);
  if (!action) {
    return;
  }

  if (operation === "edit") {
    editingActionByUser.set(config.ownerTelegramId, action.id);
    console.log(`Approval action ${action.id}: awaiting edit instructions`);
    await ctx.answerCallbackQuery("Send your edit instructions.");
    await ctx.reply("What would you like to change in this draft?");
    return;
  }

  if (activeActions.has(action.id)) {
    await ctx.answerCallbackQuery("This action is already being processed.");
    return;
  }

  activeActions.add(action.id);
  try {
    if (operation === "send") {
      await sendDraft(ctx, action);
    } else {
      await discardDraft(ctx, action);
    }
  } finally {
    activeActions.delete(action.id);
  }
}

function decodeBody(data: string | null | undefined): string {
  return data ? Buffer.from(data, "base64url").toString("utf8") : "";
}

function plainTextBody(part: gmail_v1.Schema$MessagePart | undefined): string {
  if (!part) {
    return "";
  }
  if (part.mimeType?.toLowerCase() === "text/plain" && part.body?.data) {
    return decodeBody(part.body.data);
  }

  return (part.parts ?? [])
    .map((child) => plainTextBody(child))
    .filter(Boolean)
    .join("\n");
}

export async function consumeDraftEdit(
  userId: number,
): Promise<DraftEditContext | undefined> {
  const actionId = editingActionByUser.get(userId);
  if (!actionId) {
    return undefined;
  }
  editingActionByUser.delete(userId);

  const action = getPendingAction(actionId);
  if (!action || action.status !== "pending" || isExpired(action)) {
    if (action?.status === "pending") {
      await expireAction(action);
    }
    return undefined;
  }

  const auth = await getGoogleClientFor(action.google_account);
  const gmail = google.gmail({ version: "v1", auth });
  const draft = await gmail.users.drafts.get({
    userId: "me",
    id: action.draft_id,
    format: "full",
  });

  return {
    actionId: action.id,
    draftId: action.draft_id,
    body: plainTextBody(draft.data.message?.payload),
  };
}

export async function expirePendingApprovals(): Promise<void> {
  for (const action of getExpiredPendingActions()) {
    await expireAction(action);
  }
}

export function startApprovalExpirySweep(): NodeJS.Timeout {
  void expirePendingApprovals();
  const interval = setInterval(() => {
    void expirePendingApprovals();
  }, EXPIRY_SWEEP_MS);
  interval.unref();
  return interval;
}
