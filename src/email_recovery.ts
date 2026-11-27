import {
  db, getClosedEmailContext, getCommandChoice, getSalesSequence, getSalesSequenceByThread, getScheduledSend,
  latestDraftAction, pendingActionForCommandKey, recordedClosedEmail,
  unconfirmedDraftDelivery, type GoogleAccountId,
} from "./db.js";
import { parseAddressList } from "./address_list.js";
import { confirmsExistingDraft } from "./email_references.js";
import { emailOutcomeTime, EmailOperationError, type EmailFailureReason, type EmailTurnOutcomes } from "./email_outcomes.js";
import type { ToolTurn } from "./tools/index.js";

const EMAIL_WRITE_TOOLS = new Set([
  "send_email", "draft_new_email", "draft_reply", "update_draft",
  "confirm_send_pending_draft", "start_sequence",
]);

export function hasEmailRecovery(tool: string): boolean {
  return EMAIL_WRITE_TOOLS.has(tool);
}

type ReadAction = { tool: "read_email" | "read_draft" | "search_emails"; arguments: Record<string, string> };
type NextAction = ReadAction | { tool: "resend_draft_card" | "draft_reply"; arguments: Record<string, string> } | { owner_input: string };

export interface EmailRecovery {
  reason: EmailFailureReason;
  state: Record<string, string | number | null>;
  next: NextAction;
  read_only: boolean;
  terminal: boolean;
  userMessage: string;
}

export function recordEmailRecovery(journal: EmailTurnOutcomes, recovery: EmailRecovery): void {
  if (recovery.read_only) journal.uncertain = true;
  journal.notices.add(recovery.userMessage);
}

function textField(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function recipientField(input: unknown): string | undefined {
  const to = (input as { to?: unknown } | null)?.to;
  if (!Array.isArray(to)) return textField(input, "to") ?? textField(input, "prospect");
  return to.filter((item): item is string => typeof item === "string").join(", ") || undefined;
}

function commandRecord(account: GoogleAccountId, turn: ToolTurn) {
  if (!turn.confirmation) return undefined;
  const { chatId, messageId } = turn.confirmation;
  return db.prepare(`SELECT idem_key, status, thread_id, sent_message_id, sent_at FROM command_sends
    WHERE account = ? AND idem_key GLOB ? ORDER BY id DESC LIMIT 1`)
    .get(account, `msg:${chatId}:${messageId}:*`) as {
      idem_key: string; status: string; thread_id: string | null; sent_message_id: string | null; sent_at: string | null;
    } | undefined;
}

/** Existing plain replies are still consumed by pre-routing and the receipt check. */
function legacyFailure(message: string): EmailFailureReason | undefined {
  if (/^(?:\{|Sent (?:to|the draft)|Draft created|Draft saved|Scheduled:|Start card sent|Started |Enrolled )/i.test(message)) return undefined;
  if (/only Vishnu|only your own|didn't come straight|forwarded|can't confirm a send|only allowed after.*approval/i.test(message)) return "not_authorized";
  if (/not confirmed|didn't confirm|already being (?:sent|processed)|may or may not|(?:still|already) going out/i.test(message)) return "write_unconfirmed";
  if (/^(?:New address:|Ready to schedule)|waiting on your Confirm|Tap Send|Tap Confirm/i.test(message)) return "approval_required";
  if (/already (?:handled|started|sent)|not (?:sent|scheduled) again/i.test(message)) return "already_handled";
  if (/draft was replaced|already went out|draft was never sent|cancelled|superseded/i.test(message)) return "draft_closed";
  if (/couldn't (?:re-read|read|check)|couldn't write the email|no email to |couldn't find/i.test(message)) return "provider_read_failed";
  if (/No draft is waiting|draft_id is not in|missing.*draft/i.test(message)) return "draft_missing";
  if (/Which |more than one|matches several/i.test(message)) return "choice_required";
  if (/^Not started for |caps follow-ups|only run from your work mailbox|more than \d+ emails/i.test(message)) return "excluded";
  if (/\b(?:pass|give me|say who|who should|what it should say|give the|ask him|must be|specify)\b/i.test(message)) return "input_needed";
  if (/nothing (?:has |is )?|no follow-ups|no card sent|one person per message|not in the pending set/i.test(message)) return "refused";
  return "refused";
}

export function emailRecoveryFor(tool: string, input: unknown, turn: ToolTurn, content: string, failure?: EmailOperationError, isError?: boolean): EmailRecovery | undefined {
  if (!hasEmailRecovery(tool)) return undefined;
  const reason = failure?.reason ?? (isError && !content.trim() ? "input_needed" : legacyFailure(content));
  if (!reason) return undefined;
  const userMessage = failure?.message ?? content;
  // A refused grant must not disclose records for identifiers guessed by a caller.
  if (reason === "not_authorized") return {
    reason, state: { status: "not_authorized" }, terminal: true, read_only: false,
    next: { owner_input: "A fresh instruction in Vishnu's own chat is required." }, userMessage,
  };

  const evidence = failure?.evidence;
  const accountArg = evidence?.account ?? textField(input, "account");
  const mailbox = accountArg === "personal" ? "personal" : "work";
  const command = tool === "send_email" ? commandRecord(mailbox, turn) : undefined;
  const commandDraft = command ? pendingActionForCommandKey(command.idem_key) : undefined;
  const draftId = evidence?.draftId ?? textField(input, "draft_id") ?? commandDraft?.draft_id ?? undefined;
  const draft = draftId ? latestDraftAction(draftId, accountArg === "personal" || accountArg === "work" ? accountArg : undefined) : undefined;
  const account = draft?.google_account ?? mailbox;
  const last = turn.confirmation ? getClosedEmailContext(turn.confirmation.chatId) : undefined;
  const closed = (draftId ? recordedClosedEmail({ account, draftId }) : undefined) ??
    (last && (draftId ? last.draftId === draftId && last.account === account : confirmsExistingDraft(turn.userText ?? "")) ? last : undefined);
  const boundSchedule = evidence?.scheduleId ? getScheduledSend(evidence.scheduleId) :
    draftId ? db.prepare(`SELECT id, status, send_at FROM scheduled_sends
      WHERE json_valid(request)
        AND json_extract(request, '$.draftId') = ?
        AND json_extract(request, '$.account') = ?
      ORDER BY id DESC LIMIT 1`).get(draftId, account) as { id: number; status: string; send_at: string } | undefined
      : undefined;
  const uncertainty = draftId ? unconfirmedDraftDelivery(draftId, account) : undefined;
  const recipient = closed?.to ?? draft?.live_to_header ?? draft?.to_header ?? evidence?.recipient ?? recipientField(input);
  const threadId = closed?.threadId ?? draft?.thread_id ?? command?.thread_id ?? evidence?.threadId ?? textField(input, "thread_id");
  const sentId = closed?.sentMessageId ?? draft?.sent_message_id ?? command?.sent_message_id;
  const sentAt = closed?.sentAt ?? draft?.sent_at ?? command?.sent_at;
  const seq = tool === "start_sequence"
    ? evidence?.sequenceId ? getSalesSequence(evidence.sequenceId) : threadId ? getSalesSequenceByThread(threadId) : undefined
    : undefined;
  const choice = evidence?.choiceId ? getCommandChoice(evidence.choiceId) : undefined;
  const status = closed?.status ?? (uncertainty ? "unconfirmed" : undefined) ?? draft?.status ?? boundSchedule?.status ?? seq?.status ?? choice?.status ?? command?.status ?? "no_matching_record";
  const state: EmailRecovery["state"] = {
    status, account: closed?.account ?? account,
    ...(draftId ? { draft_id: draftId } : {}),
    ...(recipient ? { recipient } : {}),
    ...(threadId ? { thread_id: threadId } : {}),
    ...(sentId ? { sent_message_id: sentId } : {}),
    ...(sentAt ? { sent_at: sentAt, sent_at_ist: emailOutcomeTime(sentAt) ?? null } : {}),
    ...(uncertainty ? { attempted_at: uncertainty.attempted_at } : {}),
    ...(draft?.telegram_message_id ? { card_message_id: draft.telegram_message_id, card_state: "shown" } : {}),
    ...(boundSchedule ? { schedule_id: boundSchedule.id, schedule_status: boundSchedule.status, send_at: boundSchedule.send_at } : {}),
    ...(seq ? { sequence_id: seq.id, sequence_status: seq.status, recipient: seq.prospect_email, thread_id: seq.thread_id,
      ...(seq.card_message_id ? { card_message_id: seq.card_message_id, card_state: "shown" } : {}) } : {}),
    ...(choice ? { choice_id: choice.id, choice_status: choice.status } : {}),
  };
  const addresses = parseAddressList(recipient ?? "").map(item => item.email);
  const subject = (textField(input, "subject") ?? draft?.subject)?.replace(/["\\\r\n]/g, " ");
  const target = addresses[0] ?? (tool === "start_sequence" ? recipient?.replace(/["\\\r\n]/g, " ").trim() : undefined);
  const location = evidence?.lookup ?? (tool === "start_sequence" || status === "sent" || uncertainty ? "sent" : "anywhere");
  const query = [`in:${location}`,
    target ? `to:"${target}"` : "",
    subject ? `subject:"${subject}"` : "", "newer_than:30d"].filter(Boolean).join(" ");
  const search: ReadAction = { tool: "search_emails", arguments: { query, account: closed?.account ?? account } };
  const readDraft: ReadAction = { tool: "read_draft", arguments: draftId ? { draft_id: draftId } : {} };
  const readSent: ReadAction = sentId
    ? { tool: "read_email", arguments: { id: sentId, account: closed?.account ?? account } }
    : search;
  const readOnly = reason === "write_unconfirmed" || (status !== "sent" && command?.status === "unconfirmed") || Boolean(uncertainty);
  if (status === "sent") {
    state.reply_context = threadId ? "Use this mailbox, thread and recipient for a fresh reply. Read the latest inbound message before drafting."
      : "The historical row has no thread ID. Read the sent message to recover it before drafting a reply.";
    return { reason: "draft_closed", state, next: readSent, read_only: readOnly, terminal: true, userMessage };
  }
  const sourceMessage = evidence?.messageId ?? textField(input, "email_id");
  let next: NextAction;
  if (readOnly) next = draftId && tool === "update_draft" && !uncertainty ? readDraft : search;
  else if (reason === "approval_required") next = { owner_input: tool === "start_sequence" ? "Wait for Vishnu to tap Start." : "Wait for Vishnu to tap Send or Confirm on the shown card." };
  else if (reason === "choice_required" && choice) next = { owner_input: "Wait for Vishnu to choose the intended address on the posted card." };
  else if (reason === "choice_required" || reason === "input_needed") next = { owner_input: userMessage.replace(/\bTry again\./gi, "").trim() };
  else if (reason === "card_not_shown" && draftId) next = draft?.telegram_message_id
    ? { tool: "resend_draft_card", arguments: { draft_id: draftId } }
    : readDraft;
  else if (reason === "provider_read_failed" && (tool === "draft_reply" || tool === "start_sequence") && sourceMessage) next = { tool: "read_email", arguments: { id: sourceMessage, account } };
  else if ((reason === "provider_read_failed" || reason === "provider_rejected") && draftId && status !== "superseded" && status !== "discarded") next = readDraft;
  else if (reason === "refused" || reason === "excluded" || reason === "already_handled") {
    next = { owner_input: reason === "excluded" ? "A different eligible thread in work Sent mail is required."
      : reason === "already_handled" ? "No further confirmation is needed for this command." : userMessage };
  } else next = search;
  return {
    reason, state, next, read_only: readOnly,
    terminal: readOnly || ["approval_required", "excluded", "refused", "choice_required", "already_handled", "draft_closed"].includes(reason),
    userMessage,
  };
}

export function emailRecoveryForModel(recovery: EmailRecovery): string {
  const { userMessage: _userMessage, ...modelOnly } = recovery;
  return `\n\nEmail recovery (recorded data and next step): ${JSON.stringify(modelOnly)}`;
}
