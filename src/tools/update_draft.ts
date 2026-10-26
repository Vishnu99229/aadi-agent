import type { LlmTool } from "../llm.js";
import { queueDraftApproval } from "../approvals.js";
import { getPendingActionForDraft } from "../db.js";
import {
  buildMimeMessage,
  gmailClient,
  messageHeader as header,
  plainTextBody,
  resolveGmailDraft,
  signatureHtmlFor,
  stripSignature,
} from "../google/mail.js";
import { dropSelf, toAddressList } from "./draft_reply.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "update_draft",
  description:
    "Update an existing Gmail draft without sending it: replace its plain-text body, its Cc list, or both. Preserves To, subject and thread. Returns the draft ID. Sending requires separate Telegram approval and is not available to this tool.",
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
          'The complete replacement plain-text body, written as Vishnu and ending with "Vishnu". Omit to keep the current body unchanged (for example when only changing Cc).',
      },
      cc: {
        description:
          "Replacement Cc list: one or more email addresses or RFC headers. Replaces the whole Cc line, so include any current Cc addresses (from read_draft) you want to keep. Pass an empty list to remove all Cc. Omit to keep the current Cc.",
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "string" } },
        ],
      },
    },
    required: ["draft_id"],
  },
};

function safeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export async function handler(input: unknown): Promise<string> {
  const values = input as { draft_id?: unknown; body?: unknown; cc?: unknown };
  if (typeof values.draft_id !== "string" || !values.draft_id.trim()) {
    throw new Error("draft_id must be a non-empty Gmail draft ID.");
  }
  if (
    values.body !== undefined &&
    (typeof values.body !== "string" || !values.body.trim())
  ) {
    throw new Error("body must be a non-empty plain-text reply when given.");
  }
  if (values.body === undefined && values.cc === undefined) {
    throw new Error("Pass body, cc, or both.");
  }

  const pending = getPendingActionForDraft(values.draft_id.trim());
  const { account, draft: existing } = await resolveGmailDraft(
    values.draft_id.trim(),
    pending?.google_account,
  );
  const gmail = gmailClient(account);
  const message = existing.message;
  const headers = message?.payload?.headers;
  const threadId = message?.threadId;

  const to = header(headers, "To");
  const subject = header(headers, "Subject");
  if (!message || !threadId || !to) {
    throw new Error("The Gmail draft is missing its recipient metadata.");
  }

  const current = stripSignature(plainTextBody(message.payload ?? {}).trim());
  const body =
    typeof values.body === "string"
      ? stripSignature(values.body).body
      : current.body;
  if (!body.trim()) {
    throw new Error("The draft has no plain-text body to keep; pass body.");
  }
  const cc =
    values.cc === undefined
      ? header(headers, "Cc")
      : dropSelf(toAddressList(values.cc).join(", "));

  // Keep the signature only on drafts Aadi signed; scheduling drafts stay
  // plain text.
  const raw = buildMimeMessage(
    [
      ["To", to],
      ["Cc", cc],
      ["Bcc", header(headers, "Bcc")],
      ["Subject", subject],
      ["In-Reply-To", header(headers, "In-Reply-To")],
      ["References", header(headers, "References")],
    ],
    body,
    current.signed ? await signatureHtmlFor(account) : "",
  );
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
    body,
    googleAccount: account.id,
    extraLines: cc ? [`Cc: ${safeHeader(cc)}`] : undefined,
  });

  return JSON.stringify({
    draft_id: draftId,
    account: account.id,
    tag: account.tag,
    cc: cc ? safeHeader(cc) : null,
  });
}
