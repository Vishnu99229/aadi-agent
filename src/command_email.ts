import { Api, InlineKeyboard, type Context } from "grammy";
import type { gmail_v1 } from "googleapis";
import {
  asksForAttachment,
  deliveryTimeHold,
  isAutomatedAddress,
  mentionsSendDate,
  nameTokens,
  namedInOwnWords,
  notAnEventCommand,
  notASendCommand,
  splitOwnerEmailCommand,
} from "./command_logic.js";
import {
  authorizationWords,
  clearPendingAction,
  explicitEmailField,
  getPendingAction,
  holdEmailToolTurn,
  linkPublishedDraft,
  lockedScheduleForDraft,
  matchOwnerSupplied,
  pendingResolvedEmails,
  rememberBookedMeeting,
  rememberScheduledSend,
  savePendingAction,
  scheduleSyncNotice,
  syncDraftRecipient,
  tooLateText,
  type ResolvedAttendee,
} from "./action_context.js";
import { rememberContactChoice, resolveContact } from "./contacts.js";
import { resolveRecipient, type RecipientMatch } from "./command_recipients.js";
import { confirmsExistingDraft, emailReferenceForTurn, refersToEarlierEmail, repliedMessageForTurn } from "./email_references.js";
import { writeCommandEmail } from "./command_writer.js";
import { knownRecipients, markRecipientsKnown } from "./known_recipients.js";
import { cardReason, decideSendAction, type SendVerdict } from "./security/send_decision.js";
import { choiceCardKey, postConfirmCard } from "./confirm_cards.js";
import { withoutFollowupClause } from "./command_intent.js";
import { followupsAfterSend } from "./sequences.js";
import { mailDomainRefusal } from "./email_grounding.js";
import { looksLikeTimeFill } from "./time_parse.js";
import { config } from "./config.js";
import {
  closeCommandChoice,
  createCommandChoice,
  createScheduledSend,
  getCommandChoice,
  getCommandSendByKey,
  sentMessageForDraft,
  setCommandSendTelegramMessage,
  listOpenCommandChoices,
  setPendingActionFollowups,
  draftRecipientsShownBefore,
  claimCommandSend,
  releaseCommandSend,
  pendingActionForCommandKey,
  latestDraftAction,
  pendingDraftActionForMessage,
  scheduledSendByKey,
  cardRecipientsForMessage,
  type PendingAction,
} from "./db.js";
import { formatMailbox, formatMailboxList } from "./draft_recipients.js";
import { parseAddressList, type ParsedMailbox } from "./address_list.js";
import { getSentThreadMetadata, loadFollowupSelfAddresses } from "./mail_helpers.js";
import { messageHeader } from "./gmail_attachments.js";
import { getGoogleAccount, type GoogleAccountId, type LoadedGoogleAccount } from "./google/auth.js";
import {
  createNewEmailDraft,
  createThreadReplyDraft,
  gmailClient,
  messageHeader as draftHeader,
  plainTextBody,
  resolveGmailDraft,
  signatureHtmlFor,
  signaturePlainText,
  stripSignature,
} from "./google/mail.js";
import { isSelfEmail } from "./mom_logic.js";
import { bookResolvedMeeting, freeSlotsText, parseCommandTimes } from "./owner_meeting.js";
import {
  CommandSendRefusedError,
  CommandSendRejectedError,
  CommandSendUnconfirmedError,
  evaluateCommandSendGate,
  sendCommandEmail,
} from "./security/command_send.js";
import { SendNotApprovedError } from "./security/send_approval.js";
import { installCaptionEditFallback } from "./telegram_io.js";
import { assertTestSeam } from "./test_seam.js";
import {
  claimRecipientDelivery, DRAFT_REPLACED, DRAFT_REREAD_FAILED, editAndSendPendingDraft,
  eligibleDrafts, pickLatestDraft, queueDraftApproval, repostPendingCard, sendPendingDraftByText, showReplacedDrafts,
} from "./approvals.js";
import { holdForVoiceNote } from "./voice_cards.js";
import { sameConversation } from "./subject_logic.js";
import type { ToolTurn } from "./tools/index.js";

const CHOICE_TTL_MS = 6 * 60 * 60 * 1000;
const TELEGRAM_BODY_CHARS = 3400;
const MAX_BUTTONS = 8;

/** What happened, in words for Vishnu. The hint is only for the chat model. */
export interface Outcome {
  text: string;
  hint?: string;
  /** He has already seen this in Telegram. */
  shown?: boolean;
  result?: "sent" | "not_sent" | "unknown" | "write_failed" | "cancelled";
  messageId?: string;
  /** The same command again: its follow-ups were handled the first time. */
  repeat?: boolean;
}

function asToolResult(outcome: Outcome): string {
  return outcome.hint ? `${outcome.text} ${outcome.hint}` : outcome.text;
}

export interface RecipientSlot {
  query: string;
  mailbox?: ParsedMailbox;
  options?: ParsedMailbox[];
  /** The addresses he chose between, so the same choice isn't asked again at fire time. */
  seen?: ParsedMailbox[];
}

export interface CommandRequest {
  to: RecipientSlot[];
  cc: RecipientSlot[];
  threadId: string | null;
  instruction: string;
  ownWords: string;
  account: GoogleAccountId;
  kind?: "email" | "meeting";
  meeting?: { title?: string; startIso: string; endIso: string };
  /** Present on a scheduled email. */
  sendAt?: string;
  subject?: string;
  /** A scheduled email made from this Gmail draft, named explicitly and checked against
   *  its mailbox and people. The only link between a draft and a schedule. */
  draftId?: string;
  /** He changed the subject himself. A reply whose subject no longer matches its thread
   *  goes out as a new conversation, with exactly his subject. */
  subjectEdited?: boolean;
  finalSubject?: string;
  /** The thread's subject when a reply was scheduled. */
  threadSubject?: string;
  /** It came straight from his own chat turn (dispatch's mark), not a delegated goal. */
  ownTurn?: boolean;
  /** Addresses he confirmed by a tap (an offered address button, or Confirm on a held
   *  schedule), or that were known when he scheduled it. */
  confirmedRecipients?: string[];
  /** His whole message, when it also asked for follow-ups: they ride on the card. */
  followupWords?: string;
}

let telegram: Api | undefined;

export function setCommandEmailTestHooks(hooks: { telegram?: Api }): void {
  assertTestSeam("setCommandEmailTestHooks");
  telegram = hooks.telegram;
}

export function commandApi(): Api {
  if (!telegram) {
    telegram = new Api(config.telegramBotToken);
    installCaptionEditFallback(telegram);
  }
  return telegram;
}

const api = commandApi;

function mailboxFromContact(contact: {
  name: string;
  emails: string[];
}): ParsedMailbox {
  return { email: contact.emails[0]!.toLowerCase(), name: contact.name };
}

function matchFromContact(resolution: Awaited<ReturnType<typeof resolveContact>>): RecipientMatch {
  if (resolution.kind === "one") {
    return { kind: "one", mailbox: mailboxFromContact(resolution.contact) };
  }
  if (resolution.kind === "many") {
    return {
      kind: "many",
      options: resolution.options.map(mailboxFromContact),
    };
  }
  return { kind: "none" };
}

function stringList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return items
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

interface LiveThread {
  subject: string;
  inReplyTo: string;
  references: string;
  mailboxes: ParsedMailbox[];
}

/** Threading comes from the live thread, never from anything stored. */
export async function readThread(gmail: gmail_v1.Gmail, threadId: string): Promise<LiveThread | undefined> {
  const thread = await getSentThreadMetadata(gmail, threadId);
  const messages = (thread.messages ?? [])
    .filter((message) => !message.labelIds?.includes("DRAFT"))
    .sort((left, right) => Number(left.internalDate ?? 0) - Number(right.internalDate ?? 0));
  const latest = messages[messages.length - 1];
  if (!latest) {
    return undefined;
  }
  const mailboxes = new Map<string, ParsedMailbox>();
  for (const message of messages) {
    for (const header of ["From", "To", "Cc"]) {
      for (const mailbox of parseAddressList(messageHeader(message, header))) {
        mailboxes.set(mailbox.email, mailbox);
      }
    }
  }
  return {
    subject: messageHeader(messages[0]!, "Subject"),
    inReplyTo: messageHeader(latest, "Message-ID"),
    references: messageHeader(latest, "References"),
    mailboxes: [...mailboxes.values()],
  };
}

export function replySubject(subject: string): string {
  return /^re\s*:/i.test(subject) ? subject : `Re: ${subject}`;
}

function sendKey(base: string, to: readonly ParsedMailbox[]): string {
  return `${base}:${to.map((item) => item.email).sort().join(",")}`;
}

function shown(body: string): string {
  return body.length <= TELEGRAM_BODY_CHARS
    ? body
    : `${body.slice(0, TELEGRAM_BODY_CHARS)}…\n(cut here for Telegram; the whole email went out)`;
}

/** Writes the email and sends it. Everything that decides who gets it is already
 *  settled, and the writer can't change it. */
/**
 * The same send command again (Telegram redelivery, or his message replayed later):
 * at most one email per command. A command that became a card is answered from that
 * card: still waiting (the same card again, never a second draft), sent, or discarded
 * (he is asked before anything new is made). Undefined: this command is new.
 */
async function repeatedCommand(key: string): Promise<Outcome | undefined> {
  if (!getCommandSendByKey(key)) {
    return undefined;
  }
  const card = pendingActionForCommandKey(key);
  if (!card || card.status === "sent") {
    return { text: "Not sent again: this command was already handled.", result: "not_sent", repeat: true };
  }
  if (card.status === "superseded") return { text: DRAFT_REPLACED, result: "not_sent", repeat: true };
  let status = card.status;
  if (status === "pending") {
    const reposted = await repostPendingCard(card);
    if (reposted.state === "reposted") {
      console.log(`Command send: repeat of a command waiting on card ${card.id}; same card again`);
      const fresh = reposted.newAddresses.length > 0 ? ` New address: ${reposted.newAddresses.join(", ")}.` : "";
      return {
        text: `Not sent yet: it's waiting on the card I've posted again for ${reposted.to || card.to_header || "them"}.${fresh} Tap Send to confirm.`,
        hint: "Nothing has been sent and no new draft was made. Answer in one short line.",
        shown: true,
        repeat: true,
      };
    }
    if (reposted.state === "read_failed") {
      return { text: DRAFT_REREAD_FAILED, result: "not_sent", repeat: true };
    }
    if (reposted.state === "failed") {
      return {
        text: "Not sent yet: it's still waiting on its card above. Tap Send to confirm.",
        result: "not_sent", repeat: true,
      };
    }
    status = "expired";
  }
  return {
    text: status === "expired"
      ? "Not sent: the draft from this message expired, so nothing went out. Want me to make a new one?"
      : "Not sent: you discarded the draft from this message, so nothing went out. Want me to make a new one?",
    hint: "Ask him before making a new draft; don't make one now.",
    result: "not_sent", repeat: true,
  };
}

/** What he's told when the content gate (or a send check) refuses: the same words
 *  whether the email would have gone out directly or as a card. */
function gateRefusal(reason: string): Outcome {
  if (reason === "refers_to_attachment") {
    return {
      text: "Not sent: the email it wrote mentions an attachment and I can't attach anything, so nothing went out.",
      hint: "Ask Vishnu how he wants to handle the file.",
      result: "not_sent",
    };
  }
  return {
    text:
      reason === "already_handled"
        ? "Not sent again: this command was already handled."
        : `Not sent: a delivery check refused it (${reason}), so nothing went out.`,
    result: "not_sent",
    ...(reason === "already_handled" ? { repeat: true } : {}),
  };
}

/** The written email as a Gmail draft on its Send card. The tap sends it. */
async function showSendCard(input: {
  /** The command's key: claimed here exactly as a direct send would claim it. */
  key: string;
  request: CommandRequest;
  account: LoadedGoogleAccount;
  confirmation: { chatId: number; messageId: number } | undefined;
  verdict: Exclude<SendVerdict, { action: "send" }>;
  toHeader: string;
  ccHeader: string;
  subject: string;
  body: string;
  reply?: { threadId: string; inReplyTo: string; references: string };
}): Promise<Outcome> {
  // One command, at most one email: the key is claimed before any draft exists, so a
  // repeat of this command finds this card instead of making another.
  if (!claimCommandSend({ key: input.key, account: input.account.id, threadId: input.request.threadId })) {
    return (await repeatedCommand(input.key)) ?? { text: "Not sent again: this command was already handled.", result: "not_sent" };
  }
  const signatureHtml = await signatureHtmlFor(input.account);
  let draftId: string;
  try {
    draftId = input.reply
      ? (
          await createThreadReplyDraft({
            account: input.account,
            threadId: input.reply.threadId,
            to: input.toHeader,
            cc: input.ccHeader || undefined,
            subject: input.subject,
            inReplyTo: input.reply.inReplyTo,
            references: input.reply.references,
            body: input.body,
            signatureHtml,
          })
        ).draftId
      : (
          await createNewEmailDraft({
            account: input.account,
            to: [input.toHeader],
            cc: input.ccHeader ? [input.ccHeader] : undefined,
            subject: input.subject,
            body: input.body,
            signatureHtml,
          })
        ).draftId;
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(`Command send: card draft failed (${errorType})`);
    // No draft was made, so the same command may try again.
    releaseCommandSend(input.key);
    return { text: "Not sent: I couldn't save it as a draft for you to check, so nothing went out. Try again.", result: "not_sent" };
  }
  const signature = signaturePlainText(signatureHtml);
  let actionId: number;
  let replacementNotice = "";
  try {
    actionId = await queueDraftApproval({
      draftId,
      threadId: input.reply?.threadId ?? null,
      to: input.toHeader,
      cc: input.ccHeader || undefined,
      subject: input.subject,
      body: input.body,
      googleAccount: input.account.id,
      ...(signature ? { signature } : {}),
    }, { commandKey: input.key, onReplaced: (notice) => { replacementNotice = notice; } });
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(`Command send: card post failed (${errorType})`);
    const saved = latestDraftAction(draftId, input.account.id);
    if (!saved) {
      releaseCommandSend(input.key);
      return { text: ["Not sent: I saved a draft but couldn't show its card, so nothing went out. Try again.", replacementNotice].filter(Boolean).join("\n"), result: "not_sent" };
    }
    const text = saved.status === "superseded" ? DRAFT_REPLACED
      : "Not sent: I couldn't show its card. Ask me again and I'll show the same draft.";
    return { text: [text, replacementNotice].filter(Boolean).join("\n"), result: "not_sent" };
  }
  if (latestDraftAction(draftId, input.account.id)?.status === "superseded") {
    return { text: [DRAFT_REPLACED, replacementNotice].filter(Boolean).join("\n"), result: "not_sent" };
  }
  if (input.request.followupWords && input.confirmation) {
    setPendingActionFollowups(
      actionId,
      input.request.followupWords,
      `msg:${input.confirmation.chatId}:${input.confirmation.messageId}`,
    );
  }
  if (input.confirmation) {
    linkPublishedDraft({
      chatId: input.confirmation.chatId,
      draftId,
      to: input.toHeader,
      cc: input.ccHeader,
      subject: input.subject,
      body: input.body,
      account: input.account.id === "personal" ? "personal" : "work",
    });
  }
  console.log(`Command send: card instead of a send new=${input.verdict.action === "card" ? input.verdict.newAddresses.length : 0}`);
  const followups = input.request.followupWords ? " The follow-ups come as a Start card once it goes out." : "";
  return {
    text: [`${cardReason(input.verdict, input.toHeader)}${followups}`, replacementNotice].filter(Boolean).join("\n"),
    hint: "Nothing has been sent. He has the card; answer in one short line.",
    shown: true,
  };
}

/** The decision for an email he asked to send now: known or confirmed people only.
 *  Sending or scheduling a draft he was shown: whoever its card showed before this
 *  message counts as confirmed. */
async function sendVerdictFor(
  request: CommandRequest,
  confirmation: { chatId: number; messageId: number } | undefined,
): Promise<SendVerdict> {
  const recipients = [...request.to, ...request.cc].flatMap((slot) => (slot.mailbox ? [slot.mailbox.email] : []));
  const confirmed = new Set((request.confirmedRecipients ?? []).map((email) => email.toLowerCase()));
  if (request.draftId && confirmation) {
    for (const email of draftRecipientsShownBefore(request.draftId, confirmation.messageId)) {
      confirmed.add(email);
    }
  }
  return decideSendAction({
    intent: "send",
    ownTurn: request.ownTurn === true,
    recipients,
    known: await knownRecipients(recipients),
    confirmed,
  });
}

export async function writeAndSend(
  request: CommandRequest,
  base: string,
  confirmation: { chatId: number; messageId: number } | undefined,
  now: Date,
  options: {
    /** Runs once the email is written, right before Gmail. False stops the send. */
    beforeSend?: () => boolean;
    note?: string;
    /** A finished subject and body. Skips a fresh rewrite from older instructions. */
    prepared?: { subject: string; body: string };
    /** A subject he changed himself. On a reply it wins over the thread's, and if it no
     *  longer matches the thread the email goes out as a new conversation. */
    explicitSubject?: string;
    /** decideSendAction's answer for these recipients. Anything but "send" leaves the
     *  written email as a draft with its card. */
    verdict: SendVerdict;
  },
): Promise<Outcome> {
  const to = request.to.map((slot) => slot.mailbox!);
  const cc = request.cc.map((slot) => slot.mailbox!);
  const domainRefusal = await mailDomainRefusal([...to, ...cc].map((item) => item.email));
  if (domainRefusal) {
    return { text: domainRefusal, result: "not_sent" };
  }
  const key = sendKey(base, to);
  const repeat = await repeatedCommand(key);
  if (repeat) {
    return repeat;
  }
  const account = await getGoogleAccount(request.account);
  const gmail = gmailClient(account);
  let thread: LiveThread | undefined;
  if (request.threadId) {
    try {
      thread = await readThread(gmail, request.threadId);
    } catch (error) {
      const errorType = error instanceof Error ? error.name : "UnknownError";
      console.error(`Command send: thread read failed (${errorType})`);
    }
    if (!thread) {
      return {
        text: "Not sent: I couldn't read that thread, so nothing went out.",
        hint: "Ask Vishnu which thread he means.",
        result: "not_sent",
      };
    }
    const onThread = new Set(thread.mailboxes.map((item) => item.email));
    if (!to.some((item) => onThread.has(item.email))) {
      return {
        text: `Not sent: ${formatMailboxList(to)} isn't on that thread, so nothing went out.`,
        hint: "Ask Vishnu whether this is the right thread.",
        result: "not_sent",
      };
    }
  }

  let written: { subject: string; body: string };
  if (options.prepared?.body.trim()) {
    written = { subject: options.prepared.subject, body: options.prepared.body };
  } else try {
    written = await writeCommandEmail({
      gmail,
      ownWords: request.ownWords,
      instruction: request.instruction,
      recipientNames: [...request.to, ...request.cc].map((slot) => slot.mailbox!.name || slot.query),
      recipientAddresses: [...to, ...cc].map((item) => item.email),
      threadId: request.threadId,
      now,
    });
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(`Command send: writer failed (${errorType})`);
    return {
      text: "Not sent: I couldn't write the email (Claude didn't answer), so nothing went out. Try again.",
      result: "write_failed",
    };
  }

  const explicit = options.explicitSubject?.trim();
  // Gmail keeps a reply in its thread only while the subject matches, so a changed subject
  // is sent as a new conversation: no thread id and no reply headers.
  const newConversation = Boolean(thread && explicit && !sameConversation(explicit, thread.subject));
  const subject = newConversation
    ? explicit!
    : thread
      ? replySubject(thread.subject)
      : explicit || options.prepared?.subject.trim() || request.subject?.trim() || written.subject;
  const toHeader = formatMailboxList(to);
  const ccHeader = formatMailboxList(cc);
  const selfAddresses = await loadFollowupSelfAddresses();
  const named = new Set([...to, ...cc].map((item) => item.email));
  const leftOff = (newConversation ? [] : thread?.mailboxes ?? []).filter(
    (item) =>
      !named.has(item.email) &&
      !selfAddresses.has(item.email) &&
      !isSelfEmail(item.email) &&
      !isAutomatedAddress(item.email),
  );
  // One content gate for both routes, on the written email, before it can go out
  // directly or become a card: a refusal here makes no draft and no card.
  const gate = evaluateCommandSendGate({
    enabled: config.sendOnCommandEnabled,
    to: toHeader,
    cc: ccHeader,
    resolved: named,
    subject,
    body: written.body,
    threadId: newConversation ? null : request.threadId,
    inReplyTo: newConversation ? "" : thread?.inReplyTo ?? "",
  });
  if (!gate.ok) {
    console.log(`Command send: content gate refused reason=${gate.reason}`);
    return gateRefusal(gate.reason);
  }
  if (options.verdict.action !== "send") {
    // Nothing goes out: the email he asked for waits as a draft on its card.
    return showSendCard({
      key,
      request,
      account,
      confirmation,
      verdict: options.verdict,
      toHeader,
      ccHeader,
      subject,
      body: written.body,
      reply: !newConversation && thread ? { threadId: request.threadId!, inReplyTo: thread.inReplyTo, references: thread.references } : undefined,
    });
  }
  const signatureHtml = await signatureHtmlFor(account);
  const release = claimRecipientDelivery(account.id, toHeader);
  if (!release) {
    if (getCommandSendByKey(key)) return gateRefusal("already_handled");
    return { text: "Not sent: another email to that recipient is already going out.", result: "cancelled" };
  }
  let messageId: string;
  let replacedDrafts: PendingAction[];
  try {
    if (options.beforeSend && !options.beforeSend()) {
      return { text: "Not sent: it was cancelled.", result: "cancelled" };
    }
    ({ messageId, replacedDrafts } = await sendCommandEmail({
      decision: options.verdict,
      key,
      confirmation,
      account,
      to: toHeader,
      cc: ccHeader,
      resolved: named,
      subject,
      body: written.body,
      signatureHtml,
      threadId: newConversation ? null : request.threadId,
      inReplyTo: newConversation ? "" : thread?.inReplyTo ?? "",
      references: newConversation ? "" : thread?.references ?? "",
      sourceDraftId: request.draftId,
    }));
  } catch (error) {
    if (error instanceof CommandSendRefusedError) {
      return gateRefusal(error.reason);
    }
    if (error instanceof CommandSendRejectedError) {
      return {
        text: `Not sent: Gmail refused the email (${error.status}), so nothing went out.`,
        result: "not_sent",
      };
    }
    if (error instanceof CommandSendUnconfirmedError) {
      return {
        text: "Not confirmed: Gmail didn't answer, so the email may or may not have gone out. I won't resend it. Check your Sent mail.",
        result: "unknown",
      };
    }
    if (error instanceof SendNotApprovedError) {
      return {
        text: "Not sent: that didn't come from your own message, so nothing went out.",
        result: "not_sent",
      };
    }
    throw error;
  } finally {
    release();
  }

  markRecipientsKnown([...to, ...cc].map((item) => item.email));
  const replacementNotice = await showReplacedDrafts(replacedDrafts);
  const lines = [
    `Sent to ${toHeader}.`,
    ...(ccHeader ? [`Cc: ${ccHeader}`] : []),
    `Subject: ${subject}`,
    ...(newConversation ? ["Sent as a new conversation, because the subject no longer matches the thread."] : []),
    ...(leftOff.length > 0 ? [`Left off the thread: ${formatMailboxList(leftOff)}`] : []),
    ...(options.note ? [options.note] : []),
    ...(replacementNotice ? [replacementNotice] : []),
  ];
  const summary = lines.join("\n");
  try {
    const full = `${summary}\n\n${shown(written.body)}`;
    // Which message said it went out, so a reply to it can name this email.
    const noted = (telegramMessageId: number): void => {
      try {
        setCommandSendTelegramMessage(key, telegramMessageId);
      } catch {
        console.error("Command send: sent note not recorded");
      }
    };
    if (!holdForVoiceNote({ text: full, caption: summary, onPosted: noted })) {
      const posted = await api().sendMessage(config.ownerTelegramId, full);
      noted(posted.message_id);
    }
    return {
      text: summary,
      hint: "Vishnu has already been shown the full email. Answer in one short line and don't repeat it.",
      shown: true,
      result: "sent",
      messageId,
    };
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(`Command send: confirmation failed (${errorType})`);
    return {
      text: `${summary}\n\n${written.body}`,
      hint: "Give him this text as it is.",
      result: "sent",
      messageId,
    };
  }
}

function notDone(request: CommandRequest): string {
  if (request.sendAt) {
    return "Not scheduled";
  }
  return request.kind === "meeting" ? "Not booked" : "Not sent";
}

export function scheduledWhen(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(new Date(iso))
    .replace(/,/g, "")
    .replace(/ at /, " ");
}

/** Saved, with a visible task, once every recipient is settled. The email itself is
 *  written when it goes out, so it reflects whatever has changed by then. */
function addressSet(items: readonly { email: string }[]): string {
  return [...new Set(items.map((item) => item.email.toLowerCase()))].sort().join(",");
}

/**
 * The draft he named for this schedule, checked: it is in the mailbox the email will go
 * from, and it is addressed to exactly the people his own words resolved to. Its wording
 * as it stands now, including any edits made before scheduling, becomes the scheduled copy.
 */
async function draftForSchedule(
  request: CommandRequest,
): Promise<{ subject: string; body: string; threadId: string | null } | string> {
  const draftId = request.draftId!;
  if (latestDraftAction(draftId, request.account)?.status === "superseded") return DRAFT_REPLACED;
  let found: Awaited<ReturnType<typeof resolveGmailDraft>>;
  try {
    found = await resolveGmailDraft(draftId, request.account);
  } catch {
    return `Not scheduled: I couldn't find that draft in your ${request.account} mailbox, so nothing was scheduled.`;
  }
  if (found.account.id !== request.account) {
    return `Not scheduled: that draft is in a different mailbox, so nothing was scheduled.`;
  }
  const message = found.draft.message;
  const headers = message?.payload?.headers;
  const draftTo = parseAddressList(draftHeader(headers, "To"));
  const draftCc = parseAddressList(draftHeader(headers, "Cc"));
  const to = request.to.map((slot) => slot.mailbox!);
  const cc = request.cc.map((slot) => slot.mailbox!);
  if (addressSet(draftTo) !== addressSet(to) || addressSet(draftCc) !== addressSet(cc)) {
    const shown = [formatMailboxList(draftTo), draftCc.length ? `Cc ${formatMailboxList(draftCc)}` : ""].filter(Boolean).join(", ");
    return `Not scheduled: that draft is addressed to ${shown || "nobody"}, not ${formatMailboxList([...to, ...cc])}, so nothing was scheduled.`;
  }
  const body = stripSignature(plainTextBody(message?.payload ?? {}).trim()).body.trim();
  if (!body) {
    return "Not scheduled: that draft is empty, so nothing was scheduled.";
  }
  const replyThread = draftHeader(headers, "In-Reply-To") ? message?.threadId ?? null : null;
  if (replyThread && request.threadId && replyThread !== request.threadId) {
    return "Not scheduled: that draft replies on a different thread, so nothing was scheduled.";
  }
  return { subject: draftHeader(headers, "Subject").trim(), body, threadId: request.threadId ?? replyThread };
}

async function scheduleRequest(
  request: CommandRequest,
  base: string,
  confirmation: { chatId: number; messageId: number } | undefined,
): Promise<Outcome> {
  if (!confirmation) {
    return { text: "Not scheduled: only Vishnu's own message can do that." };
  }
  const domainRefusal = await mailDomainRefusal(
    [...request.to, ...request.cc].flatMap((slot) => (slot.mailbox ? [slot.mailbox.email] : [])),
  );
  if (domainRefusal) {
    return { text: domainRefusal, result: "not_sent" };
  }
  const to = request.to.map((slot) => slot.mailbox!);
  let draft: { subject: string; body: string } | undefined;
  if (request.draftId) {
    const checked = await draftForSchedule(request);
    if (typeof checked === "string") {
      return { text: checked, hint: "Tell Vishnu as it is. Nothing was scheduled." };
    }
    draft = checked;
    request = { ...request, threadId: checked.threadId, subject: checked.subject || request.subject };
  }
  let subject = request.subject?.trim() ?? "";
  if (request.threadId) {
    const gmail = gmailClient(await getGoogleAccount(request.account));
    const thread = await readThread(gmail, request.threadId).catch(() => undefined);
    if (!thread) {
      return {
        text: "Not scheduled: I couldn't read that thread.",
        hint: "Ask Vishnu which thread he means.",
      };
    }
    const onThread = new Set(thread.mailboxes.map((item) => item.email));
    if (!to.some((item) => onThread.has(item.email))) {
      return {
        text: `Not scheduled: ${formatMailboxList(to)} isn't on that thread.`,
        hint: "Ask Vishnu whether this is the right thread.",
      };
    }
    // A reply keeps the thread's "Re:" subject unless the draft he named carries a subject
    // he changed. That one is kept exactly, and the email will start a new conversation.
    if (draft?.subject && !sameConversation(draft.subject, thread.subject)) {
      subject = draft.subject;
      request = { ...request, subjectEdited: true };
    } else {
      subject = replySubject(thread.subject);
    }
    request = { ...request, threadSubject: thread.subject };
  }
  const shownSubject = subject || request.instruction.split(/\s+/).slice(0, 8).join(" ");
  const names = request.to.map((slot) => slot.mailbox!.name || slot.query).join(", ");
  const itemText = `Send email to ${names} — ${shownSubject} — ${scheduledWhen(request.sendAt!)}`;
  // Known people (or ones he tapped) are scheduled; a new address waits on his Confirm.
  const verdict = await sendVerdictFor(request, confirmation);
  const recipients = [...request.to, ...request.cc].flatMap((slot) => (slot.mailbox ? [slot.mailbox.email.toLowerCase()] : []));
  const held = verdict.action !== "send";
  if (!held) {
    request = { ...request, confirmedRecipients: [...new Set([...(request.confirmedRecipients ?? []), ...recipients])] };
  }
  if (request.draftId && latestDraftAction(request.draftId, request.account)?.status === "superseded") {
    return { text: DRAFT_REPLACED };
  }
  const scheduleKey = `${sendKey(base, to)}:${request.sendAt}`;
  const row = createScheduledSend({
    held,
    key: scheduleKey,
    sendAt: request.sendAt!,
    itemText,
    tag: request.account === "personal" ? "personal" : "work",
    request: JSON.stringify({
      ...request,
      subject,
      ...(draft ? { finalSubject: subject, finalBody: draft.body } : {}),
    }),
    confirmChat: confirmation.chatId,
    confirmMessage: confirmation.messageId,
  });
  if (!row) {
    // The same command again: one schedule per command. One still held for his Confirm
    // gets its Confirm card again, bound to the people it goes to now.
    const existing = scheduledSendByKey(scheduleKey);
    if (existing?.status === "held") {
      // The card shows, and its Confirm confirms, who the schedule goes to NOW (he may
      // have corrected it since): never the original wording alone.
      let current: Pick<CommandRequest, "to" | "cc">;
      try {
        current = JSON.parse(existing.request) as Pick<CommandRequest, "to" | "cc">;
      } catch {
        return { text: "Not scheduled again: this command was already handled.", repeat: true };
      }
      const text = `Not scheduled yet: ${existing.item_text}\nIt's waiting on your Confirm. Tap Confirm to schedule for ${scheduledWhen(existing.send_at)}.`;
      await postConfirmCard(
        {
          kind: "schedule_confirm",
          scheduleId: existing.id,
          to: formatMailboxList(current.to.flatMap((slot) => (slot.mailbox ? [slot.mailbox] : []))),
          cc: formatMailboxList(current.cc.flatMap((slot) => (slot.mailbox ? [slot.mailbox] : []))),
          headline: text,
        },
        { api: api() },
      );
      console.log(`Scheduled send ${existing.id}: repeat of a held command; Confirm card posted again`);
      return { text, hint: "Nothing is scheduled until he taps Confirm. Answer in one short line.", shown: true, repeat: true };
    }
    return { text: "Not scheduled again: this command was already handled.", repeat: true };
  }
  console.log(`Scheduled send ${row.id}: status -> ${held ? "held for confirm" : "scheduled"}`);
  rememberScheduledSend({
    chatId: confirmation.chatId,
    scheduledSendId: row.id,
    sendAt: request.sendAt!,
    to: formatMailboxList(to),
    subject: shownSubject,
    account: request.account === "personal" ? "personal" : "work",
    draftId: request.draftId,
    body: draft?.body,
  });
  if (held) {
    // Nothing is scheduled until his tap: the card says why and what it would do.
    const heldText =
      verdict.action === "card" && verdict.newAddresses.length > 0
        ? `New address: ${verdict.newAddresses.join(", ")}. Tap Confirm to schedule for ${scheduledWhen(request.sendAt!)}.`
        : `Ready to schedule for ${scheduledWhen(request.sendAt!)}, but this didn't come straight from your own message. Tap Confirm to schedule it.`;
    await postConfirmCard(
      {
        kind: "schedule_confirm",
        scheduleId: row.id,
        to: formatMailboxList(to),
        cc: formatMailboxList(request.cc.flatMap((slot) => (slot.mailbox ? [slot.mailbox] : []))),
        headline: heldText,
      },
      { api: api() },
    );
    return {
      text: heldText,
      hint: "Nothing is scheduled until he taps Confirm. Answer in one short line.",
      shown: true,
    };
  }
  const scheduledCard = {
    text: `Scheduled: ${itemText}`,
    caption: `Scheduled: ${itemText}`,
    keyboard: new InlineKeyboard().text("Cancel", `cmdsend:cancelsched:${row.id}`),
  };
  if (!holdForVoiceNote(scheduledCard)) {
    await api().sendMessage(config.ownerTelegramId, scheduledCard.text, {
      reply_markup: scheduledCard.keyboard,
    });
  }
  return {
    text: `Scheduled: ${itemText}`,
    hint: "It's on his task list, and he's been shown it with a Cancel button. Answer in one short line.",
    shown: true,
  };
}

/** At send time: the people he confirmed when he scheduled it pass; anyone else must
 *  be known now. A schedule only exists once he asked for it himself. */
export async function scheduledSendVerdict(request: CommandRequest): Promise<SendVerdict> {
  const recipients = [...request.to, ...request.cc].flatMap((slot) => (slot.mailbox ? [slot.mailbox.email] : []));
  return decideSendAction({
    intent: "send",
    ownTurn: true,
    recipients,
    known: await knownRecipients(recipients),
    confirmed: new Set((request.confirmedRecipients ?? []).map((email) => email.toLowerCase())),
  });
}

async function finishRequest(
  request: CommandRequest,
  base: string,
  confirmation: { chatId: number; messageId: number } | undefined,
  now: Date,
): Promise<Outcome> {
  if (request.sendAt) {
    return scheduleRequest(request, base, confirmation);
  }
  if (request.kind !== "meeting") {
    return writeAndSend(request, base, confirmation, now, { verdict: await sendVerdictFor(request, confirmation) });
  }
  const attendees = request.to.map((slot) => slot.mailbox!);
  const result = await bookResolvedMeeting({
    key: sendKey(base, attendees),
    confirmation,
    title: request.meeting!.title,
    fallbackName: request.to[0]!.query,
    startIso: request.meeting!.startIso,
    endIso: request.meeting!.endIso,
    attendees,
    account: request.account === "personal" ? "personal" : "work",
    now,
  });
  if (result.booked && result.eventId && confirmation) {
    rememberBookedMeeting(confirmation.chatId, {
      eventId: result.eventId,
      accountId: request.account === "personal" ? "personal" : "work",
      title: request.meeting!.title ?? request.to[0]?.query ?? "Meeting",
      startIso: request.meeting!.startIso,
      attendees: attendees.map((person) => ({
        name: person.name || person.email,
        email: person.email.toLowerCase(),
      })),
    }, now);
  }
  return { text: result.text };
}

async function resolveNamedRecipient(input: {
  gmail: gmail_v1.Gmail;
  query: string;
  selfAddresses: ReadonlySet<string>;
  threadMailboxes?: readonly ParsedMailbox[];
}): Promise<RecipientMatch> {
  const threadMatch = await resolveRecipient(input);
  if (threadMatch.kind === "one") {
    return threadMatch;
  }
  // A typed address is already decided (including "that's me, don't send").
  if (parseAddressList(input.query).length > 0) {
    return threadMatch;
  }
  const fromIndex = matchFromContact(await resolveContact(input.query));
  // Gmail already found several different addresses: don't collapse them to one
  // canonical person.
  if (threadMatch.kind === "many") {
    return fromIndex.kind === "many" ? fromIndex : threadMatch;
  }
  if (fromIndex.kind === "one") {
    return fromIndex;
  }
  if (fromIndex.kind === "many") {
    return fromIndex;
  }
  return threadMatch;
}

/** Fills in each recipient it can. Collects genuine ambiguities and asks once. */
async function resolveAndContinue(
  request: CommandRequest,
  base: string,
  confirmation: { chatId: number; messageId: number } | undefined,
  now: Date,
): Promise<Outcome> {
  const account = await getGoogleAccount(request.account);
  const gmail = gmailClient(account);
  const selfAddresses = await loadFollowupSelfAddresses();
  let threadMailboxes: ParsedMailbox[] | undefined;
  if (request.threadId) {
    threadMailboxes = await readThread(gmail, request.threadId)
      .then((thread) => thread?.mailboxes)
      .catch(() => undefined);
  }
  const missing: string[] = [];
  const ambiguous: Array<{ slot: RecipientSlot; options: ParsedMailbox[] }> = [];
  const resolved: string[] = [];
  for (const slot of [...request.to, ...request.cc]) {
    if (slot.mailbox) {
      resolved.push(slot.mailbox.name || slot.query);
      continue;
    }
    const match = await resolveNamedRecipient({
      gmail,
      query: slot.query,
      selfAddresses,
      threadMailboxes,
    });
    if (match.kind === "one") {
      slot.mailbox = match.mailbox;
      rememberContactChoice(slot.query, {
        name: match.mailbox.name,
        emails: [match.mailbox.email],
        company: undefined,
        sources: ["gmail"],
      });
      resolved.push(match.mailbox.name || slot.query);
      continue;
    }
    if (match.kind === "none") {
      missing.push(slot.query);
      continue;
    }
    if (match.options.length > MAX_BUTTONS) {
      return {
        text: `${notDone(request)}: "${slot.query}" matches ${match.options.length} addresses, so nothing went out.`,
        hint: "Ask Vishnu for the person's full name or address.",
      };
    }
    slot.options = match.options;
    ambiguous.push({ slot, options: match.options });
  }
  if (ambiguous.length > 0) {
    const first = ambiguous[0]!;
    const choiceId = createCommandChoice(JSON.stringify(request), now.toISOString());
    const extra =
      ambiguous.length > 1
        ? `\nI also need to know which ${ambiguous
            .slice(1)
            .map((item) => item.slot.query)
            .join(", ")} you mean.`
        : "";
    const found =
      resolved.length > 0 ? `I resolved ${resolved.join(", ")}. ` : "";
    await postConfirmCard(
      {
        kind: "address_choice",
        choiceId,
        options: first.options,
        headline: `${found}Which ${first.slot.query}? Nothing has gone out.${extra}`,
      },
      { api: api() },
    );
    return {
      text: `${notDone(request)} yet: ${found}"${first.slot.query}" matches ${first.options.length} people and I've asked with buttons.${extra}`,
      hint: "Tell him to tap one, and don't pick one yourself.",
      shown: true,
    };
  }
  if (missing.length > 0) {
    return {
      text: `${notDone(request)}: I found no address for ${missing.map((name) => `"${name}"`).join(", ")}, so nothing went out.`,
      hint: "Ask Vishnu for the address.",
    };
  }
  return finishRequest(request, base, confirmation, now);
}

function ownerNamed(
  query: string,
  ownWords: string,
  contact: { email: string; name: string },
): boolean {
  if (/^(?:him|her|them|it)$/i.test(query.trim())) {
    return true;
  }
  if (/\b(?:this|that|the|same)\s+(?:email(?:\s+id)?|address)\b|\bemail i\b|\baddress i\b/i.test(query)) {
    return true;
  }
  const said = (token: string) =>
    new RegExp(`(?<![\\p{L}\\p{N}])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu").test(ownWords);
  const typed = parseAddressList(query)[0]?.email;
  if (typed && ownWords.toLowerCase().includes(typed)) {
    return true;
  }
  const spoken = nameTokens(query).filter((token) => token.length >= 3);
  const known = nameTokens(contact.name).filter((token) => token.length >= 3);
  const first = known[0];
  return (spoken.length > 0 && spoken.every(said)) || (first !== undefined && said(first));
}

/** Who he named, checked against his own words, or why it can't be used. An address
 *  Aadi already offered him counts, because he's answering that question. A
 *  previously resolved attendee on this workflow also counts, even if the email
 *  is not repeated in the latest message. */
function recipientSlots(
  queries: readonly string[],
  ownWords: string,
  now: Date,
  refusal: string,
  chatId?: number,
  messageId?: number,
): RecipientSlot[] | string {
  const open = listOpenCommandChoices(new Date(now.getTime() - CHOICE_TTL_MS).toISOString());
  const offeredIn = (address: string) =>
    open.filter((choice) => {
      const request = JSON.parse(choice.request) as CommandRequest;
      return [...request.to, ...request.cc].some((slot) =>
        (slot.options ?? []).some((option) => option.email === address),
      );
    });
  const answered = new Set<number>();
  const prior = pendingResolvedEmails(chatId, now);
  const referenced = emailReferenceForTurn(chatId, messageId, now.getTime());
  const slots: RecipientSlot[] = [];
  for (const query of queries) {
    const address = parseAddressList(query)[0]?.email;
    if (address && referenced && address === referenced) {
      slots.push({ query, mailbox: { email: address, name: "" } });
      continue;
    }
    const offers = address ? offeredIn(address) : [];
    const remembered = prior.get(query.trim().toLowerCase()) ?? (address ? prior.get(address) : undefined);
    const supplied = matchOwnerSupplied(chatId, query, now);
    if (supplied.kind === "many") {
      return `${refusal}: "${query}" matches more than one address Vishnu typed (${supplied.contacts.map((item) => item.email).join(", ")}). Ask which one.`;
    }
    if (address && offers.length > 0) {
      offers.forEach((choice) => answered.add(choice.id));
      slots.push({ query, mailbox: { email: address, name: "" } });
    } else if (remembered?.resolved) {
      slots.push({
        query,
        mailbox: { email: remembered.email, name: remembered.name },
      });
    } else if (supplied.kind === "one" && ownerNamed(query, ownWords, supplied.contact)) {
      slots.push({
        query,
        mailbox: { email: supplied.contact.email, name: supplied.contact.name },
      });
    } else if (namedInOwnWords(query, ownWords)) {
      slots.push({ query });
    } else {
      return `${refusal}: "${query}" isn't a name or address in Vishnu's own message, so nothing went out. Ask him who he means.`;
    }
  }
  // Answered by typing, so the old buttons can't act a second time.
  answered.forEach((id) => closeCommandChoice(id, "used"));
  return slots;
}

const DEFAULT_SEND_TIME = "10:00";
const MAX_SCHEDULE_DAYS = 370;

/** When a scheduled email goes out: undefined for now, or why it can't be used. */
function parseSendAt(
  sendOn: unknown,
  sendTime: unknown,
  now: Date,
): string | undefined | { refused: string } {
  if (typeof sendOn !== "string" || !sendOn.trim()) {
    return undefined;
  }
  const date = sendOn.trim();
  const time = typeof sendTime === "string" && sendTime.trim() ? sendTime.trim() : DEFAULT_SEND_TIME;
  const at = new Date(`${date}T${time.padStart(5, "0")}:00+05:30`);
  // Date normalizes impossible dates and 24:00. Require the same IST minute back.
  const local = new Date(at.getTime() + 330 * 60_000);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2}$/.test(time) ||
      Number.isNaN(at.getTime()) || local.toISOString().slice(0, 16) !== `${date}T${time.padStart(5, "0")}`) {
    return { refused: "Not scheduled: send_on must be YYYY-MM-DD and send_time HH:MM in IST." };
  }
  if (at.getTime() <= now.getTime()) {
    return { refused: "Not scheduled: that time has already passed. Ask Vishnu when he means." };
  }
  if (at.getTime() > now.getTime() + MAX_SCHEDULE_DAYS * 24 * 60 * 60 * 1000) {
    return { refused: "Not scheduled: that's over a year away. Ask Vishnu to confirm the date." };
  }
  return at.toISOString();
}

/** The owner's command, typed or spoken. */
function recipientEditAndSend(words: string): { field: "to" | "cc" | "bcc"; person: string; replace: boolean } | undefined {
  const clean = withoutFollowupClause(words).trim();
  const request = /^(.*?)\s*(?:,\s*|\s+)(?:and\s+then\s+|and\s+|then\s+)?send(?:\s+(?:it|(?:(?:this|that|the)\s+)?(?:e-?mail|draft|message|reply)))?(?:\s+now)?[.!]*$/i.exec(clean)?.[1]?.trim();
  if (!request) return undefined;
  const edit = request.replace(/^(?:please\s+)?(?:also\s+)?/i, "")
    .replace(/\s+(?:in|on|to)\s+(?:this|that|the)\s+(?:e-?mail|draft|message|reply)$/i, "");
  const explicit = explicitEmailField(edit);
  if (explicit) return { ...explicit, replace: false };
  const replacement = /^(?:change|switch|update)\s+(?:the\s+)?(?:to|recipient)\s+to\s+(.+)$/i.exec(edit)?.[1];
  if (replacement) return { field: "to", person: replacement, replace: true };
  const add = /^(cc|bcc|add)\s+(.+)$/i.exec(edit);
  if (!add?.[2] || /\b(?:meeting|calendar|attendee|task|reminder|point|paragraph|line|sentence|wording|phrase|bullet|section)\b|\b(?:saying|mention(?:ing)?|write|include)\b/i.test(add[2])) return undefined;
  return { field: add[1]?.toLowerCase() === "bcc" ? "bcc" : "cc", person: add[2], replace: false };
}

/** One interception point for both the chat entry and a model's send_email call. */
export async function handlePendingRecipientEdit(
  turn: FollowupTurn,
  replyToMessageId?: number,
  now = new Date(),
): Promise<string | undefined> {
  const words = turn.userText ?? "";
  const edit = recipientEditAndSend(words);
  if (!edit) return undefined;
  const confirmation = turn.confirmation;
  if (!confirmation || turn.ownTurn !== true) return "Only your own message can change and send a pending draft.";
  const stop = notASendCommand(words);
  if (stop) return `Not sent: ${stop}.`;
  const hold = deliveryTimeHold(words);
  if (hold) return hold;
  if (edit.field === "bcc") return "I can add them on Cc. Tell me if you'd like that.";
  if (asksForAttachment(words)) return "I haven't sent the draft. Add the attachment in Gmail first.";

  const shown = eligibleDrafts(confirmation);
  const replied = replyToMessageId === undefined ? undefined : pendingDraftActionForMessage(replyToMessageId);
  const focused = replyToMessageId === undefined ? getPendingAction(confirmation.chatId, now)?.email : undefined;
  const target = replied ?? (focused?.draftId ? latestDraftAction(focused.draftId, focused.account) : undefined);
  const action = target ? shown.find((draft) => draft.id === target.id)
    : replyToMessageId === undefined ? pickLatestDraft(shown) : undefined;
  if (!action?.draft_id) {
    if (target?.status === "superseded") return DRAFT_REPLACED;
    if (!target && replyToMessageId === undefined && shown.length > 1) return "Which draft should I update? Reply to its card.";
    return "No draft is waiting for your approval, so nothing was sent.";
  }
  if (parseAddressList(edit.person).length > 1) {
    return "I found more than one address in that recipient edit. Tell me which single address to add.";
  }
  const draftId = action.draft_id;
  const account = action.google_account;
  const locked = lockedScheduleForDraft(draftId, account);
  if (locked) return tooLateText(locked);
  const supplied = matchOwnerSupplied(confirmation.chatId, edit.person, now);
  if (supplied.kind === "many") return `Which ${edit.person}? ${supplied.contacts.map((contact) => contact.email).join(", ")}`;
  const match: RecipientMatch = supplied.kind === "one"
    ? { kind: "one", mailbox: { email: supplied.contact.email, name: supplied.contact.name } }
    : await resolveNamedRecipient({
        gmail: gmailClient(await getGoogleAccount(account)),
        query: edit.person, selfAddresses: await loadFollowupSelfAddresses(),
      });
  if (match.kind === "many") return `Which ${edit.person}? ${match.options.map(formatMailbox).join(", ")}`;
  if (match.kind === "none") return `I couldn't find an address for ${edit.person}. Which address should I add?`;
  const email = match.mailbox.email.trim().toLowerCase();
  if (parseAddressList(email)[0]?.email !== email || isSelfEmail(email)) return "I couldn't use that address. Which address should I add?";
  const refusal = await mailDomainRefusal([email]);
  if (refusal) return refusal;
  const result = await editAndSendPendingDraft(confirmation, action, { ...edit, field: edit.field, email }, (headers) =>
    scheduleSyncNotice(syncDraftRecipient({ chatId: confirmation.chatId, draftId, account, ...headers })),
  );
  return withFollowups(result.message, await followupsAfterDraftSend(turn, draftId, result.ok));
}

export async function sendEmailFromTool(
  input: unknown,
  /** directSend: a path with no model after it (the referenced-email send in bot.ts). */
  turn: Pick<ToolTurn, "confirmation" | "userText" | "ownTurn" | "modelCalled"> & { directSend?: boolean },
  now = new Date(),
): Promise<string> {
  if (!config.sendOnCommandEnabled) {
    return "Not sent: send-on-command is switched off. Use draft_new_email or draft_reply.";
  }
  const confirmation = turn.confirmation;
  if (!confirmation) {
    return "Not sent: only Vishnu's own message can send an email.";
  }
  const ownWords = turn.userText?.trim() ?? "";
  const edited = await handlePendingRecipientEdit(turn, repliedMessageForTurn(confirmation.chatId, confirmation.messageId), now);
  if (edited !== undefined) return edited;
  const command = splitOwnerEmailCommand(ownWords).command;
  const held = holdEmailToolTurn(confirmation.chatId, ownWords, now);
  if (held) {
    return held;
  }
  const notCommand = notASendCommand(ownWords);
  if (notCommand) {
    return `Not sent: ${notCommand}. Use the right tool, or ask him if he wants it sent now.`;
  }
  const values = (input ?? {}) as {
    to?: unknown;
    cc?: unknown;
    instruction?: unknown;
    thread_id?: unknown;
    account?: unknown;
    attachment_requested?: unknown;
    send_on?: unknown;
    send_time?: unknown;
    subject?: unknown;
    draft_id?: unknown;
  };
  if (values.attachment_requested === true || asksForAttachment(ownWords)) {
    return "Not sent: he asked for a file and I can't attach one here, so nothing went out. Ask him whether to send it without the file or draft it so he can add it.";
  }
  const pendingEmail = getPendingAction(confirmation.chatId, now)?.email;
  let when = parseSendAt(values.send_on, values.send_time, now);
  const deliveryHold = deliveryTimeHold(ownWords);
  if (deliveryHold && typeof when !== "string") {
    return deliveryHold;
  }
  if (typeof when === "object") {
    return when.refused;
  }
  if (
    pendingEmail?.needsFreshAuthorization &&
    pendingEmail.sendAt &&
    !(/\bsend\b/i.test(command) && /\bnow\b/i.test(command))
  ) {
    when = when ?? pendingEmail.sendAt;
  }
  // A follow-up clause ("... and start 3 follow-ups every Monday") is not a send date.
  if (when === undefined && mentionsSendDate(withoutFollowupClause(ownWords))) {
    return "Not sent: he gave a date or time, so nothing went out. Call send_email again with send_on, and send_time if he gave one.";
  }
  if (when === undefined && /\bschedule\b/i.test(command) && !/\bsend\s+(?:it\s+)?now\b/i.test(command)) {
    return "Not sent: he asked to schedule it, so nothing went out immediately. Ask him for the day and time.";
  }
  const referencedEmail = emailReferenceForTurn(confirmation.chatId, confirmation.messageId, now.getTime());
  if (
    when === undefined &&
    confirmsExistingDraft(ownWords) &&
    !referencedEmail &&
    pendingEmail?.draftId &&
    pendingEmail.scheduledSendId
  ) {
    const delivered = await sendPendingDraftByText(confirmation, pendingEmail.draftId, { ownTurn: turn.ownTurn === true });
    return withFollowups(delivered.message, await followupsAfterDraftSend(turn, pendingEmail.draftId, delivered.ok));
  }
  let toQueries = stringList(values.to);
  const ccQueries = stringList(values.cc);
  const instruction = typeof values.instruction === "string" ? values.instruction.trim() : "";
  if (referencedEmail) {
    // The owner's reference picked this one address. A model cannot substitute
    // a stale Gmail recipient or tack on people from an unrelated thread.
    const refersToSelected = toQueries.length === 1 &&
      (toQueries[0]!.toLowerCase() === referencedEmail ||
       refersToEarlierEmail(toQueries[0]!) ||
       /^(?:it|him|her|them|this|that|the contact)$/i.test(toQueries[0]!.trim()));
    if (!refersToSelected || ccQueries.length > 0 && !/\bcc\b/i.test(ownWords)) {
      return `Not ${when ? "scheduled" : "sent"}: the referenced photo/message identifies ${referencedEmail}, not the recipient the agent selected. Nothing went out.`;
    }
    toQueries = [referencedEmail];
  }
  if (toQueries.length === 0) {
    return "Not sent: he didn't name anyone. Ask him who it's for.";
  }
  if (!instruction) {
    return "Not sent: I don't know what it should say. Ask him.";
  }
  const slots = recipientSlots(
    [...toQueries, ...ccQueries],
    authorizationWords(confirmation.chatId, ownWords, now),
    now,
    when ? "Not scheduled" : "Not sent",
    confirmation.chatId,
    confirmation.messageId,
  );
  if (typeof slots === "string") {
    // A missing address must not discard the owner's original scheduled
    // instruction and time. A follow-up can identify the person without
    // having to repeat all the wording. This stores no permission beyond the
    // existing short send-authorization window, and does not schedule yet.
    if (when && /\b(?:send|schedule)\b/i.test(command)) {
      const unresolved = (query: string): ResolvedAttendee => ({
        query, name: query, email: "", resolved: false,
      });
      savePendingAction(confirmation.chatId, {
        action: "send_email", status: "open",
        ownerWords: ownWords, authorizedAt: now.toISOString(),
        confirmChat: confirmation.chatId, confirmMessage: confirmation.messageId,
        updatedAt: now.toISOString(),
        email: {
          to: toQueries.map(unresolved), cc: ccQueries.map(unresolved),
          notes: [instruction], purpose: instruction, subject: typeof values.subject === "string" ? values.subject : undefined,
          sendAt: when, account: values.account === "personal" ? "personal" : "work",
          waiting: "recipient",
        },
      }, now);
      return `${slots} I kept the email wording and scheduled time. Identify the recipient, then explicitly confirm scheduling.`;
    }
    return slots;
  }
  const request: CommandRequest = {
    kind: "email",
    to: slots.slice(0, toQueries.length),
    cc: slots.slice(toQueries.length),
    threadId:
      typeof values.thread_id === "string" && values.thread_id.trim() ? values.thread_id.trim() : null,
    instruction,
    // The email writer never sees a follow-up clause: only what the email should say.
    ownWords: withoutFollowupClause(ownWords),
    ownTurn: turn.ownTurn === true,
    ...(withoutFollowupClause(ownWords) !== ownWords ? { followupWords: ownWords } : {}),
    account: values.account === "personal" ? "personal" : "work",
    ...(when ? { sendAt: when } : {}),
    ...(typeof values.subject === "string" && values.subject.trim()
      ? { subject: values.subject.trim() }
      : {}),
    // Only a scheduled email is made from a draft. It is checked when it is scheduled.
    ...(when && typeof values.draft_id === "string" && values.draft_id.trim()
      ? { draftId: values.draft_id.trim() }
      : {}),
  };
  const outcome = await resolveAndContinue(
    request,
    `msg:${confirmation.chatId}:${confirmation.messageId}`,
    confirmation,
    now,
  );
  if (outcome.repeat) {
    // The same command again: nothing new went out, and its follow-ups were handled then.
    return asToolResult(outcome);
  }
  // Follow-ups he asked for in the same message start only after this send went out.
  const first = request.to[0];
  const followups = await followupsAfterSend({
    turn,
    result:
      outcome.result === "sent"
        ? "sent"
        : outcome.result === "unknown"
          ? "unknown"
          : request.sendAt && outcome.result === undefined
            ? "scheduled"
            : outcome.result === undefined
              ? "pending"
              : "not_sent",
    sentMessageId: outcome.result === "sent" ? outcome.messageId : undefined,
    account: request.account,
    recipient: first?.mailbox?.name.trim().split(/\s+/)[0] || first?.query || "them",
    recipientMailbox: first?.mailbox ? { name: first.mailbox.name, email: first.mailbox.email } : undefined,
  });
  if (!followups.text && !followups.hint) {
    return asToolResult(outcome);
  }
  const hint = [outcome.hint, followups.hint].filter(Boolean).join(" ");
  return `${outcome.text}${followups.text ? `\n${followups.text}` : ""}${hint ? ` ${hint}` : ""}`;
}

type FollowupTurn = Pick<ToolTurn, "confirmation" | "userText" | "ownTurn" | "modelCalled"> & { directSend?: boolean };

/** A send result with what the same message's follow-ups came to. */
export function withFollowups(message: string, followups: { text?: string; hint?: string }): string {
  return [message, followups.text, followups.hint].filter(Boolean).join("\n");
}

/** After a draft he confirmed by message: the follow-ups from the same message, only
 *  if this exact send went out. */
export async function followupsAfterDraftSend(
  turn: FollowupTurn,
  draftId: string,
  sent: boolean,
): Promise<{ text?: string; hint?: string }> {
  const delivered = sent ? sentMessageForDraft(draftId) : undefined;
  const to = parseAddressList(delivered?.to_header ?? "")[0];
  return followupsAfterSend({
    turn,
    result: delivered?.sent_message_id ? "sent" : "not_sent",
    sentMessageId: delivered?.sent_message_id ?? undefined,
    account: delivered?.google_account ?? "work",
    recipient: to?.name.trim().split(/\s+/)[0] || to?.email || "them",
    recipientMailbox: to ? { name: to.name, email: to.email } : undefined,
  });
}

/** "Book a meeting with X". The event is created at once, but only after the attendee
 *  resolves to exactly one address, so the invite can't reach the wrong person. */
export async function bookMeetingFromTool(
  input: unknown,
  turn: Pick<ToolTurn, "confirmation" | "userText">,
  now = new Date(),
): Promise<string> {
  if (!config.sendOnCommandEnabled) {
    return "Not booked: this is switched off. Use create_meeting.";
  }
  const confirmation = turn.confirmation;
  if (!confirmation) {
    return "Not booked: only Vishnu's own message can book a meeting.";
  }
  const ownWords = turn.userText?.trim() ?? "";
  const pending = getPendingAction(confirmation.chatId, now);
  const continuing =
    pending?.action === "create_meeting" &&
    (looksLikeTimeFill(ownWords) || (pending.meeting?.attendees.length ?? 0) > 0);
  const notCommand = continuing ? undefined : notAnEventCommand(ownWords);
  if (notCommand) {
    return `Not booked: ${notCommand}. Use the right tool, or ask him if he wants it booked now.`;
  }
  const values = (input ?? {}) as {
    attendees?: unknown;
    title?: unknown;
    start_time?: unknown;
    end_time?: unknown;
    duration_minutes?: unknown;
  };
  const authWords = authorizationWords(confirmation.chatId, ownWords, now);
  let queries = stringList(values.attendees);
  if (queries.length === 0 && pending?.meeting?.attendees.length) {
    queries = pending.meeting.attendees.map((item) => item.query);
  }
  if (queries.length === 0) {
    return "Not booked: he didn't name anyone. For a calendar-only event use create_event.";
  }
  const slots = recipientSlots(queries, authWords, now, "Not booked", confirmation.chatId);
  if (typeof slots === "string") {
    return slots;
  }
  const calendar = pending?.meeting?.calendar === "personal" ? "personal" : "work";
  const duration =
    typeof values.duration_minutes === "number"
      ? values.duration_minutes
      : pending?.meeting?.durationMinutes;
  const startTime = typeof values.start_time === "string" ? values.start_time : "";
  const title =
    typeof values.title === "string"
      ? values.title
      : pending?.meeting?.title;
  if (!startTime.trim()) {
    const resolved = await resolveAttendeesForPending(slots, now);
    if (typeof resolved === "string") {
      return resolved;
    }
    savePendingAction(confirmation.chatId, {
      action: "create_meeting",
      ownerWords: authWords,
      confirmChat: confirmation.chatId,
      confirmMessage: confirmation.messageId,
      updatedAt: now.toISOString(),
      meeting: {
        title,
        calendar,
        attendees: resolved,
        durationMinutes: duration,
        waiting: resolved.every((item) => item.resolved) ? "time" : "attendees",
        resolutionAttempts: {},
      },
    });
    const found = resolved
      .filter((item) => item.resolved)
      .map((item) => `${item.name} at ${item.email}`)
      .join(", ");
    const prefix = found ? `I found ${found}. ` : "";
    return `${prefix}${await freeSlotsText(duration, now)}`;
  }
  const times = parseCommandTimes({
    startTime,
    endTime: typeof values.end_time === "string" ? values.end_time : undefined,
    durationMinutes: duration,
    now,
  });
  if ("problem" in times) {
    return `Not booked: ${times.problem}`;
  }
  const request: CommandRequest = {
    kind: "meeting",
    to: slots,
    cc: [],
    threadId: null,
    instruction: "",
    ownWords: authWords,
    account: calendar,
    meeting: {
      title,
      startIso: times.startIso,
      endIso: times.endIso,
    },
  };
  const result = asToolResult(
    await resolveAndContinue(
      request,
      `meeting:${confirmation.chatId}:${confirmation.messageId}`,
      confirmation,
      now,
    ),
  );
  if (!result.startsWith("Not booked")) {
    clearPendingAction(confirmation.chatId, now);
  }
  return result;
}

async function resolveAttendeesForPending(
  slots: RecipientSlot[],
  now: Date,
): Promise<ResolvedAttendee[] | string> {
  const selfAddresses = await loadFollowupSelfAddresses();
  const gmail = gmailClient(await getGoogleAccount("work"));
  const attendees: ResolvedAttendee[] = [];
  const missing: string[] = [];
  const ambiguous: string[] = [];
  for (const slot of slots) {
    if (slot.mailbox) {
      attendees.push({
        query: slot.query,
        name: slot.mailbox.name,
        email: slot.mailbox.email,
        resolved: true,
      });
      continue;
    }
    const match = await resolveNamedRecipient({
      gmail,
      query: slot.query,
      selfAddresses,
    });
    if (match.kind === "one") {
      rememberContactChoice(slot.query, {
        name: match.mailbox.name,
        emails: [match.mailbox.email],
        sources: ["gmail"],
      });
      attendees.push({
        query: slot.query,
        name: match.mailbox.name,
        email: match.mailbox.email,
        resolved: true,
      });
      continue;
    }
    if (match.kind === "many") {
      ambiguous.push(
        `"${slot.query}" (${match.options.map((item) => item.email).join(", ")})`,
      );
      attendees.push({ query: slot.query, name: slot.query, email: "", resolved: false });
      continue;
    }
    missing.push(slot.query);
    attendees.push({ query: slot.query, name: slot.query, email: "", resolved: false });
  }
  if (ambiguous.length > 0) {
    const found = attendees
      .filter((item) => item.resolved)
      .map((item) => item.name)
      .join(", ");
    const prefix = found ? `I resolved ${found}. ` : "";
    return `${prefix}I found more than one person for ${ambiguous.join("; ")}. Which unique identity should I use?`;
  }
  if (missing.length > 0 && attendees.every((item) => !item.resolved)) {
    return `Not booked: I found no address for ${missing.map((name) => `"${name}"`).join(", ")}.`;
  }
  return attendees;
}

export async function bookPendingMeetingAt(
  chatId: number,
  startIso: string,
  confirmation: { chatId: number; messageId: number },
  now = new Date(),
): Promise<string> {
  return bookMeetingFromTool(
    { attendees: [], start_time: startIso },
    { confirmation, userText: startIso },
    now,
  );
}

/** add_calendar_attendee while this is on: the same rule, so an invite can't reach an
 *  address that came from something Aadi read. */
export async function resolveCommandAttendee(
  query: string,
  ownWords: string,
  chatId?: number,
): Promise<{ email: string } | { refused: string }> {
  const authWords = authorizationWords(chatId, ownWords);
  const remembered = pendingResolvedEmails(chatId).get(query.trim().toLowerCase());
  if (remembered?.resolved) {
    return { email: remembered.email };
  }
  if (!namedInOwnWords(query, authWords)) {
    return {
      refused: `Not added: "${query}" isn't a name or address in Vishnu's own message. Pass the name as he said it, or ask him.`,
    };
  }
  const gmail = gmailClient(await getGoogleAccount("work"));
  const match = await resolveNamedRecipient({
    gmail,
    query,
    selfAddresses: await loadFollowupSelfAddresses(),
  });
  if (match.kind === "one") {
    return { email: match.mailbox.email };
  }
  return {
    refused:
      match.kind === "none"
        ? `Not added: I found no address for "${query}". Ask Vishnu for it.`
        : `Not added: "${query}" matches ${match.options.map(formatMailbox).join(", ")}. Ask Vishnu to give the full address.`,
  };
}

/** A tap on one of the addresses Aadi offered, or on Don't send. */
export async function handleCommandSendCallback(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const match = /^cmdsend:(pick|drop):(\d+)(?::(\d+))?$/.exec(ctx.callbackQuery?.data ?? "");
  const now = new Date();
  const choice = match ? getCommandChoice(Number(match[2])) : undefined;
  const finish = async (text: string): Promise<void> => {
    await ctx.editMessageText(text, { reply_markup: undefined }).catch(() => undefined);
  };
  const expired = "That choice has expired. Nothing was sent. Ask me again.";
  if (
    !match ||
    !choice ||
    new Date(choice.created_at).getTime() < now.getTime() - CHOICE_TTL_MS ||
    // One tap wins: a double tap finds this already closed.
    !closeCommandChoice(choice.id, match[1] === "drop" ? "cancelled" : "used")
  ) {
    await finish(expired);
    return;
  }
  if (match[1] === "drop") {
    await finish("Not sent.");
    return;
  }
  const request = JSON.parse(choice.request) as CommandRequest;
  const slot = [...request.to, ...request.cc].find((item) => !item.mailbox && item.options);
  const picked = slot?.options?.[Number(match[3])];
  if (!slot || !picked) {
    await finish(expired);
    return;
  }
  // The tap confirms only an address its card message showed (when that was recorded).
  const tappedCard = ctx.callbackQuery?.message?.message_id;
  const shownThere = tappedCard === undefined ? new Set<string>() : cardRecipientsForMessage(choiceCardKey(choice.id), tappedCard);
  if (shownThere.size > 0 && !shownThere.has(picked.email.toLowerCase())) {
    await finish(expired);
    return;
  }
  slot.mailbox = picked;
  slot.seen = slot.options;
  delete slot.options;
  // His tap on an offered address confirms it, even a new one.
  request.confirmedRecipients = [...(request.confirmedRecipients ?? []), picked.email.toLowerCase()];
  await finish(`Picked ${formatMailbox(picked)}.`);
  const message = ctx.callbackQuery?.message;
  try {
    const outcome = await resolveAndContinue(
      request,
      `choice:${choice.id}`,
      { chatId: message?.chat.id ?? config.ownerTelegramId, messageId: message?.message_id ?? 0 },
      now,
    );
    if (!outcome.shown) {
      await ctx.reply(outcome.text);
    }
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(`Command send: tap failed (${errorType})`);
    await ctx.reply("Something broke, so nothing went out. Ask me again.");
  }
}
