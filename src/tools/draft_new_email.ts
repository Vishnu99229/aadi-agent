import type { LlmTool } from "../llm.js";
import { queueDraftApproval } from "../approvals.js";
import { parseAddressList } from "../followup_logic.js";
import { getGoogleAccount } from "../google/auth.js";
import { createNewEmailDraft } from "../google/mail.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "draft_new_email",
  description:
    "Create a new standalone Gmail draft (not a reply to any thread). Never sends. Sending needs Vishnu's Telegram Send tap.",
  inputSchema: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description:
          "Recipient email address(es), comma-separated. Use addresses Vishnu gave or that you found in his mail; never guess one.",
      },
      subject: {
        type: "string",
        description: "Subject line.",
      },
      body: {
        type: "string",
        description:
          'The complete plain-text body, written as Vishnu and ending with "Vishnu".',
      },
      account: {
        type: "string",
        enum: ["work", "personal"],
        description:
          "Mailbox to send from. Defaults to work (Epicode); use personal for personal emails.",
      },
    },
    required: ["to", "subject", "body"],
  },
};

export async function handler(input: unknown): Promise<string> {
  const values = input as {
    to?: unknown;
    subject?: unknown;
    body?: unknown;
    account?: unknown;
  };
  if (typeof values.to !== "string" || !values.to.trim()) {
    throw new Error("to must be a non-empty email address.");
  }
  if (typeof values.subject !== "string" || !values.subject.trim()) {
    throw new Error("subject must be a non-empty string.");
  }
  if (typeof values.body !== "string" || !values.body.trim()) {
    throw new Error("body must be a non-empty plain-text email.");
  }
  if (parseAddressList(values.to).length === 0) {
    throw new Error(
      "to has no email address. Find the address with search_emails or ask Vishnu.",
    );
  }

  const account = await getGoogleAccount(
    values.account === "personal" ? "personal" : "work",
  );
  const to = values.to.trim();
  const subject = values.subject.trim();
  const { draftId } = await createNewEmailDraft({
    account,
    to: [to],
    subject,
    body: values.body,
  });

  await queueDraftApproval({
    draftId,
    threadId: null,
    to,
    subject,
    body: values.body,
    googleAccount: account.id,
  });

  return `Draft created for ${to} (${account.tag}). Waiting for your Send tap. draft_id: ${draftId}`;
}
