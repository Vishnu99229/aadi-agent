import type { LlmTool } from "../llm.js";
import { getTask, getTasks, markTaskDone } from "../db.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "delete_task",
  description:
    "Dismiss a task so it stops appearing in list_tasks. Pass either its numeric id or a text fragment (case-insensitive) that matches the task text/tag. Use this when Vishnu says to ignore, delete, drop or remove a task.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "Task id from list_tasks." },
      query: {
        type: "string",
        description:
          "Text fragment matched case-insensitively against the task text. Use when the id isn't known.",
      },
    },
    required: [],
  },
};

function findByQuery(query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return getTasks().filter(
    (task) =>
      task.status === "open" &&
      task.text.toLowerCase().includes(needle),
  );
}

export function handler(input: unknown): string {
  const values = input as { id?: unknown; query?: unknown };
  const hasId =
    typeof values.id === "number" &&
    Number.isSafeInteger(values.id) &&
    values.id > 0;
  const hasQuery = typeof values.query === "string" && values.query.trim();

  if (!hasId && !hasQuery) {
    throw new Error("Provide either id (task id) or query (text fragment).");
  }

  let task = hasId ? getTask(values.id as number) : undefined;

  if (!task && hasQuery) {
    const matches = findByQuery(values.query as string);
    if (matches.length === 0) {
      throw new Error(
        `No open task found matching "${values.query}". Use list_tasks to see what's there.`,
      );
    }
    if (matches.length > 1) {
      return JSON.stringify({
        ambiguous: true,
        matches: matches.map((t) => ({
          id: t.id,
          text: t.text,
          tag: t.tag,
          due_at: t.due_at,
          status: t.status,
        })),
      });
    }
    task = matches[0];
  }

  if (!task) {
    throw new Error(`Task ${values.id} was not found.`);
  }

  if (task.status === "done") {
    return JSON.stringify({
      id: task.id,
      tag: task.tag,
      status: "done",
      already_done: true,
    });
  }

  if (!markTaskDone(task.id)) {
    throw new Error(`Task ${task.id} could not be dismissed.`);
  }

  console.log(`Task ${task.id}: status -> done (deleted/ignored)`);
  return JSON.stringify({ id: task.id, tag: task.tag, status: "done" });
}
