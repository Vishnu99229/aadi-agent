import type { LlmTool } from "../llm.js";
import { deleteMemory, getMemory, searchMemories } from "../db.js";
import { formatMemoryLine } from "../memory_logic.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "forget_memory",
  description:
    "Delete one memory by id, or by search when exactly one match. Never delete all.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "Memory id when known." },
      query: {
        type: "string",
        description: "Search text when the id is not known.",
      },
    },
    required: [],
  },
};

export function handler(input: unknown): string {
  const values = input as { id?: unknown; query?: unknown };
  if (
    typeof values.id === "number" &&
    Number.isSafeInteger(values.id) &&
    values.id > 0
  ) {
    if (!getMemory(values.id)) {
      throw new Error(`Memory ${values.id} was not found.`);
    }
    deleteMemory(values.id);
    return JSON.stringify({ forgotten: values.id });
  }
  if (typeof values.query !== "string" || !values.query.trim()) {
    throw new Error("Pass id or query.");
  }
  const matches = searchMemories(values.query.trim(), 10);
  if (matches.length === 0) {
    return "No matching memories.";
  }
  if (matches.length > 1) {
    return `Several memories matched; ask Vishnu which to forget:\n${matches
      .map((item) => formatMemoryLine(item))
      .join("\n")}`;
  }
  const memory = matches[0]!;
  deleteMemory(memory.id);
  return JSON.stringify({ forgotten: memory.id });
}
