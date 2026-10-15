import type { LlmTool } from "../llm.js";
import { searchMemories } from "../db.js";
import { formatMemoryLine } from "../memory_logic.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "search_memories",
  description:
    "Search long-term memories by keywords. Relevant memories are often already in context; use this when you need a broader search or a specific id.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Keywords to search. Omit to list the most recent memories.",
      },
    },
    required: [],
  },
};

export function handler(input: unknown): string {
  const values = input as { query?: unknown };
  const query = typeof values.query === "string" ? values.query : "";
  const rows = searchMemories(query, 20);
  if (rows.length === 0) {
    return "No matching memories.";
  }
  return rows.map((row) => formatMemoryLine(row)).join("\n");
}
