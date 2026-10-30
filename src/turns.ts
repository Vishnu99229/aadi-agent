import { assertTestSeam } from "./test_seam.js";
import {
  beginChatTurn as insertChatTurn,
  countChatTurnsToday as countTurns,
  finishChatTurn as updateChatTurn,
  getChatTurnRetryText as readRetryText,
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

export function formatTurnFailure(reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim().slice(0, 180) || "unknown error";
  return `I couldn't finish that: ${clean}.`;
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
  | { status: "failed"; reason: string }
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
    const reason =
      error instanceof Error && error.message.trim()
        ? error.message.replace(/\s+/g, " ").trim().slice(0, 180)
        : "unknown error";
    return { status: "failed", reason };
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
