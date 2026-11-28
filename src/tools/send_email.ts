import { sendEmailFromTool } from "../command_email.js";
import type { LlmTool } from "../llm.js";
import type { ToolTurn } from "./index.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "send_email",
  description:
    "Write an email and request delivery. The send decision may require a Send card. Use ONLY when Vishnu tells you in this message, typed or by voice in any language, to send an email or to reply to someone. It writes the email itself and checks who it goes to against this conversation's records: pass each person's name or address as you saw it (in his message, or in an email, event or contact a tool showed in this chat), never a pronoun, and what the email should say, never a body. For a structurally linked photo, pass the exact photo_address from context in both photo_address and To. The tool will post a Send card. For an existing draft, use confirm_send_pending_draft to deliver it now. For \"draft\", \"write\" or \"prepare\" use draft_new_email or draft_reply. If it says to ask Vishnu, ask him and never pick an address yourself.",
  inputSchema: {
    type: "object",
    properties: {
      photo_address: { type: "string", description: "Exact email address extracted from the photo linked to this turn. Requires a Send card." },
      to: {
        type: "array",
        items: { type: "string" },
        description: "Who to send to: each person's name, or name and company, or address, as it appears in his message or in what a tool showed in this chat. Never \"him\" or \"her\".",
      },
      cc: {
        type: "array",
        items: { type: "string" },
        description: "Only people he asked to copy, by name or address. Never add anyone else.",
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
      draft_id: {
        type: "string",
        description:
          "With send_on, when he is scheduling an existing Gmail draft (\"send this draft on Monday\"): that draft's draft_id. It must be the draft he means, in the same mailbox, addressed to the people in to and cc. The scheduled email then goes out as the draft reads, and later edits to that draft carry over. Omit it for a separate email, even to the same person.",
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
