import { AsyncLocalStorage } from "node:async_hooks";
import { parseAddressList } from "./address_list.js";
import type { EmailRecovery, EmailRecoveryUpdate } from "./email_recovery.js";

export interface EmailOutcome {
  id: string;
  line: string;
  recordedAt: number;
}

export interface EmailTurnOutcomes {
  startedAt: number;
  writes: Map<string, EmailOutcome>;
  notices: Set<string>;
  recoveries: Map<EmailRecoveryUpdate["operation"], EmailRecovery>;
  recoveryUpdates: WeakSet<EmailRecoveryUpdate>;
  uncertain: boolean;
  inFlight: number;
  onLateOutcome?: (outcome: EmailOutcome) => void;
}

export interface EmailToolObservation {
  writes: EmailOutcome[];
  failure?: EmailOperationError;
  recoveryTool?: string;
  target?: EmailOperationError["evidence"];
}

const turns = new AsyncLocalStorage<EmailTurnOutcomes>();
const operations = new AsyncLocalStorage<EmailToolObservation>();
const providerWrites = new AsyncLocalStorage<boolean>();

export function currentEmailTurn(): EmailTurnOutcomes | undefined {
  return turns.getStore();
}

export function newEmailTurn(): EmailTurnOutcomes {
  return { startedAt: Date.now(), writes: new Map(), notices: new Set(), recoveries: new Map(), recoveryUpdates: new WeakSet(), uncertain: false, inFlight: 0 };
}

export function withEmailTurn<T>(journal: EmailTurnOutcomes, work: () => T): T {
  return turns.run(journal, work);
}

export function observeEmailTool<T>(observation: EmailToolObservation, work: () => T): T {
  return operations.run(observation, work);
}

export function addEmailOutcomes(outcomes: readonly EmailOutcome[]): void {
  const journal = currentEmailTurn();
  if (!journal) return;
  for (const outcome of outcomes) {
    if (journal.writes.has(outcome.id)) continue;
    journal.writes.set(outcome.id, outcome);
    journal.onLateOutcome?.(outcome);
  }
}

export function recordEmailOutcome(id: string, line: string): void {
  const outcome = { id, line, recordedAt: Date.now() };
  operations.getStore()?.writes.push(outcome);
  addEmailOutcomes([outcome]);
}

export function noteEmailNotice(message: string): void {
  if (message.trim()) currentEmailTurn()?.notices.add(message);
}

export function noteEmailTarget(tool: string, target: EmailOperationError["evidence"]): void {
  const observation = operations.getStore();
  if (observation?.recoveryTool === tool) observation.target = target;
}

/** Voice cards are acknowledged after the model has finished its turn. */
export function emailCardAcknowledgement(key: string, line: string): (messageId: number) => void {
  const journal = currentEmailTurn();
  const observation = operations.getStore();
  return (messageId) => {
    const outcome = { id: `card:${messageId}:${key}`, line, recordedAt: Date.now() };
    observation?.writes.push(outcome);
    if (journal) withEmailTurn(journal, () => addEmailOutcomes([outcome]));
  };
}

/** Put recorded outcomes and notices before the reply, leaving its prose intact. */
export function renderEmailOutcomes(journal: EmailTurnOutcomes, reply: string): string {
  const lines = new Set([...journal.writes.values()].map(outcome => outcome.line));
  for (const notice of journal.notices) lines.add(notice);
  for (const recovery of journal.recoveries.values()) lines.add(recovery.userMessage);
  if (lines.size === 0) return reply;
  const report = [...lines].join("\n");
  return reply === "" ? report : `${report}\n\n${reply}`;
}

export function emailOutcomeTime(timestamp?: string | null): string | undefined {
  if (!timestamp) return undefined;
  const parsed = new Date(timestamp.includes("T") ? timestamp : `${timestamp.replace(" ", "T")}Z`);
  if (!Number.isFinite(parsed.getTime())) return undefined;
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(parsed);
}

export function outcomeRecipient(header: string): string {
  return parseAddressList(header).map(({ name, email }) => name ? `${oneLine(name)} <${email}>` : email).join(", ") || "the recipient";
}

export function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export function sentOutcomeLine(to: string, sentAt?: string | null, subject?: string | null): string {
  const time = emailOutcomeTime(sentAt);
  return `Sent to ${outcomeRecipient(to)}${time ? ` at ${time} IST` : ""}${subject ? ` on '${oneLine(subject)}'` : ""}.`;
}

export type EmailFailureReason =
  | "input_needed" | "choice_required" | "not_authorized" | "refused" | "excluded"
  | "approval_required" | "already_handled" | "provider_read_failed" | "provider_rejected"
  | "write_unconfirmed" | "draft_closed" | "draft_missing" | "message_missing" | "card_not_shown";

export class EmailOperationError extends Error {
  constructor(
    message: string,
    readonly reason: EmailFailureReason,
    readonly evidence: {
      account?: "work" | "personal";
      draftId?: string;
      threadId?: string;
      recipient?: string;
      messageId?: string;
      sequenceId?: number;
      scheduleId?: number;
      choiceId?: number;
      lookup?: "sent" | "drafts";
    } = {},
  ) {
    super(message);
    this.name = "EmailOperationError";
  }
}

export function noteEmailFailure(failure: EmailOperationError): string {
  const observation = operations.getStore();
  if (observation?.failure?.reason === "write_unconfirmed") return failure.message;
  if (observation) observation.failure = failure;
  const journal = currentEmailTurn();
  if (journal && failure.reason === "write_unconfirmed") {
    journal.uncertain = true;
    if (!observation?.recoveryTool) journal.notices.add(failure.message);
  }
  return failure.message;
}

export function definitelyRejectedWrite(error: unknown): boolean {
  const response = error as { error_code?: unknown; code?: unknown; status?: unknown; response?: { status?: unknown } } | null;
  const status = Number(response?.response?.status ?? response?.error_code ?? response?.status ?? response?.code);
  return status >= 400 && status < 500 && status !== 408 && status !== 409;
}

export function emailProviderWriteInProgress(): boolean {
  return providerWrites.getStore() === true;
}

export function requireWritableEmailTurn(): void {
  if (currentEmailTurn()?.uncertain) {
    throw new EmailOperationError("An email write is unconfirmed. Use read-only tools to check its status.", "write_unconfirmed");
  }
}

export async function emailProviderRead<T>(
  operation: () => Promise<T>, message: string, evidence: EmailOperationError["evidence"] = {},
): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    if (cause instanceof EmailOperationError) throw cause;
    throw new EmailOperationError(message, "provider_read_failed", evidence);
  }
}

/** Wrap only the provider write, after local validation and provider reads. */
export async function trackEmailProviderWrite<T>(operation: () => Promise<T>): Promise<T> {
  requireWritableEmailTurn();
  const journal = currentEmailTurn();
  if (journal) journal.inFlight += 1;
  try {
    return await providerWrites.run(true, operation);
  } finally {
    if (journal) journal.inFlight -= 1;
  }
}

export async function emailProviderWrite<T>(operation: () => Promise<T>, input: {
  rejected: string;
  unconfirmed: string;
  evidence?: EmailOperationError["evidence"];
  reportRejection?: boolean;
}): Promise<T> {
  try {
    return await trackEmailProviderWrite(operation);
  } catch (cause) {
    if (cause instanceof EmailOperationError) throw cause;
    const rejected = definitelyRejectedWrite(cause);
    const error = new EmailOperationError(
      rejected ? input.rejected : input.unconfirmed,
      rejected ? "provider_rejected" : "write_unconfirmed",
      input.evidence,
    );
    if (!rejected || input.reportRejection !== false) noteEmailFailure(error);
    throw error;
  }
}
