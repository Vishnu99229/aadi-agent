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
  getSalesSequence,
  getSalesSequenceByThread,
  isSalesDoNotContact,
  recordSalesPitchScan,
  reproposeDeclinedSalesSequence,
  SALES_SEQUENCE_DECLINED,
  setSalesSequenceCardMessage,
  setSalesSequenceTimezone,
  stopProposedSalesSequence,
  type SalesSequenceRecord,
} from "./db.js";
import { parseAddressList, type ParsedMailbox } from "./followup_logic.js";
import {
  getSentThreadMetadata,
  isAlgorithmicallyExcluded,
  isCalendarMessage,
  loadFollowupSelfAddresses,
} from "./followups.js";
import { getGoogleAccount, type LoadedGoogleAccount } from "./google/auth.js";
import { messageHeader } from "./gmail_attachments.js";
import { gmailClient, plainTextBody } from "./google/mail.js";
import { completeBackground } from "./llm.js";
import { blockedAutoSendDomains, PERSONAL_DOMAINS } from "./meeting_book.js";
import { isSelfEmail } from "./mom_logic.js";
import { allowOwnerChatStartSequence } from "./security/send_approval.js";
import { allowInboundCommands } from "./security/owner_lock.js";
import { everyMs, type IntervalJob } from "./scheduler.js";
import { installNetworkRetry } from "./telegram_io.js";
import type { ToolTurn } from "./tools/index.js";
import {
  companyFromDomain,
  countManualFollowups,
  domainOf,
  EXCLUSION_LABELS,
  evaluatePitchExclusion,
  firstStepAt,
  isExplicitSequenceRequest,
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
import { nextSendWindow, parseDateHeaderOffset } from "./sequence_rules.js";

const TIME_ZONE = "Asia/Kolkata";
const DETECT_INTERVAL_MS = 30 * 60 * 1000;
const DETECT_LOOKBACK_DAYS = 3;
const EXPLICIT_LOOKBACK_DAYS = 60;
const EXPLICIT_THREAD_LIMIT = 10;

const telegram = new Api(config.telegramBotToken);
installNetworkRetry(telegram);

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
  const earlierRecipients = sent
    .slice(0, -1)
    .flatMap((message) => [
      ...parseAddressList(messageHeader(message, "To")),
      ...parseAddressList(messageHeader(message, "Cc")),
    ])
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
    earlierRecipients: [...new Set(earlierRecipients)],
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
      const open = getOpenSalesSequenceForKey(prospectKey(email, PERSONAL_DOMAINS));
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

/** The UTC offset on the newest email this exact person sent Vishnu, on any
 *  thread. Automatic replies are skipped: their Date is the server's, not theirs. */
export async function readProspectTimezone(
  gmail: gmail_v1.Gmail,
  prospectEmail: string,
): Promise<string | undefined> {
  const listed = await gmail.users.messages.list({
    userId: "me",
    q: `from:${prospectEmail}`,
    maxResults: 5,
  });
  const messages: gmail_v1.Schema$Message[] = [];
  for (const item of listed.data.messages ?? []) {
    if (!item.id) {
      continue;
    }
    const response = await gmail.users.messages.get({
      userId: "me",
      id: item.id,
      format: "metadata",
      metadataHeaders: ["From", "Date", "Auto-Submitted"],
    });
    messages.push(response.data);
  }
  messages.sort((left, right) => Number(right.internalDate ?? 0) - Number(left.internalDate ?? 0));
  for (const message of messages) {
    const from = parseAddressList(messageHeader(message, "From"))[0]?.email;
    const auto = messageHeader(message, "Auto-Submitted").toLowerCase();
    if (from !== prospectEmail.trim().toLowerCase() || (auto !== "" && auto !== "no")) {
      continue;
    }
    const offset = parseDateHeaderOffset(messageHeader(message, "Date"));
    if (offset) {
      return offset;
    }
  }
  return undefined;
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

function pitchCardKeyboard(id: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("Start", `seq:start:${id}`)
    .text("No", `seq:no:${id}`)
    .row()
    .text("Never for this person", `seq:never:${id}`);
}

async function sendPitchCard(api: Api, row: SalesSequenceRecord): Promise<boolean> {
  try {
    const card = await api.sendMessage(
      config.ownerTelegramId,
      pitchCardText({
        name: row.prospect_name,
        email: row.prospect_email,
        company: row.prospect_company,
        subject: row.subject,
        manualFollowups: row.manual_followups,
      }),
      { reply_markup: pitchCardKeyboard(row.id) },
    );
    setSalesSequenceCardMessage(row.id, card.message_id);
    return true;
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(`Sequence card failed (${errorType}); sequence=${row.id}`);
    return false;
  }
}

/** Finds new pitches and offers one card each. Creates no active sequence. */
export async function runSequenceDetection(api: Api): Promise<number> {
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
      prospectKey: prospectKey(row.prospect.email, PERSONAL_DOMAINS),
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
    if (await sendPitchCard(api, proposed)) {
      offered += 1;
    } else {
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
  return row.prospect_name
    ? `${row.prospect_name} <${row.prospect_email}>`
    : row.prospect_email;
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
  timezone?: string,
): string {
  const scope =
    manualFollowups > 0
      ? `Started follow-ups for ${prospectLabel(row)} ('${row.subject}'): up to ${SEQUENCE_STEPS - manualFollowups} more.`
      : `Started a 4-step sequence for ${prospectLabel(row)} ('${row.subject}').`;
  if (!nextSendWindow(firstAt, timezone)) {
    return `${scope} Nothing will go out while their time zone stays ${timezone}: 10:00-17:00 their time never meets 09:00-19:00 IST.${switchedOffNote()}`;
  }
  return `${scope} First follow-up goes out at the first send window from ${formatFirstStep(firstAt)}.${switchedOffNote()}`;
}

export async function handleSequenceCallback(ctx: Context): Promise<void> {
  const match = /^seq:(start|no|never):(\d+)$/.exec(ctx.callbackQuery?.data ?? "");
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

  let assessed: ThreadAssessment | undefined;
  let liveGmail: gmail_v1.Gmail;
  try {
    const { gmail } = await workGmail();
    liveGmail = gmail;
    const ownAddress = await ownAddressOf(gmail);
    const selfAddresses = await loadFollowupSelfAddresses();
    assessed = await assessLive(gmail, row.thread_id, selfAddresses, ownAddress, {
      ignoreSequence: (other) => other.id === id,
    });
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(`Sequence ${id}: start check failed (${errorType})`);
    await ctx.reply("I couldn't check that thread, so nothing started. Tap Start again.");
    return;
  }
  if (!assessed || assessed.exclusion) {
    const reason = assessed?.exclusion ?? "calendar_or_automated";
    stopProposedSalesSequence(id, `excluded:${reason}`);
    await finish(`Not started for ${prospectLabel(row)}: ${EXCLUSION_LABELS[reason]}.`);
    return;
  }
  const now = new Date();
  const firstAt = firstStepAt(assessed.sentAt, config.sequenceStepDays, now);
  const activated = activateSalesSequence(id, {
    nextStepAt: firstAt.toISOString(),
    enrolledAt: now.toISOString(),
    manualFollowups: assessed.facts.manualFollowups,
  });
  if (!activated) {
    await ctx.editMessageReplyMarkup().catch(() => undefined);
    return;
  }
  console.log(`Sequence ${id}: status -> active`);
  let timezone: string | undefined;
  try {
    timezone = await readProspectTimezone(liveGmail, row.prospect_email);
    if (timezone) {
      setSalesSequenceTimezone(id, timezone);
    }
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(`Sequence ${id}: timezone lookup failed (${errorType})`);
  }
  await finish(startedText(row, firstAt, assessed.facts.manualFollowups, timezone));
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
      (item) => `- ${item.prospect!.name} <${item.prospect!.email}> ('${item.subject}')`,
    );
    return `Not started: more than one person matches "${target}". Which one?\n${options.join("\n")}`;
  }

  const chosen = eligible[0]!;
  const prospect = chosen.prospect!;
  const domain = domainOf(prospect.email);
  const existing = getSalesSequenceByThread(chosen.threadId);
  const row = !existing
    ? createProposedSalesSequence({
        threadId: chosen.threadId,
        prospectEmail: prospect.email,
        prospectDomain: domain,
        prospectKey: prospectKey(prospect.email, PERSONAL_DOMAINS),
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
  if (!(await sendPitchCard(api, row))) {
    if (!existing) {
      deleteProposedSalesSequence(row.id);
    } else if (existing.status === "stopped") {
      stopProposedSalesSequence(row.id, SALES_SEQUENCE_DECLINED);
    }
    return "Not started: I couldn't send the Start card. Try again.";
  }
  return `Start card sent for ${prospectLabel(row)} ('${row.subject}'). Nothing is enrolled unless Vishnu taps Start.`;
}

export async function startSequenceFromTool(
  target: string,
  turn: Pick<ToolTurn, "confirmation" | "userText">,
  api: Api = telegram,
): Promise<string> {
  allowOwnerChatStartSequence(turn.confirmation);
  if (!isExplicitSequenceRequest(turn.userText ?? "")) {
    return "No card sent. A sequence is only offered when Vishnu says \"start a sequence for X\" or \"auto follow up with X\". Use track_thread for a follow-up nudge.";
  }
  return requestSequenceCard(target, api);
}

export async function handleSequenceCommand(ctx: Context): Promise<void> {
  if (!allowInboundCommands(ctx.message)) {
    await ctx.reply("A forwarded message can't start a sequence.");
    return;
  }
  const target = typeof ctx.match === "string" ? ctx.match.trim() : "";
  if (!target) {
    await ctx.reply("Usage: /sequence <name, company or email>");
    return;
  }
  await ctx.reply(await requestSequenceCard(target, ctx.api));
}

export function registerSequenceDetection(api: Api): IntervalJob | undefined {
  if (!config.sequencesEnabled) {
    console.log("Sequence detection off (SEQUENCES_ENABLED).");
    return undefined;
  }
  const job = everyMs("sequence-detect", DETECT_INTERVAL_MS, async () => {
    await runSequenceDetection(api);
  });
  console.log("Sequence detection scheduled every 30 min.");
  return job;
}
