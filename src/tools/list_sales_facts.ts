import type { LlmTool } from "../llm.js";
import { listSalesFactsFromTool } from "../sales_facts.js";
import type { ToolTurn } from "./index.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "list_sales_facts",
  description:
    "Show every sales fact automatic follow-ups draw on: docs/sales_facts.md plus the points Vishnu added by chat. Use it when he says \"show my sales facts\" or asks what follow-ups can say.",
  inputSchema: { type: "object", properties: {} },
};

export function handler(_input: unknown, turn: ToolTurn): string {
  return listSalesFactsFromTool(turn);
}
