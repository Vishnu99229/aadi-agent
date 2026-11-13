import type { LlmTool } from "../llm.js";
import { isReleaseQuestion, releasePagesFirst, releaseSearchNote } from "../release_logic.js";
import { formatSearchToolResult, searchWeb } from "../web_search.js";
import type { ToolTurn } from "./index.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "web_search",
  description:
    "Search the live web for current or time-sensitive facts (news, prices, scores, anything as-of-today). Returns titles, URLs and short summaries. Always cite those sources. Do not claim a live result unless this tool succeeded. For the latest version or release of software or a protocol, call latest_release as well: search results alone often describe an older release.",
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

export async function handler(input: unknown, turn?: ToolTurn): Promise<string> {
  const values = input as { query?: unknown };
  const query = typeof values.query === "string" ? values.query.trim() : "";
  if (!query) {
    throw new Error("query must be a non-empty string.");
  }
  const outcome = await searchWeb(query);
  if (!outcome.ok || !(isReleaseQuestion(query) || isReleaseQuestion(turn?.userText ?? ""))) {
    return formatSearchToolResult(outcome);
  }
  // A release question: the project's own release pages lead, and the result
  // says the release list, not an article, decides what is latest.
  const hits = releasePagesFirst(outcome.hits);
  return `${formatSearchToolResult({ ...outcome, hits })}\n\n${releaseSearchNote(hits.map((hit) => hit.url))}`;
}
