import type { LlmTool } from "../llm.js";
import {
  applyIgnore,
  confirmationForIgnore,
  looksLikeIgnoreInstruction,
  ownerMayChangeIgnore,
  resolveIgnoreTarget,
} from "../ignore.js";
import { resolveReferentPhrase, type ReferentEntity } from "../referents.js";
import type { ToolTurn } from "./index.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "ignore_item",
  description:
    "Permanently stop tracking a bill source, task, reminder, email alert, account follow-up, calendar notification or build alert until Vishnu asks to resume. Does not mark bills paid, complete tasks, delete emails or remove CRM accounts. Default is permanent; pass expires_at only when he named a duration. If several things could match, ask which.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "His words for what to ignore, e.g. 'LinkedIn bills', 'the electricity bill task', 'AWS payment alerts'.",
      },
      entity_type: {
        type: "string",
        enum: [
          "bill",
          "task",
          "reminder",
          "date",
          "email_source",
          "account",
          "notification",
          "build",
          "calendar_event",
        ],
        description: "Set when he named the kind of thing. Omit when the query is enough.",
      },
      expires_at: {
        type: ["string", "null"],
        description:
          "ISO 8601 expiry when he asked for a temporary ignore. Omit for a permanent rule.",
      },
      tag: {
        type: "string",
        enum: ["work", "personal", "both"],
        description: "Work or personal scope. Default follows the item, or personal for bills.",
      },
    },
    required: ["query"],
  },
};

export function handler(input: unknown, turn: ToolTurn): string {
  if (!ownerMayChangeIgnore(turn)) {
    return "Ignore preferences can only be changed from Vishnu's own chat or voice message.";
  }
  const ownWords = turn.userText?.trim() ?? "";
  const chatId = turn.confirmation?.chatId;
  const referents = resolveReferentPhrase(ownWords, chatId);
  const referentEntities =
    referents.kind === "collection" || referents.kind === "indexes"
      ? referents.entities
      : referents.kind === "singular"
        ? [referents.entity]
        : [];
  const fromReferents = referentEntities.length > 0;
  if (ownWords && !looksLikeIgnoreInstruction(ownWords) && !fromReferents) {
    return "Ignore preferences can only be changed from Vishnu's own instruction in this turn.";
  }
  if (fromReferents && (looksLikeIgnoreInstruction(ownWords) || looksLikeReferentIgnore(ownWords))) {
    return applyReferentIgnores(referentEntities, ownWords, turn);
  }
  const values = input as {
    query?: unknown;
    entity_type?: unknown;
    expires_at?: unknown;
    tag?: unknown;
  };
  if (typeof values.query !== "string" || !values.query.trim()) {
    throw new Error("query must be a non-empty string.");
  }
  const query = values.query.trim();
  const resolved = resolveIgnoreTarget(ownWords || query);
  if (resolved.kind === "clarify") {
    return resolved.question;
  }
  if (resolved.kind === "none") {
    return resolved.message;
  }
  const chosen = resolved.input;
  if (typeof values.entity_type === "string" && values.entity_type) {
    chosen.entityType = values.entity_type as typeof chosen.entityType;
  }
  if (values.tag === "work" || values.tag === "personal" || values.tag === "both") {
    chosen.tag = values.tag;
  }
  if (typeof values.expires_at === "string" && values.expires_at.trim()) {
    chosen.duration = "temporary";
    chosen.expiresAt = values.expires_at.trim();
  }
  const result = applyIgnore({
    ...chosen,
    instruction: ownWords || query,
    authRef: authRefFor(turn),
  });
  console.log(
    `Ignore rule ${result.rule.id}: ${result.duplicate ? "duplicate" : "created"} ` +
      `${result.rule.entity_type}/${result.rule.match_key}`,
  );
  return confirmationForIgnore(result, resolved.label);
}

function authRefFor(turn: ToolTurn): string {
  const confirmation = turn.confirmation;
  if (!confirmation) {
    return "owner_chat";
  }
  return `owner_chat:${confirmation.chatId}:${confirmation.messageId}`;
}

function looksLikeReferentIgnore(text: string): boolean {
  return /^(?:all(?:\s+of)?\s+(?:them|those|these|three|six)|\d+|them|those|it|that|this)\.?$/i.test(
    text.trim(),
  );
}

function applyReferentIgnores(
  entities: readonly ReferentEntity[],
  instruction: string,
  turn: ToolTurn,
): string {
  const lines: string[] = [];
  for (const entity of entities) {
    const entityType =
      entity.type === "event"
        ? "calendar_event"
        : entity.type === "contact"
          ? undefined
          : entity.type;
    if (!entityType) {
      continue;
    }
    const result = applyIgnore({
      entityType,
      matchKey: `${entity.matchKey ?? entity.label} ${entity.id}`,
      matchScope: "record",
      tag: entity.tag === "work" ? "work" : "personal",
      entityId: entity.id,
      instruction: instruction || entity.label,
      authRef: authRefFor(turn),
    });
    console.log(
      `Ignore rule ${result.rule.id}: ${result.duplicate ? "duplicate" : "created"} ` +
        `${result.rule.entity_type}/${result.rule.match_key}`,
    );
    lines.push(confirmationForIgnore(result, entity.label));
  }
  if (lines.length === 0) {
    return "Which item or source should I ignore? Name the bill, task, reminder or sender.";
  }
  return lines.join("\n");
}
