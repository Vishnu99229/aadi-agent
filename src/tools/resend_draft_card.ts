import type { LlmTool } from "../llm.js";
import { resendDraftCard } from "../approvals.js";
import type { ToolTurn } from "./index.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "resend_draft_card",
  description:
    "Post a fresh Telegram approval card for a pending draft Vishnu already saw. Pass draft_id from the pending-draft list. Use when he asks to 'show me the card'. Does not send the email.",
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
    return "No card posted: only Vishnu's own chat message can request the card.";
  }
  const draftId =
    typeof input === "object" &&
    input !== null &&
    "draft_id" in input &&
    typeof (input as { draft_id?: unknown }).draft_id === "string"
      ? (input as { draft_id: string }).draft_id.trim()
      : "";
  if (!draftId) {
    return "No card posted: pass draft_id from the pending-draft list in your context.";
  }
  const result = await resendDraftCard(turn.confirmation, draftId);
  return result.message;
}
