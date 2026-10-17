import { google } from "googleapis";
import type { LoadedGoogleAccount } from "../google/auth.js";
import { SELF_EMAILS } from "../mom_logic.js";

export class AutoBookRefusedError extends Error {
  constructor(readonly reason: string) {
    super(`auto-book refused: ${reason}`);
    this.name = "AutoBookRefusedError";
  }
}

export interface AutoBookGateInput {
  autoBook: boolean;
  fromEmail: string;
  recipientEmail: string;
  incomingToCc: string[];
  proposalEmails: string[];
  dailyCount: number;
  dailyCap: number;
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
    "Vishnu",
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

function buildReplyRaw(params: {
  to: string;
  subject: string;
  inReplyTo: string;
  references: string;
  body: string;
}): string {
  const subject = /^re\s*:/i.test(params.subject)
    ? params.subject
    : `Re: ${params.subject}`;
  const references = [params.references, params.inReplyTo]
    .map(safeHeader)
    .filter(Boolean)
    .join(" ");
  return [
    `To: ${safeHeader(params.to)}`,
    `Subject: ${safeHeader(subject)}`,
    `In-Reply-To: ${safeHeader(params.inReplyTo)}`,
    `References: ${references}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    encodeBody(params.body),
  ].join("\r\n");
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
}

export async function autoBookConfirm(
  params: AutoBookConfirmParams,
): Promise<{ messageId: string }> {
  const gate = evaluateAddressGate(params.gate);
  if (!gate.ok) {
    throw new AutoBookRefusedError(gate.reason);
  }
  const expected = renderBookingConfirmBody(params.template);
  if (normalizeBody(params.body) !== normalizeBody(expected)) {
    throw new AutoBookRefusedError("template_mismatch");
  }
  if (params.sendImpl) {
    return params.sendImpl(params.body);
  }
  if (!params.account || !params.threadId || !params.to || !params.subject || !params.inReplyTo) {
    throw new AutoBookRefusedError("missing_send_target");
  }
  const gmail = google.gmail({ version: "v1", auth: params.account.client });
  const raw = buildReplyRaw({
    to: params.to,
    subject: params.subject,
    inReplyTo: params.inReplyTo,
    references: params.references ?? "",
    body: params.body,
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
  return { messageId };
}
