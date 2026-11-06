import { Api, InlineKeyboard, type Context } from "grammy";
import { google, type gmail_v1 } from "googleapis";
import { retireSequenceDraftCard } from "./approvals.js";
import { accountMatchesEmail } from "./account_logic.js";
import { decodedAccounts } from "./accounts.js";
import { config } from "./config.js";
import {
  addSalesDoNotContact,
  countSalesSendsSince,
  getBlockedSalesStepForDraft,
  getPendingActionForDraft,
  getSalesSequence,
  hasPendingMeetingWithEmail,
  isSalesDoNotContact,
  isSalesSequenceSentMessage,
  lastSalesSendAt,
  listActiveSalesSequences,
  listSalesSequenceSteps,
  listSalesStepsWaitingOnCard,
  markSalesStepWaitingPing,
  postponeSalesSequence,
  recoverSalesStepSent,
  setSalesSequenceTimezone,
  setSalesStepSlots,
  stopActiveSalesSequence,
  type SalesSequenceRecord,
} from "./db.js";
import { parseAddressList } from "./followup_logic.js";
import { getSentThreadMetadata, loadFollowupSelfAddresses } from "./followups.js";
import type { LoadedGoogleAccount } from "./google/auth.js";
import {
  buildMimeMessage,
  messageHeader as headerOf,
  plainTextBody,
  signatureHtmlFor,
  stripSignature,
} from "./google/mail.js";
import { messageHeader } from "./gmail_attachments.js";
import { isSelfEmail } from "./mom_logic.js";
import { blockedAutoSendDomains, PERSONAL_DOMAINS } from "./meeting_book.js";
import { salesFactsStatus } from "./sales_facts.js";
import { everyMs, type IntervalJob } from "./scheduler.js";
import { allowInboundCommands } from "./security/owner_lock.js";
import { allowOwnerChatStopSequence } from "./security/send_approval.js";
import {
  sendSequenceStep,
  SequenceSendRefusedError,
  SequenceSendRejectedError,
  SequenceSendUnconfirmedError,
} from "./security/sequence_send.js";
import {
  countManualFollowups,
  domainInSet,
  domainOf,
  isBounceSender,
  matchesProspect,
  OWN_DOMAIN,
  SEQUENCE_STEPS,
} from "./sequence_logic.js";
import {
  evaluateStopRules,
  inSendWindow,
  istDayStart,
  matchSequencesForStop,
  nextSendWindow,
  sequenceRecipient,
  type InboundFact,
  type OwnSendFact,
  type StopDecision,
  type StopFacts,
} from "./sequence_rules.js";
import { offerSlots, prepareSequenceStep } from "./sequence_writer.js";
import { ownAddressOf, readProspectTimezone, workGmail } from "./sequences.js";
import { assertTestSeam } from "./test_seam.js";
import type { ToolTurn } from "./tools/index.js";

const TICK_INTERVAL_MS = 5 * 60 * 1000;
const TICK_TIMEOUT_MS = 10 * 60 * 1000;
const RETRY_AFTER_MS = 60 * 60 * 1000;
const WAITING_ON_CARD_MS = 5 * 24 * 60 * 60 * 1000;
const MAX_PREPARES_PER_TICK = 3;
const STOP_SCAN_RESULTS = 20;
const TIME_ZONE = "Asia/Kolkata";

interface CalendarEventFact {
  attendees?: Array<{ email?: string | null }> | null;
  organizer?: { email?: string | null } | null;
}

let calendarEventsHook:
  | ((email: string, sinceIso: string) => Promise<CalendarEventFact[]>)
  | undefined;

export function setSequenceRunnerTestHooks(hooks: {
  calendarEvents?: (email: string, sinceIso: string) => Promise<CalendarEventFact[]>;
}): void {
  assertTestSeam("setSequenceRunnerTestHooks");
  calendarEventsHook = hooks.calendarEvents;
}

function displayName(row: { prospect_name: string; prospect_email: string }): string {
  return row.prospect_name.trim() || row.prospect_email;
}

function listLine(row: SalesSequenceRecord): string {
  const company = row.prospect_company ? `, ${row.prospect_company}` : "";
  return `${displayName(row)}${company} <${row.prospect_email}>`;
}

/** Stops the sequence and takes any waiting approval card with it, so a stopped
 *  sequence can't send a draft from an old card. */
async function stopSequence(row: SalesSequenceRecord, reason: string): Promise<boolean> {
  const blocked = listSalesSequenceSteps(row.id).find(
    (step) => step.status === "blocked" && step.draft_id,
  );
  const stopped = stopActiveSalesSequence(row.id, reason);
  if (stopped) {
    console.log(`Sequence ${row.id}: status -> stopped reason=${reason}`);
    if (blocked?.draft_id) {
      await retireSequenceDraftCard(blocked.draft_id);
    }
  }
  return stopped;
}

async function listIds(gmail: gmail_v1.Gmail, q: string): Promise<string[]> {
  const listed = await gmail.users.messages.list({
    userId: "me",
    q,
    maxResults: STOP_SCAN_RESULTS,
  });
  return (listed.data.messages ?? [])
    .map((item) => item.id)
    .filter((id): id is string => Boolean(id));
}

function senderOf(message: gmail_v1.Schema$Message): string {
  return parseAddressList(messageHeader(message, "From"))[0]?.email ?? "";
}

async function inboundSince(
  gmail: gmail_v1.Gmail,
  row: SalesSequenceRecord,
  sinceMs: number,
): Promise<InboundFact[]> {
  const who = PERSONAL_DOMAINS.has(row.prospect_domain)
    ? row.prospect_email
    : row.prospect_domain;
  const ids = await listIds(gmail, `from:${who} after:${Math.floor(sinceMs / 1000)}`);
  const facts: InboundFact[] = [];
  for (const id of ids) {
    const { data: message } = await gmail.users.messages.get({
      userId: "me",
      id,
      format: "full",
    });
    const labels = message.labelIds ?? [];
    const at = Number(message.internalDate ?? 0);
    const from = senderOf(message);
    if (
      labels.includes("DRAFT") ||
      labels.includes("SENT") ||
      at < sinceMs ||
      !matchesProspect(from, row.prospect_email, PERSONAL_DOMAINS)
    ) {
      continue;
    }
    facts.push({
      id,
      threadId: message.threadId ?? "",
      from,
      subject: messageHeader(message, "Subject"),
      autoSubmitted: messageHeader(message, "Auto-Submitted"),
      autoReplyHeader:
        messageHeader(message, "X-Autoreply") !== "" ||
        messageHeader(message, "X-Autorespond") !== "",
      precedence: messageHeader(message, "Precedence"),
      listUnsubscribe: messageHeader(message, "List-Unsubscribe") !== "",
      body: message.payload ? plainTextBody(message.payload) : "",
      at,
    });
  }
  return facts;
}

async function bouncedSince(
  gmail: gmail_v1.Gmail,
  row: SalesSequenceRecord,
  sinceMs: number,
): Promise<boolean> {
  const ids = await listIds(
    gmail,
    `from:(mailer-daemon OR postmaster) after:${Math.floor(sinceMs / 1000)} "${row.prospect_email}"`,
  );
  for (const id of ids) {
    const { data: message } = await gmail.users.messages.get({
      userId: "me",
      id,
      format: "metadata",
      metadataHeaders: ["From"],
    });
    if (isBounceSender(senderOf(message)) && Number(message.internalDate ?? 0) >= sinceMs) {
      return true;
    }
  }
  return false;
}

/** His own mail to them since enrolment. A message recorded against a step, even
 *  one he approved from a blocked card, is the sequence's and doesn't count. */
async function ownSendsSince(
  gmail: gmail_v1.Gmail,
  row: SalesSequenceRecord,
  sinceMs: number,
): Promise<OwnSendFact[]> {
  const who = PERSONAL_DOMAINS.has(row.prospect_domain)
    ? row.prospect_email
    : row.prospect_domain;
  const ids = await listIds(
    gmail,
    `in:sent after:${Math.floor(sinceMs / 1000)} (to:${who} OR cc:${who} OR bcc:${who})`,
  );
  const facts: OwnSendFact[] = [];
  for (const id of ids) {
    if (isSalesSequenceSentMessage(id)) {
      continue;
    }
    const { data: message } = await gmail.users.messages.get({
      userId: "me",
      id,
      format: "metadata",
      metadataHeaders: ["To", "Cc", "Bcc"],
    });
    const at = Number(message.internalDate ?? 0);
    const recipients = ["To", "Cc", "Bcc"].flatMap((name) =>
      parseAddressList(messageHeader(message, name)).map((item) => item.email),
    );
    if (
      message.labelIds?.includes("DRAFT") ||
      at < sinceMs ||
      !recipients.some((email) => matchesProspect(email, row.prospect_email, PERSONAL_DOMAINS))
    ) {
      continue;
    }
    facts.push({ id, threadId: message.threadId ?? "", at });
  }
  return facts;
}

/** A colleague wrote on the thread since enrolment, to the prospect or to him. All
 *  he sends carries the SENT label, aliases included, so his own mail never reads
 *  as a colleague's. */
async function colleagueWroteOnThread(
  gmail: gmail_v1.Gmail,
  row: SalesSequenceRecord,
  sinceMs: number,
): Promise<boolean> {
  const { data } = await gmail.users.threads.get({
    userId: "me",
    id: row.thread_id,
    format: "metadata",
    metadataHeaders: ["From"],
  });
  return (data.messages ?? []).some((message) => {
    const labels = message.labelIds ?? [];
    const from = senderOf(message);
    return (
      !labels.includes("SENT") &&
      !labels.includes("DRAFT") &&
      Number(message.internalDate ?? 0) >= sinceMs &&
      domainOf(from) === OWN_DOMAIN &&
      !isSelfEmail(from)
    );
  });
}

async function calendarHasProspect(
  account: LoadedGoogleAccount,
  email: string,
  sinceIso: string,
): Promise<boolean> {
  let events: CalendarEventFact[];
  if (calendarEventsHook) {
    events = await calendarEventsHook(email, sinceIso);
  } else {
    const calendar = google.calendar({ version: "v3", auth: account.client });
    const listed = await calendar.events.list({
      calendarId: "primary",
      q: email,
      timeMin: sinceIso,
      singleEvents: true,
      maxResults: 10,
    });
    events = listed.data.items ?? [];
  }
  const wanted = email.trim().toLowerCase();
  return events.some(
    (event) =>
      event.organizer?.email?.toLowerCase() === wanted ||
      (event.attendees ?? []).some((item) => item.email?.toLowerCase() === wanted),
  );
}

function isBlockedParty(row: SalesSequenceRecord): boolean {
  if (domainInSet(row.prospect_domain, blockedAutoSendDomains())) {
    return true;
  }
  return decodedAccounts().some(
    (account) =>
      (account.relationship === "partner" || account.relationship === "end_client") &&
      accountMatchesEmail(account, row.prospect_email),
  );
}

/** Everything the stop rules read. Only reads Gmail, Calendar and the database. */
export async function gatherStopFacts(
  gmail: gmail_v1.Gmail,
  account: LoadedGoogleAccount,
  row: SalesSequenceRecord,
  now: Date,
): Promise<StopFacts> {
  const sinceMs = new Date(row.enrolled_at ?? row.original_sent_at).getTime();
  const steps = listSalesSequenceSteps(row.id);
  const claimed = steps.find((step) => step.status === "sending");
  const [inbound, bounced, ownSends, colleagueOnThread, onCalendar] = [
    await inboundSince(gmail, row, sinceMs),
    await bouncedSince(gmail, row, sinceMs),
    await ownSendsSince(gmail, row, sinceMs),
    await colleagueWroteOnThread(gmail, row, sinceMs),
    await calendarHasProspect(account, row.prospect_email, new Date(sinceMs).toISOString()),
  ];
  return {
    now,
    threadId: row.thread_id,
    timezone: row.prospect_timezone,
    blockedParty: isBlockedParty(row),
    doNotContact: isSalesDoNotContact(row.prospect_email),
    bounced,
    inbound,
    meeting: onCalendar || hasPendingMeetingWithEmail(row.prospect_email),
    ownSends,
    colleagueOnThread,
    claimed: claimed
      ? { stepNo: claimed.step_no, claimedAt: new Date(claimed.claimed_at ?? 0).getTime() }
      : undefined,
    pausedOnCard: steps.some((step) => step.status === "blocked"),
  };
}

async function tellOwner(api: Api, text: string): Promise<void> {
  try {
    await api.sendMessage(config.ownerTelegramId, text);
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(`Sequence notice failed (${errorType})`);
  }
}

function stopNotice(row: SalesSequenceRecord, decision: StopDecision): string | undefined {
  if (decision.action !== "stop") {
    return undefined;
  }
  const who = displayName(row);
  if (decision.reason === "own_email") {
    return `Stopped follow-ups to ${who}: you emailed them yourself.`;
  }
  if (decision.reason === "colleague_on_thread") {
    return `Stopped follow-ups to ${who}: a colleague wrote on that thread.`;
  }
  if (decision.reason === "send_recovered") {
    return `Stopped follow-ups to ${who}: follow-up ${decision.recovered?.stepNo} went out but wasn't recorded, so I stopped rather than risk a double send.`;
  }
  if (decision.reason === "send_unconfirmed") {
    return `Stopped follow-ups to ${who}: I can't confirm follow-up ${decision.unconfirmedStep} went out, and I won't resend it. Check your Sent mail.`;
  }
  return undefined;
}

type RuleOutcome = "clear" | "stopped" | "postponed";

/** Runs on every scan and again right before a send. */
async function applyStopRules(
  api: Api,
  gmail: gmail_v1.Gmail,
  account: LoadedGoogleAccount,
  row: SalesSequenceRecord,
  now: Date,
): Promise<RuleOutcome> {
  const decision = evaluateStopRules(await gatherStopFacts(gmail, account, row, now));
  if (decision.action === "none") {
    return "clear";
  }
  if (decision.action === "postpone") {
    if (decision.until.getTime() <= now.getTime()) {
      return "clear";
    }
    if (postponeSalesSequence(row.id, decision.until.toISOString())) {
      console.log(`Sequence ${row.id}: postponed reason=out_of_office`);
    }
    return "postponed";
  }
  if (decision.reason === "do_not_contact") {
    addSalesDoNotContact(row.prospect_email, "stop_rule");
    for (const email of decision.doNotContact ?? []) {
      addSalesDoNotContact(email, "stop_rule");
    }
  }
  if (decision.recovered) {
    recoverSalesStepSent({
      sequenceId: row.id,
      stepNo: decision.recovered.stepNo,
      sentMessageId: decision.recovered.message.id,
      sentAt: new Date(decision.recovered.message.at).toISOString(),
      reason: decision.reason,
    });
    console.log(`Sequence ${row.id}: status -> stopped reason=${decision.reason}`);
  } else {
    await stopSequence(row, decision.reason);
  }
  const notice = stopNotice(row, decision);
  if (notice) {
    await tellOwner(api, notice);
  }
  return "stopped";
}

async function pingWaitingCards(api: Api, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - WAITING_ON_CARD_MS).toISOString();
  for (const step of listSalesStepsWaitingOnCard(cutoff)) {
    const row = getSalesSequence(step.sequence_id);
    if (!row) {
      continue;
    }
    const card = step.draft_id ? getPendingActionForDraft(step.draft_id) : undefined;
    try {
      await api.sendMessage(
        config.ownerTelegramId,
        `Follow-up to ${displayName(row)} has been waiting for your tap for 5 days - Send, Edit or Discard?`,
        card?.telegram_message_id
          ? {
              reply_parameters: {
                message_id: card.telegram_message_id,
                allow_sending_without_reply: true,
              },
            }
          : {},
      );
      markSalesStepWaitingPing(step.sequence_id, step.step_no, now.toISOString());
    } catch (error) {
      const errorType = error instanceof Error ? error.name : "UnknownError";
      console.error(`Sequence ${row.id}: waiting ping failed (${errorType})`);
    }
  }
}

function replySubject(subject: string): string {
  return /^re\s*:/i.test(subject) ? subject : `Re: ${subject}`;
}

/** Threading comes from the live thread each time, never from a stored id. */
export async function liveThreadFacts(
  gmail: gmail_v1.Gmail,
  row: SalesSequenceRecord,
): Promise<{ inReplyTo: string; references: string; followupsSoFar: number } | undefined> {
  const thread = await getSentThreadMetadata(gmail, row.thread_id);
  const messages = (thread.messages ?? [])
    .filter((message) => !message.labelIds?.includes("DRAFT"))
    .sort((left, right) => Number(left.internalDate ?? 0) - Number(right.internalDate ?? 0));
  const latest = messages[messages.length - 1];
  if (!latest) {
    return undefined;
  }
  return {
    inReplyTo: messageHeader(latest, "Message-ID"),
    references: messageHeader(latest, "References"),
    followupsSoFar: countManualFollowups(
      messages.map((message) => ({
        sentByMe: Boolean(message.labelIds?.includes("SENT")),
        toProspect: parseAddressList(messageHeader(message, "To")).some(
          (item) => item.email === row.prospect_email,
        ),
      })),
    ),
  };
}

function capOrSpacingHolds(now: Date): boolean {
  if (countSalesSendsSince(istDayStart(now).toISOString()) >= config.sequenceDailySendCap) {
    return true;
  }
  const last = lastSalesSendAt();
  return (
    last !== undefined &&
    (now.getTime() - new Date(last).getTime()) / 60_000 < config.sequenceMinSpacingMinutes
  );
}

export interface SequenceTickResult {
  scanned: number;
  stopped: number;
  postponed: number;
  sent: number;
}

/** One tick: every stop rule on every active sequence, the 5-day chase, then at
 *  most one send. Nothing here messages Vishnu about a normal send. */
export async function runSequenceTick(
  api: Api,
  options: { now?: Date; factsPath?: string } = {},
): Promise<SequenceTickResult> {
  const now = options.now ?? new Date();
  const result: SequenceTickResult = { scanned: 0, stopped: 0, postponed: 0, sent: 0 };
  if (!config.sequencesEnabled) {
    return result;
  }
  const { account, gmail } = await workGmail();
  const fromAddress = await ownAddressOf(gmail);

  const failedScan = new Set<number>();
  for (const row of listActiveSalesSequences()) {
    try {
      const outcome = await applyStopRules(api, gmail, account, row, now);
      result.scanned += 1;
      if (outcome === "stopped") {
        result.stopped += 1;
      } else if (outcome === "postponed") {
        result.postponed += 1;
      }
    } catch (error) {
      failedScan.add(row.id);
      const errorType = error instanceof Error ? error.name : "UnknownError";
      console.error(`Sequence ${row.id}: stop check failed (${errorType}); no send this tick`);
    }
  }
  await pingWaitingCards(api, now);

  if (!salesFactsStatus(options.factsPath).ready) {
    console.log("Sequence send: held, sales_facts.md is not ready");
    return result;
  }
  if (capOrSpacingHolds(now)) {
    return result;
  }

  const selfAddresses = await loadFollowupSelfAddresses();
  let prepares = 0;
  for (const listed of listActiveSalesSequences()) {
    if (prepares >= MAX_PREPARES_PER_TICK) {
      break;
    }
    if (
      failedScan.has(listed.id) ||
      !listed.next_step_at ||
      new Date(listed.next_step_at).getTime() > now.getTime()
    ) {
      continue;
    }
    if (
      config.sequenceTestRecipients.length > 0 &&
      !config.sequenceTestRecipients.includes(listed.prospect_email)
    ) {
      continue;
    }
    let row = listed;
    if (!row.prospect_timezone) {
      try {
        const timezone = await readProspectTimezone(gmail, row.prospect_email);
        if (timezone) {
          setSalesSequenceTimezone(row.id, timezone);
          row = { ...row, prospect_timezone: timezone };
        }
      } catch (error) {
        const errorType = error instanceof Error ? error.name : "UnknownError";
        console.error(`Sequence ${row.id}: timezone lookup failed (${errorType})`);
      }
    }
    if (!inSendWindow(now, row.prospect_timezone)) {
      continue;
    }
    const stepNo = row.current_step;
    prepares += 1;
    const prepared = await prepareSequenceStep(row.id, {
      now,
      factsPath: options.factsPath,
    });
    if (prepared.kind === "deferred") {
      postponeSalesSequence(row.id, new Date(now.getTime() + RETRY_AFTER_MS).toISOString());
      continue;
    }
    if (prepared.kind !== "ready") {
      continue;
    }
    try {
      const fresh = getSalesSequence(row.id);
      if (!fresh || fresh.status !== "active") {
        continue;
      }
      const check = await applyStopRules(api, gmail, account, fresh, now);
      if (check !== "clear") {
        result[check === "stopped" ? "stopped" : "postponed"] += 1;
        continue;
      }
      const live = await liveThreadFacts(gmail, fresh);
      if (!live) {
        continue;
      }
      if (live.followupsSoFar >= SEQUENCE_STEPS) {
        await stopSequence(fresh, "followups_used_up");
        result.stopped += 1;
        continue;
      }
      await sendSequenceStep({
        sequenceId: fresh.id,
        stepNo,
        account,
        fromAddress,
        threadId: fresh.thread_id,
        to: sequenceRecipient(fresh),
        subject: replySubject(fresh.subject),
        inReplyTo: live.inReplyTo,
        references: live.references,
        body: prepared.body,
        signatureHtml: await signatureHtmlFor(account),
        selfAddresses,
        now,
        factsPath: options.factsPath,
      });
      result.sent += 1;
      break;
    } catch (error) {
      if (error instanceof SequenceSendRefusedError) {
        console.log(`Sequence ${row.id}: send refused reason=${error.reason}`);
        if (error.hold) {
          break;
        }
        await stopSequence(row, `refused:${error.reason}`);
        await tellOwner(
          api,
          `Stopped follow-ups to ${displayName(row)}: a safety check refused the send (${error.reason}).`,
        );
        result.stopped += 1;
        continue;
      }
      if (error instanceof SequenceSendRejectedError) {
        if (error.status === 400) {
          await stopSequence(row, "send_rejected");
          await tellOwner(
            api,
            `Stopped follow-ups to ${displayName(row)}: Gmail refused the email as invalid.`,
          );
          result.stopped += 1;
        } else {
          postponeSalesSequence(row.id, new Date(now.getTime() + RETRY_AFTER_MS).toISOString());
        }
        continue;
      }
      if (error instanceof SequenceSendUnconfirmedError) {
        break;
      }
      const errorType = error instanceof Error ? error.name : "UnknownError";
      console.error(`Sequence ${row.id}: send step failed (${errorType})`);
      break;
    }
  }
  console.log(
    `Sequence tick: scanned=${result.scanned} stopped=${result.stopped} postponed=${result.postponed} sent=${result.sent}`,
  );
  return result;
}

function progress(row: SalesSequenceRecord): string {
  return `${row.manual_followups + row.steps_sent} of ${SEQUENCE_STEPS} follow-ups sent`;
}

/** The owner's stop, typed or spoken. The tool result is exactly what was stopped. */
export async function stopSequenceFromTool(
  target: string,
  turn: Pick<ToolTurn, "confirmation">,
): Promise<string> {
  allowOwnerChatStopSequence(turn.confirmation);
  const rows = listActiveSalesSequences();
  if (rows.length === 0) {
    return "Nothing stopped: there are no active follow-up sequences. If Vishnu meant a follow-up nudge, that is stop_tracking.";
  }
  const match = matchSequencesForStop(rows, target);
  const options = (items: SalesSequenceRecord[]): string =>
    items.map((row) => `- ${listLine(row)} (${progress(row)})`).join("\n");
  if (match.kind === "none") {
    return `Nothing stopped: no active sequence matches "${target}". Active sequences:\n${options(rows)}`;
  }
  if (match.kind === "ambiguous") {
    return `Nothing stopped yet: "${target}" matches more than one sequence. Ask Vishnu which:\n${options(match.rows)}`;
  }
  const stopped: SalesSequenceRecord[] = [];
  for (const row of match.rows) {
    if (await stopSequence(row, "owner_stop")) {
      stopped.push(row);
    }
  }
  return stopped.length > 0
    ? `Stopped ${stopped.length === 1 ? "this sequence" : `these ${stopped.length} sequences`}. No more automatic emails will go to:\n${options(stopped)}`
    : "Nothing stopped: that sequence had already ended.";
}

function nextSendLabel(row: SalesSequenceRecord, now: Date): string {
  const step = listSalesSequenceSteps(row.id).find((item) => item.step_no === row.current_step);
  if (step?.status === "blocked") {
    return "paused, waiting on your card";
  }
  if (step?.status === "sending") {
    return "sending";
  }
  if (!row.next_step_at) {
    return "paused";
  }
  const due = new Date(row.next_step_at);
  const at = nextSendWindow(due > now ? due : now, row.prospect_timezone);
  if (!at) {
    return `won't send: 10:00-17:00 their time (${row.prospect_timezone}) never meets 09:00-19:00 IST`;
  }
  return `next ${new Intl.DateTimeFormat("en-IN", {
    timeZone: TIME_ZONE,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(at)} IST`;
}

export function sequencesPanel(now = new Date()): {
  text: string;
  keyboard: InlineKeyboard | undefined;
} {
  const rows = listActiveSalesSequences();
  if (rows.length === 0) {
    return { text: "No active follow-up sequences.", keyboard: undefined };
  }
  const keyboard = new InlineKeyboard();
  for (const row of rows) {
    keyboard.text(`Stop ${displayName(row)}`.slice(0, 60), `seq:stop:${row.id}`).row();
  }
  const lines = rows.map(
    (row) => `- ${listLine(row)}: step ${row.current_step} of ${SEQUENCE_STEPS}, ${nextSendLabel(row, now)}`,
  );
  const off = config.sequencesEnabled
    ? ""
    : "\n\nSending is switched off (SEQUENCES_ENABLED), so nothing goes out until it's on.";
  return { text: `Active follow-up sequences:\n${lines.join("\n")}${off}`, keyboard };
}

export async function handleSequencesCommand(ctx: Context): Promise<void> {
  if (!allowInboundCommands(ctx.message)) {
    await ctx.reply("A forwarded message can't do that.");
    return;
  }
  const panel = sequencesPanel();
  await ctx.reply(panel.text, panel.keyboard ? { reply_markup: panel.keyboard } : {});
}

export async function handleSequenceStopCallback(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const match = /^seq:stop:(\d+)$/.exec(ctx.callbackQuery?.data ?? "");
  const row = match ? getSalesSequence(Number(match[1])) : undefined;
  const stopped = row?.status === "active" ? await stopSequence(row, "owner_stop") : false;
  const panel = sequencesPanel();
  const heading = row
    ? stopped
      ? `Stopped: ${listLine(row)} (${progress(row)}).`
      : `Already ended: ${listLine(row)}.`
    : "That sequence no longer exists.";
  const text = `${heading}\n\n${panel.text}`;
  const extra = panel.keyboard ? { reply_markup: panel.keyboard } : { reply_markup: undefined };
  await ctx.editMessageText(text, extra).catch(async () => {
    await ctx.reply(text, panel.keyboard ? { reply_markup: panel.keyboard } : {});
  });
}

/** Rebuilds the time lines Aadi wrote into a blocked step's draft, just before it
 *  is sent or edited. Once he has changed or removed any of them the times are his,
 *  and none come back. Throws when it can't get real times, so stale ones never go
 *  out. */
export async function refreshSequenceDraftSlots(
  draftId: string,
  now = new Date(),
): Promise<string | undefined> {
  const step = getBlockedSalesStepForDraft(draftId);
  const stored = JSON.parse(step?.slot_lines ?? "[]") as string[];
  if (!step || stored.length === 0) {
    return undefined;
  }
  const row = getSalesSequence(step.sequence_id);
  if (!row) {
    return undefined;
  }
  const { account, gmail } = await workGmail();
  const { data: draft } = await gmail.users.drafts.get({
    userId: "me",
    id: draftId,
    format: "full",
  });
  const message = draft.message;
  if (!message?.payload) {
    throw new Error("Draft has no content to refresh.");
  }
  const current = stripSignature(plainTextBody(message.payload).trim());
  const present = stored.filter((line) => current.body.includes(line));
  if (present.length < stored.length) {
    return undefined;
  }
  const offer = await offerSlots(now, row.prospect_timezone);
  if (!offer) {
    throw new Error("No free slots to offer.");
  }
  const fresh = offer.lines;
  if (present.length === fresh.length && present.every((line, index) => line === fresh[index])) {
    return undefined;
  }
  let body = current.body.replace(present[0]!, fresh.join("\n"));
  for (const line of present.slice(1)) {
    body = body.replace(`${line}\n`, "").replace(line, "");
  }
  body = body.replace(/\n{3,}/g, "\n\n").trim();
  const headers = message.payload.headers;
  const raw = buildMimeMessage(
    [
      ["To", headerOf(headers, "To")],
      ["Cc", headerOf(headers, "Cc")],
      ["Bcc", headerOf(headers, "Bcc")],
      ["Subject", headerOf(headers, "Subject")],
      ["In-Reply-To", headerOf(headers, "In-Reply-To")],
      ["References", headerOf(headers, "References")],
    ],
    body,
    current.signed ? await signatureHtmlFor(account) : "",
  );
  await gmail.users.drafts.update({
    userId: "me",
    id: draftId,
    requestBody: {
      id: draftId,
      message: {
        threadId: message.threadId ?? undefined,
        raw: Buffer.from(raw, "utf8").toString("base64url"),
      },
    },
  });
  setSalesStepSlots(step.sequence_id, step.step_no, body, fresh);
  console.log(`Sequence ${row.id}: refreshed slots on blocked step ${step.step_no}`);
  return `Times refreshed before sending:\n${fresh.join("\n")}`;
}

export function registerSequenceSend(api: Api): IntervalJob | undefined {
  if (!config.sequencesEnabled) {
    console.log("Sequence sending off (SEQUENCES_ENABLED).");
    return undefined;
  }
  const job = everyMs(
    "sequence-send",
    TICK_INTERVAL_MS,
    async () => {
      await runSequenceTick(api);
    },
    { jobTimeoutMs: TICK_TIMEOUT_MS },
  );
  console.log("Sequence send scheduled every 5 min.");
  return job;
}
