import { InlineKeyboard } from "grammy";
import { LlmChainError } from "./llm.js";
import type { CallOutcome } from "./models/circuit.js";
import { PROVIDER_LABELS, type ProviderId } from "./models/registry.js";
import { assertTestSeam } from "./test_seam.js";
import {
  beginChatTurn as insertChatTurn,
  countChatTurnsToday as countTurns,
  finishChatTurn as updateChatTurn,
  getChatTurnForwarded as readForwarded,
  getChatTurnRetryText as readRetryText,
  setChatTurnForwarded as writeForwarded,
  setChatTurnRetryText as writeRetryText,
  type ChatTurnOutcome,
} from "./db.js";

export const TURN_TIMEOUT_MS = 60_000;

let timeoutOverride: number | undefined;

export function setTurnTimeoutMsForTests(ms: number | undefined): void {
  assertTestSeam("setTurnTimeoutMsForTests");
  timeoutOverride = ms;
}

export function turnTimeoutMs(): number {
  return timeoutOverride ?? TURN_TIMEOUT_MS;
}

export interface TurnGate {
  id: number;
  open: boolean;
}

export type FailureClass = "rate limit" | "credit" | "timeout" | "server error" | "request rejected" | "internal error";

/** Why a turn failed, as fixed data. A provider's own response body never gets here. */
export type TurnFailureCause =
  | { kind: "timeout" }
  | { kind: "empty" }
  | { kind: "error"; provider?: string; reason: FailureClass };

export const NOTHING_CHANGED_ON_FAILURE = "Nothing was sent or changed.";
export const MAY_HAVE_CHANGED_ON_FAILURE = "Something may already have changed; check before trying again.";

function failureClass(outcome: CallOutcome): FailureClass {
  switch (outcome) {
    case "rate_limit":
      return "rate limit";
    case "auth":
      return "credit";
    case "timeout":
      return "timeout";
    case "server":
      return "server error";
    default:
      return "request rejected";
  }
}

function providerName(provider: string): string {
  return provider in PROVIDER_LABELS ? PROVIDER_LABELS[provider as ProviderId] : provider === "local" ? "The laptop model" : provider;
}

/** The provider and reason class of a failed turn, from the structured chain error. */
export function failureCause(error: unknown): TurnFailureCause {
  if (error instanceof LlmChainError) {
    const first = error.failures[0];
    return first
      ? { kind: "error", provider: providerName(first.provider), reason: failureClass(first.outcome) }
      : { kind: "error", reason: "server error" };
  }
  return { kind: "error", reason: "internal error" };
}

/** A fixed message: what failed and whether anything changed. Never raw provider text. */
export function formatTurnFailure(cause: TurnFailureCause, changed = false): string {
  const what =
    cause.kind === "timeout"
      ? "the reply timed out"
      : cause.kind === "empty"
        ? "the model returned an empty reply"
        : cause.provider
          ? `${cause.provider}: ${cause.reason}`
          : cause.reason;
  return `I couldn't finish that (${what}). ${changed ? MAY_HAVE_CHANGED_ON_FAILURE : NOTHING_CHANGED_ON_FAILURE}`;
}

export function retryKeyboard(turnId: number): InlineKeyboard {
  return new InlineKeyboard().text("Retry", `retry:${turnId}`);
}

export function beginTurn(): TurnGate {
  const id = insertChatTurn();
  return { id, open: true };
}

export function attachRetryText(gate: TurnGate, text: string): void {
  writeRetryText(gate.id, text);
}

export function retryTextFor(turnId: number): string | undefined {
  return readRetryText(turnId);
}

export function markTurnForwarded(gate: TurnGate, forwarded: boolean): void {
  writeForwarded(gate.id, forwarded);
}

export function turnWasForwarded(turnId: number): boolean {
  return readForwarded(turnId);
}

export function closeTurn(
  gate: TurnGate,
  outcome: ChatTurnOutcome,
  startedAt: number,
  error?: string,
): void {
  const durationMs = Math.max(0, Date.now() - startedAt);
  updateChatTurn(gate.id, {
    outcome,
    durationMs,
    error,
  });
  console.log(
    `turn id=${gate.id} duration_ms=${durationMs} outcome=${outcome}`,
  );
}

export function countChatTurnsToday(now = new Date()): {
  failed: number;
  timeout: number;
} {
  return countTurns(now);
}

export function formatTurnsHealthLine(now = new Date()): string {
  const counts = countChatTurnsToday(now);
  return `turns today: ${counts.failed} failed, ${counts.timeout} timed out`;
}

export async function settleChatWork(
  work: () => Promise<string>,
  timeoutMs: number,
): Promise<
  | { status: "ok"; reply: string }
  | { status: "timeout" }
  | { status: "empty" }
  | { status: "failed"; reason: string; cause: TurnFailureCause }
> {
  try {
    const raced = await raceTimeout(work(), timeoutMs);
    if (raced.timedOut) {
      return { status: "timeout" };
    }
    if (!raced.value.trim()) {
      return { status: "empty" };
    }
    return { status: "ok", reply: raced.value };
  } catch (error) {
    // The reason is kept for the turn log only; Telegram gets formatTurnFailure(cause).
    const reason =
      error instanceof Error && error.message.trim()
        ? error.message.replace(/\s+/g, " ").trim().slice(0, 180)
        : "unknown error";
    return { status: "failed", reason, cause: failureCause(error) };
  }
}

export async function raceTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
): Promise<{ timedOut: true } | { timedOut: false; value: T }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then((value) => ({ timedOut: false as const, value })),
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
