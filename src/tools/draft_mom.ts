import type { LlmTool } from "../llm.js";
import { draftMomForNote, draftMomForQuery } from "../mom.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "draft_mom",
  description:
    'Create, but never send, a NEW Minutes of Meeting email from Vishnu\'s Epicode work account to the calendar meeting attendees (internal and external, excluding Vishnu). Use when he asks to send or draft MoM for a call. Finds the latest matching wrap-up notes. Subject is "MoM – <title> – <date>". Not a reply; do not use draft_reply. Sending requires Telegram approval.',
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          'Name, company, or meeting title, for example "Pinnacle" or "Eternal pricing".',
      },
      note_id: {
        type: "number",
        description: "Optional numeric note id when already known.",
      },
    },
    required: [],
  },
};

export async function handler(input: unknown): Promise<string> {
  const values = input as { query?: unknown; note_id?: unknown };
  if (
    typeof values.note_id === "number" &&
    Number.isSafeInteger(values.note_id) &&
    values.note_id > 0
  ) {
    return draftMomForNote(
      values.note_id,
      typeof values.query === "string" ? values.query : undefined,
    );
  }
  if (typeof values.query === "string" && values.query.trim()) {
    return draftMomForQuery(values.query.trim());
  }
  throw new Error(
    'Pass query (who the call was with) or note_id, for example query "Pinnacle".',
  );
}
