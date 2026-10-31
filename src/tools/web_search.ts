import type { LlmTool } from "../llm.js";
import { formatSearchToolResult, searchWeb } from "../web_search.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "web_search",
  description:
    "Search the live web for current or time-sensitive facts (news, prices, scores, anything as-of-today). Returns titles, URLs and short summaries. Always cite those sources. Do not claim a live result unless this tool succeeded.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query. Be specific; include place or date when it matters.",
      },
    },
    required: ["query"],
  },
};

export async function handler(input: unknown): Promise<string> {
  const values = input as { query?: unknown };
  const query = typeof values.query === "string" ? values.query.trim() : "";
  if (!query) {
    throw new Error("query must be a non-empty string.");
  }
  const outcome = await searchWeb(query);
  return formatSearchToolResult(outcome);
}
