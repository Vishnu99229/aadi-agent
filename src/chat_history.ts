import type { StoredMessage } from "./db.js";
import { assertTestSeam } from "./test_seam.js";

export const HISTORY_KEEP_MAX = 30;
export const HISTORY_FOLD = 10;
export const HISTORY_TOKEN_BUDGET = 8_000;
export const TOOL_STUB_MIN_CHARS = 1_500;

export const SUMMARISE_SYSTEM =
  "Summarise this Telegram chat for Aadi: key decisions and facts; my stated preferences and how I want things done; open tasks, promises and pending drafts; names, companies, dates and specifics. Plain text, under 250 words. No secrets, OTPs, passwords or account numbers.";

const DEFAULTS = {
  keepMax: HISTORY_KEEP_MAX,
  fold: HISTORY_FOLD,
  tokenBudget: HISTORY_TOKEN_BUDGET,
};

let limits = { ...DEFAULTS };

export function setHistoryLimitsForTests(
  next: Partial<typeof DEFAULTS> | undefined,
): void {
  assertTestSeam("setHistoryLimitsForTests");
  limits = { ...DEFAULTS, ...next };
}

export function historyLimits(): typeof DEFAULTS {
  return limits;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function redactSecrets(text: string): string {
  return text
    .replace(/\b(otp|one[-\s]?time (?:password|pin|code))\b[:\s-]*\d{4,8}\b/gi, "$1 [redacted]")
    .replace(/\b\d{4,8}\b(?=[^.]*\b(?:otp|one[-\s]?time)\b)/gi, "[redacted]")
    .replace(/\b(password|passwd|passcode)\b[:\s=]*\S+/gi, "$1 [redacted]")
    .replace(/\b(account(?:\s+number)?|a\/c|acct)[:\s#.-]*\d{6,}\b/gi, "$1 [redacted]")
    .replace(/\b(?:\d[ -]*){12,19}\b/g, "[redacted]");
}

export function userMessagesAfter(
  messages: readonly StoredMessage[],
  index: number,
): number {
  let count = 0;
  for (let i = index + 1; i < messages.length; i += 1) {
    if (messages[i]!.role === "user") {
      count += 1;
    }
  }
  return count;
}

function toolStubLabel(message: StoredMessage): string {
  const name = (message.tool_name ?? "tool").replace(/_/g, " ");
  if (/email/i.test(name)) {
    const from = message.content.match(/^From:\s*(.+)$/im)?.[1]?.trim();
    const sender = from?.replace(/\s+/g, " ").slice(0, 80);
    return sender ? `read email from ${sender}` : "read email";
  }
  if (/document|drive|attachment/i.test(name)) {
    return "read document";
  }
  if (/search/i.test(name)) {
    return `${name} results`;
  }
  return name;
}

export function stubForToolMessage(message: StoredMessage): string {
  const kilo = (message.content.length / 1000).toFixed(1);
  return `[${toolStubLabel(message)}, ${kilo}K chars]`;
}

export function stubLongToolOutputs(
  messages: readonly StoredMessage[],
): StoredMessage[] {
  return messages.map((message, index) => {
    if (message.role !== "tool") {
      return message;
    }
    if (message.content.length <= TOOL_STUB_MIN_CHARS) {
      return message;
    }
    if (userMessagesAfter(messages, index) <= 2) {
      return message;
    }
    return { ...message, content: stubForToolMessage(message) };
  });
}

export function historyTokenCount(messages: readonly StoredMessage[]): number {
  return estimateTokens(messages.map((message) => message.content).join("\n"));
}

export interface HistoryPlan {
  folds: StoredMessage[][];
  keep: StoredMessage[];
}

export function planHistoryWindow(
  messages: readonly StoredMessage[],
  untilId = 0,
): HistoryPlan {
  const { keepMax, fold, tokenBudget } = limits;
  let remaining = stubLongToolOutputs(
    messages.filter((message) => message.id > untilId),
  );
  const folds: StoredMessage[][] = [];
  while (
    remaining.length > keepMax ||
    historyTokenCount(remaining) > tokenBudget
  ) {
    const take = Math.min(fold, Math.max(0, remaining.length - 1));
    if (take <= 0) {
      break;
    }
    folds.push(remaining.slice(0, take));
    remaining = remaining.slice(take);
  }
  return { folds, keep: remaining };
}
