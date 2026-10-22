import type { LlmTool } from "../llm.js";
import { searchQaBank } from "../db.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "search_qa_bank",
  description:
    "Search the shared Q&A bank for past answers to RFP or questionnaire questions. Returns the top 3 matches with their source document.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "The question to look up. Keywords from the question work best.",
      },
    },
    required: ["query"],
  },
};

export function handler(input: unknown): string {
  const values = input as { query?: unknown };
  const query = typeof values.query === "string" ? values.query.trim() : "";
  if (!query) {
    throw new Error("query must be a non-empty string.");
  }
  const rows = searchQaBank(query, 3);
  if (rows.length === 0) {
    return "No past answer found, needs manual input.";
  }
  return rows
    .map((row) => {
      const source = row.source_doc ? ` (source: ${row.source_doc})` : "";
      return `Q: ${row.question}\nA: ${row.answer}${source}`;
    })
    .join("\n\n");
}
