import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InlineKeyboard, type Api, type Context } from "grammy";
import { config } from "./config.js";
import {
  createDocument,
  createTask,
  clearDocumentPendingTasks,
  deleteExpiredDocuments,
  getDocument,
  updateDocument,
  type DocumentActionItem,
} from "./db.js";
import {
  analyzeImage,
  analyzePdf,
  analyzeText,
  formatDocumentReply,
  MAX_PDF_PAGES,
  transcribePdfVisibleText,
  trimPdfToMaxPages,
  type DocumentAnalysis,
} from "./document_llm.js";
import { composedSummaryText, extractPdfText } from "./pdf_text.js";
import { recordRecentUpload } from "./recent_upload.js";

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

export async function processIncomingDocument(
  ctx: Context,
  fileName: string,
  fileId: string,
  mimeType?: string,
): Promise<number | null> {
  const lower = fileName.toLowerCase();
  const isPdf = lower.endsWith(".pdf") || mimeType === "application/pdf";
  const isDocx = lower.endsWith(".docx");
  if (!isPdf && !isDocx) {
    await ctx.reply(
      "Send a PDF, DOCX, or a photo of a document. Other formats are not supported yet.",
    );
    return null;
  }

  // Store first so follow-up questions work even if analysis fails.
  const record = createDocument(fileName, "personal", "", null);
  console.log(`Document ${record.id}: placeholder stored`);
  recordRecentUpload(
    record.id,
    fileName,
    isPdf ? "PDF" : "DOCX",
  );

  const tempDirectory = await mkdtemp(join(tmpdir(), "aadi-doc-"));
  try {
    const bytes = await downloadTelegramFile(ctx, fileId);
    let analysis: DocumentAnalysis;
    let storedText = "";
    let limitedFollowup = false;
    if (isPdf) {
      const trimmed = await trimPdfToMaxPages(bytes, MAX_PDF_PAGES);
      const local = await extractPdfText(
        trimmed.pdf,
        Math.min(trimmed.totalPages, MAX_PDF_PAGES),
      );
      if (local.hasTextLayer) {
        storedText = local.text;
        updateDocument(record.id, {
          tag: "personal",
          extractedText: storedText,
          pendingActionItems: null,
        });
        console.log(
          `Document ${record.id}: pdf text stored pages=${local.pages} chars=${storedText.length}`,
        );
      }
      analysis = await analyzePdf(
        trimmed.pdf,
        Math.min(trimmed.totalPages, MAX_PDF_PAGES),
        trimmed.truncated,
      );
      if (!storedText) {
        const transcript = await transcribePdfVisibleText(
          trimmed.pdf,
          Math.min(trimmed.totalPages, MAX_PDF_PAGES),
        );
        if (transcript.text.replace(/\s+/g, "").length >= 80) {
          storedText = transcript.text;
        } else {
          storedText =
            composedSummaryText(analysis) || extractedFallback(analysis);
          limitedFollowup = true;
        }
      }
    } else {
      const path = join(tempDirectory, "input.docx");
      await writeFile(path, bytes);
      const mammoth = await import("mammoth");
      const extracted = await mammoth.extractRawText({ path });
      storedText = extracted.value;
      updateDocument(record.id, {
        tag: "personal",
        extractedText: storedText,
        pendingActionItems: null,
      });
      analysis = await analyzeText(extracted.value, "DOCX upload");
    }

    persistAnalysis(record.id, analysis, storedText);
    const pending =
      analysis.action_items.length > 0 ? analysis.action_items : null;
    const reply = formatDocumentReply(record.id, analysis, {
      limitedFollowup,
    });
    const keyboard = pending ? documentKeyboard(record.id) : undefined;
    await ctx.reply(reply, keyboard ? { reply_markup: keyboard } : undefined);
    return record.id;
  } catch (error) {
    console.error(
      `Document ${record.id} analysis failed (${error instanceof Error ? error.message : String(error)}).`,
    );
    await ctx.reply(
      `${DOCUMENT_READ_ERROR} Your file is saved as document ${record.id}, so you can still ask me about it.`,
    );
    return record.id;
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
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
