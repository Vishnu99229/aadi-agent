import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InlineKeyboard, type Context } from "grammy";
import { config } from "./config.js";
import {
  createDocument,
  createTask,
  clearDocumentPendingTasks,
  deleteExpiredDocuments,
  getDocument,
  updateDocument,
  type DocumentActionItem,
  type ItemTag,
} from "./db.js";
import {
  analyzeImage,
  analyzeText,
  formatDocumentReply,
  MAX_PDF_PAGES,
  transcribePdfVisibleText,
  trimPdfToMaxPages,
  type DocumentAnalysis,
} from "./document_llm.js";
import { reviewTypedDocument } from "./document_review.js";
import {
  attachmentKindFromMime,
  detectDocumentKind,
  isSupportedAttachment,
} from "./document_types.js";
import { composedSummaryText, extractPdfText } from "./pdf_text.js";
import { recordRecentUpload } from "./recent_upload.js";
import { extractSpreadsheetText } from "./xlsx_text.js";

export const DOCUMENT_READ_ERROR =
  "I couldn't read that file properly, try sending it again.";

const TELEGRAM_MAX_BYTES = 20 * 1024 * 1024;

function telegramFileUrl(filePath: string): string {
  const encodedPath = filePath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `https://api.telegram.org/file/bot${config.telegramBotToken}/${encodedPath}`;
}

async function downloadTelegramFile(
  ctx: Context,
  fileId: string,
): Promise<Uint8Array> {
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) {
    throw new Error("Telegram did not provide a file path.");
  }
  const response = await fetch(telegramFileUrl(file.file_path), {
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`Telegram download failed with HTTP ${response.status}.`);
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(contentLength) &&
    contentLength > TELEGRAM_MAX_BYTES
  ) {
    throw new Error("File exceeds Telegram's 20 MB bot download limit.");
  }
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.byteLength > TELEGRAM_MAX_BYTES) {
    throw new Error("File exceeds Telegram's 20 MB bot download limit.");
  }
  if (data.byteLength === 0) {
    throw new Error("Telegram returned an empty file.");
  }
  return data;
}

function documentKeyboard(documentId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("Add as tasks", `document:tasks:${documentId}`)
    .text("Skip", `document:skip:${documentId}`);
}

function persistAnalysis(
  documentId: number,
  analysis: DocumentAnalysis,
  extractedText: string,
): void {
  const pending =
    analysis.action_items.length > 0 ? analysis.action_items : null;
  updateDocument(documentId, {
    tag: analysis.tag,
    extractedText,
    pendingActionItems: pending,
  });
  console.log(
    `Document ${documentId}: stored pages=${analysis.pages_processed} fallback=${analysis.fallback_summary} chars=${extractedText.length}`,
  );
}

function imageMediaType(
  fileName: string,
  mimeType?: string,
): "image/jpeg" | "image/png" | "image/webp" {
  const mime = (mimeType ?? "").toLowerCase();
  if (mime === "image/png" || fileName.toLowerCase().endsWith(".png")) {
    return "image/png";
  }
  if (mime === "image/webp" || fileName.toLowerCase().endsWith(".webp")) {
    return "image/webp";
  }
  return "image/jpeg";
}

async function extractDocxText(bytes: Uint8Array): Promise<string> {
  const tempDirectory = await mkdtemp(join(tmpdir(), "aadi-doc-"));
  try {
    const path = join(tempDirectory, "input.docx");
    await writeFile(path, bytes);
    const mammoth = await import("mammoth");
    const extracted = await mammoth.extractRawText({ path });
    return extracted.value;
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

export async function ingestDocumentBytes(params: {
  fileName: string;
  mimeType?: string;
  bytes: Uint8Array;
  tag: ItemTag;
  hint?: string;
}): Promise<{
  documentId: number;
  reply: string;
  pendingActionItems: DocumentActionItem[] | null;
}> {
  if (!isSupportedAttachment(params.fileName, params.mimeType)) {
    throw new Error(
      "That file type isn't supported. I can read PDF, DOCX, XLSX/XLS, and images.",
    );
  }

  const kind = attachmentKindFromMime(params.fileName, params.mimeType);
  const record = createDocument(params.fileName, params.tag, "", null);
  console.log(`Document ${record.id}: placeholder stored`);
  recordRecentUpload(
    record.id,
    params.fileName,
    kind === "pdf" ? "PDF" : kind === "docx" ? "DOCX" : kind === "xlsx" ? "XLSX" : "image",
  );

  let storedText = "";
  let pagesProcessed = 0;
  let truncated = false;
  let limitedFollowup = false;
  let analysis: DocumentAnalysis | undefined;

  try {
    if (kind === "pdf") {
      const local = await extractPdfText(params.bytes);
      pagesProcessed = local.pages;
      if (local.hasTextLayer) {
        storedText = local.text;
        truncated = false;
        console.log(
          `Document ${record.id}: pdf text stored pages=${local.pages} chars=${storedText.length}`,
        );
      } else {
        const trimmed = await trimPdfToMaxPages(params.bytes, MAX_PDF_PAGES);
        truncated = trimmed.truncated;
        pagesProcessed = Math.min(trimmed.totalPages, MAX_PDF_PAGES);
        const transcript = await transcribePdfVisibleText(
          trimmed.pdf,
          pagesProcessed,
        );
        if (transcript.text.replace(/\s+/g, "").length >= 80) {
          storedText = transcript.text;
        } else {
          limitedFollowup = true;
        }
      }
    } else if (kind === "docx") {
      storedText = await extractDocxText(params.bytes);
    } else if (kind === "xlsx") {
      storedText = extractSpreadsheetText(params.bytes);
    } else {
      analysis = await analyzeImage(
        params.bytes,
        imageMediaType(params.fileName, params.mimeType),
      );
      storedText = analysis.extracted_text || extractedFallback(analysis);
      pagesProcessed = 1;
    }

    if (storedText) {
      updateDocument(record.id, {
        tag: params.tag,
        extractedText: storedText,
        pendingActionItems: null,
      });
    }

    const detected = detectDocumentKind(
      params.fileName,
      params.hint ?? "",
      storedText,
    );
    let reply: string;
    if (detected !== "other" && storedText.trim()) {
      const typed = await reviewTypedDocument(detected, storedText, record.id);
      analysis = {
        tag: params.tag,
        document_type: detected,
        summary_bullets: typed.review.summary,
        dates: [],
        money: [],
        risks:
          typed.review.kind === "contract"
            ? typed.review.pushback
            : typed.review.kind === "rfp"
              ? typed.review.check_with_team
              : [],
        action_items: [],
        extracted_text: storedText,
        pages_processed: pagesProcessed,
        truncated,
        fallback_summary: false,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0,
        },
      };
      reply = typed.reply;
      if (truncated) {
        reply += `\n\nNote: Only the first ${MAX_PDF_PAGES} pages were processed; the file was longer.`;
      }
    } else {
      if (!analysis) {
        const forAnalysis =
          storedText.length > 24_000 ? storedText.slice(0, 24_000) : storedText;
        analysis = await analyzeText(
          forAnalysis,
          params.hint || "document",
          pagesProcessed,
          truncated || storedText.length > 24_000,
        );
      }
      if (!storedText) {
        storedText =
          composedSummaryText(analysis) || extractedFallback(analysis);
        limitedFollowup = true;
      }
      persistAnalysis(record.id, analysis, storedText);
      reply = formatDocumentReply(record.id, analysis, { limitedFollowup });
      return {
        documentId: record.id,
        reply,
        pendingActionItems:
          analysis.action_items.length > 0 ? analysis.action_items : null,
      };
    }

    persistAnalysis(record.id, analysis, storedText);
    return {
      documentId: record.id,
      reply,
      pendingActionItems:
        analysis.action_items.length > 0 ? analysis.action_items : null,
    };
  } catch (error) {
    console.error(
      `Document ${record.id} analysis failed (${error instanceof Error ? error.message : String(error)}).`,
    );
    throw error;
  }
}

/** Ingest already-extracted text (e.g. a Google Doc exported as text/plain)
 *  through the same type-detection + analysis pipeline as `ingestDocumentBytes`.
 *  Writes a row to `documents` and returns the id plus a Telegram-ready reply. */
export async function ingestDocumentText(params: {
  fileName: string;
  text: string;
  tag: ItemTag;
  hint?: string;
}): Promise<{
  documentId: number;
  reply: string;
  pendingActionItems: DocumentActionItem[] | null;
}> {
  if (!params.text.trim()) {
    throw new Error("That Drive file exported no text to analyse.");
  }
  const record = createDocument(params.fileName, params.tag, "", null);
  console.log(`Document ${record.id}: placeholder stored (drive text)`);
  recordRecentUpload(record.id, params.fileName, "drive");

  const storedText = params.text;
  updateDocument(record.id, {
    tag: params.tag,
    extractedText: storedText,
    pendingActionItems: null,
  });

  const detected = detectDocumentKind(
    params.fileName,
    params.hint ?? "",
    storedText,
  );
  let analysis: DocumentAnalysis;
  let reply: string;
  if (detected !== "other") {
    const typed = await reviewTypedDocument(detected, storedText, record.id);
    analysis = {
      tag: params.tag,
      document_type: detected,
      summary_bullets: typed.review.summary,
      dates: [],
      money: [],
      risks:
        typed.review.kind === "contract"
          ? typed.review.pushback
          : typed.review.kind === "rfp"
            ? typed.review.check_with_team
            : [],
      action_items: [],
      extracted_text: storedText,
      pages_processed: 1,
      truncated: false,
      fallback_summary: false,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
      },
    };
    reply = typed.reply;
  } else {
    const forAnalysis =
      storedText.length > 24_000 ? storedText.slice(0, 24_000) : storedText;
    analysis = await analyzeText(
      forAnalysis,
      params.hint || "document",
      1,
      storedText.length > 24_000,
    );
    reply = formatDocumentReply(record.id, analysis);
  }
  persistAnalysis(record.id, analysis, storedText);
  return {
    documentId: record.id,
    reply,
    pendingActionItems:
      analysis.action_items.length > 0 ? analysis.action_items : null,
  };
}

export async function processIncomingDocument(
  ctx: Context,
  fileName: string,
  fileId: string,
  mimeType?: string,
): Promise<number | null> {
  if (!isSupportedAttachment(fileName, mimeType)) {
    await ctx.reply(
      "Send a PDF, DOCX, XLSX/XLS, or a photo of a document. Other formats are not supported yet.",
    );
    return null;
  }

  try {
    const bytes = await downloadTelegramFile(ctx, fileId);
    const result = await ingestDocumentBytes({
      fileName,
      mimeType,
      bytes,
      tag: "personal",
    });
    const keyboard = result.pendingActionItems
      ? documentKeyboard(result.documentId)
      : undefined;
    await ctx.reply(
      result.reply,
      keyboard ? { reply_markup: keyboard } : undefined,
    );
    return result.documentId;
  } catch (error) {
    console.error(
      `Document analysis failed (${error instanceof Error ? error.message : String(error)}).`,
    );
    await ctx.reply(DOCUMENT_READ_ERROR);
    return null;
  }
}

function extractedFallback(analysis: {
  summary_bullets: string[];
  dates: string[];
  money: string[];
  risks: string[];
}): string {
  return [
    ...analysis.summary_bullets,
    ...analysis.dates,
    ...analysis.money,
    ...analysis.risks,
  ].join("\n");
}

export async function processIncomingPhoto(ctx: Context): Promise<number | null> {
  const photos = ctx.message?.photo;
  if (!photos?.length) {
    return null;
  }

  // Store first so follow-up questions work even if analysis fails.
  const record = createDocument("photo-document.jpg", "personal", "", null);
  console.log(`Document ${record.id}: placeholder stored`);
  recordRecentUpload(record.id, "photo-document.jpg", "photo");

  try {
    const largest = photos[photos.length - 1]!;
    const bytes = await downloadTelegramFile(ctx, largest.file_id);
    const analysis = await analyzeImage(bytes, "image/jpeg");
    persistAnalysis(
      record.id,
      analysis,
      analysis.extracted_text || extractedFallback(analysis),
    );

    const pending =
      analysis.action_items.length > 0 ? analysis.action_items : null;
    const reply = formatDocumentReply(record.id, analysis);
    const keyboard = pending ? documentKeyboard(record.id) : undefined;
    await ctx.reply(reply, keyboard ? { reply_markup: keyboard } : undefined);
    return record.id;
  } catch (error) {
    console.error(
      `Document ${record.id} analysis failed (${error instanceof Error ? error.message : String(error)}).`,
    );
    await ctx.reply(DOCUMENT_READ_ERROR);
    return record.id;
  }
}

export async function handleDocumentCallback(
  ctx: Context,
  operation: "tasks" | "skip",
  documentId: number,
): Promise<void> {
  await ctx.answerCallbackQuery();
  const document = getDocument(documentId);
  if (!document) {
    await ctx.reply("That document is no longer available.");
    return;
  }

  if (operation === "skip") {
    clearDocumentPendingTasks(documentId);
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
    return;
  }

  if (!document.pending_action_items) {
    await ctx.reply("No pending action items for that document.");
    return;
  }

  const items = JSON.parse(
    document.pending_action_items,
  ) as DocumentActionItem[];
  const created: number[] = [];
  for (const item of items) {
    const task = createTask(item.text, item.tag, item.due_at);
    created.push(task.id);
    console.log(`Task ${task.id}: status -> open`);
  }
  clearDocumentPendingTasks(documentId);
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
  await ctx.reply(
    `Added ${created.length} task(s): ${created.map((id) => `#${id}`).join(", ")}.`,
  );
}

export function startDocumentExpirySweep(): NodeJS.Timeout {
  const removed = deleteExpiredDocumentsOnStart();
  if (removed > 0) {
    console.log(`Document expiry: removed ${removed} row(s)`);
  }
  return setInterval(() => {
    const count = deleteExpiredDocumentsOnStart();
    if (count > 0) {
      console.log(`Document expiry: removed ${count} row(s)`);
    }
  }, 24 * 60 * 60 * 1_000);
}

function deleteExpiredDocumentsOnStart(): number {
  return deleteExpiredDocuments();
}
