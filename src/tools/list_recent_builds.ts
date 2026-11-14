import type { LlmTool } from "../llm.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "list_recent_builds",
  description: "List Aadi's recent code builds, newest first: number, status, request and pull request.",
  inputSchema: {
    type: "object",
    properties: { limit: { type: "integer", description: "How many, up to 15. Default 8." } },
  },
};

export async function handler(input: unknown): Promise<string> {
  const limit = Math.min(15, Math.max(1, Number((input as { limit?: unknown } | undefined)?.limit ?? 8) || 8));
  const { listBuilds } = await import("../db.js");
  const rows = listBuilds(limit);
  if (rows.length === 0) {
    return JSON.stringify({ builds: [], note: "No builds yet." });
  }
  return JSON.stringify({
    builds: rows.map((row) => ({
      build_id: row.id,
      status: row.status,
      request: row.task.replace(/\s+/g, " ").slice(0, 160),
      pr_number: row.pr_number,
      has_error: Boolean(row.error),
      updated_at: row.updated_at,
    })),
  });
}
