import type { LlmTool } from "../llm.js";
import {
  SEARCH_HISTORY_DEFAULT_LIMIT,
  SEARCH_HISTORY_MAX_LIMIT,
  SEARCH_HISTORY_NO_MATCH,
  searchHistory,
} from "../embeddings.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "search_history",
  description:
    "Search older Telegram chat, outside the live window, by meaning. Use when Vishnu asks what was said or decided earlier. Returns nothing you should invent past.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "What to look for in past conversation, in Vishnu's words.",
      },
      limit: {
        type: "number",
        description: "How many matches to return. Default 8, maximum 20.",
      },
    },
    required: ["query"],
  },
};

export async function handler(input: unknown): Promise<string> {
  const values = input as { query?: unknown; limit?: unknown };
  if (typeof values.query !== "string" || values.query.trim() === "") {
    throw new Error("query must be a non-empty string.");
  }
  let limit = SEARCH_HISTORY_DEFAULT_LIMIT;
  if (values.limit !== undefined) {
    if (typeof values.limit !== "number" || !Number.isFinite(values.limit)) {
      throw new Error("limit must be a number.");
    }
    limit = Math.min(SEARCH_HISTORY_MAX_LIMIT, Math.max(1, Math.floor(values.limit)));
  }
  try {
    return await searchHistory(values.query, limit);
  } catch {
    console.log("search_history: provider=gemini status=error hits=0");
    return "Not searched: embedding request failed";
  }
}
