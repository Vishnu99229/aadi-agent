import type { LlmTool } from "../llm.js";
import { cancelScheduledSendFromTool } from "../scheduled_sends.js";
import { config } from "../config.js";
import type { ToolTurn } from "./index.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "cancel_scheduled_send",
  description:
    "Cancel an email scheduled to send later, when he says \"cancel the email to X\" or \"don't send the X email\". Its task closes too and nothing is sent. Pass the name or subject he used, or \"all\". If it matches several, ask him which.",
  inputSchema: {
    type: "object",
    properties: {
      target: { type: "string", description: "The person, company or subject, as he said it, or \"all\"." },
    },
    required: ["target"],
  },
};

export function handler(input: unknown, turn: ToolTurn): string {
  if (!config.sendOnCommandEnabled) {
    return "Not cancelled: send-on-command is switched off, so nothing will go out.";
  }
  if (!turn.confirmation) {
    return "Not cancelled: only Vishnu's own message can do that.";
  }
  const values = (input ?? {}) as { target?: unknown };
  return cancelScheduledSendFromTool(typeof values.target === "string" ? values.target : "", turn);
}
