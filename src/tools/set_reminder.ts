import type { LlmTool } from "../llm.js";
import {
  createReminder,
  type ItemTag,
  type ReminderRecurrence,
} from "../db.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "set_reminder",
  description:
    "Set a tagged reminder. Call get_current_time first, then pass the next ISO 8601 datetime in Asia/Kolkata. Past times are rejected.",
  inputSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "The reminder text.",
      },
      tag: {
        type: "string",
        enum: ["work", "personal"],
        description: "Whether this reminder is work or personal.",
      },
      remind_at: {
        type: "string",
        description:
          "The next exact ISO 8601 reminder datetime with offset, such as 2026-10-13T09:00:00+05:30.",
      },
      recurrence: {
        type: "string",
        enum: ["none", "daily", "weekly", "weekdays"],
        description: "How the reminder repeats. Defaults to none.",
      },
    },
    required: ["text", "tag", "remind_at"],
  },
};

function parseTag(value: unknown): ItemTag {
  if (value !== "work" && value !== "personal") {
    throw new Error('tag must be either "work" or "personal".');
  }
  return value;
}

function parseRecurrence(value: unknown): ReminderRecurrence {
  if (value === undefined) {
    return "none";
  }
  if (
    value !== "none" &&
    value !== "daily" &&
    value !== "weekly" &&
    value !== "weekdays"
  ) {
    throw new Error(
      'recurrence must be "none", "daily", "weekly", or "weekdays".',
    );
  }
  return value;
}

export function handler(input: unknown): string {
  const values = input as {
    text?: unknown;
    tag?: unknown;
    remind_at?: unknown;
    recurrence?: unknown;
  };
  if (typeof values.text !== "string" || !values.text.trim()) {
    throw new Error("text must be a non-empty reminder.");
  }
  if (
    typeof values.remind_at !== "string" ||
    !/(?:Z|[+-]\d{2}:\d{2})$/.test(values.remind_at)
  ) {
    throw new Error(
      "remind_at must be an exact ISO 8601 datetime with a timezone offset.",
    );
  }

  const remindAt = new Date(values.remind_at);
  if (Number.isNaN(remindAt.getTime())) {
    throw new Error("remind_at must be a valid ISO 8601 datetime.");
  }
  if (remindAt.getTime() <= Date.now()) {
    throw new Error(
      "remind_at is in the past. Call get_current_time and choose a future Asia/Kolkata datetime.",
    );
  }

  const reminder = createReminder(
    values.text.trim(),
    parseTag(values.tag),
    remindAt.toISOString(),
    parseRecurrence(values.recurrence),
  );
  console.log(`Reminder ${reminder.id}: status -> pending`);
  return JSON.stringify({
    id: reminder.id,
    tag: reminder.tag,
    remind_at: reminder.remind_at,
    recurrence: reminder.recurrence,
    status: reminder.status,
  });
}
