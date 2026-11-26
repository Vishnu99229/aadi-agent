import type { LlmTool } from "../llm.js";
import {
  queueDraftApproval,
  sendCreatedDraftNow,
} from "../approvals.js";
import { decodedAccounts } from "../accounts.js";
import {
  formatMailboxList,
  splitDraftRecipients,
} from "../draft_recipients.js";
import { parseAddressList } from "../address_list.js";
import { getGoogleAccount } from "../google/auth.js";
import { createNewEmailDraft, signatureHtmlFor, signaturePlainText } from "../google/mail.js";
import { deliveryTimeHold, notASendCommand } from "../command_logic.js";
import { linkPublishedDraft } from "../action_context.js";
import { emailReferenceForTurn, refersToEarlierEmail } from "../email_references.js";
import { dropSelf, toAddressList } from "./draft_reply.js";
import type { ToolTurn } from "./index.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "draft_new_email",
  description:
    "Create a new standalone Gmail draft (not a reply to any thread). Set send_immediately true only when Vishnu explicitly asked to send in this chat turn; that sends now with no approval card. If he asked to draft, omit send_immediately so he gets Send / Edit / Discard. Default recipients: external (non-epicode.in) in To, epicode.in colleagues in Cc. If more than one external company is present, put the prospect (matched account or the person Vishnu named) in To and other externals in Cc. Pass cc yourself when you already split them; otherwise the tool splits a mixed To list using the subject as the hint.",
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
      send_immediately: {
        type: "boolean",
        description:
          "True only when Vishnu explicitly asked to send this email in this chat turn (for example 'send an email to X' or 'email X saying Y'). Omit or false when he asked to draft it first.",
      },
    },
    required: ["to", "subject", "body"],
  },
};

export async function handler(input: unknown, turn: ToolTurn): Promise<string> {
  const values = input as {
    to?: unknown;
    cc?: unknown;
    subject?: unknown;
    body?: unknown;
    account?: unknown;
    send_immediately?: unknown;
  };
  if (typeof values.to !== "string" || !values.to.trim()) {
    throw new Error("to must be a non-empty email address.");
  }
  const referencedEmail = emailReferenceForTurn(
    turn.confirmation?.chatId,
    turn.confirmation?.messageId,
  );
  const selectedTo = referencedEmail && refersToEarlierEmail(values.to)
    ? referencedEmail
    : values.to.trim();
  if (referencedEmail) {
    const chosen = parseAddressList(selectedTo);
    if (
      chosen.length !== 1 || chosen[0]!.email.toLowerCase() !== referencedEmail ||
      (values.cc !== undefined && !/\bcc\b/i.test(turn.userText ?? ""))
    ) {
      return `Not drafted: the referenced photo/message identifies ${referencedEmail}, but the agent chose different recipients. No Gmail draft was created.`;
    }
  }
  if (typeof values.subject !== "string" || !values.subject.trim()) {
    throw new Error("subject must be a non-empty string.");
  }
  if (typeof values.body !== "string" || !values.body.trim()) {
    throw new Error("body must be a non-empty plain-text email.");
  }
  if (parseAddressList(selectedTo).length === 0) {
    throw new Error(
      "to has no email address. Find the address with search_emails or ask Vishnu.",
    );
  }

  const subject = values.subject.trim();
  let toHeader = dropSelf(selectedTo);
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

  if (values.send_immediately === true) {
    const hold = deliveryTimeHold(turn.userText ?? "");
    if (hold) return hold;
  }
  const account = await getGoogleAccount(
    values.account === "personal" ? "personal" : "work",
  );
  const signatureHtml = await signatureHtmlFor(account);
  const { draftId } = await createNewEmailDraft({
    account,
    to: [toHeader],
    cc: ccHeader ? [ccHeader] : undefined,
    subject,
    body: values.body,
    signatureHtml,
  });

  let cardNote = "";
  const sendImmediately =
    values.send_immediately === true && notASendCommand(turn.userText ?? "") === undefined;
  const signature = signaturePlainText(signatureHtml);
  if (sendImmediately) {
    const sent = await sendCreatedDraftNow({
      draftId,
      googleAccount: account.id,
      confirmation: turn.confirmation,
      ownTurn: turn.ownTurn === true,
      userText: turn.userText,
    });
    if (!sent.ok && sent.reason === "card") {
      cardNote = sent.message;
    }
    if (sent.ok) {
      return [`Sent to ${toHeader}.`, sent.replacementNotice].filter(Boolean).join("\n");
    }
  }

  let replacementNotice = "";
  await queueDraftApproval({
    draftId,
    threadId: null,
    to: toHeader,
    cc: ccHeader || undefined,
    subject,
    body: values.body,
    googleAccount: account.id,
    ...(signature ? { signature } : {}),
  }, { onReplaced: (notice) => { replacementNotice = notice; } });
  if (turn.confirmation) {
    linkPublishedDraft({
      chatId: turn.confirmation.chatId,
      draftId,
      to: toHeader,
      cc: ccHeader,
      subject,
      body: values.body,
      account: account.id,
    });
  }

  return [
    `${cardNote ? `${cardNote} ` : ""}Draft created for ${toHeader} (${account.tag}). Waiting for your Send tap. draft_id: ${draftId}`,
    replacementNotice,
  ].filter(Boolean).join("\n");
}
