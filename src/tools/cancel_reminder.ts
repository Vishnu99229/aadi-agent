import type { LlmTool } from "../llm.js";
import {
  getReminder,
  transitionReminderStatus,
} from "../db.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "cancel_reminder",
  description:
    "Cancel a pending reminder using its numeric ID from list_reminders. Sent reminders cannot be cancelled.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "number",
        description: "The numeric reminder ID.",
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
    throw new Error("id must be a positive integer reminder ID.");
  }

  const reminder = getReminder(values.id);
  if (!reminder) {
    throw new Error(`Reminder ${values.id} was not found.`);
  }
  if (reminder.status === "cancelled") {
    return JSON.stringify({
      id: reminder.id,
      tag: reminder.tag,
      status: "cancelled",
      already_cancelled: true,
    });
  }
  if (reminder.status !== "pending") {
    throw new Error(`Reminder ${reminder.id} has already been sent.`);
  }
  if (!transitionReminderStatus(reminder.id, "pending", "cancelled")) {
    throw new Error(`Reminder ${reminder.id} could not be cancelled.`);
  }

  console.log(`Reminder ${reminder.id}: status -> cancelled`);
  return JSON.stringify({
    id: reminder.id,
    tag: reminder.tag,
    status: "cancelled",
  });
}
