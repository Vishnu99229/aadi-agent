import type { LlmTool } from "../llm.js";
import { removeSalesFactFromTool } from "../sales_facts.js";
import type { ToolTurn } from "./index.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "remove_sales_fact",
  description:
    "Delete one sales fact Vishnu added by chat. Use it when he himself says \"remove sales fact <x>\". Only added facts can be removed; report the tool result as it is, and if it lists several matches, ask him which.",
  inputSchema: {
    type: "object",
    properties: {
      fact: {
        type: "string",
        description: "Words from the fact as he said them, or its number such as \"#3\".",
      },
    },
    required: ["fact"],
  },
};

export function handler(input: unknown, turn: ToolTurn): string {
  return removeSalesFactFromTool(input, turn);
}
