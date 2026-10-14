import type { LlmTool } from "../llm.js";
import { getFollowups, type FollowupStatus, type ItemTag } from "../db.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "list_waiting",
  description:
    'List email threads Vishnu is waiting on, plus snoozed and replied threads still in the tracker. Use this to find a thread before stop_tracking, not only "due" nudges. Optional query matches recipient or subject. Optional status: waiting, snoozed, replied, dismissed, all (default: waiting, snoozed, and replied).',
  inputSchema: {
    type: "object",
    properties: {
      tag: {
        type: "string",
        enum: ["work", "personal"],
      },
      query: {
        type: "string",
        description: "Optional match on recipient or subject.",
      },
      status: {
        type: "string",
        enum: ["waiting", "snoozed", "replied", "dismissed", "all"],
      },
    },
    required: [],
  },
};

export function handler(input: unknown): string {
  const values = input as {
    tag?: unknown;
    query?: unknown;
    status?: unknown;
  };
  if (
    values.tag !== undefined &&
    values.tag !== "work" &&
    values.tag !== "personal"
  ) {
    throw new Error('tag must be either "work" or "personal".');
  }
  if (
    values.status !== undefined &&
    values.status !== "waiting" &&
    values.status !== "snoozed" &&
    values.status !== "replied" &&
    values.status !== "dismissed" &&
    values.status !== "all"
  ) {
    throw new Error(
      'status must be "waiting", "snoozed", "replied", "dismissed", or "all".',
    );
  }
  const tag = values.tag as ItemTag | undefined;
  const query =
    typeof values.query === "string" ? values.query.trim().toLowerCase() : "";
  const statusFilter = (values.status as FollowupStatus | "all" | undefined) ??
    undefined;
  const now = Date.now();
  const followups = getFollowups().filter((followup) => {
    if (tag && followup.tag !== tag) {
      return false;
    }
    if (statusFilter === "all") {
      // include every status
    } else if (statusFilter) {
      if (followup.status !== statusFilter) {
        return false;
      }
    } else if (
      followup.status !== "waiting" &&
      followup.status !== "snoozed" &&
      followup.status !== "replied"
    ) {
      return false;
    }
    if (query) {
      const haystack = `${followup.recipient} ${followup.subject}`.toLowerCase();
      if (!haystack.includes(query)) {
        return false;
      }
    }
    return true;
  });

  if (followups.length === 0) {
    return "No matching email follow-ups.";
  }

  return JSON.stringify(
    followups.map((followup) => ({
      id: followup.id,
      recipient: followup.recipient,
      subject: followup.subject,
      tag: followup.tag,
      account: followup.google_account,
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
