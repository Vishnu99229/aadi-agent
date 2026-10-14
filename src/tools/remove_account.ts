import type { LlmTool } from "../llm.js";
import { getAccount, removeAccount } from "../db.js";
import { findAccountByName, formatAccountListLine } from "../account_logic.js";
import { decodedAccounts } from "../accounts.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "remove_account",
  description:
    "Remove a tracked Epicode account. Prefer a name query; numeric id from list_accounts also works. If several match, nothing is deleted and the matches are returned.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "number" },
      name: { type: "string" },
    },
    required: [],
  },
};

export function handler(input: unknown): string {
  const values = input as { id?: unknown; name?: unknown };

  if (typeof values.id === "number" && Number.isSafeInteger(values.id) && values.id > 0) {
    if (!getAccount(values.id)) {
      return JSON.stringify({
        removed: false,
        reason: "not_found",
        found: decodedAccounts().map(formatAccountListLine),
      });
    }
    removeAccount(values.id);
    console.log(`Account ${values.id}: removed`);
    return JSON.stringify({ id: values.id, removed: true });
  }

  const query = typeof values.name === "string" ? values.name.trim() : "";
  if (!query) {
    throw new Error("Provide name or a numeric id.");
  }
  const matches = findAccountByName(decodedAccounts(), query);
  if (matches.length === 0) {
    return JSON.stringify({
      removed: false,
      reason: "not_found",
      query,
      found: decodedAccounts().map(formatAccountListLine),
    });
  }
  if (matches.length > 1) {
    return JSON.stringify({
      removed: false,
      reason: "ambiguous",
      query,
      found: matches.map(formatAccountListLine),
    });
  }
  const id = matches[0]!.id;
  removeAccount(id);
  console.log(`Account ${id}: removed`);
  return JSON.stringify({ id, name: matches[0]!.name, removed: true });
}
