import type { LlmTool } from "../llm.js";
import {
  getReminders,
  type ItemTag,
  type ReminderStatus,
} from "../db.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "list_reminders",
  description:
    "List reminders, optionally filtered by work/personal tag and pending/sent/cancelled status. Results include reminder IDs for cancellation.",
  inputSchema: {
    type: "object",
    properties: {
      tag: {
        type: "string",
        enum: ["work", "personal"],
        description: "Optional reminder tag filter.",
      },
      status: {
        type: "string",
        enum: ["pending", "sent", "cancelled"],
        description: "Optional reminder status filter.",
      },
    },
    required: [],
  },
};

export function handler(input: unknown): string {
  const values = input as { tag?: unknown; status?: unknown };
  if (
    values.tag !== undefined &&
    values.tag !== "work" &&
    values.tag !== "personal"
  ) {
    throw new Error('tag must be either "work" or "personal".');
  }
  if (
    values.status !== undefined &&
    values.status !== "pending" &&
    values.status !== "sent" &&
    values.status !== "cancelled"
  ) {
    throw new Error(
      'status must be "pending", "sent", or "cancelled".',
    );
  }
  const tag =
    values.tag === "work" || values.tag === "personal"
      ? (values.tag as ItemTag)
      : undefined;
  const status =
    values.status === "pending" ||
    values.status === "sent" ||
    values.status === "cancelled"
      ? (values.status as ReminderStatus)
      : undefined;

  const reminders = getReminders().filter(
    (reminder) =>
      (!tag || reminder.tag === tag) &&
      (!status || reminder.status === status),
  );

  if (reminders.length === 0) {
    return "No matching reminders.";
  }

  return reminders
    .map(
      (reminder) =>
        `#${reminder.id} [${reminder.status}] (${reminder.tag}) ${reminder.text} — ${reminder.remind_at}${
          reminder.recurrence !== "none"
            ? ` — repeats ${reminder.recurrence}`
            : ""
        }`,
    )
    .join("\n");
}
