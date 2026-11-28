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
import { htmlFromSequenceBody } from "../sequence_writer.js";
import { isSelfEmail } from "../mom_logic.js";
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
        /** Every step row, his own included. Missing means the original 4. */
        total_steps?: number;
        cc_first_only?: number;
      }
    | undefined;
  /** The open sequence for this person, which must be this one. */
  openSequenceId: number | undefined;
  stepNo: number;
  step:
    | {
        status: string;
        draft_text: string | null;
        sent_message_id: string | null;
        /** Own-team Cc stored at Start. Only step 1 ever has one. */
        cc?: string | null;
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

function sameAddresses(left: string[], right: string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/** Follow-up 1 may Cc exactly the own-team addresses stored at Start: epicode.in
 *  colleagues and his own addresses. Later steps require an explicit persisted
 *  setting and the same per-step stored addresses. */
function ccAllowed(input: SequenceSendGateInput, enrolled: string): boolean {
  const given = input.cc?.trim() ?? "";
  const stored = input.step?.cc?.trim() ?? "";
  if (!given && !stored) {
    return true;
  }
  const addresses = addressesIn(given);
  if (
    (input.stepNo !== 1 && input.sequence?.cc_first_only !== 0) ||
    addresses.length === 0 ||
    !sameAddresses(addresses, addressesIn(stored))
  ) {
    return false;
  }
  return addresses.every((address) => {
    const domain = domainOf(address);
    if (address === enrolled) {
      return false;
    }
    if (domainInSet(domain, new Set([OWN_DOMAIN]))) {
      return true;
    }
    return (
      (isSelfEmail(address) || input.selfAddresses.has(address)) &&
      !domainInSet(domain, input.blockedDomains)
    );
  });
}

export function evaluateSequenceSendGate(
  input: SequenceSendGateInput,
): { ok: true } | { ok: false; reason: string } {
  const refuse = (reason: string) => ({ ok: false as const, reason });
  if (!input.enabled) {
    return refuse("disabled");
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
    return refuse("prospect_has_other_sequence");
  }
  const enrolled = sequence.prospect_email.trim().toLowerCase();
  if (!ccAllowed(input, enrolled)) {
    return refuse("cc_not_allowed");
  }
  if (input.bcc?.trim()) {
    return refuse("bcc_not_allowed");
  }
  const recipients = addressesIn(input.to);
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
  if (sequence.manual_followups + sequence.steps_sent >= (sequence.total_steps ?? SEQUENCE_STEPS)) {
    return refuse("followups_used_up");
  }
  if (!input.body.trim() || input.body !== step.draft_text) {
    return refuse("body_not_the_written_draft");
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
    cc: params.cc,
    subject: params.subject,
    inReplyTo: params.inReplyTo,
    references: params.references,
    body: params.body,
    signatureHtml: params.signatureHtml,
    htmlBody: params.signatureHtml
      ? htmlFromSequenceBody(params.body, params.signatureHtml)
      : undefined,
  });
  const headerBlock = mimeHeaderBlock(raw);
  const ccLines = headerBlock.match(/^cc:.*$/gim) ?? [];
  if (
    /^bcc:/im.test(headerBlock) ||
    ccLines.length > 1 ||
    !sameAddresses(addressesIn(ccLines[0] ?? ""), addressesIn(params.cc ?? ""))
  ) {
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
