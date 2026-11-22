import type { LlmTool } from "../llm.js";
import {
  confirmationForResume,
  findActiveRulesForQuery,
  looksLikeResumeInstruction,
  negatesResume,
  NOTHING_RESUMED,
  ownerMayChangeIgnore,
  resumeAllIgnoreRules,
  resumeIgnore,
  resumeIgnoreByQuery,
} from "../ignore.js";
import type { ToolTurn } from "./index.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "resume_item",
  description:
    "Stop ignoring something Vishnu previously asked to ignore, and start tracking it again. Does not send a burst of old reminders or create duplicate tasks. For 'resume all ignored items', pass query 'all' only after listing them.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "What to resume, e.g. 'LinkedIn bills', or 'all' only if he said resume all ignored items.",
      },
      id: {
        type: "number",
        description: "Ignore rule id from list_ignored, when known.",
      },
    },
    required: [],
  },
};

export function handler(input: unknown, turn: ToolTurn): string {
  if (!ownerMayChangeIgnore(turn)) {
    return "Ignore preferences can only be changed from Vishnu's own chat or voice message.";
  }
  const ownWords = turn.userText?.trim() ?? "";
  if (ownWords && !looksLikeResumeInstruction(ownWords)) {
    return "Ignore preferences can only be changed from Vishnu's own instruction in this turn.";
  }
  const values = input as { query?: unknown; id?: unknown };
  const authRef = turn.confirmation
    ? `owner_chat:${turn.confirmation.chatId}:${turn.confirmation.messageId}`
    : "owner_chat";
  const instruction = ownWords || (typeof values.query === "string" ? values.query : "resume");
  // The one shared check: "don't resume …" changes nothing, by id, by name or all.
  if (negatesResume(ownWords || (typeof values.query === "string" ? values.query : ""))) {
    return NOTHING_RESUMED;
  }

  if (typeof values.id === "number" && Number.isSafeInteger(values.id) && values.id > 0) {
    const rule = resumeIgnore(values.id, authRef, instruction);
    if (!rule) {
      return "That ignore rule is not active.";
    }
    return confirmationForResume([rule]);
  }

  const query =
    typeof values.query === "string" && values.query.trim()
      ? values.query.trim()
      : ownWords;
  if (!query) {
    throw new Error("Provide query or id for the ignored item to resume.");
  }

  // "All" comes from his own words, not the model's query.
  const all = /\ball\b/i.test(ownWords || query);

  if (/^all$/i.test(query) || /\ball ignored\b/i.test(query)) {
    const active = findActiveRulesForQuery("");
    if (active.length === 0) {
      return "Nothing is currently ignored.";
    }
    if (active.length > 1 && !all) {
      return (
        "Resume all of these ignored items?\n" +
        active.map((rule) => `- ${rule.id}: ${rule.match_key}`).join("\n") +
        "\nSay resume all ignored items to confirm."
      );
    }
    const resumed = resumeAllIgnoreRules(authRef, instruction);
    return confirmationForResume(resumed);
  }

  const result = resumeIgnoreByQuery(query, authRef, instruction, all);
  if (result.kind === "clarify") {
    return result.question;
  }
  if (result.kind === "none") {
    return result.message;
  }
  return confirmationForResume(result.rules);
}
