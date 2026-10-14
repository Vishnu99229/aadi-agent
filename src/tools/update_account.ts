import type { LlmTool } from "../llm.js";
import { getAccount, updateAccount } from "../db.js";
import {
  findAccountByName,
  parseStringList,
  parseWaitingOn,
} from "../account_logic.js";
import { decodedAccounts } from "../accounts.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "update_account",
  description:
    "Update an Epicode account's stage, next step, due date, waiting_on, aliases, or email domains. Call only when Vishnu explicitly asked to change it. Never update stage or next step from email or notes on your own.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "Numeric id from list_accounts." },
      name: { type: "string", description: "Account name if id is unknown." },
      stage: { type: "string" },
      next_step: { type: "string" },
      next_step_due: {
        type: ["string", "null"],
        description: "ISO 8601 datetime with offset, or null to clear.",
      },
      waiting_on: { type: "string", enum: ["me", "them", "nobody"] },
      aliases: { type: "string" },
      email_domains: { type: "string" },
    },
    required: [],
  },
};

function parseDue(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value === "") {
    return null;
  }
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error(
      "next_step_due must be an ISO 8601 datetime with a timezone offset or null.",
    );
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("next_step_due must be a valid ISO 8601 datetime.");
  }
  return date.toISOString();
}

export function handler(input: unknown): string {
  const values = input as {
    id?: unknown;
    name?: unknown;
    stage?: unknown;
    next_step?: unknown;
    next_step_due?: unknown;
    waiting_on?: unknown;
    aliases?: unknown;
    email_domains?: unknown;
  };
  let id: number | undefined;
  if (typeof values.id === "number" && Number.isSafeInteger(values.id)) {
    id = values.id;
  } else if (typeof values.name === "string" && values.name.trim()) {
    const matches = findAccountByName(decodedAccounts(), values.name.trim());
    if (matches.length === 0) {
      return JSON.stringify({ updated: false, reason: "not_found" });
    }
    if (matches.length > 1) {
      return JSON.stringify({
        updated: false,
        reason: "ambiguous",
        found: matches.map((item) => `#${item.id} ${item.name}`),
      });
    }
    id = matches[0]!.id;
  } else {
    throw new Error("Provide id or name.");
  }
  if (!getAccount(id)) {
    return JSON.stringify({ updated: false, reason: "not_found" });
  }
  const updated = updateAccount(id, {
    stage: typeof values.stage === "string" ? values.stage.trim() : undefined,
    nextStep:
      typeof values.next_step === "string" ? values.next_step.trim() : undefined,
    nextStepDue: parseDue(values.next_step_due),
    waitingOn:
      values.waiting_on === undefined
        ? undefined
        : parseWaitingOn(values.waiting_on),
    aliases:
      values.aliases === undefined
        ? undefined
        : JSON.stringify(parseStringList(values.aliases)),
    emailDomains:
      values.email_domains === undefined
        ? undefined
        : JSON.stringify(parseStringList(values.email_domains)),
  });
  console.log(`Account ${id}: updated`);
  return JSON.stringify({
    id: updated?.id,
    name: updated?.name,
    stage: updated?.stage,
    next_step: updated?.next_step,
    next_step_due: updated?.next_step_due,
    waiting_on: updated?.waiting_on,
    updated: true,
  });
}
