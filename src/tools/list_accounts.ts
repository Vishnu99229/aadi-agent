import type { LlmTool } from "../llm.js";
import { formatAccountsList } from "../accounts.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "list_accounts",
  description:
    "List tracked Epicode deals/accounts, most stale first (least recent activity). Each line has id, name, partner/end-client, stage, and last activity date.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

export function handler(_input: unknown): string {
  return formatAccountsList();
}
