import type { gmail_v1 } from "googleapis";
import type { LlmTool } from "../llm.js";
import { queueDraftApproval } from "../approvals.js";
import { parseGoogleAccountFilter } from "../google/auth.js";
import {
  buildThreadReplyMime,
  gmailClient,
  mimeHeaderBlock,
  resolveGmailMessage,
} from "../google/mail.js";
import { parseAddressList } from "../followup_logic.js";
import { isSelfEmail } from "../mom_logic.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "draft_reply",
  description:
    "Create a Gmail reply draft in the same thread and mailbox. Never sends. Sending needs Telegram approval.",
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
      to: {
        description:
          "Optional explicit recipients. One or more email addresses (strings) or RFC headers. Required when the original message's From is Vishnu himself (e.g. a thread Vishnu started); otherwise defaults to the original sender.",
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "string" } },
        ],
      },
      cc: {
        description:
          "Optional Cc recipients. One or more email addresses (strings) or RFC headers. Omit to send without any Cc.",
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "string" } },
        ],
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

function replySubject(subject: string): string {
  const normalized = subject.replace(/[\r\n]+/g, " ").trim() || "(no subject)";
  return /^re\s*:/i.test(normalized) ? normalized : `Re: ${normalized}`;
}

function toAddressList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function dropSelf(header: string): string {
  const kept = parseAddressList(header).filter(
    (item) => !isSelfEmail(item.email),
  );
  return kept
    .map((item) =>
      item.name && !item.name.includes("@") && item.name.toLowerCase() !== item.email
        ? `${item.name} <${item.email}>`
        : item.email,
    )
    .join(", ");
}

export async function handler(input: unknown): Promise<string> {
  const values = input as {
    email_id?: unknown;
    body?: unknown;
    account?: unknown;
    to?: unknown;
    cc?: unknown;
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
    ["From", "To", "Cc", "Subject", "Message-ID", "References"],
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

  const explicitTo = toAddressList(values.to).join(", ");
  const explicitCc = toAddressList(values.cc).join(", ");
  const fromIsSelf = parseAddressList(from).every((item) =>
    isSelfEmail(item.email),
  );

  // Pick recipients: prefer the agent's explicit `to`; otherwise reply to the
  // original sender. If the original is Vishnu-to-Vishnu and the agent did
  // not supply `to`, there's no safe default — refuse rather than send to
  // self or let Gmail quietly address the owner.
  let to = dropSelf(explicitTo || from);
  if (!to && fromIsSelf) {
    throw new Error(
      "draft_reply: original From is the owner; agent must pass an explicit `to`.",
    );
  }
  if (!to) {
    throw new Error(
      "draft_reply: no external recipient after dropping self from the chosen To.",
    );
  }
  const cc = dropSelf(explicitCc);

  const subject = replySubject(header(headers, "Subject"));
  const raw = buildThreadReplyMime({
    to,
    cc: cc || undefined,
    subject,
    inReplyTo: messageId,
    references: header(headers, "References"),
    body: values.body,
  });
  console.log(
    `Draft MIME headers (body redacted):\n${mimeHeaderBlock(raw)}`,
  );
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
    to,
    subject,
    body: values.body,
    googleAccount: account.id,
    extraLines: cc ? [`Cc: ${cc}`] : undefined,
  });

  return JSON.stringify({
    draft_id: result.data.id,
    account: account.id,
    tag: account.tag,
    to,
    cc: cc || null,
  });
}
