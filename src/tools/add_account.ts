import type { LlmTool } from "../llm.js";
import { createAccount } from "../db.js";
import {
  parseStringList,
  parseWaitingOn,
  type WaitingOn,
} from "../account_logic.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "add_account",
  description:
    "Add an Epicode deal/account to the tracker. Only call this when Vishnu asked to add or confirmed the name, domains, and contacts. Stage and next step stay empty unless he provided them.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Account or deal name." },
      aliases: {
        type: "string",
        description:
          "Optional comma-separated other names or contact names used in email and notes.",
      },
      email_domains: {
        type: "string",
        description:
          "Optional comma-separated email domains, e.g. pinnacle.com, shriramlife.com.",
      },
      stage: { type: "string", description: "Optional free-text stage." },
      next_step: { type: "string" },
      next_step_due: {
        type: ["string", "null"],
        description: "Optional ISO 8601 datetime with offset, or null.",
      },
      waiting_on: {
        type: "string",
        enum: ["me", "them", "nobody"],
      },
    },
    required: ["name"],
  },
};

function parseDue(value: unknown): string | null {
  if (value === undefined || value === null || value === "") {
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
    name?: unknown;
    aliases?: unknown;
    email_domains?: unknown;
    stage?: unknown;
    next_step?: unknown;
    next_step_due?: unknown;
    waiting_on?: unknown;
  };
  if (typeof values.name !== "string" || !values.name.trim()) {
    throw new Error("name must be a non-empty account name.");
  }
  const waitingOn: WaitingOn =
    values.waiting_on === undefined || values.waiting_on === ""
      ? "nobody"
      : parseWaitingOn(values.waiting_on);
  const account = createAccount({
    name: values.name.trim(),
    aliases: JSON.stringify(parseStringList(values.aliases)),
    emailDomains: JSON.stringify(parseStringList(values.email_domains)),
    stage: typeof values.stage === "string" ? values.stage.trim() : "",
    nextStep: typeof values.next_step === "string" ? values.next_step.trim() : "",
    nextStepDue: parseDue(values.next_step_due),
    waitingOn,
  });
  console.log(`Account ${account.id}: created`);
  return JSON.stringify({
    id: account.id,
    name: account.name,
    stage: account.stage,
    waiting_on: account.waiting_on,
  });
}
