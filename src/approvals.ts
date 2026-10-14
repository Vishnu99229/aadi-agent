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

const PREVIEW_LIMIT = 3800;
const EXPIRY_SWEEP_MS = 60 * 60 * 1000;

const telegram = new Api(config.telegramBotToken);
const activeActions = new Set<number>();
const editingActionByUser = new Map<number, number>();

export interface DraftApprovalPreview {
  draftId: string;
  threadId: string;
  to: string;
  subject: string;
  body: string;
  googleAccount: "personal" | "work";
}

export interface DraftEditContext {
  actionId: number;
  draftId: string;
  body: string;
}

function keyboard(actionId: number): InlineKeyboard {
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
  const prefix = [
    "Draft waiting for approval",
    "",
    `Account: ${mailbox}`,
    `To: ${preview.to}`,
    `Subject: ${preview.subject}`,
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
  if (action.telegram_message_id) {
    try {
      await telegram.editMessageText(
        config.ownerTelegramId,
        action.telegram_message_id,
        text,
        { reply_markup: keyboard(action.id) },
      );
      console.log(`Approval action ${action.id}: preview updated`);
      return action.id;
    } catch {
      console.log(`Approval action ${action.id}: preview replacement failed`);
    }
  }

  const message = await telegram.sendMessage(config.ownerTelegramId, text, {
    reply_markup: keyboard(action.id),
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

async function sendDraft(ctx: Context, action: PendingAction): Promise<void> {
  try {
    const auth = await getGoogleClientFor(action.google_account);
    const gmail = google.gmail({ version: "v1", auth });
    await gmail.users.drafts.send({
      userId: "me",
      requestBody: { id: action.draft_id },
    });
  } catch {
    console.log(`Approval action ${action.id}: send failed; status -> pending`);
    await ctx.answerCallbackQuery({
      text: "Sending failed. The draft is still pending; please try again.",
      show_alert: true,
    });
    return;
  }

  if (!transitionPendingAction(action.id, "pending", "sent")) {
    console.log(`Approval action ${action.id}: sent; status update failed`);
    await ctx.answerCallbackQuery({
      text: "The draft was sent, but its approval status could not be updated.",
      show_alert: true,
    });
    return;
  }

  console.log(`Approval action ${action.id}: status -> sent`);
  await showStatus(ctx, "Sent").catch(() => {
    console.log(`Approval action ${action.id}: sent preview update failed`);
  });
  await ctx.answerCallbackQuery("Sent").catch(() => undefined);
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
