import { google } from "googleapis";
import type { LoadedGoogleAccount } from "../google/auth.js";
import { SELF_EMAILS } from "../mom_logic.js";

export class AutoBookRefusedError extends Error {
  constructor(readonly reason: string) {
    super(`auto-book refused: ${reason}`);
    this.name = "AutoBookRefusedError";
  }
}

export const FALLBACK_OPENING =
  "Thanks for getting in touch. I'd be glad to set up a call.";
export const PLAIN_SIGNATURE = "Vishnu Rajan\nGTM, Epicode";
export const DEFAULT_SIGNATURE_HTML =
  "<div>Vishnu Rajan<br>GTM, Epicode</div>";
export const TELEGRAM_ONLY_LABELS = [
  "Meeting proposal — Send stores the offered slots",
] as const;

export type SchedulingKind = "proposal" | "clarify" | "confirm";

export interface AutoBookGateInput {
  autoBook: boolean;
  fromEmail: string;
  recipientEmail: string;
  incomingToCc: string[];
  proposalEmails: string[];
  dailyCount: number;
  dailyCap: number;
}

export interface SchedulingSendGateInput extends AutoBookGateInput {
  dailySendCount: number;
  dailySendCap: number;
}

export interface AutoBookCheckInput extends AutoBookGateInput {
  slotIndex: number | null;
  verdict: "one" | "none" | "ambiguous";
  confidence: number;
  minConfidence: number;
  slotCount: number;
  slotStart: Date | null;
  now: Date;
  slotStillFree: boolean;
}

export interface BookingConfirmVars {
  firstName: string;
  dayDate: string;
  startTime: string;
  endTime: string;
  otherZone: string | null;
}

export interface ProposalBodyVars {
  firstName: string;
  openingLine: string;
  durationMinutes: number;
  slots: string[];
}

export interface ClarifyBodyVars {
  firstName: string;
  slots: string[];
}

export type AutoBookDecision =
  | { ok: true; slotIndex: number }
  | { ok: false; reason: string };

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function extraToCcAddresses(
  incomingToCc: string[],
  proposalEmails: string[],
): string[] {
  const allowed = new Set(
    [...proposalEmails, ...SELF_EMAILS].map((email) => normalizeEmail(email)),
  );
  return incomingToCc
    .map((email) => normalizeEmail(email))
    .filter((email) => email && !allowed.has(email));
}

export function evaluateAddressGate(
  input: AutoBookGateInput,
): { ok: true } | { ok: false; reason: string } {
  if (!input.autoBook) {
    return { ok: false, reason: "auto_book_disabled" };
  }
  if (normalizeEmail(input.fromEmail) !== normalizeEmail(input.recipientEmail)) {
    return { ok: false, reason: "from_mismatch" };
  }
  if (extraToCcAddresses(input.incomingToCc, input.proposalEmails).length > 0) {
    return { ok: false, reason: "new_cc" };
  }
  if (input.dailyCount >= input.dailyCap) {
    return { ok: false, reason: "daily_cap" };
  }
  return { ok: true };
}

export function evaluateAutoBookChecks(input: AutoBookCheckInput): AutoBookDecision {
  const gate = evaluateAddressGate(input);
  if (!gate.ok) {
    return gate;
  }
  if (input.verdict !== "one" || input.slotIndex === null) {
    return { ok: false, reason: input.verdict === "ambiguous" ? "ambiguous" : "no_slot" };
  }
  if (input.confidence < input.minConfidence) {
    return { ok: false, reason: "low_confidence" };
  }
  if (input.slotIndex < 0 || input.slotIndex >= input.slotCount) {
    return { ok: false, reason: "bad_index" };
  }
  if (!input.slotStart) {
    return { ok: false, reason: "missing_slot" };
  }
  if (input.slotStart.getTime() - input.now.getTime() < 60 * 60 * 1000) {
    return { ok: false, reason: "too_soon" };
  }
  if (!input.slotStillFree) {
    return { ok: false, reason: "busy" };
  }
  return { ok: true, slotIndex: input.slotIndex };
}

export function validateOpeningLine(raw: string | null | undefined): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const line = raw.replace(/\s+/g, " ").trim();
  if (!line) {
    return undefined;
  }
  const words = line.split(" ").filter(Boolean);
  if (words.length > 40) {
    return undefined;
  }
  if (/https?:\/\//i.test(line) || /\bwww\./i.test(line)) {
    return undefined;
  }
  if (/@/.test(line) || /\d/.test(line)) {
    return undefined;
  }
  if (/<[^>]+>/.test(line) || /attach/i.test(line)) {
    return undefined;
  }
  if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(line)) {
    return undefined;
  }
  return line;
}

export function openingLineOrFallback(raw: string | null | undefined): string {
  return validateOpeningLine(raw) ?? FALLBACK_OPENING;
}

function slotLines(slots: string[]): string {
  return slots.map((slot) => `• ${slot}`).join("\n");
}

export function renderProposalBody(vars: ProposalBodyVars): string {
  const opening = openingLineOrFallback(vars.openingLine);
  return [
    `Hi ${vars.firstName},`,
    "",
    opening,
    "",
    `Would any of these work for a ${vars.durationMinutes}-minute call?`,
    slotLines(vars.slots),
    "",
    "If none of these suit, just share a time that works for you and I'll make it happen.",
    "",
    PLAIN_SIGNATURE,
  ].join("\n");
}

export function renderClarifyBody(vars: ClarifyBodyVars): string {
  return [
    `Hi ${vars.firstName},`,
    "",
    "Happy to lock it in. Which of these suits you best?",
    slotLines(vars.slots),
    "",
    PLAIN_SIGNATURE,
  ].join("\n");
}

export function renderBookingConfirmBody(vars: BookingConfirmVars): string {
  const zone =
    vars.otherZone && vars.otherZone.trim()
      ? ` (${vars.otherZone.trim()})`
      : "";
  return [
    `Hi ${vars.firstName},`,
    "",
    `Done. I've sent a calendar invite for ${vars.dayDate}, ${vars.startTime}–${vars.endTime} IST${zone}. The Google Meet link is in the invite.`,
    "",
    "Looking forward to speaking.",
    "",
    PLAIN_SIGNATURE,
  ].join("\n");
}

function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, "\n").trim();
}

function safeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function encodeBody(body: string): string {
  return Buffer.from(body, "utf8")
    .toString("base64")
    .match(/.{1,76}/g)!
    .join("\r\n");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function htmlFromSchedulingBody(
  plain: string,
  signatureHtml = DEFAULT_SIGNATURE_HTML,
): string {
  const trimmed = normalizeBody(plain);
  const withoutSig = trimmed.endsWith(PLAIN_SIGNATURE)
    ? trimmed.slice(0, trimmed.length - PLAIN_SIGNATURE.length).trimEnd()
    : trimmed;
  const blocks = withoutSig.split(/\n{2,}/);
  const htmlBlocks = blocks.map((block) => {
    const lines = block.split("\n");
    const bullets = lines.filter((line) => line.startsWith("• "));
    if (bullets.length === lines.length && lines.length > 0) {
      const items = bullets
        .map((line) => `<li>${escapeHtml(line.slice(2))}</li>`)
        .join("");
      return `<ul>${items}</ul>`;
    }
    return `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`;
  });
  return `<div>${htmlBlocks.join("")}${signatureHtml}</div>`;
}

export function containsForbiddenInternal(body: string): boolean {
  const text = body.replace(/\r\n/g, "\n");
  if (TELEGRAM_ONLY_LABELS.some((label) => text.includes(label))) {
    return true;
  }
  if (/^subject\s*:/im.test(text)) {
    return true;
  }
  return false;
}

function expectedPlain(params: {
  kind: SchedulingKind;
  proposal?: ProposalBodyVars;
  clarify?: ClarifyBodyVars;
  confirm?: BookingConfirmVars;
}): string | undefined {
  if (params.kind === "proposal" && params.proposal) {
    return renderProposalBody({
      ...params.proposal,
      openingLine: openingLineOrFallback(params.proposal.openingLine),
    });
  }
  if (params.kind === "clarify" && params.clarify) {
    return renderClarifyBody(params.clarify);
  }
  if (params.kind === "confirm" && params.confirm) {
    return renderBookingConfirmBody(params.confirm);
  }
  return undefined;
}

function replySubject(subject: string): string {
  return /^re\s*:/i.test(subject) ? subject : `Re: ${subject}`;
}

function buildMultipartRaw(params: {
  to: string;
  subject: string;
  inReplyTo: string;
  references: string;
  plain: string;
  html: string;
}): string {
  const subject = replySubject(params.subject);
  const references = [params.references, params.inReplyTo]
    .map(safeHeader)
    .filter(Boolean)
    .join(" ");
  const boundary = `aadi_${Date.now().toString(16)}`;
  return [
    `To: ${safeHeader(params.to)}`,
    `Subject: ${safeHeader(subject)}`,
    `In-Reply-To: ${safeHeader(params.inReplyTo)}`,
    `References: ${references}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    encodeBody(params.plain),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    encodeBody(params.html),
    `--${boundary}--`,
  ].join("\r\n");
}

export interface SendSchedulingEmailParams {
  kind: SchedulingKind;
  gate: SchedulingSendGateInput;
  body: string;
  html?: string;
  signatureHtml?: string;
  proposal?: ProposalBodyVars;
  clarify?: ClarifyBodyVars;
  confirm?: BookingConfirmVars;
  sendImpl?: (body: string) => Promise<{ messageId: string }>;
  account?: LoadedGoogleAccount;
  threadId?: string;
  to?: string;
  subject?: string;
  inReplyTo?: string;
  references?: string;
}

function evaluateSendGate(
  kind: SchedulingKind,
  gate: SchedulingSendGateInput,
): { ok: true } | { ok: false; reason: string } {
  if (gate.dailySendCount >= gate.dailySendCap) {
    return { ok: false, reason: "send_cap" };
  }
  if (kind === "confirm") {
    return evaluateAddressGate(gate);
  }
  if (!gate.autoBook) {
    return { ok: false, reason: "auto_book_disabled" };
  }
  return { ok: true };
}

export async function sendSchedulingEmail(
  params: SendSchedulingEmailParams,
): Promise<{ messageId: string; html: string }> {
  const gate = evaluateSendGate(params.kind, params.gate);
  if (!gate.ok) {
    throw new AutoBookRefusedError(gate.reason);
  }
  const expected = expectedPlain(params);
  if (!expected || normalizeBody(params.body) !== normalizeBody(expected)) {
    throw new AutoBookRefusedError("template_mismatch");
  }
  if (containsForbiddenInternal(params.body)) {
    throw new AutoBookRefusedError("internal_label");
  }
  if (params.kind === "proposal") {
    const opening = params.proposal?.openingLine ?? "";
    if (
      validateOpeningLine(opening) === undefined &&
      normalizeBody(opening) !== normalizeBody(FALLBACK_OPENING) &&
      !normalizeBody(params.body).includes(FALLBACK_OPENING)
    ) {
      throw new AutoBookRefusedError("opening_line");
    }
  }
  const html =
    params.html ??
    htmlFromSchedulingBody(params.body, params.signatureHtml ?? DEFAULT_SIGNATURE_HTML);
  if (params.sendImpl) {
    const sent = await params.sendImpl(params.body);
    return { messageId: sent.messageId, html };
  }
  if (!params.account || !params.threadId || !params.to || !params.subject || !params.inReplyTo) {
    throw new AutoBookRefusedError("missing_send_target");
  }
  const gmail = google.gmail({ version: "v1", auth: params.account.client });
  const raw = buildMultipartRaw({
    to: params.to,
    subject: params.subject,
    inReplyTo: params.inReplyTo,
    references: params.references ?? "",
    plain: params.body,
    html,
  });
  const sent = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      threadId: params.threadId,
      raw: Buffer.from(raw, "utf8").toString("base64url"),
    },
  });
  const messageId = sent.data.id;
  if (!messageId) {
    throw new AutoBookRefusedError("send_missing_id");
  }
  return { messageId, html };
}

export interface AutoBookConfirmParams {
  gate: AutoBookGateInput;
  body: string;
  template: BookingConfirmVars;
  sendImpl?: (body: string) => Promise<{ messageId: string }>;
  account?: LoadedGoogleAccount;
  threadId?: string;
  to?: string;
  subject?: string;
  inReplyTo?: string;
  references?: string;
  signatureHtml?: string;
}

export async function autoBookConfirm(
  params: AutoBookConfirmParams,
): Promise<{ messageId: string }> {
  const sent = await sendSchedulingEmail({
    kind: "confirm",
    gate: {
      ...params.gate,
      dailySendCount: 0,
      dailySendCap: Number.MAX_SAFE_INTEGER,
    },
    body: params.body,
    confirm: params.template,
    sendImpl: params.sendImpl,
    account: params.account,
    threadId: params.threadId,
    to: params.to,
    subject: params.subject,
    inReplyTo: params.inReplyTo,
    references: params.references,
    signatureHtml: params.signatureHtml,
  });
  return { messageId: sent.messageId };
}
