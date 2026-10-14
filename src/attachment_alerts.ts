import { InlineKeyboard, type Api, type Context } from "grammy";
import cron, { type ScheduledTask } from "node-cron";
import { config } from "./config.js";
import {
  createAttachmentAlert,
  getAttachmentAlert,
  transitionAttachmentAlert,
} from "./db.js";
import { ingestDocumentBytes } from "./documents.js";
import {
  attachmentAlertLabel,
  detectDocumentKind,
  looksLikeReviewAttachment,
} from "./document_types.js";
import { loadGoogleAccounts } from "./google/auth.js";
import { gmailClient } from "./google/mail.js";
import {
  collectAttachmentParts,
  downloadGmailAttachment,
  messageHeader,
  senderDisplay,
} from "./gmail_attachments.js";
import { isSelfEmail } from "./mom_logic.js";

const TIME_ZONE = "Asia/Kolkata";
const LOOKBACK = "in:inbox has:attachment newer_than:1d";

function alertKeyboard(alertId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("Review", `att:review:${alertId}`)
    .text("Ignore", `att:ignore:${alertId}`);
}

function fromEmail(fromHeader: string): string {
  const match = fromHeader.match(/<([^>]+)>/);
  return (match?.[1] ?? fromHeader).trim().toLowerCase();
}

export async function runAttachmentAlertScan(api: Api): Promise<number> {
  const accounts = await loadGoogleAccounts();
  const work = accounts.find((account) => account.id === "work");
  if (!work) {
    return 0;
  }
  const gmail = gmailClient(work);
  const listed = await gmail.users.messages.list({
    userId: "me",
    q: LOOKBACK,
    maxResults: 25,
  });
  let sent = 0;
  for (const item of listed.data.messages ?? []) {
    if (!item.id) {
      continue;
    }
    const response = await gmail.users.messages.get({
      userId: "me",
      id: item.id,
      format: "full",
    });
    const message = response.data;
    const from = messageHeader(message, "From");
    if (isSelfEmail(fromEmail(from))) {
      continue;
    }
    const subject = messageHeader(message, "Subject");
    const sender = senderDisplay(from);
    const attachments = collectAttachmentParts(message.payload);
    for (const attachment of attachments) {
      if (
        !looksLikeReviewAttachment({
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          subject,
        })
      ) {
        continue;
      }
      const guessed = attachmentAlertLabel(
        detectDocumentKind(attachment.filename, subject),
        attachment.filename,
        subject,
      );
      const row = createAttachmentAlert({
        messageId: message.id!,
        googleAccount: "work",
        attachmentId: attachment.id,
        fileName: attachment.filename,
        mimeType: attachment.mimeType,
        sender,
        subject,
        guessedType: guessed,
      });
      if (!row) {
        continue;
      }
      const text = `${guessed} from ${sender}: ${attachment.filename}`;
      await api.sendMessage(config.ownerTelegramId, text, {
        reply_markup: alertKeyboard(row.id),
      });
      console.log(
        `Attachment alert ${row.id}: message_id=${message.id} type=${guessed}`,
      );
      sent += 1;
    }
  }
  return sent;
}

export async function handleAttachmentAlertCallback(
  ctx: Context,
  operation: "review" | "ignore",
  alertId: number,
): Promise<void> {
  const alert = getAttachmentAlert(alertId);
  if (!alert) {
    await ctx.answerCallbackQuery({
      text: "That alert is no longer available.",
      show_alert: true,
    });
    return;
  }
  if (alert.status !== "pending") {
    await ctx.answerCallbackQuery(`Already ${alert.status}.`);
    return;
  }

  if (operation === "ignore") {
    transitionAttachmentAlert(alertId, "pending", "ignored");
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
    await ctx.answerCallbackQuery("Ignored");
    return;
  }

  await ctx.answerCallbackQuery("Reviewing…");
  try {
    const accounts = await loadGoogleAccounts();
    const work = accounts.find((account) => account.id === "work");
    if (!work) {
      throw new Error("Work Google account is not connected.");
    }
    const gmail = gmailClient(work);
    const response = await gmail.users.messages.get({
      userId: "me",
      id: alert.message_id,
      format: "full",
    });
    const attachments = collectAttachmentParts(response.data.payload);
    const chosen =
      attachments.find((item) => item.id === alert.attachment_id) ??
      attachments.find(
        (item) => item.filename.toLowerCase() === alert.file_name.toLowerCase(),
      );
    if (!chosen) {
      throw new Error("That attachment is no longer on the email.");
    }
    const bytes = await downloadGmailAttachment(
      { account: work, message: response.data },
      chosen,
    );
    const result = await ingestDocumentBytes({
      fileName: alert.file_name,
      mimeType: alert.mime_type,
      bytes,
      tag: "work",
      hint: alert.subject,
    });
    transitionAttachmentAlert(alertId, "pending", "reviewed");
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(
      () => undefined,
    );
    const characters = Array.from(result.reply);
    const limit = 4000;
    for (let offset = 0; offset < characters.length; offset += limit) {
      await ctx.reply(characters.slice(offset, offset + limit).join(""));
    }
    console.log(
      `Attachment alert ${alertId}: reviewed document_id=${result.documentId}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Attachment alert ${alertId}: review failed (${message})`);
    await ctx.reply(message);
  }
}

export function registerAttachmentAlertScan(api: Api): ScheduledTask {
  const task = cron.schedule(
    "*/10 * * * *",
    async () => {
      try {
        await runAttachmentAlertScan(api);
      } catch (error) {
        const errorType = error instanceof Error ? error.name : "UnknownError";
        console.error(`Attachment alert scan failed (${errorType}).`);
      }
    },
    { name: "aadi-attachment-alerts", timezone: TIME_ZONE, noOverlap: true },
  );
  console.log(`Work attachment alerts every 10 minutes (${TIME_ZONE}).`);
  return task;
}
