import type { LlmTool } from "../llm.js";
import { discardPendingDraftByText } from "../approvals.js";
import type { ToolTurn } from "./index.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "discard_pending_draft",
  description:
    "Discard one pending email draft Vishnu already saw on its card. Pass draft_id from the pending-draft list. Deletes the Gmail draft and drops it from the pending set. Use for 'discard the others' or 'discard the Sujoy ones' by calling once per matching id. Never invent an id.",
  inputSchema: {
    type: "object",
    properties: {
      draft_id: {
        type: "string",
        description:
          "Gmail draft ID from the pending-draft list in context. Required.",
      },
    },
    required: ["draft_id"],
  },
};

export async function handler(input: unknown, turn: ToolTurn): Promise<string> {
  if (!turn.confirmation) {
    return "Not discarded: only Vishnu's own chat message can discard a draft.";
  }
  const draftId =
    typeof input === "object" &&
    input !== null &&
    "draft_id" in input &&
    typeof (input as { draft_id?: unknown }).draft_id === "string"
      ? (input as { draft_id: string }).draft_id.trim()
      : "";
  if (!draftId) {
    return "Not discarded: pass draft_id from the pending-draft list in your context.";
  }
  const result = await discardPendingDraftByText(turn.confirmation, draftId);
  return result.message;
}
