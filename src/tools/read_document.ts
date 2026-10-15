import type { LlmTool } from "../llm.js";
import { getDocument } from "../db.js";
import { selectDocumentText } from "../pdf_text.js";

const MAX_CHARS = 12_000;

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "read_document",
  description:
    "Read stored text of an uploaded document by id. Include question to pick the relevant pages of a long file.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "number",
        description: "The numeric document id.",
      },
      question: {
        type: "string",
        description:
          "The follow-up question. Used to pick the most relevant pages of a long document.",
      },
    },
    required: ["id"],
  },
};

export function handler(input: unknown): string {
  const values = input as { id?: unknown; question?: unknown };
  if (
    typeof values.id !== "number" ||
    !Number.isSafeInteger(values.id) ||
    values.id <= 0
  ) {
    throw new Error("id must be a positive integer document id.");
  }
  const document = getDocument(values.id);
  if (!document) {
    throw new Error(`Document ${values.id} was not found or expired.`);
  }
  const question =
    typeof values.question === "string" ? values.question : undefined;
  const text = document.extracted_text;
  if (!text.trim()) {
    return "No extracted text is stored for this document yet.";
  }
  return selectDocumentText(text, question, MAX_CHARS);
}
