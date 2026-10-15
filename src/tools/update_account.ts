import type { LlmTool } from "../llm.js";
import { getAccount, updateAccount } from "../db.js";
import {
  findAccountByName,
  parseRelationship,
  parseStringList,
  parseWaitingOn,
} from "../account_logic.js";
import { decodedAccounts } from "../accounts.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "update_account",
  description:
    "Update a tracked Epicode account. Call only when Vishnu asked. Never change stage or next step from email/notes on your own.",
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
      people: {
        type: "string",
        description: "People involved, display only, not used for matching.",
      },
      relationship: { type: "string", enum: ["partner", "end_client"] },
      via_partner: {
        type: "string",
        description: "Partner account name when this is an end client.",
      },
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
    people?: unknown;
    relationship?: unknown;
    via_partner?: unknown;
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
  let viaPartnerId: number | null | undefined;
  if (typeof values.via_partner === "string" && values.via_partner.trim()) {
    const matches = findAccountByName(
      decodedAccounts(),
      values.via_partner.trim(),
    ).filter((item) => item.relationship === "partner" && item.id !== id);
    if (matches.length === 0) {
      return JSON.stringify({
        updated: false,
        reason: "partner_not_found",
      });
    }
    if (matches.length > 1) {
      return JSON.stringify({
        updated: false,
        reason: "partner_ambiguous",
        found: matches.map((item) => `#${item.id} ${item.name}`),
      });
    }
    viaPartnerId = matches[0]!.id;
  } else if (values.via_partner === null || values.via_partner === "") {
    viaPartnerId = null;
  }
  const relationship =
    values.relationship === undefined
      ? undefined
      : parseRelationship(values.relationship);
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
    people:
      values.people === undefined
        ? undefined
        : JSON.stringify(parseStringList(values.people)),
    relationship,
    viaPartnerId,
  });
  console.log(`Account ${id}: updated`);
  return JSON.stringify({
    id: updated?.id,
    name: updated?.name,
    relationship: updated?.relationship,
    via_partner_id: updated?.via_partner_id,
    stage: updated?.stage,
    next_step: updated?.next_step,
    next_step_due: updated?.next_step_due,
    waiting_on: updated?.waiting_on,
    updated: true,
  });
}
