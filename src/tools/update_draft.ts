import { google, type gmail_v1 } from "googleapis";
import type { LlmTool } from "../llm.js";
import { queueDraftApproval } from "../approvals.js";
import { getGoogleClient } from "../google/auth.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "update_draft",
  description:
    "Replace the plain-text body of an existing Gmail draft without sending it. Preserve the draft's recipients, subject, and thread. Returns the draft ID. Sending requires separate Telegram approval and is not available to this tool.",
  inputSchema: {
    type: "object",
    properties: {
      draft_id: {
        type: "string",
        description: "The Gmail draft ID returned by draft_reply.",
      },
      body: {
        type: "string",
        description:
          'The complete replacement plain-text body, written as Vishnu and ending with "Vishnu".',
      },
    },
    required: ["draft_id", "body"],
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

function encodeBody(body: string): string {
  return Buffer.from(body, "utf8")
    .toString("base64")
    .match(/.{1,76}/g)!
    .join("\r\n");
}

function buildDraftMessage(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  body: string,
): string {
  const outputHeaders = [
    ["To", header(headers, "To")],
    ["Cc", header(headers, "Cc")],
    ["Bcc", header(headers, "Bcc")],
    ["Subject", header(headers, "Subject")],
    ["In-Reply-To", header(headers, "In-Reply-To")],
    ["References", header(headers, "References")],
  ]
    .filter(([, value]) => Boolean(value))
    .map(([name, value]) => `${name}: ${safeHeader(value)}`);

  return [
    ...outputHeaders,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    encodeBody(body),
  ].join("\r\n");
}

export async function handler(input: unknown): Promise<string> {
  const values = input as { draft_id?: unknown; body?: unknown };
  if (typeof values.draft_id !== "string" || !values.draft_id.trim()) {
    throw new Error("draft_id must be a non-empty Gmail draft ID.");
  }
  if (typeof values.body !== "string" || !values.body.trim()) {
    throw new Error("body must be a non-empty plain-text reply.");
  }

  const auth = await getGoogleClient();
  const gmail = google.gmail({ version: "v1", auth });
  const existing = await gmail.users.drafts.get({
    userId: "me",
    id: values.draft_id,
    format: "full",
  });
  const message = existing.data.message;
  const headers = message?.payload?.headers;
  const threadId = message?.threadId;

  const to = header(headers, "To");
  const subject = header(headers, "Subject");
  if (!message || !threadId || !to) {
    throw new Error("The Gmail draft is missing its recipient metadata.");
  }

  const raw = buildDraftMessage(headers, values.body);
  const result = await gmail.users.drafts.update({
    userId: "me",
    id: values.draft_id,
    requestBody: {
      id: values.draft_id,
      message: {
        threadId: threadId ?? undefined,
        raw: Buffer.from(raw, "utf8").toString("base64url"),
      },
    },
  });

  const draftId = result.data.id ?? values.draft_id;
  await queueDraftApproval({
    draftId,
    threadId,
    to: safeHeader(to),
    subject: safeHeader(subject),
    body: values.body,
  });

  return JSON.stringify({ draft_id: draftId });
}
