import type { LlmTool } from "../llm.js";
import { describeContact, displayQuery } from "../contact_logic.js";
import { askWhichContact } from "../contact_questions.js";
import { resolveContact } from "../contacts.js";
import type { ToolTurn } from "./index.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "resolve_contact",
  description:
    "Find who Vishnu means by a person's name. Looks in known contacts, Gmail correspondence, calendar attendees and account records, matching a first name or a full name. Call it before you filter mail, events, accounts or sequences by a person he named. One match comes back with their address and company. If several people match, or nobody does, Vishnu is asked and the turn ends: never choose for him. Read-only: it does not approve sending to anyone.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: 'The person as Vishnu said it, e.g. "Hardik", "Hardik Singh" or "Hardik from Pinnacle".',
      },
    },
    required: ["name"],
  },
};

export async function handler(input: unknown, turn?: ToolTurn): Promise<string> {
  const name = (input as { name?: unknown }).name;
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("name must be the person's name as Vishnu said it.");
  }
  const resolution = await resolveContact(name);
  if (resolution.kind === "one") {
    const seen = resolution.contact.sources.length > 0 ? ` Seen in: ${resolution.contact.sources.join(", ")}.` : "";
    return `One match for "${displayQuery(name)}": ${describeContact(resolution.contact)}.${seen}`;
  }
  if (resolution.kind === "none" && resolution.company) {
    return `"${displayQuery(name)}" is a company on Vishnu's accounts (${resolution.company}), not one person. Search by the company name or its domain instead.`;
  }
  return askWhichContact(turn ?? {}, name, resolution);
}
