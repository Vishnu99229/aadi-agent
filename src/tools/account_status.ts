import type { LlmTool } from "../llm.js";
import { findAccountByName, formatAccountListLine } from "../account_logic.js";
import { buildAccountStatus, decodedAccounts } from "../accounts.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "account_status",
  description:
    "Status of one Epicode deal from work mail and notes. Does not change stage or next step.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Account name, alias, or domain.",
      },
    },
    required: ["name"],
  },
};

export async function handler(input: unknown): Promise<string> {
  const values = input as { name?: unknown };
  if (typeof values.name !== "string" || !values.name.trim()) {
    throw new Error("name must be a non-empty account name.");
  }
  const matches = findAccountByName(decodedAccounts(), values.name.trim());
  if (matches.length === 0) {
    const listed = decodedAccounts().map(formatAccountListLine);
    return listed.length
      ? `No matching account.\n${listed.join("\n")}`
      : "No accounts tracked yet.";
  }
  if (matches.length > 1) {
    return `Several accounts match. Which one?\n${matches.map(formatAccountListLine).join("\n")}`;
  }
  return buildAccountStatus(matches[0]!);
}
