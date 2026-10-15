import type { LlmTool } from "../llm.js";
import { draftMomForNote, draftMomForQuery } from "../mom.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "draft_mom",
  description:
    'Draft a new MoM email from work mail to meeting attendees (excluding Vishnu). Not a reply. Sending needs Telegram approval.',
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
