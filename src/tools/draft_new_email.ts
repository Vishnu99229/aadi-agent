import type { LlmTool } from "../llm.js";
import { queueDraftApproval } from "../approvals.js";
import { decodedAccounts } from "../accounts.js";
import {
  formatMailboxList,
  splitDraftRecipients,
} from "../draft_recipients.js";
import { parseAddressList } from "../followup_logic.js";
import { getGoogleAccount } from "../google/auth.js";
import { createNewEmailDraft, signatureHtmlFor } from "../google/mail.js";
import { dropSelf, toAddressList } from "./draft_reply.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "draft_new_email",
  description:
    "Create a new standalone Gmail draft (not a reply to any thread). Never sends. Sending needs Vishnu's Telegram Send tap. Default recipients: external (non-epicode.in) in To, epicode.in colleagues in Cc. If more than one external company is present, put the prospect (matched account or the person Vishnu named) in To and other externals in Cc. Pass cc yourself when you already split them; otherwise the tool splits a mixed To list using the subject as the hint.",
  inputSchema: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description:
          "Recipient email address(es), comma-separated. Use addresses Vishnu gave or that you found in his mail; never guess one.",
      },
      cc: {
        description:
          "Optional Cc list. One or more email addresses or RFC headers. When omitted, mixed To addresses are split using the default To/Cc rule.",
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "string" } },
        ],
      },
      subject: {
        type: "string",
        description: "Subject line.",
      },
      body: {
        type: "string",
        description:
          "The complete plain-text body, written as Vishnu. Do not add a sign-off or name; Gmail appends the signature.",
      },
      account: {
        type: "string",
        enum: ["work", "personal"],
        description:
          "Mailbox to send from. Defaults to work (Epicode); use personal for a personal email.",
      },
    },
    required: ["to", "subject", "body"],
  },
};

export async function handler(input: unknown): Promise<string> {
  const values = input as {
    to?: unknown;
    cc?: unknown;
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

  const subject = values.subject.trim();
  let toHeader = dropSelf(values.to.trim());
  let ccHeader = "";
  if (values.cc !== undefined) {
    ccHeader = dropSelf(toAddressList(values.cc).join(", "));
  } else {
    const split = splitDraftRecipients(
      parseAddressList(toHeader),
      `${subject}\n${values.body}`,
      decodedAccounts(),
    );
    toHeader = formatMailboxList(split.to);
    ccHeader = formatMailboxList(split.cc);
  }
  if (!toHeader) {
    throw new Error("to has no remaining recipient after dropping Vishnu's own addresses.");
  }

  const account = await getGoogleAccount(
    values.account === "personal" ? "personal" : "work",
  );
  const { draftId } = await createNewEmailDraft({
    account,
    to: [toHeader],
    cc: ccHeader ? [ccHeader] : undefined,
    subject,
    body: values.body,
    signatureHtml: await signatureHtmlFor(account),
  });

  await queueDraftApproval({
    draftId,
    threadId: null,
    to: toHeader,
    cc: ccHeader || undefined,
    subject,
    body: values.body,
    googleAccount: account.id,
    extraLines: ccHeader ? [`Cc: ${ccHeader}`] : undefined,
  });

  return `Draft created for ${toHeader} (${account.tag}). Waiting for your Send tap. draft_id: ${draftId}`;
}
