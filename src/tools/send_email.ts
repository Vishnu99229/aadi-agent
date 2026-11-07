import { sendEmailFromTool } from "../command_email.js";
import type { LlmTool } from "../llm.js";
import type { ToolTurn } from "./index.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "send_email",
  description:
    "Write and send an email now, with no card and no review. Use ONLY when Vishnu tells you in this message, typed or by voice in any language, to send an email or to reply to someone. It writes the email itself and finds the addresses: pass the people as he named them and what the email should say, never a body. For \"draft\", \"write\" or \"prepare\" use draft_new_email or draft_reply. If it says to ask Vishnu, ask him and never pick an address yourself.",
  inputSchema: {
    type: "object",
    properties: {
      to: {
        type: "array",
        items: { type: "string" },
        description: "Who to send to, in Vishnu's own words: a name, or name and company, or an address.",
      },
      cc: {
        type: "array",
        items: { type: "string" },
        description: "Only people he asked to copy, in his own words. Never add anyone else.",
      },
      instruction: {
        type: "string",
        description: "What the email should say, from what he told you.",
      },
      thread_id: {
        type: "string",
        description: "The Gmail thread, when he wants a reply or a follow-up. Find it with search_emails first. Omit for a new email.",
      },
      account: {
        type: "string",
        enum: ["work", "personal"],
        description: "Mailbox to send from. Defaults to work (Epicode).",
      },
      send_on: {
        type: "string",
        description: "To send later, the day as YYYY-MM-DD in IST, when he said \"on Monday\" or a date. Omit to send now.",
      },
      send_time: {
        type: "string",
        description: "With send_on, the time as HH:MM in IST, if he gave one. Defaults to 10:00.",
      },
      subject: {
        type: "string",
        description: "With send_on on a new email, a short subject. It shows on his task list and is the email's subject.",
      },
      attachment_requested: {
        type: "boolean",
        description: "True when he asked to attach or send a file, such as a deck or PDF.",
      },
    },
    required: ["to", "instruction"],
  },
};

export function handler(input: unknown, turn: ToolTurn): Promise<string> {
  return sendEmailFromTool(input, turn);
}
