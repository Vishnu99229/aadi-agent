import type { LlmTool } from "../llm.js";
import { getTask, markTaskDone } from "../db.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "complete_task",
  description:
    "Mark one task done using its numeric task ID from list_tasks. This changes only the local task list.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "number",
        description: "The numeric task ID.",
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
    throw new Error("id must be a positive integer task ID.");
  }

  const task = getTask(values.id);
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
    throw new Error(`Task ${task.id} could not be completed.`);
  }

  console.log(`Task ${task.id}: status -> done`);
  return JSON.stringify({ id: task.id, tag: task.tag, status: "done" });
}
