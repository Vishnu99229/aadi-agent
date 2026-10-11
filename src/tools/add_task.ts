import type { LlmTool } from "../llm.js";
import { createTask, type ItemTag } from "../db.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "add_task",
  description:
    "Add a task tagged as work or personal. Convert any natural-language due date to an exact ISO 8601 datetime in Asia/Kolkata before calling. Omit due_at if the task has no deadline.",
  inputSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "The task text.",
      },
      tag: {
        type: "string",
        enum: ["work", "personal"],
        description: "Whether this task is work or personal.",
      },
      due_at: {
        type: ["string", "null"],
        description:
          "Optional exact ISO 8601 due datetime with an offset, such as 2026-10-13T09:00:00+05:30.",
      },
    },
    required: ["text", "tag"],
  },
};

function parseTag(value: unknown): ItemTag {
  if (value !== "work" && value !== "personal") {
    throw new Error('tag must be either "work" or "personal".');
  }
  return value;
}

export function handler(input: unknown): string {
  const values = input as { text?: unknown; tag?: unknown; due_at?: unknown };
  if (typeof values.text !== "string" || !values.text.trim()) {
    throw new Error("text must be a non-empty task.");
  }

  let dueAt: string | null = null;
  if (values.due_at !== undefined && values.due_at !== null) {
    if (
      typeof values.due_at !== "string" ||
      !/(?:Z|[+-]\d{2}:\d{2})$/.test(values.due_at)
    ) {
      throw new Error(
        "due_at must be an ISO 8601 datetime with a timezone offset or null.",
      );
    }
    const date = new Date(values.due_at);
    if (Number.isNaN(date.getTime())) {
      throw new Error("due_at must be a valid ISO 8601 datetime.");
    }
    dueAt = date.toISOString();
  }

  const task = createTask(values.text.trim(), parseTag(values.tag), dueAt);
  console.log(`Task ${task.id}: status -> open`);
  return JSON.stringify({
    id: task.id,
    tag: task.tag,
    due_at: task.due_at,
    status: task.status,
  });
}
