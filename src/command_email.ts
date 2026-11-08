import { Api, InlineKeyboard, type Context } from "grammy";
import type { gmail_v1 } from "googleapis";
import {
  addressIn,
  asksForAttachment,
  isAutomatedAddress,
  mentionsSendDate,
  namedInOwnWords,
  notAnEventCommand,
  notASendCommand,
} from "./command_logic.js";
import { resolveRecipient } from "./command_recipients.js";
import { writeCommandEmail } from "./command_writer.js";
import { config } from "./config.js";
import {
  closeCommandChoice,
  createCommandChoice,
  createScheduledSend,
  getCommandChoice,
  getCommandSendByKey,
  listOpenCommandChoices,
} from "./db.js";
import { formatMailbox, formatMailboxList } from "./draft_recipients.js";
import { parseAddressList, type ParsedMailbox } from "./mail_helpers.js";
import { getSentThreadMetadata, loadFollowupSelfAddresses } from "./mail_helpers.js";
import { messageHeader } from "./gmail_attachments.js";
import { getGoogleAccount, type GoogleAccountId } from "./google/auth.js";
import { gmailClient, signatureHtmlFor } from "./google/mail.js";
import { isSelfEmail } from "./mom_logic.js";
import { bookResolvedMeeting, freeSlotsText, parseCommandTimes } from "./owner_meeting.js";
import {
  CommandSendRefusedError,
  CommandSendRejectedError,
  CommandSendUnconfirmedError,
  sendCommandEmail,
} from "./security/command_send.js";
import { SendNotApprovedError } from "./security/send_approval.js";
import { installCaptionEditFallback } from "./telegram_io.js";
import { assertTestSeam } from "./test_seam.js";
import { holdForVoiceNote } from "./voice_cards.js";
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
export async function writeAndSend(
  request: CommandRequest,
  base: string,
  confirmation: { chatId: number; messageId: number } | undefined,
  now: Date,
  options: {
    /** Runs once the email is written, right before Gmail. False stops the send. */
    beforeSend?: () => boolean;
    note?: string;
  } = {},
): Promise<Outcome> {
  const to = request.to.map((slot) => slot.mailbox!);
  const cc = request.cc.map((slot) => slot.mailbox!);
  const key = sendKey(base, to);
  if (getCommandSendByKey(key)) {
    return { text: "Not sent again: this command was already handled.", result: "not_sent" };
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
  try {
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

  const subject = thread ? replySubject(thread.subject) : request.subject?.trim() || written.subject;
  const toHeader = formatMailboxList(to);
  const ccHeader = formatMailboxList(cc);
  const selfAddresses = await loadFollowupSelfAddresses();
  const named = new Set([...to, ...cc].map((item) => item.email));
  const leftOff = (thread?.mailboxes ?? []).filter(
    (item) =>
      !named.has(item.email) &&
      !selfAddresses.has(item.email) &&
      !isSelfEmail(item.email) &&
      !isAutomatedAddress(item.email),
  );
  if (options.beforeSend && !options.beforeSend()) {
    return { text: "Not sent: it was cancelled.", result: "cancelled" };
  }
  let messageId: string;
  try {
    ({ messageId } = await sendCommandEmail({
      key,
      confirmation,
      account,
      to: toHeader,
      cc: ccHeader,
      resolved: named,
      subject,
      body: written.body,
      signatureHtml: await signatureHtmlFor(account),
      threadId: request.threadId,
      inReplyTo: thread?.inReplyTo ?? "",
      references: thread?.references ?? "",
    }));
  } catch (error) {
    if (error instanceof CommandSendRefusedError) {
      if (error.reason === "refers_to_attachment") {
        return {
          text: "Not sent: the email it wrote mentions an attachment and I can't attach anything, so nothing went out.",
          hint: "Ask Vishnu how he wants to handle the file.",
          result: "not_sent",
        };
      }
      return {
        text:
          error.reason === "already_handled"
            ? "Not sent again: this command was already handled."
            : `Not sent: a delivery check refused it (${error.reason}), so nothing went out.`,
        result: "not_sent",
      };
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
  }

  const lines = [
    `Sent to ${toHeader}.`,
    ...(ccHeader ? [`Cc: ${ccHeader}`] : []),
    `Subject: ${subject}`,
    ...(leftOff.length > 0 ? [`Left off the thread: ${formatMailboxList(leftOff)}`] : []),
    ...(options.note ? [options.note] : []),
  ];
  const summary = lines.join("\n");
  try {
    const full = `${summary}\n\n${shown(written.body)}`;
    if (!holdForVoiceNote({ text: full, caption: summary })) {
      await api().sendMessage(config.ownerTelegramId, full);
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

function choiceKeyboard(choiceId: number, options: readonly ParsedMailbox[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  options.forEach((option, index) => {
    keyboard.text(formatMailbox(option).slice(0, 60), `cmdsend:pick:${choiceId}:${index}`).row();
  });
  return keyboard.text("Don't send", `cmdsend:drop:${choiceId}`);
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
async function scheduleRequest(
  request: CommandRequest,
  base: string,
  confirmation: { chatId: number; messageId: number } | undefined,
): Promise<Outcome> {
  if (!confirmation) {
    return { text: "Not scheduled: only Vishnu's own message can do that." };
  }
  const to = request.to.map((slot) => slot.mailbox!);
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
    subject = replySubject(thread.subject);
  }
  const shownSubject = subject || request.instruction.split(/\s+/).slice(0, 8).join(" ");
  const names = request.to.map((slot) => slot.mailbox!.name || slot.query).join(", ");
  const itemText = `Send email to ${names} — ${shownSubject} — ${scheduledWhen(request.sendAt!)}`;
  const row = createScheduledSend({
    key: `${sendKey(base, to)}:${request.sendAt}`,
    sendAt: request.sendAt!,
    itemText,
    tag: request.account === "personal" ? "personal" : "work",
    request: JSON.stringify({ ...request, subject }),
    confirmChat: confirmation.chatId,
    confirmMessage: confirmation.messageId,
  });
  if (!row) {
    return { text: "Not scheduled again: this command was already handled." };
  }
  console.log(`Scheduled send ${row.id}: status -> scheduled`);
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
    return writeAndSend(request, base, confirmation, now);
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
    now,
  });
  return { text: result.text };
}

/** Fills in each recipient it can. Stops at the first one it can't, and asks. */
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
  for (const slot of [...request.to, ...request.cc]) {
    if (slot.mailbox) {
      continue;
    }
    const match = await resolveRecipient({
      gmail,
      query: slot.query,
      selfAddresses,
      threadMailboxes,
    });
    if (match.kind === "one") {
      slot.mailbox = match.mailbox;
      continue;
    }
    if (match.kind === "none") {
      return {
        text: `${notDone(request)}: I found no address for "${slot.query}", so nothing went out.`,
        hint: "Ask Vishnu for the address.",
      };
    }
    if (match.options.length > MAX_BUTTONS) {
      return {
        text: `${notDone(request)}: "${slot.query}" matches ${match.options.length} addresses, so nothing went out.`,
        hint: "Ask Vishnu for the person's full name or address.",
      };
    }
    slot.options = match.options;
    const choiceId = createCommandChoice(JSON.stringify(request), now.toISOString());
    const choiceCard = {
      text: `Which ${slot.query}? Nothing has gone out.`,
      caption: `Which ${slot.query}? Nothing has gone out.`,
      keyboard: choiceKeyboard(choiceId, match.options),
    };
    if (!holdForVoiceNote(choiceCard)) {
      await api().sendMessage(config.ownerTelegramId, choiceCard.text, {
        reply_markup: choiceCard.keyboard,
      });
    }
    return {
      text: `${notDone(request)} yet: "${slot.query}" matches ${match.options.length} addresses and I've asked with buttons.`,
      hint: "Tell him to tap one, and don't pick one yourself.",
      shown: true,
    };
  }
  return finishRequest(request, base, confirmation, now);
}

/** Who he named, checked against his own words, or why it can't be used. An address
 *  Aadi already offered him counts, because he's answering that question. */
function recipientSlots(
  queries: readonly string[],
  ownWords: string,
  now: Date,
  refusal: string,
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
  const slots: RecipientSlot[] = [];
  for (const query of queries) {
    const address = addressIn(query);
    const offers = address ? offeredIn(address) : [];
    if (address && offers.length > 0) {
      offers.forEach((choice) => answered.add(choice.id));
      slots.push({ query, mailbox: { email: address, name: "" } });
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2}$/.test(time) || Number.isNaN(at.getTime())) {
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
export async function sendEmailFromTool(
  input: unknown,
  turn: Pick<ToolTurn, "confirmation" | "userText">,
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
  };
  if (values.attachment_requested === true || asksForAttachment(ownWords)) {
    return "Not sent: he asked for a file and I can't attach one here, so nothing went out. Ask him whether to send it without the file or draft it so he can add it.";
  }
  const when = parseSendAt(values.send_on, values.send_time, now);
  if (typeof when === "object") {
    return when.refused;
  }
  if (when === undefined && mentionsSendDate(ownWords)) {
    return "Not sent: he gave a date or time, so nothing went out. Call send_email again with send_on, and send_time if he gave one.";
  }
  const toQueries = stringList(values.to);
  const ccQueries = stringList(values.cc);
  const instruction = typeof values.instruction === "string" ? values.instruction.trim() : "";
  if (toQueries.length === 0) {
    return "Not sent: he didn't name anyone. Ask him who it's for.";
  }
  if (!instruction) {
    return "Not sent: I don't know what it should say. Ask him.";
  }
  const slots = recipientSlots([...toQueries, ...ccQueries], ownWords, now, when ? "Not scheduled" : "Not sent");
  if (typeof slots === "string") {
    return slots;
  }
  const request: CommandRequest = {
    kind: "email",
    to: slots.slice(0, toQueries.length),
    cc: slots.slice(toQueries.length),
    threadId:
      typeof values.thread_id === "string" && values.thread_id.trim() ? values.thread_id.trim() : null,
    instruction,
    ownWords,
    account: values.account === "personal" ? "personal" : "work",
    ...(when ? { sendAt: when } : {}),
    ...(typeof values.subject === "string" && values.subject.trim()
      ? { subject: values.subject.trim() }
      : {}),
  };
  return asToolResult(
    await resolveAndContinue(
      request,
      `msg:${confirmation.chatId}:${confirmation.messageId}`,
      confirmation,
      now,
    ),
  );
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
  const notCommand = notAnEventCommand(ownWords);
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
  const queries = stringList(values.attendees);
  if (queries.length === 0) {
    return "Not booked: he didn't name anyone. For a calendar-only event use create_event.";
  }
  const slots = recipientSlots(queries, ownWords, now, "Not booked");
  if (typeof slots === "string") {
    return slots;
  }
  const duration = typeof values.duration_minutes === "number" ? values.duration_minutes : undefined;
  const startTime = typeof values.start_time === "string" ? values.start_time : "";
  if (!startTime.trim()) {
    return freeSlotsText(duration, now);
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
    ownWords,
    account: "work",
    meeting: {
      title: typeof values.title === "string" ? values.title : undefined,
      startIso: times.startIso,
      endIso: times.endIso,
    },
  };
  return asToolResult(
    await resolveAndContinue(
      request,
      `meeting:${confirmation.chatId}:${confirmation.messageId}`,
      confirmation,
      now,
    ),
  );
}

/** add_calendar_attendee while this is on: the same rule, so an invite can't reach an
 *  address that came from something Aadi read. */
export async function resolveCommandAttendee(
  query: string,
  ownWords: string,
): Promise<{ email: string } | { refused: string }> {
  if (!namedInOwnWords(query, ownWords)) {
    return {
      refused: `Not added: "${query}" isn't a name or address in Vishnu's own message. Pass the name as he said it, or ask him.`,
    };
  }
  const gmail = gmailClient(await getGoogleAccount("work"));
  const match = await resolveRecipient({
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
  slot.mailbox = picked;
  slot.seen = slot.options;
  delete slot.options;
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
