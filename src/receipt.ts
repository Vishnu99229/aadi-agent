/**
 * What a tool call left behind, as the loop records it. Whether a reply's words
 * match these records is the reply checker's call (reply_checker.ts), never a
 * pattern over the words.
 */
export interface ToolReceipt {
  name: string;
  success: boolean;
  content?: string;
}

/** Tools that can deliver an email. */
const DELIVERY_TOOLS: ReadonlySet<string> = new Set([
  "draft_reply",
  "draft_new_email",
  "confirm_send_pending_draft",
  "send_email",
]);

export function isDeliveryTool(name: string): boolean {
  return DELIVERY_TOOLS.has(name);
}

/** Tools answer "Not …", "Tool failed: …" or "Unknown tool …" when nothing was done. */
export function isSuccessfulToolResult(
  content: string,
  isError?: boolean,
): boolean {
  if (isError) {
    return false;
  }
  const text = content.trim();
  if (!text) {
    return false;
  }
  if (/^Not\s/i.test(text) || /^Tool failed/i.test(text) || /^Unknown tool/i.test(text)) {
    return false;
  }
  return true;
}
