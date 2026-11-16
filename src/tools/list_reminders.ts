import type { LlmTool } from "../llm.js";
import {
  getReminders,
  type ItemTag,
  type ReminderStatus,
} from "../db.js";
import { reminderIsIgnored } from "../ignore.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "list_reminders",
  description:
    "List matching reminders. Optional tag and status. Use before cancel_reminder.",
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
      include_ignored: {
        type: "boolean",
        description:
          "Include reminders Vishnu asked to ignore. Default false.",
      },
    },
    required: [],
  },
};

export function handler(input: unknown): string {
  const values = input as {
    tag?: unknown;
    status?: unknown;
    include_ignored?: unknown;
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

  const includeIgnored = values.include_ignored === true;
  const reminders = getReminders().filter(
    (reminder) =>
      (!tag || reminder.tag === tag) &&
      (!status || reminder.status === status) &&
      (includeIgnored || !reminderIsIgnored(reminder)),
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
