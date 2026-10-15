import type { LlmTool } from "../llm.js";
import { listMemories } from "../db.js";
import { groupedMemoryText } from "../memory_logic.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "list_memories",
  description:
    "List every long-term memory grouped by category. Use for /memory-style overviews.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

export function handler(): string {
  return groupedMemoryText(listMemories());
}
