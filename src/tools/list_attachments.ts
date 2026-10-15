import type { LlmTool } from "../llm.js";
import { parseGoogleAccountFilter } from "../google/auth.js";
import { resolveGmailMessage } from "../google/mail.js";
import { collectAttachmentParts } from "../gmail_attachments.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "list_attachments",
  description:
    "List attachments on a Gmail message (ids, names, types, sizes). Then use read_attachment.",
  inputSchema: {
    type: "object",
    properties: {
      email_id: {
        type: "string",
        description: "The Gmail message ID from search_emails.",
      },
      account: {
        type: "string",
        enum: ["personal", "work"],
        description:
          "Optional mailbox filter. Use the account field from search_emails when present.",
      },
    },
    required: ["email_id"],
  },
};

export async function handler(input: unknown): Promise<string> {
  const values = input as { email_id?: unknown; account?: unknown };
  if (typeof values.email_id !== "string" || !values.email_id.trim()) {
    throw new Error("email_id must be a non-empty Gmail message ID.");
  }
  const { account, message } = await resolveGmailMessage(
    values.email_id.trim(),
    parseGoogleAccountFilter(values.account),
    "full",
  );
  const attachments = collectAttachmentParts(message.payload);
  console.log(
    `list_attachments: message_id=${message.id} count=${attachments.length} account=${account.id}`,
  );
  if (attachments.length === 0) {
    return "No file attachments on that email.";
  }
  return JSON.stringify(
    {
      account: account.id,
      tag: account.tag,
      email_id: message.id,
      attachments: attachments.map((item) => ({
        attachment: item.id,
        filename: item.filename,
        mime_type: item.mimeType,
        size_bytes: item.size,
      })),
    },
    null,
    2,
  );
}
