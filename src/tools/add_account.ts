import type { LlmTool } from "../llm.js";
import { createAccount } from "../db.js";
import {
  findAccountByName,
  parseRelationship,
  parseStringList,
  parseWaitingOn,
  type AccountRelationship,
  type WaitingOn,
} from "../account_logic.js";
import { decodedAccounts } from "../accounts.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "add_account",
  description:
    "Add an Epicode deal/account to the tracker. relationship is partner (direct) or end_client (via a partner). End clients require via_partner. aliases and email_domains are used to match mail and notes. people is display-only (names involved, not matchers). Only call this when Vishnu asked to add or confirmed the name, domains, and contacts. Stage and next step stay empty unless he provided them.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Account or deal name." },
      aliases: {
        type: "string",
        description:
          "Optional comma-separated names used to match email and notes (company names, not partner contacts on an end client).",
      },
      email_domains: {
        type: "string",
        description:
          "Optional comma-separated email domains that belong to this account only.",
      },
      people: {
        type: "string",
        description:
          "Optional comma-separated people involved, for display only. Not used for matching.",
      },
      relationship: {
        type: "string",
        enum: ["partner", "end_client"],
        description:
          "partner = Epicode sells to them. end_client = their deal runs through a partner.",
      },
      via_partner: {
        type: "string",
        description:
          "Partner account name when relationship is end_client, e.g. Pinnacle Teleservices.",
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
    people?: unknown;
    relationship?: unknown;
    via_partner?: unknown;
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
  const relationship: AccountRelationship =
    values.relationship === undefined || values.relationship === ""
      ? values.via_partner
        ? "end_client"
        : "partner"
      : parseRelationship(values.relationship);
  let viaPartnerId: number | null = null;
  if (relationship === "end_client") {
    if (typeof values.via_partner !== "string" || !values.via_partner.trim()) {
      throw new Error("end_client accounts need via_partner (the partner account name).");
    }
    const matches = findAccountByName(
      decodedAccounts(),
      values.via_partner.trim(),
    ).filter((item) => item.relationship === "partner");
    if (matches.length === 0) {
      throw new Error(
        `No partner account matching "${values.via_partner.trim()}". Add the partner first.`,
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `Several partners match "${values.via_partner.trim()}": ${matches
          .map((item) => `#${item.id} ${item.name}`)
          .join(", ")}`,
      );
    }
    viaPartnerId = matches[0]!.id;
  }
  const account = createAccount({
    name: values.name.trim(),
    aliases: JSON.stringify(parseStringList(values.aliases)),
    emailDomains: JSON.stringify(parseStringList(values.email_domains)),
    people: JSON.stringify(parseStringList(values.people)),
    relationship,
    viaPartnerId,
    stage: typeof values.stage === "string" ? values.stage.trim() : "",
    nextStep: typeof values.next_step === "string" ? values.next_step.trim() : "",
    nextStepDue: parseDue(values.next_step_due),
    waitingOn,
  });
  console.log(`Account ${account.id}: created`);
  return JSON.stringify({
    id: account.id,
    name: account.name,
    relationship: account.relationship,
    via_partner_id: account.via_partner_id,
    stage: account.stage,
    waiting_on: account.waiting_on,
  });
}
