import type { LlmTool } from "../llm.js";
import { searchDriveFiles } from "../google/drive.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "search_drive",
  description:
    "Search Vishnu's Google Drive by filename (case-insensitive). Returns up to 5 files with their webViewLink; use read_drive_file on a webViewLink to ingest a hit.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Keywords that should appear in the filename, for example 'Epicode RFP'.",
      },
    },
    required: ["query"],
  },
};

export async function handler(input: unknown): Promise<string> {
  const values = input as { query?: unknown };
  if (typeof values.query !== "string" || !values.query.trim()) {
    throw new Error("query must be a non-empty string.");
  }
  const hits = await searchDriveFiles(values.query.trim(), 5);
  if (hits.length === 0) {
    return JSON.stringify({ matches: [] });
  }
  return JSON.stringify({
    matches: hits.map((hit) => ({
      id: hit.id,
      name: hit.name,
      mime_type: hit.mimeType,
      web_view_link: hit.webViewLink,
      modified_time: hit.modifiedTime,
    })),
  });
}
