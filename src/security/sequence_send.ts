import { config } from "../config.js";
import {
  claimSalesStepSending,
  countSalesSendsSince,
  getOpenSalesSequenceForKey,
  getSalesSequence,
  getSalesSequenceStep,
  isSalesDoNotContact,
  lastSalesSendAt,
  recordSalesStepSent,
  releaseSalesStepClaim,
} from "../db.js";
import type { LoadedGoogleAccount } from "../google/auth.js";
import { buildThreadReplyMime, gmailClient, mimeHeaderBlock } from "../google/mail.js";
import { blockedAutoSendDomains } from "../meeting_book.js";
import { isSelfEmail } from "../mom_logic.js";
import { salesFactsStatus } from "../sales_facts.js";
import {
  domainInSet,
  domainOf,
  OWN_DOMAIN,
  SEQUENCE_STEPS,
} from "../sequence_logic.js";
import { inSendWindow, istDayStart } from "../sequence_rules.js";

/** Refusals that say nothing about this prospect. The step just waits. */
const HOLD_REASONS = new Set([
  "disabled",
  "facts_not_ready",
  "outside_test_list",
  "daily_cap",
  "spacing",
  "outside_window",
]);

export class SequenceSendRefusedError extends Error {
  readonly hold: boolean;
  constructor(readonly reason: string) {
    super(`sequence send refused: ${reason}`);
    this.name = "SequenceSendRefusedError";
    this.hold = HOLD_REASONS.has(reason);
  }
}

/** Gmail answered and did not take the message, so it is safe to try later. */
export class SequenceSendRejectedError extends Error {
  constructor(readonly status: number) {
    super(`sequence send rejected: ${status}`);
    this.name = "SequenceSendRejectedError";
  }
}

/** The call failed in a way that leaves the message's fate unknown. The step stays
 *  claimed and is never sent again. */
export class SequenceSendUnconfirmedError extends Error {
  constructor() {
    super("sequence send unconfirmed");
    this.name = "SequenceSendUnconfirmedError";
  }
}

export interface SequenceSendGateInput {
  enabled: boolean;
  factsReady: boolean;
  testRecipients: readonly string[];
  accountId: string;
  fromAddress: string;
  sequence:
    | {
        id: number;
        status: string;
        account: string;
        prospect_email: string;
        current_step: number;
        steps_sent: number;
        manual_followups: number;
        prospect_timezone: string | null;
      }
    | undefined;
  /** The open sequence for this company, which must be this one. */
  openSequenceId: number | undefined;
  stepNo: number;
  step:
    | {
        status: string;
        draft_text: string | null;
        check_result: string | null;
        sent_message_id: string | null;
      }
    | undefined;
  to: string;
  cc: string | undefined;
  bcc: string | undefined;
  body: string;
  inReplyTo: string;
  threadId: string;
  sequenceThreadId: string | undefined;
  blockedDomains: ReadonlySet<string>;
  selfAddresses: ReadonlySet<string>;
  doNotContact: boolean;
  sendsToday: number;
  dailyCap: number;
  minutesSinceLastSend: number | undefined;
  minSpacingMinutes: number;
  now: Date;
}

const ADDRESS = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

function addressesIn(header: string): string[] {
  return (header.match(ADDRESS) ?? []).map((item) => item.toLowerCase());
}

/** Passed both checks at writing time. An unchecked draft can't reach Gmail. */
function draftPassedChecks(checkResult: string | null): boolean {
  if (!checkResult) {
    return false;
  }
  try {
    const parsed = JSON.parse(checkResult) as {
      deterministic?: unknown[];
      model?: { pass?: unknown } | null;
    };
    return (
      Array.isArray(parsed.deterministic) &&
      parsed.deterministic.length === 0 &&
      parsed.model?.pass === true
    );
  } catch {
    return false;
  }
}

export function evaluateSequenceSendGate(
  input: SequenceSendGateInput,
): { ok: true } | { ok: false; reason: string } {
  const refuse = (reason: string) => ({ ok: false as const, reason });
  if (!input.enabled) {
    return refuse("disabled");
  }
  if (!input.factsReady) {
    return refuse("facts_not_ready");
  }
  if (input.accountId !== "work") {
    return refuse("not_work_account");
  }
  if (domainOf(input.fromAddress) !== OWN_DOMAIN) {
    return refuse("not_work_sender");
  }
  const sequence = input.sequence;
  if (!sequence || sequence.account !== "work" || sequence.status !== "active") {
    return refuse("sequence_not_active");
  }
  if (input.threadId !== input.sequenceThreadId) {
    return refuse("wrong_thread");
  }
  if (input.openSequenceId !== sequence.id) {
    return refuse("company_has_other_sequence");
  }
  if (input.cc?.trim()) {
    return refuse("cc_not_allowed");
  }
  if (input.bcc?.trim()) {
    return refuse("bcc_not_allowed");
  }
  const recipients = addressesIn(input.to);
  const enrolled = sequence.prospect_email.trim().toLowerCase();
  if (recipients.length !== 1 || recipients[0] !== enrolled) {
    return refuse("recipient_mismatch");
  }
  if (
    isSelfEmail(enrolled) ||
    input.selfAddresses.has(enrolled) ||
    domainInSet(domainOf(enrolled), input.blockedDomains)
  ) {
    return refuse("blocked_recipient");
  }
  if (input.doNotContact) {
    return refuse("do_not_contact");
  }
  if (input.testRecipients.length > 0 && !input.testRecipients.includes(enrolled)) {
    return refuse("outside_test_list");
  }
  const step = input.step;
  if (
    !step ||
    step.status !== "planned" ||
    step.sent_message_id ||
    sequence.current_step !== input.stepNo
  ) {
    return refuse("step_not_ready");
  }
  if (input.stepNo <= sequence.manual_followups) {
    return refuse("step_used_by_manual_followup");
  }
  if (sequence.manual_followups + sequence.steps_sent >= SEQUENCE_STEPS) {
    return refuse("followups_used_up");
  }
  if (!input.body.trim() || input.body !== step.draft_text) {
    return refuse("body_not_the_checked_draft");
  }
  if (!draftPassedChecks(step.check_result)) {
    return refuse("draft_not_checked");
  }
  if (!input.inReplyTo.trim()) {
    return refuse("no_thread_headers");
  }
  if (!inSendWindow(input.now, sequence.prospect_timezone)) {
    return refuse("outside_window");
  }
  if (input.sendsToday >= input.dailyCap) {
    return refuse("daily_cap");
  }
  if (
    input.minutesSinceLastSend !== undefined &&
    input.minutesSinceLastSend < input.minSpacingMinutes
  ) {
    return refuse("spacing");
  }
  return { ok: true };
}

export interface SendSequenceStepParams {
  sequenceId: number;
  stepNo: number;
  account: LoadedGoogleAccount;
  fromAddress: string;
  threadId: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  inReplyTo: string;
  references: string;
  body: string;
  signatureHtml?: string;
  selfAddresses: ReadonlySet<string>;
  now?: Date;
  factsPath?: string;
}

function httpStatus(error: unknown): number | undefined {
  const record = error as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  for (const value of [record?.response?.status, record?.status, record?.code]) {
    const status = Number(value);
    if (Number.isInteger(status) && status >= 100 && status < 600) {
      return status;
    }
  }
  return undefined;
}

/** The only way a sequence step reaches Gmail. Everything the gate decides on comes
 *  from the database and config; the caller's recipient and body only have to match
 *  them. The step is claimed before the call, so no crash can cause a second send. */
export async function sendSequenceStep(
  params: SendSequenceStepParams,
): Promise<{ messageId: string }> {
  const now = params.now ?? new Date();
  const sequence = getSalesSequence(params.sequenceId);
  const step = getSalesSequenceStep(params.sequenceId, params.stepNo);
  const last = lastSalesSendAt();
  const gate = evaluateSequenceSendGate({
    enabled: config.sequencesEnabled,
    factsReady: salesFactsStatus(params.factsPath).ready,
    testRecipients: config.sequenceTestRecipients,
    accountId: params.account.id,
    fromAddress: params.fromAddress,
    sequence,
    openSequenceId: sequence
      ? getOpenSalesSequenceForKey(sequence.prospect_key)?.id
      : undefined,
    stepNo: params.stepNo,
    step,
    to: params.to,
    cc: params.cc,
    bcc: params.bcc,
    body: params.body,
    inReplyTo: params.inReplyTo,
    threadId: params.threadId,
    sequenceThreadId: sequence?.thread_id,
    blockedDomains: blockedAutoSendDomains(),
    selfAddresses: params.selfAddresses,
    doNotContact: sequence ? isSalesDoNotContact(sequence.prospect_email) : false,
    sendsToday: countSalesSendsSince(istDayStart(now).toISOString()),
    dailyCap: config.sequenceDailySendCap,
    minutesSinceLastSend: last
      ? (now.getTime() - new Date(last).getTime()) / 60_000
      : undefined,
    minSpacingMinutes: config.sequenceMinSpacingMinutes,
    now,
  });
  if (!gate.ok) {
    throw new SequenceSendRefusedError(gate.reason);
  }
  const raw = buildThreadReplyMime({
    to: params.to,
    subject: params.subject,
    inReplyTo: params.inReplyTo,
    references: params.references,
    body: params.body,
    signatureHtml: params.signatureHtml,
  });
  if (/^(?:cc|bcc):/im.test(mimeHeaderBlock(raw))) {
    throw new SequenceSendRefusedError("cc_not_allowed");
  }
  if (!claimSalesStepSending(params.sequenceId, params.stepNo, now.toISOString())) {
    throw new SequenceSendRefusedError("step_not_ready");
  }
  const tag = `Sequence ${params.sequenceId} step ${params.stepNo}: provider=gmail`;
  let messageId: string | null | undefined;
  try {
    const sent = await gmailClient(params.account).users.messages.send({
      userId: "me",
      requestBody: {
        threadId: params.threadId,
        raw: Buffer.from(raw, "utf8").toString("base64url"),
      },
    });
    messageId = sent.data.id;
  } catch (error) {
    const status = httpStatus(error);
    if (status !== undefined && status >= 400 && status < 500 && status !== 408) {
      releaseSalesStepClaim(params.sequenceId, params.stepNo);
      console.error(`${tag} status=rejected code=${status}`);
      throw new SequenceSendRejectedError(status);
    }
    console.error(`${tag} status=unconfirmed`);
    throw new SequenceSendUnconfirmedError();
  }
  if (!messageId) {
    console.error(`${tag} status=unconfirmed`);
    throw new SequenceSendUnconfirmedError();
  }
  recordSalesStepSent({
    sequenceId: params.sequenceId,
    stepNo: params.stepNo,
    sentMessageId: messageId,
    sentAt: now.toISOString(),
    stepDays: config.sequenceStepDays,
  });
  console.log(`${tag} status=sent`);
  return { messageId };
}
