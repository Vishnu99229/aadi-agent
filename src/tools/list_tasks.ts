import type { LlmTool } from "../llm.js";
import {
  getTasks,
  type ItemTag,
  type TaskStatus,
} from "../db.js";

const TIME_ZONE = "Asia/Kolkata";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "list_tasks",
  description:
    "List ALL matching tasks (no time window). Optionally filter by work/personal tag, open/done status, and an exact Asia/Kolkata due date (YYYY-MM-DD). Omit due_date when looking a task up to complete or delete it.",
  inputSchema: {
    type: "object",
    properties: {
      tag: {
        type: "string",
        enum: ["work", "personal"],
        description: "Optional task tag filter.",
      },
      status: {
        type: "string",
        enum: ["open", "done"],
        description: "Optional task status filter.",
      },
      due_date: {
        type: "string",
        description:
          "Optional Asia/Kolkata calendar date formatted YYYY-MM-DD.",
      },
    },
    required: [],
  },
};

function dateInKolkata(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

export function handler(input: unknown): string {
  const values = input as {
    tag?: unknown;
    status?: unknown;
    due_date?: unknown;
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
    values.status !== "open" &&
    values.status !== "done"
  ) {
    throw new Error('status must be either "open" or "done".');
  }
  const tag =
    values.tag === "work" || values.tag === "personal"
      ? (values.tag as ItemTag)
      : undefined;
  const status =
    values.status === "open" || values.status === "done"
      ? (values.status as TaskStatus)
      : undefined;

  if (
    values.due_date !== undefined &&
    (typeof values.due_date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(values.due_date))
  ) {
    throw new Error("due_date must be formatted YYYY-MM-DD.");
  }

  const tasks = getTasks().filter(
    (task) =>
      (!tag || task.tag === tag) &&
      (!status || task.status === status) &&
      (!values.due_date ||
        (task.due_at !== null &&
          dateInKolkata(task.due_at) === values.due_date)),
  );

  if (tasks.length === 0) {
    return "No matching tasks.";
  }

  return tasks
    .map(
      (task) =>
        `#${task.id} [${task.status}] (${task.tag}) ${task.text}${
          task.due_at ? ` — due ${task.due_at}` : ""
        }`,
    )
    .join("\n");
}
