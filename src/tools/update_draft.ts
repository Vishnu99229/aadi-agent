import type { LlmTool } from "../llm.js";
import {
  draftChange,
  lockedScheduleForDraft,
  scheduleSyncNotice,
  syncBoundSchedules,
  syncDraftRecipient,
  tooLateText,
  type ScheduleSync,
} from "../action_context.js";
import { queueDraftApproval } from "../approvals.js";
import { noteDraftEditedThisTurn } from "./confirm_send_pending_draft.js";
import { accountBoundToDraft, getPendingActionForDraft } from "../db.js";
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
import type { ToolTurn } from "./index.js";
import { sameConversation } from "../subject_logic.js";
import { emailReferenceForTurn } from "../email_references.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "update_draft",
  description:
    "Update an existing Gmail draft in place without sending it: replace its subject, To list, Cc list, plain-text body, or any combination. Refreshes the existing approval card and keeps the same draft id. If the draft belongs to a scheduled email, that email gets the same change; the result's scheduled_email field says what happened and must be passed on to Vishnu. Sending requires separate Telegram approval and is not available to this tool.",
  inputSchema: {
    type: "object",
    properties: {
      draft_id: {
        type: "string",
        description: "The Gmail draft ID returned by draft_reply or draft_new_email.",
      },
      subject: {
        type: "string",
        description: "Replacement subject. Omit to keep the current subject.",
      },
      to: {
        description:
          "Replacement To list: one or more email addresses or RFC headers. Replaces the whole To line. Omit to keep the current To.",
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "string" } },
        ],
      },
      body: {
        type: "string",
        description:
          "The complete replacement plain-text body, written as Vishnu. Do not add a sign-off or name; Gmail appends the signature. Omit to keep the current body unchanged (for example when only changing recipients).",
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

/** What Vishnu must hear about a scheduled email after an update_draft call: a refusal,
 *  or a scheduled copy that was stopped or was already going out. Undefined when it matches. */
export function draftUpdateNotice(result: string): string | undefined {
  try {
    const parsed = JSON.parse(result) as { schedule?: ScheduleSync["kind"]; scheduled_email?: string };
    return parsed.schedule === "stopped" || parsed.schedule === "too_late" ? parsed.scheduled_email : undefined;
  } catch {
    return result;
  }
}

export async function handler(input: unknown, turn?: ToolTurn): Promise<string> {
  const referencedEmail = emailReferenceForTurn(turn?.confirmation?.chatId, turn?.confirmation?.messageId);
  if (referencedEmail) {
    return `Not updated: the owner selected ${referencedEmail} from OCR/a quoted message. This is a new recipient reference, not permission to rewrite an older Gmail draft.`;
  }
  const values = input as {
    draft_id?: unknown;
    body?: unknown;
    cc?: unknown;
    to?: unknown;
    subject?: unknown;
  };
  if (typeof values.draft_id !== "string" || !values.draft_id.trim()) {
    throw new Error("draft_id must be a non-empty Gmail draft ID.");
  }
  if (
    values.body !== undefined &&
    (typeof values.body !== "string" || !values.body.trim())
  ) {
    throw new Error("body must be a non-empty plain-text reply when given.");
  }
  if (
    values.body === undefined &&
    values.cc === undefined &&
    values.to === undefined &&
    (typeof values.subject !== "string" || !values.subject.trim())
  ) {
    throw new Error("Pass body, to, cc, subject, or a combination.");
  }

  const draftId = values.draft_id.trim();
  const pending = getPendingActionForDraft(draftId);
  const hintedAccount = pending?.google_account ?? accountBoundToDraft(draftId);
  // The email this draft was scheduled as may already be going out, or gone. Its history
  // stays as sent: say so before reading or changing the draft.
  if (hintedAccount) {
    const locked = lockedScheduleForDraft(draftId, hintedAccount);
    if (locked) {
      return tooLateText(locked);
    }
  }
  const { account, draft: existing } = await resolveGmailDraft(draftId, hintedAccount);
  const locked = lockedScheduleForDraft(draftId, account.id);
  if (locked) {
    return tooLateText(locked);
  }
  const gmail = gmailClient(account);
  const message = existing.message;
  const headers = message?.payload?.headers;
  const threadId = message?.threadId;

  const to =
    values.to === undefined
      ? header(headers, "To")
      : dropSelf(toAddressList(values.to).join(", "));
  const subject = typeof values.subject === "string" && values.subject.trim()
    ? safeHeader(values.subject)
    : header(headers, "Subject");
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

  // A reply whose subject he changes can't stay in its thread: Gmail keeps a reply there
  // only while the subject matches. It becomes a new conversation, with no thread id and
  // no reply headers, and the card says so.
  const replying = Boolean(header(headers, "In-Reply-To"));
  const leavesThread =
    replying &&
    typeof values.subject === "string" &&
    values.subject.trim() !== "" &&
    !sameConversation(subject, header(headers, "Subject"));

  // Keep the signature only on drafts Aadi signed; scheduling drafts stay
  // plain text.
  const raw = buildMimeMessage(
    [
      ["To", to],
      ["Cc", cc],
      ["Bcc", header(headers, "Bcc")],
      ["Subject", subject],
      ["In-Reply-To", leavesThread ? "" : header(headers, "In-Reply-To")],
      ["References", leavesThread ? "" : header(headers, "References")],
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
        ...(leavesThread ? {} : { threadId: threadId ?? undefined }),
        raw: Buffer.from(raw, "utf8").toString("base64url"),
      },
    },
  });

  const savedDraftId = result.data.id ?? values.draft_id;
  const draftThread = leavesThread ? result.data.message?.threadId ?? threadId : threadId;
  const conversationNote = leavesThread
    ? "New subject: this will go out as a new conversation, not as a reply in the original thread."
    : "";
  // The scheduled email this draft belongs to gets the same recipients, subject and body,
  // whether the edit came from chat, an Edit tap, or a contextual rewrite.
  let sync: ScheduleSync = { kind: "none" };
  if (
    values.to !== undefined ||
    values.cc !== undefined ||
    typeof values.body === "string" ||
    typeof values.subject === "string"
  ) {
    const fields = {
      to: safeHeader(to),
      cc: values.cc === undefined ? undefined : safeHeader(cc),
      subject: safeHeader(subject),
      body: typeof values.body === "string" ? body : undefined,
    };
    sync = turn?.confirmation
      ? syncDraftRecipient({ chatId: turn.confirmation.chatId, draftId: savedDraftId, ...fields, account: account.id })
      : syncBoundSchedules(savedDraftId, account.id, draftChange(fields));
  }
  const scheduleNote =
    sync.kind === "synced" ? "The scheduled email was updated to match this draft." : scheduleSyncNotice(sync);
  await queueDraftApproval({
    draftId: savedDraftId,
    threadId: draftThread,
    to: safeHeader(to),
    cc: cc ? safeHeader(cc) : undefined,
    subject: safeHeader(subject),
    body,
    googleAccount: account.id,
    extraLines: [
      ...(cc ? [`Cc: ${safeHeader(cc)}`] : []),
      ...(conversationNote ? [conversationNote] : []),
      ...(scheduleNote ? [scheduleNote] : []),
    ],
  });
  // His own edit this turn: a "send it" in the same message may now confirm this draft.
  noteDraftEditedThisTurn(turn?.confirmation, savedDraftId);

  return JSON.stringify({
    draft_id: savedDraftId,
    account: account.id,
    tag: account.tag,
    to: safeHeader(to),
    cc: cc ? safeHeader(cc) : null,
    ...(leavesThread ? { new_conversation: conversationNote } : {}),
    ...(sync.kind === "none" ? {} : { schedule: sync.kind, scheduled_email: scheduleNote }),
  });
}
