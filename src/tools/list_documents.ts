import type { LlmTool } from "../llm.js";
import { listDocuments } from "../db.js";
import { attachmentKindFromMime } from "../document_types.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

function kindLabel(fileName: string): string {
  const kind = attachmentKindFromMime(fileName);
  switch (kind) {
    case "pdf":
      return "PDF";
    case "docx":
      return "DOCX";
    case "xlsx":
      return "XLSX";
    case "image":
      return "image";
    default:
      return "file";
  }
}

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "list_documents",
  description:
    "List recent stored uploads (id, filename, kind, uploaded_at), newest first. Use when an earlier document is not in the recent-upload context (rows live 7 days). Then call read_document with the id. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: `How many to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
      },
    },
    required: [],
  },
};

export function handler(input: unknown): string {
  const values = input as { limit?: unknown };
  let limit = DEFAULT_LIMIT;
  if (values.limit !== undefined) {
    if (
      typeof values.limit !== "number" ||
      !Number.isFinite(values.limit) ||
      values.limit < 1
    ) {
      throw new Error(`limit must be a number from 1 to ${MAX_LIMIT}.`);
    }
    limit = Math.min(MAX_LIMIT, Math.floor(values.limit));
  }
  const rows = listDocuments(limit);
  if (rows.length === 0) {
    return "No stored documents in the last 7 days.";
  }
  return rows
    .map(
      (row) =>
        `id ${row.id} — "${row.file_name}" (${kindLabel(row.file_name)}), uploaded_at ${row.created_at}`,
    )
    .join("\n");
}
