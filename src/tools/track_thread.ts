import type { LlmTool } from "../llm.js";
import type { ItemTag } from "../db.js";
import { trackLatestSentTo } from "../followups.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "track_thread",
  description:
    "Track Vishnu's latest sent email to a recipient. Does not draft or send. Use when he asks to follow up.",
  inputSchema: {
    type: "object",
    properties: {
      recipient: {
        type: "string",
        description:
          "The recipient's email address or a precise recipient search term.",
      },
      tag: {
        type: "string",
        enum: ["work", "personal"],
        description: "Whether the thread is work or personal.",
      },
    },
    required: ["recipient", "tag"],
  },
};

export async function handler(input: unknown): Promise<string> {
  const values = input as { recipient?: unknown; tag?: unknown };
  if (typeof values.recipient !== "string" || !values.recipient.trim()) {
    throw new Error("recipient must be a non-empty email or name.");
  }
  if (values.tag !== "work" && values.tag !== "personal") {
    throw new Error('tag must be either "work" or "personal".');
  }

  const followup = await trackLatestSentTo(
    values.recipient.trim(),
    values.tag as ItemTag,
  );
  return JSON.stringify({
    id: followup.id,
    recipient: followup.recipient,
    subject: followup.subject,
    tag: followup.tag,
    status: followup.status,
    last_sent_at: followup.last_sent_at,
    next_check_at: followup.next_check_at,
  });
}
