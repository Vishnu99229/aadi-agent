import type { LlmTool } from "../llm.js";
import { ingestDocumentBytes } from "../documents.js";
import { parseGoogleAccountFilter } from "../google/auth.js";
import { resolveGmailMessage } from "../google/mail.js";
import {
  attachmentTooLarge,
  collectAttachmentParts,
  downloadGmailAttachment,
  matchAttachment,
  MAX_ATTACHMENT_BYTES,
  messageHeader,
} from "../gmail_attachments.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "read_attachment",
  description:
    "Download and review one Gmail attachment (PDF, DOCX, XLSX/XLS, or image) from personal or work mail. Pass email_id and the attachment id or filename from list_attachments. Stores the extracted text for 7 days so follow-up questions can use read_document. Skips files over 25 MB. Never send or forward the file.",
  inputSchema: {
    type: "object",
    properties: {
      email_id: {
        type: "string",
        description: "The Gmail message ID from search_emails.",
      },
      attachment: {
        type: "string",
        description:
          "Attachment id or filename from list_attachments.",
      },
      account: {
        type: "string",
        enum: ["personal", "work"],
        description:
          "Optional mailbox filter. Use the account field from search_emails when present.",
      },
    },
    required: ["email_id", "attachment"],
  },
};

export async function handler(input: unknown): Promise<string> {
  const values = input as {
    email_id?: unknown;
    attachment?: unknown;
    account?: unknown;
  };
  if (typeof values.email_id !== "string" || !values.email_id.trim()) {
    throw new Error("email_id must be a non-empty Gmail message ID.");
  }
  if (typeof values.attachment !== "string" || !values.attachment.trim()) {
    throw new Error("attachment must be an attachment id or filename.");
  }

  const resolved = await resolveGmailMessage(
    values.email_id.trim(),
    parseGoogleAccountFilter(values.account),
    "full",
  );
  const attachments = collectAttachmentParts(resolved.message.payload);
  const matched = matchAttachment(attachments, values.attachment.trim());
  if (matched.length === 0) {
    throw new Error("No attachment on that email matched.");
  }
  if (matched.length > 1) {
    return JSON.stringify({
      error: "Multiple attachments matched. Pass the exact attachment id.",
      attachments: matched.map((item) => ({
        attachment: item.id,
        filename: item.filename,
      })),
    });
  }
  const chosen = matched[0]!;
  if (attachmentTooLarge(chosen.size)) {
    return "That attachment is over 25 MB, so I skipped it.";
  }

  const bytes = await downloadGmailAttachment(resolved, chosen);
  console.log(
    `read_attachment: message_id=${resolved.message.id} size=${bytes.byteLength} account=${resolved.account.id}`,
  );
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    return "That attachment is over 25 MB, so I skipped it.";
  }

  const subject = messageHeader(resolved.message, "Subject");
  const result = await ingestDocumentBytes({
    fileName: chosen.filename,
    mimeType: chosen.mimeType,
    bytes,
    tag: resolved.account.tag,
    hint: subject,
  });
  return result.reply;
}
