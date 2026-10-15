import type { LlmTool } from "../llm.js";
import { formatAccountsList } from "../accounts.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "list_accounts",
  description:
    "List tracked Epicode deals, most stale first. Each line: id, name, partner/end-client, stage, last activity.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

export function handler(_input: unknown): string {
  return formatAccountsList();
}
