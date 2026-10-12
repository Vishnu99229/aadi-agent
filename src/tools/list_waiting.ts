import type { LlmTool } from "../llm.js";
import { getFollowups, type ItemTag } from "../db.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "list_waiting",
  description:
    'List email threads Vishnu is waiting for a reply on. Use this whenever he asks "what am I waiting on?" or similar. Optionally filter by work or personal.',
  inputSchema: {
    type: "object",
    properties: {
      tag: {
        type: "string",
        enum: ["work", "personal"],
        description: "Optional work or personal filter.",
      },
    },
    required: [],
  },
};

export function handler(input: unknown): string {
  const values = input as { tag?: unknown };
  if (
    values.tag !== undefined &&
    values.tag !== "work" &&
    values.tag !== "personal"
  ) {
    throw new Error('tag must be either "work" or "personal".');
  }
  const tag = values.tag as ItemTag | undefined;
  const now = Date.now();
  const followups = getFollowups().filter(
    (followup) =>
      (followup.status === "waiting" || followup.status === "snoozed") &&
      (!tag || followup.tag === tag),
  );

  if (followups.length === 0) {
    return "No matching email follow-ups.";
  }

  return JSON.stringify(
    followups.map((followup) => ({
      id: followup.id,
      recipient: followup.recipient,
      subject: followup.subject,
      tag: followup.tag,
      status: followup.status,
      days_waiting: Math.max(
        0,
        Math.floor(
          (now - new Date(followup.last_sent_at).getTime()) / DAY_MS,
        ),
      ),
      last_sent_at: followup.last_sent_at,
      next_check_at: followup.next_check_at,
      nudge_count: followup.nudge_count,
    })),
  );
}
