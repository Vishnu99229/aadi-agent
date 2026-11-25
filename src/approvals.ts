import { Api, InlineKeyboard, type Context } from "grammy";
import { google, type gmail_v1 } from "googleapis";
import { config } from "./config.js";
import {
  cancelOpenDraftSchedules,
  claimDraftDelivery,
  createPendingAction,
  createPendingEventAction,
  draftDeliveryBlocksDiscard,
  getExpiredPendingActions,
  getPendingAction,
  getPendingActionForDraft,
  listDraftsShownBefore,
  markTaskDone,
  recordScheduledSendSent,
  setPendingActionDraftMeta,
  setPendingActionTelegramMessage,
  setPendingActionSentMessage,
  transitionPendingAction,
  type GoogleAccountId,
  type PendingAction,
  type PendingEventInput,
  draftRecipientsShownBefore,
  pendingActionFollowups,
  recordCommandSendSent,
} from "./db.js";
import { getGoogleClientFor } from "./google/auth.js";
import {
  allowCreateEvent,
  allowOwnerChatSendDraft,
  allowSendDraft,
} from "./security/send_approval.js";
import { parseAddressList } from "./mail_helpers.js";
import { installCaptionEditFallback, installNetworkRetry } from "./telegram_io.js";
import { holdForVoiceNote, shortCardText } from "./voice_cards.js";
import { classifyOwnerEmailIntent } from "./email_references.js";
import { knownRecipients, markRecipientsKnown } from "./known_recipients.js";
import { followupsAfterSend } from "./sequences.js";
import { assertSendDecision, cardReason, decideSendAction, type SendVerdict } from "./security/send_decision.js";
import { plainTextBody, stripSignature } from "./google/mail.js";
import { assertTestSeam } from "./test_seam.js";

const PREVIEW_LIMIT = 3800;
/** Only a draft that would not fit in one Telegram message is shortened on the card. */
const DRAFT_SUMMARY_CHARS = 3200;
const TELEGRAM_TEXT_LIMIT = 4000;
const EXPIRY_SWEEP_MS = 60 * 60 * 1000;

const realTelegram = new Api(config.telegramBotToken);
installNetworkRetry(realTelegram);
installCaptionEditFallback(realTelegram);
let telegram: Api = realTelegram;
let fakeGmailFor: ((account: GoogleAccountId) => gmail_v1.Gmail) | undefined;

export function setApprovalsTestHooks(hooks: {
  telegram?: Api;
  gmailFor?: (account: GoogleAccountId) => gmail_v1.Gmail;
}): void {
  assertTestSeam("setApprovalsTestHooks");
  telegram = hooks.telegram ?? realTelegram;
  fakeGmailFor = hooks.gmailFor;
}

async function gmailFor(account: GoogleAccountId): Promise<gmail_v1.Gmail> {
  if (fakeGmailFor) {
    return fakeGmailFor(account);
  }
  return google.gmail({ version: "v1", auth: await getGoogleClientFor(account) });
}
const activeActions = new Set<number>();
const editingActionByUser = new Map<number, number>();
const sendOnlyActions = new Set<number>();

type AfterDraftSend = (
  draftId: string,
  sentMessageId: string,
) => Promise<void>;
let afterDraftSend: AfterDraftSend | undefined;

export function setAfterDraftSend(handler: AfterDraftSend): void {
  afterDraftSend = handler;
}

export interface DraftApprovalPreview {
  draftId: string;
  /** Null for a standalone (non-reply) email. */
  threadId: string | null;
  to: string;
  subject: string;
  body: string;
  googleAccount: "personal" | "work";
  extraLines?: string[];
  cc?: string;
  /** Plain-text mailbox signature appended to the Gmail draft. */
  signature?: string;
}

export interface DraftEditContext {
  actionId: number;
  draftId: string;
  body: string;
  to: string;
  cc: string;
  subject: string;
  account: GoogleAccountId;
}

/** A draft as it stands in Gmail: who it goes to, its subject and plain body. */
export async function readDraftSnapshot(
  draftId: string,
  account: GoogleAccountId,
): Promise<{ to: string; cc: string; subject: string; body: string }> {
  const gmail = await gmailFor(account);
  const draft = await gmail.users.drafts.get({ userId: "me", id: draftId, format: "full" });
  const payload = draft.data.message?.payload;
  const headers = payload?.headers ?? [];
  const header = (name: string) =>
    headers.find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value?.trim() ?? "";
  return {
    to: header("To"),
    cc: header("Cc"),
    subject: header("Subject"),
    body: payload ? stripSignature(plainTextBody(payload).trim()).body : "",
  };
}

function keyboard(actionId: number, sendOnly = false, showFull = false): InlineKeyboard {
  const keys = new InlineKeyboard();
  if (showFull) {
    keys.text("📄 Show Full Draft", `approval:draft:${actionId}`).row();
  }
  if (sendOnly) {
    return keys
      .text("Send", `approval:send:${actionId}`)
      .row()
      .text("Cancel", `approval:discard:${actionId}`);
  }
  return keys
    .text("Send", `approval:send:${actionId}`)
    .text("Edit", `approval:edit:${actionId}`)
    .text("Discard", `approval:discard:${actionId}`);
}

function recipientLabel(to: string): string {
  return parseAddressList(to)[0]?.name?.trim() || to.trim() || "them";
}

export function splitTelegramText(text: string, limit = TELEGRAM_TEXT_LIMIT): string[] {
  const characters = Array.from(text);
  if (characters.length <= limit) {
    return [text];
  }
  const parts: string[] = [];
  for (let offset = 0; offset < characters.length; offset += limit) {
    parts.push(characters.slice(offset, offset + limit).join(""));
  }
  return parts;
}

function truncate(text: string, limit: number): string {
  const characters = Array.from(text);
  return characters.length <= limit
    ? text
    : `${characters.slice(0, limit).join("")}\n[preview truncated]`;
}

function previewText(preview: DraftApprovalPreview): string {
  const mailbox =
    preview.googleAccount === "work" ? "work (Epicode)" : "personal (Gmail)";
  const extra = (preview.extraLines ?? []).filter(
    (line) => line.trim() && !/^cc:/i.test(line.trim()),
  );
  const signature = preview.signature?.trim();
  const prefix = [
    "Draft waiting for approval",
    "",
    `Account: ${mailbox}`,
    `To: ${preview.to}`,
    ...(preview.cc?.trim() ? [`Cc: ${preview.cc.trim()}`] : ["Cc: none"]),
    `Subject: ${preview.subject}`,
    ...(extra.length ? ["", ...extra] : []),
    "",
  ].join("\n");

  const bodyChars = Array.from(preview.body).length;
  if (bodyChars > DRAFT_SUMMARY_CHARS) {
    const count = bodyChars.toLocaleString("en-US");
    return [
      `Draft ready for ${recipientLabel(preview.to)}. The email is ${count} characters long.`,
      "",
      `Account: ${mailbox}`,
      `To: ${preview.to}`,
      ...(preview.cc?.trim() ? [`Cc: ${preview.cc.trim()}`] : []),
      `Subject: ${preview.subject}`,
      ...(extra.length ? ["", ...extra] : []),
    ].join("\n");
  }

  const signatureBlock = signature ? `\n\n-- \n${signature}` : "\n\nSignature: appended from the mailbox when this is sent.";
  const room = PREVIEW_LIMIT - prefix.length - signatureBlock.length;
  return `${prefix}${truncate(preview.body, Math.max(200, room))}${signatureBlock}`;
}

const DRAFT_STALE_MS = 3 * 60 * 60 * 1000;

function sqliteTimeMs(value: string): number {
  return new Date(`${value.replace(" ", "T")}Z`).getTime();
}

export function touchedAtMs(action: PendingAction): number {
  return sqliteTimeMs(action.updated_at || action.created_at);
}

function isStale(action: PendingAction): boolean {
  if (action.type === "create_event") {
    return Date.now() - sqliteTimeMs(action.created_at) >= 24 * 60 * 60 * 1000;
  }
  return Date.now() - touchedAtMs(action) >= DRAFT_STALE_MS;
}

function callbackMessageText(ctx: Context): string {
  const message = ctx.callbackQuery?.message;
  return message && "text" in message
    ? (message.text ?? "Approval")
    : "Approval";
}

async function showStatus(
  ctx: Context,
  status: "Sent" | "Discarded" | "Expired" | "Cancelled" | "Created",
  trailer?: string,
): Promise<void> {
  const base = `${callbackMessageText(ctx)}\n\nStatus: ${status}`;
  const text = trailer ? `${base}\n${trailer}` : base;
  await ctx.editMessageText(text, { reply_markup: new InlineKeyboard() });
}

function eventKeyboard(actionId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("Create Event", `approval:create:${actionId}`)
    .text("Cancel", `approval:cancel:${actionId}`);
}

function formatEventPreviewTime(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return iso;
  }
  return parsed.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function parseEventAttendees(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function eventPreviewText(input: {
  title: string;
  startIso: string;
  endIso: string;
  attendees: string[];
  description?: string;
  googleAccount: "personal" | "work";
}): string {
  const mailbox =
    input.googleAccount === "work" ? "work (Epicode)" : "personal (Gmail)";
  const attendeeLine = input.attendees.length
    ? input.attendees.join(", ")
    : "None";
  const lines = [
    "Event waiting for approval",
    "",
    `Calendar: ${mailbox}`,
    `Title: ${input.title}`,
    `Start: ${formatEventPreviewTime(input.startIso)}`,
    `End: ${formatEventPreviewTime(input.endIso)}`,
    `Attendees: ${attendeeLine}`,
  ];
  if (input.description && input.description.trim()) {
    lines.push("", input.description.trim());
  }
  return lines.join("\n");
}

async function expireAction(action: PendingAction): Promise<boolean> {
  if (
    action.status !== "pending" ||
    !transitionPendingAction(action.id, "pending", "expired")
  ) {
    return false;
  }

  editingActionByUser.forEach((actionId, userId) => {
    if (actionId === action.id) {
      editingActionByUser.delete(userId);
    }
  });
  console.log(`Approval action ${action.id}: status -> expired`);

  if (action.telegram_message_id) {
    try {
      await telegram.editMessageText(
        config.ownerTelegramId,
        action.telegram_message_id,
        "Draft approval expired.",
        { reply_markup: new InlineKeyboard() },
      );
    } catch {
      console.log(`Approval action ${action.id}: expiry preview update failed`);
    }
  }

  return true;
}

export async function queueEventApproval(
  input: PendingEventInput,
): Promise<number> {
  const action = createPendingEventAction(input);
  const text = eventPreviewText({
    title: input.title,
    startIso: input.startIso,
    endIso: input.endIso,
    attendees: input.attendees,
    description: input.description,
    googleAccount: input.googleAccount ?? "work",
  });
  const markup = eventKeyboard(action.id);
  const eventId = action.id;
  if (
    holdForVoiceNote({
      text,
      caption: shortCardText(text),
      keyboard: markup,
      onPosted: (messageId) => setPendingActionTelegramMessage(eventId, messageId),
    })
  ) {
    console.log(`Approval action ${action.id}: event preview held for voice note`);
    return action.id;
  }
  const message = await telegram.sendMessage(config.ownerTelegramId, text, {
    reply_markup: markup,
  });
  setPendingActionTelegramMessage(action.id, message.message_id);
  console.log(`Approval action ${action.id}: event preview sent`);
  return action.id;
}

export async function queueDraftApproval(
  preview: DraftApprovalPreview,
  options: { sendOnly?: boolean; newCard?: boolean; touch?: boolean } = {},
): Promise<number> {
  let action = getPendingActionForDraft(preview.draftId);

  if (action && isStale(action)) {
    await expireAction(action);
    action = undefined;
  }

  if (!action) {
    action = createPendingAction(
      preview.draftId,
      preview.threadId,
      preview.googleAccount,
    );
  }

  if (options.touch !== false) {
    setPendingActionDraftMeta(action.id, {
      toHeader: preview.to,
      ccHeader: preview.cc?.trim() ?? "",
      subject: preview.subject,
    });
  }

  const sendOnly = options.sendOnly ?? false;
  if (sendOnly) sendOnlyActions.add(action.id);
  else sendOnlyActions.delete(action.id);

  const text = previewText(preview);
  const markup = keyboard(
    action.id,
    sendOnlyActions.has(action.id),
    Array.from(preview.body).length > DRAFT_SUMMARY_CHARS,
  );

  if (action.telegram_message_id && options.newCard !== true) {
    try {
      await telegram.editMessageText(
        config.ownerTelegramId,
        action.telegram_message_id,
        text,
        { reply_markup: markup },
      );
      console.log(`Approval action ${action.id}: preview updated`);
      return action.id;
    } catch {
      console.log(`Approval action ${action.id}: preview replacement failed`);
    }
  }

  const draftActionId = action.id;
  if (
    holdForVoiceNote({
      text,
      caption: shortCardText(
        [
          `Draft to ${preview.to}`,
          ...(preview.cc?.trim() ? [`Cc: ${preview.cc.trim()}`] : []),
          `Subject: ${preview.subject}`,
          "",
          preview.body,
        ].join("\n"),
      ),
      keyboard: markup,
      onPosted: (messageId) => setPendingActionTelegramMessage(draftActionId, messageId),
    })
  ) {
    console.log(`Approval action ${action.id}: preview held for voice note`);
    return action.id;
  }
  const message = await telegram.sendMessage(config.ownerTelegramId, text, {
    reply_markup: markup,
  });
  setPendingActionTelegramMessage(action.id, message.message_id);
  console.log(`Approval action ${action.id}: preview sent`);
  return action.id;
}

async function currentPendingAction(
  ctx: Context,
  actionId: number,
): Promise<PendingAction | undefined> {
  const action = getPendingAction(actionId);

  if (!action) {
    await ctx.answerCallbackQuery({
      text: "This approval no longer exists.",
      show_alert: true,
    });
    return undefined;
  }

  if (action.status === "pending" && isStale(action)) {
    await expireAction(action);
    await showStatus(ctx, "Expired").catch(() => undefined);
    await ctx.answerCallbackQuery("Expired");
    return undefined;
  }

  if (action.status !== "pending") {
    const statusMap = {
      sent: "Sent",
      discarded: "Discarded",
      expired: "Expired",
      created: "Created",
      cancelled: "Cancelled",
    } as const;
    const status = statusMap[action.status];
    await showStatus(ctx, status).catch(() => undefined);
    await ctx.answerCallbackQuery(`Already ${status.toLowerCase()}.`);
    return undefined;
  }

  return action;
}

type SendOutcome =
  | { ok: true; sentMessageId?: string }
  | { ok: false; reason: "send_failed" | "status_update_failed" | "already_sent" | "in_progress" | "unconfirmed" | "not_decided" };

/** The people a draft goes to right now, from Gmail itself: what drafts.send would use. */
async function draftRecipients(account: GoogleAccountId, draftId: string): Promise<string[]> {
  const gmail = await gmailFor(account);
  const draft = await gmail.users.drafts.get({ userId: "me", id: draftId, format: "metadata" });
  const headers = draft.data.message?.payload?.headers ?? [];
  const value = (name: string) =>
    headers.find((item: { name?: string | null; value?: string | null }) => (item.name ?? "").toLowerCase() === name)?.value ?? "";
  return [...new Set([...parseAddressList(value("to")), ...parseAddressList(value("cc"))].map((item) => item.email.toLowerCase()))];
}

/** Everyone this card has shown: its current To and Cc, and any address it showed
 *  earlier (cards from before the log existed still have their To and Cc). */
function shownOnCard(action: PendingAction): Set<string> {
  const shown = new Set(
    [...parseAddressList(action.to_header ?? ""), ...parseAddressList(action.cc_header ?? "")].map((item) => item.email.toLowerCase()),
  );
  if (action.draft_id) {
    for (const email of draftRecipientsShownBefore(action.draft_id, Number.MAX_SAFE_INTEGER)) {
      shown.add(email);
    }
  }
  return shown;
}

/** His own "send it" for a draft he was shown: only addresses its card showed before
 *  his message, or that he's sent to before, go out with no further tap. */
async function textSendVerdict(action: PendingAction, messageId: number, ownTurn: boolean): Promise<{ verdict: SendVerdict; to: string }> {
  const recipients = action.draft_id ? await draftRecipients(action.google_account, action.draft_id).catch(() => []) : [];
  const verdict = decideSendAction({
    intent: "send",
    ownTurn,
    recipients,
    known: await knownRecipients(recipients),
    confirmed: action.draft_id ? draftRecipientsShownBefore(action.draft_id, messageId) : new Set(),
  });
  return { verdict, to: action.to_header ?? recipients.join(", ") };
}

function sendFailureText(reason: Exclude<SendOutcome, { ok: true }>["reason"]): string {
  if (reason === "not_decided") {
    return "Not sent: the people on it changed, so check the card and tap Send again.";
  }
  if (reason === "already_sent") {
    return "That email was already delivered. I didn't send it again.";
  }
  if (reason === "in_progress") {
    return "That email is already being sent. I didn't send it again.";
  }
  if (reason === "unconfirmed") {
    return "Gmail didn't confirm an earlier send, so I won't try again. Check your Sent mail.";
  }
  return reason === "send_failed"
    ? "Sending failed. The draft is still pending; please try again."
    : "The draft was sent, but its approval status could not be updated.";
}

async function performDraftSend(action: PendingAction, decision: SendVerdict): Promise<SendOutcome> {
  const draftId = action.draft_id;
  if (!draftId) {
    return { ok: false, reason: "send_failed" };
  }
  // The decision must cover exactly who the draft goes to now.
  let recipients: string[];
  try {
    recipients = await draftRecipients(action.google_account, draftId);
    assertSendDecision(decision, recipients);
  } catch {
    console.log(`Approval action ${action.id}: send refused reason=not_decided`);
    return { ok: false, reason: "not_decided" };
  }
  const claim = claimDraftDelivery(draftId, action.google_account, new Date().toISOString());
  if (claim.state === "already_sent" || claim.state === "unconfirmed" || claim.state === "in_progress") {
    if (claim.state === "already_sent") {
      transitionPendingAction(action.id, "pending", "sent");
    }
    console.log(`Approval action ${action.id}: send blocked reason=${claim.state}`);
    return { ok: false, reason: claim.state };
  }
  let sentMessageId: string | undefined;
  try {
    const gmail = await gmailFor(action.google_account);
    const sent = await gmail.users.drafts.send({
      userId: "me",
      requestBody: { id: draftId },
    });
    sentMessageId = sent.data.id ?? undefined;
    markRecipientsKnown(recipients);
  } catch {
    if (claim.state === "claimed") {
      console.log(`Approval action ${action.id}: send unconfirmed; schedule ${claim.id} stays claimed`);
      return { ok: false, reason: "unconfirmed" };
    }
    console.log(`Approval action ${action.id}: send failed; status -> pending`);
    return { ok: false, reason: "send_failed" };
  }
  if (claim.state === "claimed") {
    recordScheduledSendSent(claim.id, sentMessageId ?? null);
    markTaskDone(claim.taskId);
    console.log(`Scheduled send ${claim.id}: status -> sent reason=manual_draft`);
  }
  if (sentMessageId && afterDraftSend) {
    try {
      await afterDraftSend(draftId, sentMessageId);
    } catch {
      console.log(`Approval action ${action.id}: after-send hook failed`);
    }
  }
  if (sentMessageId) {
    // Recorded only, so "put this email in a follow-up sequence" can find it. It
    // never decides a send, and a failure here never changes the outcome.
    try {
      setPendingActionSentMessage(action.id, sentMessageId);
    } catch {
      console.log(`Approval action ${action.id}: sent message not recorded`);
    }
  }
  if (action.command_key) {
    // The send command this card stood for is done, exactly like a direct send.
    recordCommandSendSent(action.command_key, sentMessageId ?? "unknown");
  }
  if (!transitionPendingAction(action.id, "pending", "sent")) {
    console.log(`Approval action ${action.id}: sent; status update failed`);
    return { ok: false, reason: "status_update_failed" };
  }
  console.log(`Approval action ${action.id}: status -> sent`);
  return { ok: true, sentMessageId };
}

/** A repeat of the command a card stands for: the same card again (never a new draft).
 *  It shows the people the card showed, with the draft's body as it is in Gmail. */
export async function repostPendingCard(action: PendingAction): Promise<"reposted" | "expired" | "failed"> {
  if (action.status !== "pending" || !action.draft_id) {
    return "failed";
  }
  if (isStale(action)) {
    await expireAction(action);
    return "expired";
  }
  try {
    const snapshot = await readDraftSnapshot(action.draft_id, action.google_account);
    await queueDraftApproval(
      {
        draftId: action.draft_id,
        threadId: action.thread_id,
        to: action.to_header ?? snapshot.to,
        cc: (action.to_header ? action.cc_header : snapshot.cc) || undefined,
        subject: action.subject ?? snapshot.subject,
        body: snapshot.body,
        googleAccount: action.google_account,
      },
      { newCard: true, touch: false },
    );
    console.log(`Approval action ${action.id}: card posted again for a repeated command`);
    return "reposted";
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(`Approval action ${action.id}: repost failed (${errorType})`);
    return "failed";
  }
}

/** Send a Gmail draft now. No Telegram card and no pending_actions row.
 *  Only allowed from Vishnu's own chat or voice turn. */
export async function sendCreatedDraftNow(params: {
  draftId: string;
  googleAccount: GoogleAccountId;
  confirmation: SendConfirmation | undefined;
  /** Straight from his own chat turn (dispatch's mark). */
  ownTurn?: boolean;
  /** His own words: "draft ..." never sends. */
  userText?: string;
}): Promise<
  | { ok: true }
  | { ok: false; reason: "not_approved" | "send_failed" }
  | { ok: false; reason: "card"; message: string }
> {
  // While send_email is on it is the only no-tap path, so its recipient check can't
  // be bypassed. The draft tools fall through to their Send card.
  if (config.sendOnCommandEnabled) {
    return { ok: false, reason: "not_approved" };
  }
  try {
    allowOwnerChatSendDraft(params.confirmation);
  } catch {
    return { ok: false, reason: "not_approved" };
  }
  // Only known people, on his own turn, for a send he asked for: anything else is the card.
  let recipients: string[];
  try {
    recipients = await draftRecipients(params.googleAccount, params.draftId);
  } catch {
    return { ok: false, reason: "send_failed" };
  }
  const verdict = decideSendAction({
    intent: classifyOwnerEmailIntent(params.userText ?? "") === "draft" ? "draft" : "send",
    ownTurn: params.ownTurn === true,
    recipients,
    known: await knownRecipients(recipients),
  });
  if (verdict.action !== "send") {
    return { ok: false, reason: "card", message: cardReason(verdict, recipients.join(", ")) };
  }
  try {
    assertSendDecision(verdict, recipients);
  } catch {
    return { ok: false, reason: "send_failed" };
  }
  const claim = claimDraftDelivery(params.draftId, params.googleAccount, new Date().toISOString());
  if (claim.state === "already_sent" || claim.state === "in_progress" || claim.state === "unconfirmed") {
    console.log(`Draft ${params.draftId}: immediate send blocked reason=${claim.state}`);
    return { ok: false, reason: "send_failed" };
  }
  let sentMessageId: string | undefined;
  try {
    const gmail = await gmailFor(params.googleAccount);
    const sent = await gmail.users.drafts.send({
      userId: "me",
      requestBody: { id: params.draftId },
    });
    sentMessageId = sent.data.id ?? undefined;
    markRecipientsKnown(recipients);
  } catch {
    console.log(`Draft ${params.draftId}: immediate send failed`);
    return { ok: false, reason: "send_failed" };
  }
  if (claim.state === "claimed") {
    recordScheduledSendSent(claim.id, sentMessageId ?? null);
    markTaskDone(claim.taskId);
  }
  if (sentMessageId && afterDraftSend) {
    try {
      await afterDraftSend(params.draftId, sentMessageId);
    } catch {
      console.log(`Draft ${params.draftId}: after-send hook failed`);
    }
  }
  console.log(`Draft ${params.draftId}: sent immediately`);
  return { ok: true };
}

type EventOutcome =
  | { ok: true; htmlLink: string | undefined }
  | { ok: false; reason: "insert_failed" | "status_update_failed" | "missing_fields" };

async function performEventInsert(action: PendingAction): Promise<EventOutcome> {
  if (
    !action.event_title ||
    !action.event_start ||
    !action.event_end
  ) {
    return { ok: false, reason: "missing_fields" };
  }
  let htmlLink: string | undefined;
  try {
    const auth = await getGoogleClientFor(action.google_account);
    const calendar = google.calendar({ version: "v3", auth });
    const attendees = parseEventAttendees(action.event_attendees).map(
      (email) => ({ email }),
    );
    const created = await calendar.events.insert({
      calendarId: "primary",
      requestBody: {
        summary: action.event_title,
        description: action.event_description ?? undefined,
        start: { dateTime: action.event_start, timeZone: "Asia/Kolkata" },
        end: { dateTime: action.event_end, timeZone: "Asia/Kolkata" },
        attendees: attendees.length ? attendees : undefined,
      },
      sendUpdates: attendees.length ? "all" : "none",
    });
    htmlLink = created.data.htmlLink ?? undefined;
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.log(
      `Approval action ${action.id}: event insert failed (${errorType})`,
    );
    return { ok: false, reason: "insert_failed" };
  }
  if (!transitionPendingAction(action.id, "pending", "created")) {
    console.log(
      `Approval action ${action.id}: event created but status update failed`,
    );
    return { ok: false, reason: "status_update_failed" };
  }
  console.log(`Approval action ${action.id}: status -> created`);
  return { ok: true, htmlLink };
}

async function createEvent(ctx: Context, action: PendingAction): Promise<void> {
  allowCreateEvent({
    callbackData: ctx.callbackQuery?.data,
    actionId: action.id,
    actionStatus: action.status,
    actionType: action.type,
  });
  const outcome = await performEventInsert(action);
  if (!outcome.ok) {
    const message =
      outcome.reason === "insert_failed"
        ? "Could not create the event. The approval is still pending; try again."
        : outcome.reason === "status_update_failed"
          ? "The event was created, but its approval status could not be updated."
          : "Event data is incomplete; cannot create.";
    await ctx.answerCallbackQuery({ text: message, show_alert: true });
    return;
  }
  const trailer = outcome.htmlLink ? `Link: ${outcome.htmlLink}` : undefined;
  await showStatus(ctx, "Created", trailer).catch(() => {
    console.log(`Approval action ${action.id}: created preview update failed`);
  });
  await ctx.answerCallbackQuery("Created").catch(() => undefined);
}

async function cancelEvent(ctx: Context, action: PendingAction): Promise<void> {
  if (!transitionPendingAction(action.id, "pending", "cancelled")) {
    await ctx.answerCallbackQuery({
      text: "Could not update the approval status.",
      show_alert: true,
    });
    return;
  }
  console.log(`Approval action ${action.id}: status -> cancelled`);
  await showStatus(ctx, "Cancelled").catch(() => {
    console.log(`Approval action ${action.id}: cancelled preview update failed`);
  });
  await ctx.answerCallbackQuery("Cancelled").catch(() => undefined);
}

async function sendDraft(ctx: Context, action: PendingAction): Promise<void> {
  allowSendDraft({
    callbackData: ctx.callbackQuery?.data,
    actionId: action.id,
    actionStatus: action.status,
  });
  // His tap on the card's own Send confirms the people the card showed. Anyone else on
  // the Gmail draft now (changed outside Aadi) must be someone he has emailed before.
  const recipients = action.draft_id ? await draftRecipients(action.google_account, action.draft_id).catch(() => []) : [];
  const shown = shownOnCard(action);
  const verdict = decideSendAction({
    intent: "send",
    ownTurn: true,
    recipients,
    known: await knownRecipients(recipients.filter((email) => !shown.has(email))),
    confirmed: shown,
  });
  if (verdict.action === "card" && verdict.newAddresses.length > 0) {
    console.log(`Approval action ${action.id}: send refused, draft has addresses the card didn't show`);
    await ctx.answerCallbackQuery({
      text: `Not sent: ${verdict.newAddresses.join(", ")} is on the draft now but wasn't on this card. Ask me to show it again, then tap Send.`,
      show_alert: true,
    });
    return;
  }
  const outcome = await performDraftSend(action, verdict);
  if (!outcome.ok) {
    if (outcome.reason === "already_sent") {
      await showStatus(ctx, "Sent").catch(() => undefined);
    }
    await ctx.answerCallbackQuery({ text: sendFailureText(outcome.reason), show_alert: true });
    return;
  }
  await showStatus(ctx, "Sent").catch(() => {
    console.log(`Approval action ${action.id}: sent preview update failed`);
  });
  await ctx.answerCallbackQuery("Sent").catch(() => undefined);
  await followupsAfterCardSend(action, outcome.sentMessageId, recipients);
}

/** "Email a new address saying ... and start follow-ups": the email went out on his tap,
 *  so the follow-ups come now, as a pre-filled Start card (never enrolled directly). */
async function followupsAfterCardSend(action: PendingAction, sentMessageId: string | undefined, recipients: string[]): Promise<void> {
  const followups = pendingActionFollowups(action.id);
  if (!followups || !sentMessageId) {
    return;
  }
  const key = /^msg:(-?\d+):(\d+)$/.exec(followups.key);
  if (!key) {
    return;
  }
  try {
    const to = parseAddressList(action.to_header ?? "")[0];
    const result = await followupsAfterSend({
      turn: {
        confirmation: { chatId: Number(key[1]), messageId: Number(key[2]) },
        userText: followups.words,
        ownTurn: true,
        directSend: true,
      },
      result: "sent",
      sentMessageId,
      account: action.google_account,
      recipient: to?.name.trim().split(/\s+/)[0] || to?.email || recipients[0] || "them",
      recipientMailbox: to ? { name: to.name, email: to.email } : undefined,
    });
    if (result.text) {
      await telegram.sendMessage(config.ownerTelegramId, result.text);
    }
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(`Approval action ${action.id}: follow-ups after send failed (${errorType})`);
  }
}

function recipientLabelFromHeader(header: string): string {
  const addresses = parseAddressList(header);
  if (addresses.length === 0) {
    return "the recipient";
  }
  const first = addresses[0]!;
  return first.name || first.email;
}

async function fetchDraftRecipientLabel(
  action: PendingAction,
): Promise<string> {
  if (action.to_header?.trim()) {
    return recipientLabelFromHeader(action.to_header);
  }
  if (!action.draft_id) {
    return "the recipient";
  }
  try {
    const gmail = await gmailFor(action.google_account);
    const draft = await gmail.users.drafts.get({
      userId: "me",
      id: action.draft_id,
      format: "metadata",
    });
    const header =
      draft.data.message?.payload?.headers?.find(
        (item: { name?: string | null; value?: string | null }) =>
          (item.name ?? "").toLowerCase() === "to",
      )?.value ?? "";
    return recipientLabelFromHeader(header);
  } catch {
    return "the recipient";
  }
}

export interface TextSendDraftResult {
  ok: boolean;
  message: string;
}

export interface SendConfirmation {
  chatId: number;
  /** Telegram id of Vishnu's confirming message, typed or voice. */
  messageId: number;
}

export function eligibleDrafts(confirmation: SendConfirmation): PendingAction[] {
  return listDraftsShownBefore(confirmation.messageId).filter(
    (action) => !isStale(action),
  );
}

export function countConfirmableDrafts(confirmation: SendConfirmation): number {
  return eligibleDrafts(confirmation).length;
}

/** One draft: that one. Several: the unique most recently created or edited.
 *  Two with the same touch time: undefined so the caller asks which. */
export function pickLatestDraft(
  shown: readonly PendingAction[],
): PendingAction | undefined {
  if (shown.length <= 1) {
    return shown[0];
  }
  const ranked = [...shown].sort((left, right) => {
    const diff = touchedAtMs(right) - touchedAtMs(left);
    if (diff !== 0) {
      return diff;
    }
    return right.id - left.id;
  });
  const top = ranked[0]!;
  const second = ranked[1]!;
  if (touchedAtMs(top) === touchedAtMs(second)) {
    return undefined;
  }
  return top;
}

/** @deprecated Use pickLatestDraft. Kept as an alias so older tests compile
 *  until they are updated. */
export function pickConfirmedDraft(
  shown: readonly PendingAction[],
  _priorOwnerMessageIds?: readonly number[],
): PendingAction | undefined {
  return pickLatestDraft(shown);
}

export function findEligibleDraft(
  confirmation: SendConfirmation,
  draftId: string,
): PendingAction | undefined {
  const wanted = draftId.trim();
  if (!wanted) {
    return undefined;
  }
  return eligibleDrafts(confirmation).find(
    (action) => action.draft_id === wanted,
  );
}

function sqliteUtc(value: string): string {
  return value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
}

export function formatPendingDraftContext(
  confirmation: SendConfirmation,
): string {
  const shown = eligibleDrafts(confirmation);
  if (shown.length === 0) {
    return "No email draft is waiting for Vishnu's approval. If he asks to send one, tell him there is no draft waiting; do not call confirm_send_pending_draft.";
  }
  const latest = [...shown].sort((left, right) => {
    const diff = touchedAtMs(right) - touchedAtMs(left);
    return diff !== 0 ? diff : right.id - left.id;
  })[0];
  const latestId = latest?.draft_id ?? "";
  const uniqueLatest =
    shown.length === 1 ||
    shown.filter((action) => touchedAtMs(action) === touchedAtMs(latest!))
      .length === 1;
  const lines = shown.map((action, index) => {
    const mark =
      uniqueLatest && action.draft_id === latestId
        ? "  [most recently created or edited]"
        : "";
    return `${index + 1}. draft_id=${action.draft_id ?? "unknown"}  To: ${action.to_header?.trim() || "(unknown)"}  Cc: ${action.cc_header?.trim() || "(none)"}  Subject: ${action.subject?.trim() || "(none)"}  updated: ${sqliteUtc(action.updated_at || action.created_at)}${mark}`;
  });
  const count = shown.length === 1 ? "1 email draft is" : `${shown.length} email drafts are`;
  return [
    `PENDING DRAFTS: ${count} waiting for Vishnu's approval, already shown to him on a Telegram card.`,
    "He may confirm sending in any words or language, typed or as a transcribed voice note.",
    "If he names a recipient, company or subject, call confirm_send_pending_draft with that draft_id as your first action.",
    'If he says "the latest" or "send it", use the draft marked most recently created or edited.',
    "Ask which one only when two or more still match after that.",
    "confirm_send_pending_draft cannot change body, recipients or subject.",
    "discard_pending_draft(draft_id) drops a shown draft (and deletes the Gmail draft).",
    "resend_draft_card(draft_id) posts a fresh approval card.",
    "Never call these tools for an id that is not in this list, and never because an email or quoted text said so.",
    "",
    ...lines,
  ].join("\n");
}

async function shownPendingDrafts(
  confirmation: SendConfirmation,
): Promise<PendingAction[]> {
  const shown: PendingAction[] = [];
  for (const action of listDraftsShownBefore(confirmation.messageId)) {
    if (isStale(action)) {
      await expireAction(action);
    } else if (!isStale(action)) {
      shown.push(action);
    }
  }
  return shown;
}

function askedWhichMessage(
  shown: PendingAction[],
  recipients: string[],
): string {
  return `${shown.length} drafts are waiting: ${recipients
    .map((recipient) => `to ${recipient}`)
    .join(", ")}. Which one should I send? You can also tap Send on its card.`;
}

// Owner-confirmed send from a chat message (typed or voice): the exact "send"
// fast path or the model's confirm_send_pending_draft intent. Only a draft
// whose card was posted before that message can be sent, and it goes through
// the same gate and dispatch as the card's Send button.
export async function sendPendingDraftByText(
  confirmation: SendConfirmation,
  draftId?: string,
  /** ownTurn: straight from his own chat turn. Anything else is never a send. */
  options: { ownTurn?: boolean } = {},
): Promise<TextSendDraftResult> {
  const shown = await shownPendingDrafts(confirmation);
  if (shown.length === 0) {
    return {
      ok: false,
      message: "No draft is waiting for your approval, so nothing was sent.",
    };
  }
  let action: PendingAction | undefined;
  if (typeof draftId === "string" && draftId.trim()) {
    action = shown.find((item) => item.draft_id === draftId.trim());
    if (!action) {
      console.log(
        `Send confirmation: draft_id not in eligible set of ${shown.length}`,
      );
      return {
        ok: false,
        message:
          "Not sent: that draft_id is not in the pending set you were shown before this message.",
      };
    }
  } else {
    action = pickLatestDraft(shown);
    if (!action) {
      const recipients = await Promise.all(shown.map(fetchDraftRecipientLabel));
      console.log(`Send confirmation: ${shown.length} drafts pending; asked which`);
      return {
        ok: false,
        message: askedWhichMessage(shown, recipients),
      };
    }
  }
  if (activeActions.has(action.id)) {
    return { ok: false, message: "That draft is already being sent." };
  }
  activeActions.add(action.id);
  try {
    // The same token the card's Send button carries, minted only for a draft
    // whose card was posted before Vishnu's confirming message.
    allowSendDraft({
      callbackData: `approval:send:${action.id}`,
      actionId: action.id,
      actionStatus: action.status,
    });
    const recipient = await fetchDraftRecipientLabel(action);
    const { verdict, to } = await textSendVerdict(action, confirmation.messageId, options.ownTurn === true);
    if (verdict.action !== "send") {
      console.log(`Approval action ${action.id}: card, not sent (${verdict.action === "card" && verdict.newAddresses.length > 0 ? "new address" : "not own turn"})`);
      return { ok: false, message: cardReason(verdict, to) };
    }
    const outcome = await performDraftSend(action, verdict);
    if (!outcome.ok) {
      return { ok: false, message: sendFailureText(outcome.reason) };
    }
    if (action.telegram_message_id) {
      try {
        await telegram.editMessageText(
          config.ownerTelegramId,
          action.telegram_message_id,
          "Draft approval\n\nStatus: Sent",
          { reply_markup: new InlineKeyboard() },
        );
      } catch {
        console.log(
          `Approval action ${action.id}: text-send preview update failed`,
        );
      }
    }
    console.log(`Approval action ${action.id}: sent on chat confirmation`);
    return {
      ok: true,
      message: `Sent the draft to ${recipient}.`,
    };
  } finally {
    activeActions.delete(action.id);
  }
}

type DiscardOutcome =
  | { ok: true }
  | { ok: false; reason: "no_draft" | "delete_failed" | "status_update_failed" | "in_progress" | "already_sent" };

async function performDraftDiscard(action: PendingAction): Promise<DiscardOutcome> {
  const draftId = action.draft_id;
  if (!draftId) {
    return { ok: false, reason: "no_draft" };
  }
  const blocked = draftDeliveryBlocksDiscard(draftId, action.google_account);
  if (blocked) {
    if (blocked === "already_sent") {
      transitionPendingAction(action.id, "pending", "sent");
    }
    return { ok: false, reason: blocked };
  }
  cancelOpenDraftSchedules(draftId, action.google_account);
  try {
    const gmail = await gmailFor(action.google_account);
    await gmail.users.drafts.delete({
      userId: "me",
      id: draftId,
    });
  } catch {
    console.log(
      `Approval action ${action.id}: discard failed; status -> pending`,
    );
    return { ok: false, reason: "delete_failed" };
  }
  if (!transitionPendingAction(action.id, "pending", "discarded")) {
    console.log(`Approval action ${action.id}: discarded; status update failed`);
    return { ok: false, reason: "status_update_failed" };
  }
  console.log(`Approval action ${action.id}: status -> discarded`);
  return { ok: true };
}

async function markCardDiscarded(action: PendingAction): Promise<void> {
  if (!action.telegram_message_id) {
    return;
  }
  try {
    await telegram.editMessageText(
      config.ownerTelegramId,
      action.telegram_message_id,
      "Draft approval\n\nStatus: Discarded",
      { reply_markup: new InlineKeyboard() },
    );
  } catch {
    console.log(`Approval action ${action.id}: discard preview update failed`);
  }
}

/** Drops a draft the owner cancelled in chat, including its Send card. */
export async function retireOwnerDraft(
  draftId: string,
): Promise<"retired" | "missing" | "delete_failed"> {
  const action = getPendingActionForDraft(draftId);
  if (!action?.draft_id) {
    return "missing";
  }
  const outcome = await performDraftDiscard(action);
  if (outcome.ok) {
    await markCardDiscarded(action);
    return "retired";
  }
  if (outcome.reason === "delete_failed" && transitionPendingAction(action.id, "pending", "discarded")) {
    await markCardDiscarded(action);
  }
  return "delete_failed";
}

export async function discardPendingDraftByText(
  confirmation: SendConfirmation,
  draftId: string,
): Promise<TextSendDraftResult> {
  const shown = await shownPendingDrafts(confirmation);
  const action = shown.find((item) => item.draft_id === draftId.trim());
  if (!action) {
    console.log(
      `Discard confirmation: draft_id not in eligible set of ${shown.length}`,
    );
    return {
      ok: false,
      message:
        "Not discarded: that draft_id is not in the pending set you were shown before this message.",
    };
  }
  if (activeActions.has(action.id)) {
    return { ok: false, message: "That draft is already being processed." };
  }
  activeActions.add(action.id);
  try {
    const outcome = await performDraftDiscard(action);
    if (!outcome.ok) {
      return {
        ok: false,
        message:
          outcome.reason === "delete_failed"
            ? "Discarding failed. The draft is still pending; please try again."
            : "The draft was discarded, but its approval status could not be updated.",
      };
    }
    await markCardDiscarded(action);
    const recipient = await fetchDraftRecipientLabel(action);
    return { ok: true, message: `Discarded the draft to ${recipient}.` };
  } finally {
    activeActions.delete(action.id);
  }
}

export async function resendDraftCard(
  confirmation: SendConfirmation,
  draftId: string,
): Promise<TextSendDraftResult> {
  const shown = await shownPendingDrafts(confirmation);
  const action = shown.find((item) => item.draft_id === draftId.trim());
  if (!action || !action.draft_id) {
    console.log(
      `Resend card: draft_id not in eligible set of ${shown.length}`,
    );
    return {
      ok: false,
      message:
        "Not resent: that draft_id is not in the pending set you were shown before this message.",
    };
  }
  let body = "";
  try {
    const gmail = await gmailFor(action.google_account);
    const draft = await gmail.users.drafts.get({
      userId: "me",
      id: action.draft_id,
      format: "full",
    });
    body = draft.data.message?.payload
      ? stripSignature(plainTextBody(draft.data.message.payload).trim()).body
      : "";
  } catch {
    return {
      ok: false,
      message:
        "Could not read the Gmail draft, so I did not post a new card.",
    };
  }
  await queueDraftApproval(
    {
      draftId: action.draft_id,
      threadId: action.thread_id,
      to: action.to_header?.trim() || "unknown",
      cc: action.cc_header?.trim() || undefined,
      subject: action.subject?.trim() || "(no subject)",
      body,
      googleAccount: action.google_account,
    },
    { newCard: true, touch: false },
  );
  console.log(`Approval action ${action.id}: card resent`);
  return { ok: true, message: "Posted a fresh approval card for that draft." };
}

async function discardDraft(
  ctx: Context,
  action: PendingAction,
): Promise<void> {
  const outcome = await performDraftDiscard(action);
  if (!outcome.ok) {
    if (outcome.reason === "no_draft") {
      await ctx.answerCallbackQuery({
        text: "This approval has no draft to discard.",
        show_alert: true,
      });
      return;
    }
    const text =
      outcome.reason === "delete_failed"
        ? "Discarding failed. The draft is still pending; please try again."
        : outcome.reason === "in_progress"
          ? "That email is already being sent, so I didn't discard it."
          : outcome.reason === "already_sent"
            ? "That email was already delivered, so I didn't discard it."
            : "The draft was discarded, but its approval status could not be updated.";
    await ctx.answerCallbackQuery({
      text,
      show_alert: true,
    });
    return;
  }

  await showStatus(ctx, "Discarded").catch(() => {
    console.log(`Approval action ${action.id}: discard preview update failed`);
  });
  await ctx.answerCallbackQuery("Discarded").catch(() => undefined);
}

export type ApprovalOperation =
  | "send"
  | "edit"
  | "discard"
  | "draft"
  | "create"
  | "cancel";

async function showFullDraft(ctx: Context, action: PendingAction): Promise<void> {
  if (action.type !== "send_draft" || !action.draft_id) {
    await ctx.answerCallbackQuery({
      text: "That approval is not a draft.",
      show_alert: true,
    });
    return;
  }
  const gmail = await gmailFor(action.google_account);
  const draft = await gmail.users.drafts.get({
    userId: "me",
    id: action.draft_id,
    format: "full",
  });
  const payload = draft.data.message?.payload;
  const body = payload ? stripSignature(plainTextBody(payload).trim()).body.trim() : "";
  if (!body) {
    await ctx.answerCallbackQuery({
      text: "That draft has no text.",
      show_alert: true,
    });
    return;
  }
  await ctx.answerCallbackQuery("Sending the full draft.");
  const parts = splitTelegramText(body);
  for (const part of parts) {
    await ctx.reply(part);
  }
}

export async function handleApprovalCallback(
  ctx: Context,
  operation: ApprovalOperation,
  actionId: number,
): Promise<void> {
  const action = await currentPendingAction(ctx, actionId);
  if (!action) {
    return;
  }

  // Draft-only operations.
  if (operation === "draft") {
    try {
      await showFullDraft(ctx, action);
    } catch (error) {
      const errorType = error instanceof Error ? error.name : "UnknownError";
      console.error(`Approval action ${action.id}: full draft failed (${errorType})`);
      await ctx.answerCallbackQuery({
        text: "I couldn't load that draft.",
        show_alert: true,
      });
    }
    return;
  }

  if (operation === "edit") {
    if (action.type !== "send_draft") {
      await ctx.answerCallbackQuery({
        text: "Edit only applies to drafts.",
        show_alert: true,
      });
      return;
    }
    editingActionByUser.set(config.ownerTelegramId, action.id);
    console.log(`Approval action ${action.id}: awaiting edit instructions`);
    await ctx.answerCallbackQuery("Send your edit instructions.");
    await ctx.reply("What would you like to change in this draft?");
    return;
  }

  // Reject cross-type button taps so a stale draft keyboard can't
  // trigger an event action and vice versa.
  if (
    (operation === "send" || operation === "discard") &&
    action.type !== "send_draft"
  ) {
    await ctx.answerCallbackQuery({
      text: "That approval is for an event, not a draft.",
      show_alert: true,
    });
    return;
  }
  if (
    (operation === "create" || operation === "cancel") &&
    action.type !== "create_event"
  ) {
    await ctx.answerCallbackQuery({
      text: "That approval is for a draft, not an event.",
      show_alert: true,
    });
    return;
  }

  if (activeActions.has(action.id)) {
    await ctx.answerCallbackQuery("This action is already being processed.");
    return;
  }

  activeActions.add(action.id);
  try {
    if (operation === "send") {
      await sendDraft(ctx, action);
    } else if (operation === "discard") {
      await discardDraft(ctx, action);
    } else if (operation === "create") {
      await createEvent(ctx, action);
    } else if (operation === "cancel") {
      await cancelEvent(ctx, action);
    }
  } finally {
    activeActions.delete(action.id);
  }
}

/** The scheduled worker delivered this draft's email. The Send card can no longer send it. */
export async function retireDraftApproval(draftId: string, account: GoogleAccountId): Promise<void> {
  const action = getPendingActionForDraft(draftId);
  if (!action || action.google_account !== account) {
    return;
  }
  if (action.telegram_message_id) {
    try {
      await telegram.editMessageText(
        config.ownerTelegramId,
        action.telegram_message_id,
        "Draft approval\n\nStatus: Sent",
        { reply_markup: new InlineKeyboard() },
      );
    } catch {
      console.log(`Approval action ${action.id}: scheduled-send preview update failed`);
    }
  }
  if (transitionPendingAction(action.id, "pending", "sent")) {
    console.log(`Approval action ${action.id}: status -> sent reason=scheduled_delivery`);
  }
}

export function hasPendingDraftEdit(userId: number): boolean {
  return editingActionByUser.has(userId);
}

export async function consumeDraftEdit(
  userId: number,
): Promise<DraftEditContext | undefined> {
  const actionId = editingActionByUser.get(userId);
  if (!actionId) {
    return undefined;
  }
  editingActionByUser.delete(userId);

  const action = getPendingAction(actionId);
  if (
    !action ||
    action.type !== "send_draft" ||
    !action.draft_id ||
    action.status !== "pending" ||
    isStale(action)
  ) {
    if (action?.status === "pending") {
      await expireAction(action);
    }
    return undefined;
  }
  const draftId = action.draft_id;
  const snapshot = await readDraftSnapshot(draftId, action.google_account);
  return {
    actionId: action.id,
    draftId,
    ...snapshot,
    account: action.google_account,
  };
}

export async function expirePendingApprovals(): Promise<void> {
  for (const action of getExpiredPendingActions()) {
    await expireAction(action);
  }
}

export function startApprovalExpirySweep(): NodeJS.Timeout {
  void expirePendingApprovals();
  const interval = setInterval(() => {
    void expirePendingApprovals();
  }, EXPIRY_SWEEP_MS);
  interval.unref();
  return interval;
}
