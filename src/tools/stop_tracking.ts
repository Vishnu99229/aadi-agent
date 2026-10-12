import type { LlmTool } from "../llm.js";
import {
  getFollowup,
  transitionFollowupStatus,
} from "../db.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "stop_tracking",
  description:
    "Stop tracking one email follow-up using its numeric ID from list_waiting. This does not modify or delete any Gmail message.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "number",
        description: "The numeric follow-up ID.",
      },
    },
    required: ["id"],
  },
};

export function handler(input: unknown): string {
  const values = input as { id?: unknown };
  if (
    typeof values.id !== "number" ||
    !Number.isSafeInteger(values.id) ||
    values.id <= 0
  ) {
    throw new Error("id must be a positive integer follow-up ID.");
  }

  const followup = getFollowup(values.id);
  if (!followup) {
    throw new Error(`Follow-up ${values.id} was not found.`);
  }
  if (followup.status === "dismissed") {
    return JSON.stringify({
      id: followup.id,
      status: "dismissed",
      already_dismissed: true,
    });
  }
  if (
    !transitionFollowupStatus(
      followup.id,
      ["waiting", "snoozed", "replied"],
      "dismissed",
    )
  ) {
    throw new Error(`Follow-up ${followup.id} could not be dismissed.`);
  }

  console.log(`Follow-up ${followup.id}: status -> dismissed`);
  return JSON.stringify({ id: followup.id, status: "dismissed" });
}
