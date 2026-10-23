import type { LlmTool } from "../llm.js";
import { ingestDocumentBytes, ingestDocumentText } from "../documents.js";
import {
  extractDriveFileId,
  fetchDriveFile,
  type DriveFetchResult,
} from "../google/drive.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "read_drive_file",
  description:
    "Read a Google Drive file (Google Doc, Google Sheet, Google Slides, PDF, DOCX or XLSX) by URL or file id, store it in the documents table, and return the document id so later follow-up questions can use read_document or learn_qa_bank.",
  inputSchema: {
    type: "object",
    properties: {
      file_url: {
        type: "string",
        description:
          "A Google Drive, Docs, Sheets or Slides URL. Takes precedence over file_id when both are given.",
      },
      file_id: {
        type: "string",
        description:
          "The raw Drive file id. Use this when you already have the id (no URL).",
      },
      tag: {
        type: "string",
        enum: ["work", "personal"],
        description:
          'Which bucket the stored document falls under. Default "work".',
      },
      account: {
        type: "string",
        enum: ["work", "personal"],
        description:
          'Which Google account to fetch the file with. Default "work" — Vishnu only authenticates the work account for Drive.',
      },
    },
  },
};

export async function handler(input: unknown): Promise<string> {
  const values = input as {
    file_url?: unknown;
    file_id?: unknown;
    tag?: unknown;
    account?: unknown;
  };
  const url = typeof values.file_url === "string" ? values.file_url : "";
  const rawId = typeof values.file_id === "string" ? values.file_id : "";
  const tag = values.tag === "personal" ? "personal" : "work";
  const account = values.account === "personal" ? "personal" : "work";

  const fileId = url
    ? extractDriveFileId(url)
    : rawId
      ? extractDriveFileId(rawId)
      : undefined;
  if (!fileId) {
    throw new Error(
      "Could not find a Google Drive file id in file_url or file_id.",
    );
  }

  let fetched: DriveFetchResult;
  try {
    fetched = await fetchDriveFile(fileId, account);
  } catch (error) {
    const err = error as { code?: number; status?: number; message?: string };
    const code = err.code ?? err.status;
    if (code === 404) {
      throw new Error(`Drive file ${fileId} was not found or isn't shared with your account.`);
    }
    if (code === 403) {
      throw new Error(`Drive denied access to ${fileId}. Make sure it is shared with your Google account.`);
    }
    throw new Error(
      `Drive fetch failed: ${err.message ?? "unknown error"}`,
    );
  }

  if (fetched.text !== undefined) {
    const ingested = await ingestDocumentText({
      fileName: fetched.fileName,
      text: fetched.text,
      tag,
      hint: `Google Drive (${fetched.mimeType})`,
    });
    return JSON.stringify({
      document_id: ingested.documentId,
      file_name: fetched.fileName,
      source: "google-drive",
      exported_as: fetched.ingestMimeType,
      summary: ingested.reply,
    });
  }

  if (!fetched.bytes || fetched.bytes.byteLength === 0) {
    throw new Error(`Drive file ${fileId} returned no content.`);
  }

  const ingested = await ingestDocumentBytes({
    fileName: fetched.fileName,
    mimeType: fetched.ingestMimeType,
    bytes: fetched.bytes,
    tag,
    hint: `Google Drive (${fetched.mimeType})`,
  });
  return JSON.stringify({
    document_id: ingested.documentId,
    file_name: fetched.fileName,
    source: "google-drive",
    mime_type: fetched.ingestMimeType,
    summary: ingested.reply,
  });
}
