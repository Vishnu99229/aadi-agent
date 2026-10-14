import type { gmail_v1 } from "googleapis";
import type { LlmTool } from "../llm.js";
import { queueDraftApproval } from "../approvals.js";
import { parseGoogleAccountFilter } from "../google/auth.js";
import { gmailClient, resolveGmailMessage } from "../google/mail.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "draft_reply",
  description:
    "Create, but never send, a Gmail draft replying to an existing email in the same thread and the SAME account the email arrived on (personal Gmail or Epicode work). Use only after the reply has all required facts. Returns the Gmail draft ID. Sending requires separate Telegram approval and is not available to this tool.",
  inputSchema: {
    type: "object",
    properties: {
      email_id: {
        type: "string",
        description:
          "The Gmail message ID being replied to, usually obtained from search_emails.",
      },
      body: {
        type: "string",
        description:
          'The complete plain-text reply body, written as Vishnu and ending with "Vishnu".',
      },
      account: {
        type: "string",
        enum: ["personal", "work"],
        description:
          "Mailbox the original email is in. Use the account field from search_emails when present.",
      },
    },
    required: ["email_id", "body"],
  },
};

function header(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string {
  return (
    headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())
      ?.value ?? ""
  );
}

function safeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function replySubject(subject: string): string {
  const normalized = safeHeader(subject) || "(no subject)";
  return /^re\s*:/i.test(normalized) ? normalized : `Re: ${normalized}`;
}

function encodeBody(body: string): string {
  return Buffer.from(body, "utf8")
    .toString("base64")
    .match(/.{1,76}/g)!
    .join("\r\n");
}

function buildReplyMessage(params: {
  to: string;
  subject: string;
  messageId: string;
  references: string;
  body: string;
}): string {
  const references = [params.references, params.messageId]
    .map(safeHeader)
    .filter(Boolean)
    .join(" ");

  return [
    `To: ${safeHeader(params.to)}`,
    `Subject: ${replySubject(params.subject)}`,
    `In-Reply-To: ${safeHeader(params.messageId)}`,
    `References: ${references}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    encodeBody(params.body),
  ].join("\r\n");
}

export async function handler(input: unknown): Promise<string> {
  const values = input as {
    email_id?: unknown;
    body?: unknown;
    account?: unknown;
  };
  if (typeof values.email_id !== "string" || !values.email_id.trim()) {
    throw new Error("email_id must be a non-empty Gmail message ID.");
  }
  if (typeof values.body !== "string" || !values.body.trim()) {
    throw new Error("body must be a non-empty plain-text reply.");
  }

  const { account, message: original } = await resolveGmailMessage(
    values.email_id.trim(),
    parseGoogleAccountFilter(values.account),
    "metadata",
    ["From", "Subject", "Message-ID", "References"],
  );
  const gmail = gmailClient(account);
  const headers = original.payload?.headers;
  const threadId = original.threadId;
  const from = header(headers, "From");
  const messageId = header(headers, "Message-ID");

  if (!threadId || !from || !messageId) {
    throw new Error(
      "The original email is missing threading or sender metadata.",
    );
  }

  const subject = replySubject(header(headers, "Subject"));
  const raw = buildReplyMessage({
    to: from,
    subject,
    messageId,
    references: header(headers, "References"),
    body: values.body,
  });
  const result = await gmail.users.drafts.create({
    userId: "me",
    requestBody: {
      message: {
        threadId,
        raw: Buffer.from(raw, "utf8").toString("base64url"),
      },
    },
  });

  if (!result.data.id) {
    throw new Error("Gmail created the draft without returning a draft ID.");
  }

  await queueDraftApproval({
    draftId: result.data.id,
    threadId,
    to: safeHeader(from),
    subject,
    body: values.body,
    googleAccount: account.id,
  });

  return JSON.stringify({
    draft_id: result.data.id,
    account: account.id,
    tag: account.tag,
  });
}
