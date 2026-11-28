/**
 * Raw data never goes to Telegram as a message. A text that is a JSON object or
 * array, or a tool call written out as text, is structured payload: it means a
 * model wrote its tool call as prose, or code passed a tool result straight
 * through. It is never sent and never run.
 */

const TOOL_CALL_BLOCK = "<tool_call>";

function withoutCodeFence(text: string): string {
  if (!text.startsWith("```") || !text.endsWith("```") || text.length < 6) {
    return text;
  }
  const firstBreak = text.indexOf("\n");
  if (firstBreak < 0) {
    return text;
  }
  return text.slice(firstBreak + 1, -3).trim();
}

function parsesAsStructure(text: string): boolean {
  const first = text[0];
  if (first !== "{" && first !== "[") {
    return false;
  }
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null;
  } catch {
    return false;
  }
}

/** The whole text is a JSON object or array (optionally in one code fence), or holds a <tool_call> block. */
export function isRawPayload(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.includes(TOOL_CALL_BLOCK)) {
    return true;
  }
  return parsesAsStructure(trimmed) || parsesAsStructure(withoutCodeFence(trimmed));
}

export class RawTextBlockedError extends Error {
  constructor(readonly method: string) {
    super(`Telegram ${method} withheld: the text was raw data, not a message.`);
    this.name = "RawTextBlockedError";
  }
}

/** Throws instead of sending raw data. */
export function assertSendableText(text: string, method = "sendMessage"): void {
  if (isRawPayload(text)) {
    console.error(`Outgoing text guard: ${method} withheld raw data (${text.trim().length} chars).`);
    throw new RawTextBlockedError(method);
  }
}

export const FORMAT_PROBLEM_TEXT = "I hit a formatting problem; nothing else was done.";
