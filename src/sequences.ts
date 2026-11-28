import { Api, InlineKeyboard, type Context } from "grammy";
import type { gmail_v1 } from "googleapis";
import { accountMatchesEmail } from "./account_logic.js";
import { decodedAccounts } from "./accounts.js";
import { config } from "./config.js";
import {
  activateSalesSequence,
  addSalesDoNotContact,
  createProposedSalesSequence,
  deleteProposedSalesSequence,
  getMeetingThread,
  getOpenMeetingProposalByThread,
  getOpenSalesSequenceForKey,
  getSalesPitchScan,
  commandSendForTelegramMessage,
  draftCardForTelegramMessage,
  getSalesSequence,
  getSalesSequenceByThread,
  isSalesDoNotContact,
  latestRecordedSendTo,
  getPendingAction,
  setPendingActionFollowups,
  recordSalesPitchScan,
  reproposeDeclinedSalesSequence,
  SALES_SEQUENCE_DECLINED,
  SALES_SEQUENCE_STEP_COUNT,
  salesSequenceStepCap,
  setSalesSequenceCardMessage,
  setProposedSalesSequenceSettings,
  setSalesSequenceTimezone,
  stopProposedSalesSequence,
  type SalesSequenceRecord,
} from "./db.js";
import { parseAddressList, type ParsedMailbox } from "./mail_helpers.js";
import {
  getSentThreadMetadata,
  isAlgorithmicallyExcluded,
  isCalendarMessage,
  loadFollowupSelfAddresses,
} from "./mail_helpers.js";
import { getGoogleAccount, type LoadedGoogleAccount } from "./google/auth.js";
import { messageHeader } from "./gmail_attachments.js";
import { gmailClient, plainTextBody } from "./google/mail.js";
import { completeBackground } from "./llm.js";
import { blockedAutoSendDomains, PERSONAL_DOMAINS } from "./meeting_book.js";
import { isSelfEmail } from "./mom_logic.js";
import { repliedMessageForTurn } from "./email_references.js";
import { resolvePersonFromFacts } from "./recipient_facts.js";
import {
  allowOwnerChatStartSequence,
  allowOwnTurnSequenceEnrollment,
} from "./security/send_approval.js";
import { allowInboundCommands } from "./security/owner_lock.js";
import { everyMs, type IntervalJob } from "./scheduler.js";
import { installCaptionEditFallback, installNetworkRetry } from "./telegram_io.js";
import { assertTestSeam } from "./test_seam.js";
import { holdForVoiceNote, shortCardText } from "./voice_cards.js";
import type { ToolTurn } from "./tools/index.js";
import {
  emailCardAcknowledgement, emailProviderRead, emailProviderWrite, EmailOperationError, noteEmailFailure, noteEmailNotice, noteEmailTarget, oneLine,
  recordEmailOutcome, requireWritableEmailTurn,
} from "./email_outcomes.js";
import {
  companyFromDomain,
  countManualFollowups,
  domainOf,
  EXCLUSION_LABELS,
  evaluatePitchExclusion,
  firstStepAt,
  hasOriginalOutreach,
  ownTeamCc,
  prospectDisplay,
  parsePitchClassification,
  PITCH_SCHEMA,
  PITCH_SYSTEM,
  pitchCardText,
  pitchClassifierInput,
  prospectKey,
  SEQUENCE_STEPS,
  soleProspect,
  UNCLASSIFIABLE_EXCLUSIONS,
  type PitchClassification,
  type PitchExclusion,
  type PitchFacts,
} from "./sequence_logic.js";
import { nextSendWindow } from "./sequence_rules.js";
import { resolveProspectTimezone, zoneDisplay } from "./sequence_timezone.js";

const TIME_ZONE = "Asia/Kolkata";
const DETECT_INTERVAL_MS = 30 * 60 * 1000;
const DETECT_LOOKBACK_DAYS = 3;
const EXPLICIT_LOOKBACK_DAYS = 60;
const EXPLICIT_THREAD_LIMIT = 10;

const telegram = new Api(config.telegramBotToken);
installNetworkRetry(telegram);
installCaptionEditFallback(telegram);
let telegramForTests: Api | undefined;

/** Tests post Start cards to a fake Telegram. Only against the in-memory database. */
export function setSequenceTestHooks(hooks: { telegram?: Api }): void {
  assertTestSeam("setSequenceTestHooks");
  telegramForTests = hooks.telegram;
}

function cardApi(api?: Api): Api {
  return api ?? telegramForTests ?? telegram;
}

export interface ThreadAssessment {
  threadId: string;
  latestSentId: string;
  sentAt: Date;
  subject: string;
  facts: PitchFacts;
  prospect: ParsedMailbox | undefined;
  /** First To address, for display only when the email has no sole prospect. */
  recipientDomain: string;
  exclusion: PitchExclusion | null;
}

export interface PitchDetectionRow extends ThreadAssessment {
  classification: PitchClassification | null;
}

export async function workGmail(): Promise<{
  account: LoadedGoogleAccount;
  gmail: gmail_v1.Gmail;
}> {
  const account = await getGoogleAccount("work");
  if (account.id !== "work") {
    throw new Error("Sales sequences run on the work account only.");
  }
  return { account, gmail: gmailClient(account) };
}

function isAutomated(message: gmail_v1.Schema$Message, subject: string): boolean {
  const autoSubmitted = messageHeader(message, "Auto-Submitted").toLowerCase();
  return (
    isCalendarMessage(message, subject) ||
    messageHeader(message, "List-Unsubscribe") !== "" ||
    (autoSubmitted !== "" && autoSubmitted !== "no")
  );
}

function sentMessagesOldestFirst(
  thread: gmail_v1.Schema$Thread,
): gmail_v1.Schema$Message[] {
  return (thread.messages ?? [])
    .filter(
      (message) =>
        message.labelIds?.includes("SENT") && !message.labelIds?.includes("DRAFT"),
    )
    .sort((left, right) => Number(left.internalDate ?? 0) - Number(right.internalDate ?? 0));
}

function assessThread(
  thread: gmail_v1.Schema$Thread,
  threadId: string,
  selfAddresses: ReadonlySet<string>,
  ownAddress: string,
  options: { ignoreSequence?: (row: SalesSequenceRecord) => boolean },
): ThreadAssessment | undefined {
  const sent = sentMessagesOldestFirst(thread);
  const latest = sent[sent.length - 1];
  if (!latest?.id) {
    return undefined;
  }
  const notSelf = (email: string): boolean =>
    email !== ownAddress && !selfAddresses.has(email) && !isSelfEmail(email);
  const subject = messageHeader(latest, "Subject").trim() || "(no subject)";
  const toHeader = messageHeader(latest, "To");
  const ccHeader = messageHeader(latest, "Cc");
  const to = parseAddressList(toHeader);
  const cc = parseAddressList(ccHeader);

  const threadSenders = (thread.messages ?? [])
    .filter((message) => !message.labelIds?.includes("DRAFT"))
    .flatMap((message) =>
      parseAddressList(messageHeader(message, "From")).map((item) => item.email),
    )
    .filter(notSelf);
  const earlier = (header: "To" | "Cc"): string[] =>
    sent
      .slice(0, -1)
      .flatMap((message) => parseAddressList(messageHeader(message, header)))
      .map((item) => item.email)
      .filter(notSelf);

  const candidate = soleProspect({ to }, { selfAddresses });
  const manualFollowups = candidate
    ? countManualFollowups(
        [...(thread.messages ?? [])]
          .filter((message) => !message.labelIds?.includes("DRAFT"))
          .sort(
            (left, right) =>
              Number(left.internalDate ?? 0) - Number(right.internalDate ?? 0),
          )
          .map((message) => ({
            sentByMe: Boolean(message.labelIds?.includes("SENT")),
            toProspect: parseAddressList(messageHeader(message, "To")).some(
              (item) => item.email === candidate.email,
            ),
          })),
      )
    : 0;
  const facts: PitchFacts = {
    to,
    cc,
    manualFollowups,
    threadSenders: [...new Set(threadSenders)],
    earlierTo: [...new Set(earlier("To"))],
    earlierCc: [...new Set(earlier("Cc"))],
    isCalendarOrAutomated: isAutomated(latest, subject),
    noReplyOrIgnored: isAlgorithmicallyExcluded(
      toHeader,
      ccHeader,
      ownAddress,
      selfAddresses,
    ),
  };
  const existing = getSalesSequenceByThread(threadId);
  const accounts = decodedAccounts();
  const exclusion = evaluatePitchExclusion(facts, {
    selfAddresses,
    blockedDomains: blockedAutoSendDomains(),
    personalDomains: PERSONAL_DOMAINS,
    isAccountEmail: (email) =>
      accounts.some((account) => accountMatchesEmail(account, email)),
    isDoNotContact: isSalesDoNotContact,
    threadHasSequence:
      existing !== undefined && !(options.ignoreSequence?.(existing) ?? false),
    prospectHasOpenSequence: (email) => {
      const open = getOpenSalesSequenceForKey(prospectKey(email));
      return open !== undefined && !(options.ignoreSequence?.(open) ?? false);
    },
    threadInMeetingFlow:
      getMeetingThread(threadId) !== undefined ||
      getOpenMeetingProposalByThread(threadId) !== undefined,
  });
  return {
    threadId,
    latestSentId: latest.id,
    sentAt: new Date(Number(latest.internalDate ?? 0)),
    subject,
    facts,
    prospect: soleProspect(facts, { selfAddresses }),
    recipientDomain: domainOf(to[0]?.email ?? ""),
    exclusion,
  };
}

/** Stop rules only look after enrolment, so a prospect who has already written
 *  to Vishnu on another thread since this email has to be caught here. */
async function hasWrittenSince(
  gmail: gmail_v1.Gmail,
  prospectEmail: string,
  since: Date,
): Promise<boolean> {
  const domain = domainOf(prospectEmail);
  const from = PERSONAL_DOMAINS.has(domain) ? prospectEmail : domain;
  const listed = await gmail.users.messages.list({
    userId: "me",
    q: `from:${from} after:${Math.floor(since.getTime() / 1000)}`,
    maxResults: 1,
  });
  return (listed.data.messages ?? []).length > 0;
}

async function assessLive(
  gmail: gmail_v1.Gmail,
  threadId: string,
  selfAddresses: ReadonlySet<string>,
  ownAddress: string,
  options: { ignoreSequence?: (row: SalesSequenceRecord) => boolean } = {},
): Promise<ThreadAssessment | undefined> {
  const thread = await getSentThreadMetadata(gmail, threadId);
  const assessed = assessThread(thread, threadId, selfAddresses, ownAddress, options);
  if (
    assessed &&
    !assessed.exclusion &&
    assessed.prospect &&
    (await hasWrittenSince(gmail, assessed.prospect.email, assessed.sentAt))
  ) {
    assessed.exclusion = "replied_elsewhere";
  }
  return assessed;
}

export async function ownAddressOf(gmail: gmail_v1.Gmail): Promise<string> {
  const profile = await gmail.users.getProfile({ userId: "me" });
  const address = profile.data.emailAddress?.trim().toLowerCase();
  if (!address) {
    throw new Error("Gmail profile did not return an email address.");
  }
  return address;
}

export async function classifySalesPitch(
  gmail: gmail_v1.Gmail,
  threadId: string,
): Promise<PitchClassification | undefined> {
  const thread = await gmail.users.threads.get({
    userId: "me",
    id: threadId,
    format: "full",
  });
  const lines = (thread.data.messages ?? [])
    .filter((message) => !message.labelIds?.includes("DRAFT"))
    .sort((left, right) => Number(left.internalDate ?? 0) - Number(right.internalDate ?? 0))
    .map((message) => ({
      from: messageHeader(message, "From"),
      subject: messageHeader(message, "Subject"),
      body: message.payload ? plainTextBody(message.payload) : "",
    }));
  const result = await completeBackground({
    task: "sequence",
    system: { cacheable: PITCH_SYSTEM },
    messages: [{ role: "user", content: pitchClassifierInput(lines) }],
    tools: [],
    jsonSchema: PITCH_SCHEMA,
    maxTokens: 200,
    cacheTtl: "5m",
  });
  return parsePitchClassification(result.textParts.join(""));
}

async function listSentThreadIds(
  gmail: gmail_v1.Gmail,
  query: string,
): Promise<string[]> {
  const threadIds = new Set<string>();
  let pageToken: string | undefined;
  do {
    const response = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: 500,
      pageToken,
    });
    for (const message of response.data.messages ?? []) {
      if (message.threadId) {
        threadIds.add(message.threadId);
      }
    }
    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);
  return [...threadIds];
}

/** Reads Gmail and the model, and writes nothing. Passing classifyExcluded also
 *  asks the model about excluded external threads, so a report can show what
 *  the exclusions removed. */
export async function detectPitches(options: {
  lookbackDays: number;
  classifyExcluded?: boolean;
  useScanCache?: boolean;
}): Promise<PitchDetectionRow[]> {
  const { gmail } = await workGmail();
  const ownAddress = await ownAddressOf(gmail);
  const selfAddresses = await loadFollowupSelfAddresses();
  const threadIds = await listSentThreadIds(
    gmail,
    `in:sent newer_than:${options.lookbackDays}d`,
  );
  const rows: PitchDetectionRow[] = [];
  for (const threadId of threadIds) {
    const assessed = await assessLive(gmail, threadId, selfAddresses, ownAddress);
    if (!assessed) {
      continue;
    }
    let classification: PitchClassification | null = null;
    const cached = options.useScanCache
      ? getSalesPitchScan(assessed.latestSentId)
      : undefined;
    const wanted =
      !assessed.exclusion ||
      (options.classifyExcluded && !UNCLASSIFIABLE_EXCLUSIONS.has(assessed.exclusion));
    if (cached) {
      classification = {
        is_sales_pitch: cached.is_sales_pitch === 1,
        confidence: cached.confidence,
        reason: cached.reason,
      };
    } else if (wanted) {
      try {
        classification = (await classifySalesPitch(gmail, threadId)) ?? null;
      } catch (error) {
        const errorType = error instanceof Error ? error.name : "UnknownError";
        console.error(`Sequence classifier failed (${errorType}); thread=${threadId}`);
      }
    }
    rows.push({ ...assessed, classification });
  }
  return rows;
}

/** Which command a card shows: the message that set its settings. A detection card
 *  has none. Start enrols only while the row still holds that card's settings. */
function cardVersion(row: SalesSequenceRecord): string | undefined {
  return row.command_key ? /^msg:-?\d+:(\d+)$/.exec(row.command_key)?.[1] ?? row.command_key : undefined;
}

function pitchCardKeyboard(id: number, version?: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("Start", version ? `seq:start:${id}:${version}` : `seq:start:${id}`)
    .text("No", `seq:no:${id}`)
    .row()
    .text("Never for this person", `seq:never:${id}`);
}

async function sendPitchCard(api: Api, row: SalesSequenceRecord, cardText?: string): Promise<"posted" | "refused" | "unconfirmed"> {
  if (!hasOriginalOutreach(row.original_message_id)) {
    console.log(`Sequence ${row.id}: no original sent message; card not sent`);
    return "refused";
  }
  try {
    const text = cardText ?? pitchCardText({
      name: row.prospect_name,
      email: row.prospect_email,
      company: row.prospect_company,
      subject: row.subject,
      manualFollowups: row.manual_followups,
    });
    const keyboard = pitchCardKeyboard(row.id, cardVersion(row));
    const acknowledged = emailCardAcknowledgement(`sequence:${row.id}`,
      `Start card posted for ${oneLine(prospectLabel(row))}. Waiting for your Start tap.`);
    const onPosted = (messageId: number): void => {
      acknowledged(messageId);
      setSalesSequenceCardMessage(row.id, messageId);
    };
    if (
      holdForVoiceNote({
        text,
        caption: shortCardText(text),
        keyboard,
        onPosted,
        emailCard: { account: "work", sequenceId: row.id, threadId: row.thread_id, recipient: row.prospect_email },
      })
    ) {
      return "posted";
    }
    const card = await emailProviderWrite(() => api.sendMessage(config.ownerTelegramId, text, { reply_markup: keyboard }), {
      rejected: "Telegram rejected the Start card. No sequence was enrolled.",
      unconfirmed: "Telegram didn't confirm the Start card. Check Telegram before requesting another card.",
      evidence: { account: "work", sequenceId: row.id, threadId: row.thread_id, recipient: row.prospect_email },
    });
    onPosted(card.message_id);
    return "posted";
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(`Sequence card failed (${errorType}); sequence=${row.id}`);
    return error instanceof EmailOperationError && error.reason === "write_unconfirmed" ? "unconfirmed" : "refused";
  }
}

/** Finds new pitches and offers one card each. Creates no active sequence. */
export async function runSequenceDetection(api: Api): Promise<number> {
  if (!config.sequenceDetectionEnabled) return 0;

  const rows = await detectPitches({
    lookbackDays: DETECT_LOOKBACK_DAYS,
    useScanCache: true,
  });
  let offered = 0;
  for (const row of rows) {
    if (!row.classification) {
      continue;
    }
    recordSalesPitchScan({
      messageId: row.latestSentId,
      threadId: row.threadId,
      isSalesPitch: row.classification.is_sales_pitch,
      confidence: row.classification.confidence,
      reason: row.classification.reason,
    });
    if (
      row.exclusion ||
      !row.prospect ||
      !row.classification.is_sales_pitch ||
      row.classification.confidence < config.sequencePitchMinConfidence
    ) {
      continue;
    }
    const domain = domainOf(row.prospect.email);
    const company = companyFromDomain(domain, PERSONAL_DOMAINS);
    const proposed = createProposedSalesSequence({
      threadId: row.threadId,
      prospectEmail: row.prospect.email,
      prospectDomain: domain,
      prospectKey: prospectKey(row.prospect.email),
      prospectName: row.prospect.name,
      prospectCompany: company,
      subject: row.subject,
      originalMessageId: row.latestSentId,
      originalSentAt: row.sentAt.toISOString(),
      manualFollowups: row.facts.manualFollowups,
      classifierConfidence: row.classification.confidence,
      classifierReason: row.classification.reason,
    });
    if (!proposed) {
      continue;
    }
    const posted = await sendPitchCard(api, proposed);
    if (posted === "posted") {
      offered += 1;
    } else if (posted === "refused") {
      deleteProposedSalesSequence(proposed.id);
    }
  }
  console.log(`Sequence detection: threads=${rows.length} offered=${offered}`);
  return offered;
}

function formatFirstStep(at: Date): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: TIME_ZONE,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(at);
}

function prospectLabel(row: {
  prospect_name: string;
  prospect_email: string;
}): string {
  return prospectDisplay(row.prospect_name, row.prospect_email);
}

function switchedOffNote(): string {
  return config.sequencesEnabled
    ? ""
    : " Sending is switched off (SEQUENCES_ENABLED), so nothing goes out until it's on.";
}

function startedText(
  row: SalesSequenceRecord,
  firstAt: Date,
  manualFollowups: number,
  zone?: { zone: string; source: string },
): string {
  const scope =
    manualFollowups > 0
      ? `Started follow-ups for ${prospectLabel(row)} ('${row.subject}'): up to ${SEQUENCE_STEPS - manualFollowups} more.`
      : `Started a 4-step sequence for ${prospectLabel(row)} ('${row.subject}').`;
  const where = zone
    ? ` Their time zone: ${zoneDisplay(zone.zone, zone.source)}. If that's wrong, tell me, e.g. "${row.prospect_name.trim().split(/\s+/)[0] || row.prospect_email} is in New York".`
    : "";
  return `${scope} First follow-up goes out Mon-Fri 9am-5pm their time, from ${formatFirstStep(firstAt)} IST.${where}${switchedOffNote()}`;
}

export async function handleSequenceCallback(ctx: Context): Promise<void> {
  const match = /^seq:(start|no|never):(\d+)(?::(\d+))?$/.exec(ctx.callbackQuery?.data ?? "");
  if (!match) {
    await ctx.answerCallbackQuery().catch(() => undefined);
    return;
  }
  const action = match[1]!;
  const id = Number(match[2]);
  await ctx.answerCallbackQuery().catch(() => undefined);
  const row = getSalesSequence(id);
  if (!row || row.status !== "proposed") {
    await ctx.editMessageReplyMarkup().catch(() => undefined);
    return;
  }
  const finish = async (text: string): Promise<void> => {
    await ctx.editMessageText(text, { reply_markup: undefined }).catch(async () => {
      await ctx.reply(text);
    });
  };

  if (action === "no") {
    stopProposedSalesSequence(id, SALES_SEQUENCE_DECLINED);
    await finish(`No sequence for ${prospectLabel(row)}.`);
    return;
  }
  if (action === "never") {
    addSalesDoNotContact(row.prospect_email, "owner_card");
    stopProposedSalesSequence(id, "do_not_contact");
    await finish(`Never again: ${prospectLabel(row)} is marked do-not-contact.`);
    return;
  }

  // Each Start is bound to its own card: once a newer card replaced the settings, an
  // older card can't enrol them.
  if (match[3] !== cardVersion(row)) {
    await finish(`This card is out of date: a newer card for ${prospectLabel(row)} replaced it. Tap Start on the newest card.`);
    return;
  }
  // A command card enrols exactly what it showed; a detection card, the standard 4.
  const outcome = await enrolProposed(id, settingsOfRow(row));
  if (!outcome.ok) {
    if (outcome.reason === "check_failed") {
      await ctx.reply("I couldn't check that thread, so nothing started. Tap Start again.");
      return;
    }
    if (outcome.reason === "excluded") {
      await finish(`Not started for ${prospectLabel(row)}: ${EXCLUSION_LABELS[outcome.exclusion]}.`);
      return;
    }
    await ctx.editMessageReplyMarkup().catch(() => undefined);
    return;
  }
  await finish(
    row.command_key
      ? commandStartedText(outcome.row)
      : startedText(row, outcome.firstAt, outcome.manualFollowups, outcome.zone),
  );
}

/** What a command sets. A Start tap sets none of it: 4 steps, the default gap and
 *  the ask in his email. */
interface EnrolSettings {
  followups?: number;
  stepDays?: number | null;
  cta?: string | null;
  ccFirstOnly?: boolean;
  commandKey?: string | null;
}

type EnrolOutcome =
  | {
      ok: true;
      row: SalesSequenceRecord;
      firstAt: Date;
      manualFollowups: number;
      zone?: { zone: string; source: string };
    }
  | { ok: false; reason: "check_failed" | "not_proposed" | "too_many" }
  | { ok: false; reason: "excluded"; exclusion: PitchExclusion };

/** The one way a proposed row becomes active, for the Start tap and for a command
 *  alike: the live thread is read again and every exclusion checked, right now. */
async function enrolProposed(id: number, settings: EnrolSettings = {}): Promise<EnrolOutcome> {
  const row = getSalesSequence(id);
  if (!row || row.status !== "proposed") {
    return { ok: false, reason: "not_proposed" };
  }
  let assessed: ThreadAssessment | undefined;
  let liveGmail: gmail_v1.Gmail;
  let ownAddress: string;
  let selfAddresses: Set<string>;
  try {
    const { gmail } = await workGmail();
    liveGmail = gmail;
    ownAddress = await ownAddressOf(gmail);
    selfAddresses = await loadFollowupSelfAddresses();
    assessed = await assessLive(gmail, row.thread_id, selfAddresses, ownAddress, {
      ignoreSequence: (other) => other.id === id,
    });
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(`Sequence ${id}: start check failed (${errorType})`);
    return { ok: false, reason: "check_failed" };
  }
  if (!assessed || assessed.exclusion) {
    const reason = assessed?.exclusion ?? "calendar_or_automated";
    stopProposedSalesSequence(id, `excluded:${reason}`);
    return { ok: false, reason: "excluded", exclusion: reason };
  }
  const now = new Date();
  // Never before the email it follows, so his own email never reads as a later send.
  const enrolledAt = new Date(Math.max(now.getTime(), assessed.sentAt.getTime() + 1000));
  const firstAt = firstStepAt(assessed.sentAt, settings.stepDays ?? config.sequenceStepDays, now);
  requireWritableEmailTurn();
  let activated: boolean;
  try {
    activated = activateSalesSequence(id, {
      nextStepAt: firstAt.toISOString(),
      enrolledAt: enrolledAt.toISOString(),
      manualFollowups: assessed.facts.manualFollowups,
      stepOneCc: ownTeamCc(assessed.facts.cc, selfAddresses, ownAddress),
      ccFirstOnly: settings.ccFirstOnly,
      followups: settings.followups,
      stepDays: settings.stepDays ?? null,
      cta: settings.cta ?? null,
      commandKey: settings.commandKey ?? null,
    });
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(`Sequence ${id}: not activated (${errorType})`);
    return { ok: false, reason: "too_many" };
  }
  if (!activated) {
    return { ok: false, reason: "not_proposed" };
  }
  console.log(`Sequence ${id}: status -> active`);
  const activatedRow = getSalesSequence(id)!;
  recordEmailOutcome(`sequence:enrolled:${id}:${activatedRow.enrolled_at ?? enrolledAt.toISOString()}`,
    `Started ${activatedRow.total_steps - activatedRow.manual_followups} follow-ups to ${oneLine(prospectLabel(activatedRow))}.`);
  let zone: { zone: string; source: string } | undefined;
  try {
    zone = await resolveProspectTimezone(liveGmail, row);
    setSalesSequenceTimezone(id, zone.zone, zone.source);
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(`Sequence ${id}: timezone lookup failed (${errorType}); retried before the first send`);
  }
  return {
    ok: true,
    row: getSalesSequence(id)!,
    firstAt,
    manualFollowups: assessed.facts.manualFollowups,
    zone,
  };
}

function revivable(row: SalesSequenceRecord): boolean {
  return (
    row.status === "proposed" ||
    (row.status === "stopped" &&
      row.steps_sent === 0 &&
      row.stop_reason === SALES_SEQUENCE_DECLINED)
  );
}

/** An explicit owner request replaces the classifier, never the card: it only
 *  shows a Start card, and every guard is checked again when he taps Start. */
export async function requestSequenceCard(
  rawTarget: string,
  api: Api = telegram,
): Promise<string> {
  const target = rawTarget.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
  if (!target) {
    return "Who should the sequence be for? Give me a name, company or email.";
  }
  const assessedThreads = await emailProviderRead(async () => {
    const { gmail } = await workGmail();
    const ownAddress = await ownAddressOf(gmail);
    const selfAddresses = await loadFollowupSelfAddresses();
    const listed = await gmail.users.messages.list({
      userId: "me",
      q: `in:sent newer_than:${EXPLICIT_LOOKBACK_DAYS}d to:"${target}"`,
      maxResults: 25,
    });
    const threadIds = [
      ...new Set(
        (listed.data.messages ?? [])
          .map((message) => message.threadId)
          .filter((id): id is string => Boolean(id)),
      ),
    ].slice(0, EXPLICIT_THREAD_LIMIT);

    const assessedThreads: ThreadAssessment[] = [];
    for (const threadId of threadIds) {
      const assessed = await assessLive(gmail, threadId, selfAddresses, ownAddress, {
        ignoreSequence: (row) => row.thread_id === threadId && revivable(row),
      });
      if (assessed) {
        assessedThreads.push(assessed);
      }
    }
    return assessedThreads;
  }, "I couldn't read work Sent mail. No sequence was enrolled.", { account: "work", recipient: target });
  assessedThreads.sort((left, right) => right.sentAt.getTime() - left.sentAt.getTime());
  if (assessedThreads.length === 0) {
    return `Not started: I found no email to "${target}" in your work Sent mail from the last ${EXPLICIT_LOOKBACK_DAYS} days.`;
  }

  const eligible = assessedThreads.filter((item) => !item.exclusion && item.prospect);
  if (eligible.length === 0) {
    const newest = assessedThreads[0]!;
    const who = newest.prospect?.email ?? newest.recipientDomain;
    return `Not started for ${who} ('${newest.subject}'): ${EXCLUSION_LABELS[newest.exclusion ?? "no_external_recipient"]}.`;
  }

  const newestByProspect = new Map<string, ThreadAssessment>();
  for (const item of eligible) {
    const email = item.prospect!.email;
    if (!newestByProspect.has(email)) {
      newestByProspect.set(email, item);
    }
  }
  if (newestByProspect.size > 1) {
    const options = [...newestByProspect.values()].map(
      (item) => `- ${prospectDisplay(item.prospect!.name, item.prospect!.email)} ('${item.subject}')`,
    );
    return `Not started: more than one person matches "${target}". Which one?\n${options.join("\n")}`;
  }

  const chosen = eligible[0]!;
  const prospect = chosen.prospect!;
  noteEmailTarget("start_sequence", { recipient: prospect.email });
  requireWritableEmailTurn();
  const domain = domainOf(prospect.email);
  const existing = getSalesSequenceByThread(chosen.threadId);
  const row = !existing
    ? createProposedSalesSequence({
        threadId: chosen.threadId,
        prospectEmail: prospect.email,
        prospectDomain: domain,
        prospectKey: prospectKey(prospect.email),
        prospectName: prospect.name,
        prospectCompany: companyFromDomain(domain, PERSONAL_DOMAINS),
        subject: chosen.subject,
        originalMessageId: chosen.latestSentId,
        originalSentAt: chosen.sentAt.toISOString(),
        manualFollowups: chosen.facts.manualFollowups,
        classifierConfidence: null,
        classifierReason: null,
      })
    : existing.status === "proposed"
      ? existing
      : reproposeDeclinedSalesSequence(existing.id);
  if (!row) {
    return `Not started for ${prospect.email}: ${EXCLUSION_LABELS.prospect_in_sequence}.`;
  }
  // The standard card shows the standard settings, so the row holds them too, and any
  // earlier command card for it is out of date.
  if (row.command_key) {
    setProposedSalesSequenceSettings(row.id, { totalSteps: SALES_SEQUENCE_STEP_COUNT, stepDays: null, cta: null, commandKey: null });
  }
  const posted = await sendPitchCard(api, getSalesSequence(row.id) ?? row);
  if (posted === "unconfirmed") return "Telegram didn't confirm the Start card. Check Telegram before requesting another card.";
  if (posted === "refused") {
    if (!existing) {
      deleteProposedSalesSequence(row.id);
    } else if (existing.status === "stopped") {
      stopProposedSalesSequence(row.id, SALES_SEQUENCE_DECLINED);
    }
    return "Not started: the Start card wasn't posted. No sequence was enrolled.";
  }
  return `Start card sent for ${prospectLabel(row)} ('${row.subject}'). Nothing is enrolled unless Vishnu taps Start.`;
}

type CommandTurn = Pick<ToolTurn, "confirmation" | "userText" | "ownTurn" | "modelCalled">;
type Mailbox = Pick<ParsedMailbox, "name" | "email">;
type SendState = "pending" | "failed" | "unconfirmed" | "scheduled" | "sent";

const WHO = "Who is the prospect?";
const UNKNOWN_EMAIL = "Not started: reply to a message about a sent email, or name the prospect.";
const SEND_STATE_TEXT: Record<Exclude<SendState, "sent">, string> = {
  pending: "Not started yet: the email has not gone out.",
  failed: "No follow-ups started: the email didn't go out.",
  unconfirmed: "No follow-ups started: Gmail didn't confirm the email went out.",
  scheduled: "No follow-ups started: the email is scheduled. Start them once it goes out.",
};

const FOLLOWUP_LIMIT = 6;
const GAP_LIMIT = 14;
const CTA_LIMIT = 100;

export interface SequenceArguments {
  prospect?: unknown;
  source?: unknown;
  preview?: unknown;
  total_steps?: unknown;
  step_days?: unknown;
  cta?: unknown;
  cc_first_only?: unknown;
}

interface CommandSettings {
  followups: number;
  gapDays: number | null;
  cta: string | null;
  ccFirstOnly: boolean;
}

interface SequenceRequest {
  prospect: string;
  source: "prospect" | "current_send" | "replied_email";
  preview: boolean;
  settings: CommandSettings;
  adjustments: string[];
}

function sequenceRequest(values: SequenceArguments): SequenceRequest | string {
  const { total_steps, step_days, cta, cc_first_only, source = "prospect", preview = false } = values;
  if (source !== "prospect" && source !== "current_send" && source !== "replied_email") {
    return "Not started: choose a prospect, this turn's send, or the replied-to email.";
  }
  if (typeof preview !== "boolean" || (cc_first_only !== undefined && typeof cc_first_only !== "boolean")) {
    return "Not started: preview and cc_first_only must be true or false.";
  }
  if (total_steps !== undefined && (typeof total_steps !== "number" || !Number.isSafeInteger(total_steps))) {
    return "Not started: total_steps must be a whole number.";
  }
  if (step_days !== undefined && (typeof step_days !== "number" || !Number.isSafeInteger(step_days))) {
    return "Not started: step_days must be a whole number.";
  }
  if (cta !== undefined && typeof cta !== "string") {
    return "Not started: provide the call to action as text.";
  }
  const prospect = typeof values.prospect === "string" ? values.prospect.trim() : "";
  if (source === "prospect" && !prospect) return WHO;
  const requestedSteps = total_steps ?? 3;
  const followups = Math.max(1, Math.min(FOLLOWUP_LIMIT, requestedSteps));
  const gapDays = step_days === undefined ? null : Math.max(1, Math.min(GAP_LIMIT, step_days));
  const ask = cta?.trim() || null;
  const adjustments: string[] = [];
  if (followups !== requestedSteps) adjustments.push(`Adjusted ${requestedSteps} requested follow-ups to ${followups} (allowed: 1–${FOLLOWUP_LIMIT}).`);
  if (step_days !== undefined && gapDays !== step_days) adjustments.push(`Adjusted the interval from ${step_days} to ${gapDays} days (allowed: 1–${GAP_LIMIT}).`);
  if (ask && ask.length > CTA_LIMIT) adjustments.push(`Shortened the call to action to ${CTA_LIMIT} characters.`);
  return {
    prospect, source, preview, adjustments,
    settings: { followups, gapDays, cta: ask?.slice(0, CTA_LIMIT) ?? null, ccFirstOnly: cc_first_only ?? true },
  };
}

type SequenceDecision =
  | { action: "standard_card"; person: string }
  | {
      action: "enroll" | "card";
      via: SequenceRequest["source"];
      person: string | null;
      settings: CommandSettings;
      reasons: string[];
    };

function commandKeyOf(turn: CommandTurn): string | undefined {
  return turn.confirmation ? `msg:${turn.confirmation.chatId}:${turn.confirmation.messageId}` : undefined;
}

function dayAndTime(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
}

function settingsLine(followups: number, gap: number, cta: string | null): string {
  return `${followups} follow-up${followups === 1 ? "" : "s"}, every ${gap} day${gap === 1 ? "" : "s"}, CTA: ${cta ?? "same ask as your email"}`;
}

/** Exactly what was set, worked out from the row, so a repeat reports the same. */
function commandStartedText(row: SalesSequenceRecord): string {
  const followups = row.total_steps - row.manual_followups;
  const gap = row.step_days ?? config.sequenceStepDays;
  const count = `${followups} ${row.manual_followups > 0 ? "more " : ""}follow-up${followups === 1 ? "" : "s"}`;
  const own = row.manual_followups > 0 ? ` (you've sent ${row.manual_followups} yourself)` : "";
  const first = nextSendWindow(new Date(row.next_step_at ?? Date.now()), row.prospect_timezone);
  const when = row.prospect_timezone
    ? `${dayAndTime(first, row.prospect_timezone)} their time`
    : `${dayAndTime(first, TIME_ZONE)} IST, once their time zone is checked`;
  return `Started ${count} to ${prospectLabel(row)}${own}, every ${gap} day${gap === 1 ? "" : "s"}, CTA: ${row.cta ?? "same ask as your email"}. First one goes ${when}.${switchedOffNote()}`;
}

/** The settings a command card holds, for the Start tap. A detection card holds none. */
function settingsOfRow(row: SalesSequenceRecord): EnrolSettings {
  return row.command_key
    ? {
        followups: Math.max(1, row.total_steps - row.manual_followups),
        stepDays: row.step_days,
        cta: row.cta,
        ccFirstOnly: row.cc_first_only !== 0,
        commandKey: row.command_key,
      }
    : {};
}

interface SequenceSend {
  state: SendState;
  sentMessageId?: string;
  cardActionId?: number;
  account: string;
  recipient?: Mailbox;
}

const turnSends = new Map<string, { send: SequenceSend; at: number }>();
const TURN_STATE_TTL_MS = 30 * 60_000;

export function recordSequenceSend(confirmation: NonNullable<CommandTurn["confirmation"]>, send: SequenceSend): void {
  const now = Date.now();
  for (const [key, entry] of turnSends) {
    if (now - entry.at > TURN_STATE_TTL_MS) turnSends.delete(key);
  }
  turnSends.set(commandKeyOf({ confirmation })!, { send, at: now });
}

/** His newest email to the person he named. More than one person: ask which. */
async function newestThreadFor(
  gmail: gmail_v1.Gmail,
  target: string,
  selfAddresses: ReadonlySet<string>,
  ownAddress: string,
): Promise<ThreadAssessment | string> {
  const safeTarget = target.replaceAll('"', "").replaceAll("\\", "").replaceAll("\n", " ").replaceAll("\r", " ").trim();
  if (!safeTarget) return WHO;
  const listed = await gmail.users.messages.list({
    userId: "me",
    q: `in:sent newer_than:${EXPLICIT_LOOKBACK_DAYS}d to:"${safeTarget}"`,
    maxResults: 25,
  });
  const threadIds = [
    ...new Set(
      (listed.data.messages ?? [])
        .map((message) => message.threadId)
        .filter((id): id is string => Boolean(id)),
    ),
  ].slice(0, EXPLICIT_THREAD_LIMIT);
  const assessedThreads: ThreadAssessment[] = [];
  for (const threadId of threadIds) {
    const assessed = await assessLive(gmail, threadId, selfAddresses, ownAddress, {
      ignoreSequence: (row) => row.thread_id === threadId && revivable(row),
    });
    if (assessed) {
      assessedThreads.push(assessed);
    }
  }
  assessedThreads.sort((left, right) => right.sentAt.getTime() - left.sentAt.getTime());
  if (assessedThreads.length === 0) {
    return `Not started: I found no email to "${target}" in your work Sent mail from the last ${EXPLICIT_LOOKBACK_DAYS} days.`;
  }
  const people = new Map<string, ThreadAssessment>();
  for (const item of assessedThreads) {
    if (item.prospect && !people.has(item.prospect.email)) {
      people.set(item.prospect.email, item);
    }
  }
  if (people.size > 1) {
    const options = [...people.values()].map(
      (item) => `- ${prospectDisplay(item.prospect!.name, item.prospect!.email)} ('${item.subject}')`,
    );
    return `Not started: more than one person matches "${target}". Which one?\n${options.join("\n")}`;
  }
  // The newest email decides. If it can't be followed up, say why: never an older one.
  return assessedThreads[0]!;
}

/** The Gmail message an Aadi message was about: a draft card that went out, or a
 *  "Sent to ..." note. */
function emailForTelegramMessage(
  telegramMessageId: number,
): { state: "sent"; sentMessageId: string; account: string } | { state: "unsent_draft" | "never_sent" | "unknown" } {
  const card = draftCardForTelegramMessage(telegramMessageId);
  if (card) {
    if (card.status === "pending") {
      return { state: "unsent_draft" };
    }
    if (card.status !== "sent") {
      return { state: "never_sent" };
    }
    return card.sent_message_id
      ? { state: "sent", sentMessageId: card.sent_message_id, account: card.google_account }
      : { state: "unknown" };
  }
  const sent = commandSendForTelegramMessage(telegramMessageId);
  if (sent?.status === "sent" && sent.sent_message_id) {
    return { state: "sent", sentMessageId: sent.sent_message_id, account: sent.account };
  }
  return { state: "unknown" };
}

async function recipientOf(sentMessageId: string): Promise<Mailbox | undefined> {
  try {
    const { gmail } = await workGmail();
    const message = await gmail.users.messages.get({ userId: "me", id: sentMessageId, format: "metadata", metadataHeaders: ["To"] });
    const first = parseAddressList(messageHeader(message.data, "To"))[0];
    return first ? { name: first.name, email: first.email } : undefined;
  } catch {
    return undefined;
  }
}

async function sendCommandCard(api: Api, row: SalesSequenceRecord, settings: CommandSettings): ReturnType<typeof sendPitchCard> {
  const gap = settings.gapDays ?? config.sequenceStepDays;
  return sendPitchCard(api, row, `Start follow-ups to ${prospectLabel(row)}? ${settingsLine(settings.followups, gap, settings.cta)}. Cc: ${settings.ccFirstOnly ? "first follow-up only" : "eligible teammates on each follow-up"}.`);
}

interface CarryContext {
  turn: CommandTurn;
  api: Api;
  /** The email the follow-ups are for, when the email (not a name) decides. */
  email?: { sentMessageId: string; account: string };
  commandKey?: string;
}

/** Resolve a named prospect with chat records, then fall back to the Sent mailbox. */
async function namedProspect(person: string, turn: CommandTurn): Promise<string | { reply: string }> {
  const confirmation = turn.confirmation;
  if (!confirmation || turn.ownTurn !== true) return person;
  const match = await resolvePersonFromFacts(person, {
    chatId: confirmation.chatId, messageId: confirmation.messageId, ownerText: turn.userText ?? "",
  });
  if (match.kind === "one") return match.mailbox.email;
  if (match.kind === "many") {
    const options = match.options.map(option => `- ${prospectDisplay(option.name, option.email)}`);
    return { reply: `Not started: more than one person matches "${person}". Which one?\n${options.join("\n")}` };
  }
  return person;
}

/** Aadi's own record of its newest email to this address, when Gmail search hasn't
 *  caught up with it yet. */
async function recordedThreadFor(
  gmail: gmail_v1.Gmail,
  address: string,
  selfAddresses: ReadonlySet<string>,
  ownAddress: string,
): Promise<ThreadAssessment | undefined> {
  const recorded = latestRecordedSendTo(address);
  if (!recorded || recorded.account !== "work") return undefined;
  const message = await gmail.users.messages.get({ userId: "me", id: recorded.sentMessageId, format: "minimal" });
  const threadId = message.data.threadId;
  if (!threadId) return undefined;
  return (await assessLive(gmail, threadId, selfAddresses, ownAddress, {
    ignoreSequence: (row) => row.thread_id === threadId && revivable(row),
  })) ?? undefined;
}

/** Enrol or post a pre-filled card.
 *  The live exclusion check runs here, for both. */
async function carryOutSequenceDecision(decision: SequenceDecision, carry: CarryContext): Promise<string> {
  if (decision.action === "standard_card") {
    return requestSequenceCard(decision.person, carry.api);
  }
  const turn = carry.turn;
  const commandKey = carry.commandKey ?? commandKeyOf(turn);
  if (decision.via !== "prospect" && !carry.email) {
    return UNKNOWN_EMAIL;
  }
  if (carry.email && carry.email.account !== "work") {
    return "Not started: follow-ups only run from your work mailbox.";
  }
  let chosen: ThreadAssessment | undefined;
  try {
    const { gmail } = await workGmail();
    const ownAddress = await ownAddressOf(gmail);
    const selfAddresses = await loadFollowupSelfAddresses();
    if (decision.via === "prospect") {
      const target = await namedProspect(decision.person!, turn);
      if (typeof target !== "string") {
        return target.reply;
      }
      const found = await newestThreadFor(gmail, target, selfAddresses, ownAddress);
      if (typeof found === "string") {
        const recorded = target.includes("@") ? await recordedThreadFor(gmail, target, selfAddresses, ownAddress) : undefined;
        if (!recorded) {
          return found;
        }
        chosen = recorded;
      } else {
        chosen = found;
      }
    } else {
      const message = await gmail.users.messages.get({ userId: "me", id: carry.email!.sentMessageId, format: "minimal" });
      const threadId = message.data.threadId;
      if (!threadId) {
        return UNKNOWN_EMAIL;
      }
      chosen = await assessLive(gmail, threadId, selfAddresses, ownAddress, {
        ignoreSequence: (row) => row.thread_id === threadId && revivable(row),
      });
      if (!chosen) {
        return UNKNOWN_EMAIL;
      }
    }
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(`Sequence command: thread check failed (${errorType})`);
    return noteEmailFailure(new EmailOperationError(
      "Not started: I couldn't check that thread. Read the latest sent email before requesting follow-ups.", "provider_read_failed",
      { account: "work", messageId: carry.email?.sentMessageId ?? undefined, recipient: decision.person ?? undefined },
    ));
  }
  noteEmailTarget("start_sequence", { recipient: chosen.prospect?.email, threadId: chosen.prospect ? undefined : chosen.threadId });
  // The same message already enrolled this thread: report it, enrol nothing more.
  const already = getSalesSequenceByThread(chosen.threadId);
  if (commandKey && already?.status === "active" && already.command_key === commandKey) {
    noteEmailFailure(new EmailOperationError("That sequence is already active.", "already_handled",
      { account: "work", sequenceId: already.id }));
    return commandStartedText(already);
  }
  if (chosen.exclusion || !chosen.prospect) {
    const who = chosen.prospect?.email ?? chosen.recipientDomain;
    return noteEmailFailure(new EmailOperationError(
      `Not started for ${who} ('${chosen.subject}'): ${EXCLUSION_LABELS[chosen.exclusion ?? "no_external_recipient"]}.`,
      "excluded", { account: "work", threadId: chosen.threadId, recipient: who },
    ));
  }
  const remaining = salesSequenceStepCap() - chosen.facts.manualFollowups;
  if (remaining < 1) return "Not started: this thread has already reached its follow-up limit.";
  const settings = { ...decision.settings, followups: Math.min(decision.settings.followups, remaining) };
  const threadLimit = settings.followups < decision.settings.followups
    ? `Capped at ${settings.followups} additional follow-ups for this thread.`
    : "";
  if (threadLimit) noteEmailNotice(threadLimit);
  const prospect = chosen.prospect;
  requireWritableEmailTurn();
  const domain = domainOf(prospect.email);
  const existing = getSalesSequenceByThread(chosen.threadId);
  const row = !existing
    ? createProposedSalesSequence({
        threadId: chosen.threadId,
        prospectEmail: prospect.email,
        prospectDomain: domain,
        prospectKey: prospectKey(prospect.email),
        prospectName: prospect.name,
        prospectCompany: companyFromDomain(domain, PERSONAL_DOMAINS),
        subject: chosen.subject,
        originalMessageId: chosen.latestSentId,
        originalSentAt: chosen.sentAt.toISOString(),
        manualFollowups: chosen.facts.manualFollowups,
        classifierConfidence: null,
        classifierReason: null,
      })
    : existing.status === "proposed"
      ? existing
      : reproposeDeclinedSalesSequence(existing.id);
  if (!row) {
    return `Not started for ${prospect.email}: ${EXCLUSION_LABELS.prospect_in_sequence}.`;
  }
  const enrolSettings: EnrolSettings = {
    followups: settings.followups,
    stepDays: settings.gapDays,
    cta: settings.cta,
    ccFirstOnly: settings.ccFirstOnly,
    commandKey,
  };
  if (decision.action === "enroll") {
    allowOwnTurnSequenceEnrollment(turn);
    const outcome = await enrolProposed(row.id, enrolSettings);
    if (outcome.ok) {
      console.log(`Sequence ${row.id}: enrolled by command steps=${outcome.row.total_steps}`);
      return [commandStartedText(outcome.row), threadLimit].filter(Boolean).join(" ");
    }
    if (!existing && getSalesSequence(row.id)?.status === "proposed") {
      deleteProposedSalesSequence(row.id);
    }
    if (outcome.reason === "excluded") {
      return `Not started for ${prospect.email} ('${chosen.subject}'): ${EXCLUSION_LABELS[outcome.exclusion]}.`;
    }
    if (outcome.reason === "too_many") {
      return "Not started: the thread reached its follow-up limit while I was checking it.";
    }
    return outcome.reason === "check_failed"
      ? noteEmailFailure(new EmailOperationError(
        "Not started: I couldn't check that thread. Read the latest sent email before requesting follow-ups.",
        "provider_read_failed", { account: "work", threadId: chosen.threadId, recipient: prospect.email },
      ))
      : "Not started: that sequence was already started or stopped.";
  }
  // A card: it holds exactly what was understood, and Start enrols exactly that.
  setProposedSalesSequenceSettings(row.id, {
    totalSteps: chosen.facts.manualFollowups + settings.followups,
    stepDays: settings.gapDays,
    cta: settings.cta,
    ccFirstOnly: settings.ccFirstOnly,
    commandKey: commandKey ?? null,
    // Today's count of his own follow-ups, so the card's number is what Start enrols.
    manualFollowups: chosen.facts.manualFollowups,
  });
  const carded = getSalesSequence(row.id)!;
  const posted = await sendCommandCard(carry.api, carded, settings);
  if (posted === "unconfirmed") return "Telegram didn't confirm the Start card. Check Telegram before requesting another card.";
  if (posted === "refused") {
    if (!existing) {
      deleteProposedSalesSequence(row.id);
    }
    return "Not started: the Start card wasn't posted. No sequence was enrolled.";
  }
  const gap = settings.gapDays ?? config.sequenceStepDays;
  return `Start card sent for ${prospectLabel(carded)}: ${decision.reasons.join("; ")}. Tap Start for ${settingsLine(settings.followups, gap, settings.cta)}. Nothing is enrolled until you tap Start.${threadLimit ? ` ${threadLimit}` : ""}`;
}

async function runSequenceRequest(request: SequenceRequest, carry: CarryContext, recipient?: Mailbox): Promise<string> {
  const reasons: string[] = [];
  if (request.preview) reasons.push("confirmation required");
  if (carry.turn.ownTurn !== true || carry.turn.modelCalled !== true) {
    reasons.push("this did not come directly from your chat turn");
  }
  if (request.source !== "prospect" && request.prospect) {
    const named = await namedProspect(request.prospect, carry.turn);
    const recipientNames = recipient ? [recipient.email, recipient.name].map(name => name.trim().toLowerCase()) : [];
    if (typeof named !== "string" || !recipientNames.includes(named.toLowerCase())) {
      reasons.push(recipient ? `the email went to ${prospectDisplay(recipient.name, recipient.email)}` : "the recipient could not be verified");
    }
  }
  const result = await carryOutSequenceDecision({
    action: reasons.length ? "card" : "enroll",
    via: request.source,
    person: request.prospect || null,
    settings: request.settings,
    reasons,
  }, carry);
  for (const adjustment of request.adjustments) noteEmailNotice(adjustment);
  return [result, ...request.adjustments].join(" ");
}

export async function startSequenceFromTool(
  target: string,
  turn: CommandTurn,
  explicitApi?: Api,
  values: SequenceArguments = {},
): Promise<string> {
  const api = cardApi(explicitApi);
  allowOwnerChatStartSequence(turn.confirmation);
  const request = sequenceRequest({ ...values, prospect: target });
  if (typeof request === "string") return request;
  const carry: CarryContext = { turn, api };
  if (request.source === "prospect") return runSequenceRequest(request, carry);

  if (request.source === "replied_email") {
    if (turn.confirmation?.chatId !== config.ownerTelegramId) return UNKNOWN_EMAIL;
    const repliedTo = repliedMessageForTurn(turn.confirmation?.chatId, turn.confirmation?.messageId);
    if (repliedTo === undefined) return UNKNOWN_EMAIL;
    const found = emailForTelegramMessage(repliedTo);
    if (found.state !== "sent") {
      if (found.state === "unsent_draft") return "Not started: that draft has not been sent.";
      if (found.state === "never_sent") return "Not started: that draft was never sent.";
      return UNKNOWN_EMAIL;
    }
    carry.email = found;
    return runSequenceRequest(request, carry, await recipientOf(found.sentMessageId));
  }

  const key = commandKeyOf(turn);
  const entry = key ? turnSends.get(key) : undefined;
  const sent = entry && Date.now() - entry.at <= TURN_STATE_TTL_MS ? entry.send : undefined;
  if (sent?.state === "sent" && sent.sentMessageId) {
    carry.email = { sentMessageId: sent.sentMessageId, account: sent.account };
    return runSequenceRequest(request, carry, sent.recipient);
  }
  if (sent?.state === "pending" && key && sent.cardActionId !== undefined) {
    const card = getPendingAction(sent.cardActionId);
    if (card?.status === "sent" && card.sent_message_id) {
      carry.email = { sentMessageId: card.sent_message_id, account: card.google_account };
      return runSequenceRequest({ ...request, preview: true }, carry, sent.recipient);
    }
    // Store the validated settings so the Send tap can offer the same sequence.
    const deferred: SequenceArguments = {
      prospect: request.prospect, source: request.source,
      total_steps: request.settings.followups, step_days: request.settings.gapDays ?? undefined,
      cta: request.settings.cta ?? undefined, cc_first_only: request.settings.ccFirstOnly,
    };
    if (card?.status === "pending" && setPendingActionFollowups(card.id, JSON.stringify(deferred), key)) {
      const message = "The follow-ups will be offered on a Start card after this email goes out.";
      for (const adjustment of request.adjustments) noteEmailNotice(adjustment);
      return [message, ...request.adjustments].join(" ");
    }
  }
  return sent && sent.state !== "sent" ? SEND_STATE_TEXT[sent.state] : SEND_STATE_TEXT.pending;
}

export async function offerFollowupsAfterCardSend(
  stored: { settings: string; key: string },
  send: { sentMessageId: string; account: string; recipient?: Mailbox },
): Promise<string> {
  let values: SequenceArguments;
  try {
    const parsed: unknown = JSON.parse(stored.settings);
    if (typeof parsed !== "object" || parsed === null || !("source" in parsed) || parsed.source !== "current_send") {
      return "Ask for follow-ups again to choose the settings for the email you just sent.";
    }
    values = parsed;
  } catch {
    return "Ask for follow-ups again to choose the settings for the email you just sent.";
  }
  const request = sequenceRequest(values);
  if (typeof request === "string") return request;
  return runSequenceRequest({ ...request, preview: true }, { turn: {}, api: cardApi(), email: send, commandKey: stored.key }, send.recipient);
}

export async function handleSequenceCommand(ctx: Context): Promise<void> {
  if (!allowInboundCommands(ctx.message)) {
    await ctx.reply("A forwarded message can't start a sequence.");
    return;
  }
  const target = typeof ctx.match === "string" ? ctx.match.trim() : "";
  if (!target) {
    await ctx.reply("Usage: /outbox <name, company or email>");
    return;
  }
  await ctx.reply(await carryOutSequenceDecision({ action: "standard_card", person: target }, { turn: {}, api: ctx.api }));
}

export function registerSequenceDetection(api: Api): IntervalJob | undefined {
  if (!config.sequencesEnabled) {
    console.log("Sequence detection off (SEQUENCES_ENABLED).");
    return undefined;
  }
  if (!config.sequenceDetectionEnabled) {
    console.log("Sequence detection off (SEQUENCE_DETECTION_ENABLED).");
    return undefined;
  }
  const job = everyMs("sequence-detect", DETECT_INTERVAL_MS, async () => {
    await runSequenceDetection(api);
  });
  console.log("Sequence detection scheduled every 30 min.");
  return job;
}
