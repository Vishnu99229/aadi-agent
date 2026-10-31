import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InlineKeyboard, type Context } from "grammy";
import { getTaskBackend } from "./chat_backend.js";
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
import { complete, isAnthropicCreditError } from "./llm.js";
import { composedSummaryText, extractPdfText } from "./pdf_text.js";
import { recordRecentUpload } from "./recent_upload.js";
import {
  extractTextFromImage,
  OCR_MIN_CHARS,
} from "./vision_ocr.js";
import { extractSpreadsheetText } from "./xlsx_text.js";

export const DOCUMENT_READ_ERROR =
  "I couldn't read that file properly, try sending it again.";

export function documentFailureReply(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (isAnthropicCreditError(error)) {
    return "I extracted the file but couldn't analyse it: Anthropic credit is too low.";
  }
  if (
    /did not provide a file path|download failed|empty file|20 MB bot download/i.test(
      text,
    )
  ) {
    return "I couldn't download that file. Try sending it again.";
  }
  if (/no text found|scanned PDF/i.test(text)) {
    return "No text found — is it a scanned PDF?";
  }
  if (/timed out|timeout|aborted/i.test(text)) {
    return "Reading that file timed out. Try sending it again.";
  }
  if (/pdfjs|getDocument|InvalidPDF|PasswordException/i.test(text)) {
    return "I couldn't extract text from that PDF. Try sending it again.";
  }
  return DOCUMENT_READ_ERROR;
}

export const IMAGE_READ_ERROR =
  "I couldn't read the text in this image. Please type it out.";

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
  userPrompt?: string;
}): Promise<{
  documentId: number;
  reply: string;
  pendingActionItems: DocumentActionItem[] | null;
  answeredPrompt?: boolean;
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
          throw new Error("No text found — is it a scanned PDF?");
        }
      }
    } else if (kind === "docx") {
      storedText = await extractDocxText(params.bytes);
    } else if (kind === "xlsx") {
      storedText = extractSpreadsheetText(params.bytes);
    } else {
      const photo = await analyzePhotoBytes(
        params.bytes,
        imageMediaType(params.fileName, params.mimeType),
        params.userPrompt,
      );
      analysis = photo.analysis;
      storedText = analysis.extracted_text || extractedFallback(analysis);
      pagesProcessed = 1;
      if (
        params.userPrompt?.trim() &&
        photo.source === "ocr" &&
        photo.reply.trim()
      ) {
        persistAnalysis(record.id, analysis, storedText);
        return {
          documentId: record.id,
          reply: photo.reply,
          pendingActionItems:
            analysis.action_items.length > 0 ? analysis.action_items : null,
          answeredPrompt: true,
        };
      }
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
): Promise<{ documentId: number; answeredPrompt: boolean } | null> {
  if (!isSupportedAttachment(fileName, mimeType)) {
    await ctx.reply(
      "Send a PDF, DOCX, XLSX/XLS, or a photo of a document. Other formats are not supported yet.",
    );
    return null;
  }

  try {
    const userPrompt = ctx.message?.caption?.trim() ?? "";
    const bytes = await downloadTelegramFile(ctx, fileId);
    const result = await ingestDocumentBytes({
      fileName,
      mimeType,
      bytes,
      tag: "personal",
      userPrompt: userPrompt || undefined,
    });
    const keyboard = result.pendingActionItems
      ? documentKeyboard(result.documentId)
      : undefined;
    await ctx.reply(
      result.reply,
      keyboard ? { reply_markup: keyboard } : undefined,
    );
    return {
      documentId: result.documentId,
      answeredPrompt: result.answeredPrompt === true,
    };
  } catch (error) {
    console.error(
      `Document analysis failed (${error instanceof Error ? error.message : String(error)}).`,
    );
    await ctx.reply(documentFailureReply(error));
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

function ocrPrompt(extractedText: string, userPrompt?: string): string {
  const extracted = `I have extracted the following text from an image via Google Cloud Vision OCR:

<extracted_text>
${extractedText}
</extracted_text>`;
  const question = userPrompt?.trim();
  if (question) {
    return `The user asked: "${question}"

${extracted}

Answer ONLY the user's question based on this text. Do not summarize the entire document unless they asked for a summary. If the text does not contain the answer, say so briefly.`;
  }
  return `${extracted}

Based on this text, please analyze the user's intent and respond accordingly.`;
}

async function analyzeExtractedImageText(
  extractedText: string,
  userPrompt?: string,
): Promise<{ analysis: DocumentAnalysis; reply: string }> {
  const result = await complete({
    backend: getTaskBackend("chat"),
    tools: [],
    task: "document",
    system: {
      cacheable: userPrompt?.trim()
        ? "You read OCR text from a photo Vishnu sent on Telegram. Answer only his question. Plain text only. Be concise."
        : "You read OCR text from a photo Vishnu sent on Telegram. Plain text only. Be concise.",
    },
    messages: [{ role: "user", content: ocrPrompt(extractedText, userPrompt) }],
  });
  const reply = result.textParts.join("\n").trim();
  const bullets = (reply || extractedText)
    .split("\n")
    .map((line) => line.replace(/^[-•\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, 5);
  return {
    reply: reply || extractedText.slice(0, 500),
    analysis: {
      tag: "personal",
      document_type: "image",
      summary_bullets: bullets,
      dates: [],
      money: [],
      risks: [],
      action_items: [],
      extracted_text: extractedText,
      pages_processed: 1,
      truncated: false,
      fallback_summary: true,
      usage: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        estimatedCostUsd: result.usage.estimatedCostUsd,
      },
    },
  };
}

export async function analyzePhotoBytes(
  imageBytes: Uint8Array,
  mediaType: "image/jpeg" | "image/png" | "image/webp",
  userPrompt?: string,
): Promise<{
  analysis: DocumentAnalysis;
  reply: string;
  source: "ocr" | "vision-llm";
}> {
  const extractedText = await extractTextFromImage(Buffer.from(imageBytes));
  if (extractedText.trim().length > OCR_MIN_CHARS) {
    console.log(
      `Vision OCR: using extracted text chars=${extractedText.trim().length} has_prompt=${Boolean(userPrompt?.trim())}`,
    );
    const reasoned = await analyzeExtractedImageText(extractedText, userPrompt);
    return { ...reasoned, source: "ocr" };
  }
  console.log("Vision OCR: empty, falling back to vision LLM");
  const analysis = await analyzeImage(imageBytes, mediaType);
  return { analysis, reply: "", source: "vision-llm" };
}

export async function processIncomingPhoto(
  ctx: Context,
): Promise<{ documentId: number; answeredPrompt: boolean } | null> {
  const photos = ctx.message?.photo;
  if (!photos?.length) {
    return null;
  }

  const userPrompt = ctx.message?.caption?.trim() ?? "";

  // Store first so follow-up questions work even if analysis fails.
  const record = createDocument("photo-document.jpg", "personal", "", null);
  console.log(`Document ${record.id}: placeholder stored`);
  recordRecentUpload(record.id, "photo-document.jpg", "photo");

  try {
    const largest = photos[photos.length - 1]!;
    const bytes = await downloadTelegramFile(ctx, largest.file_id);
    const photo = await analyzePhotoBytes(
      bytes,
      "image/jpeg",
      userPrompt || undefined,
    );
    persistAnalysis(
      record.id,
      photo.analysis,
      photo.analysis.extracted_text || extractedFallback(photo.analysis),
    );

    const pending =
      photo.analysis.action_items.length > 0
        ? photo.analysis.action_items
        : null;
    const answeredPrompt = Boolean(userPrompt) && photo.source === "ocr";
    if (answeredPrompt) {
      const keyboard = pending ? documentKeyboard(record.id) : undefined;
      await ctx.reply(photo.reply, keyboard ? { reply_markup: keyboard } : undefined);
      return { documentId: record.id, answeredPrompt: true };
    }
    if (userPrompt) {
      // Caption still needs an answer; vision-LLM stored text for the agent.
      return { documentId: record.id, answeredPrompt: false };
    }
    const reply =
      photo.source === "ocr"
        ? `${photo.reply}\n\nDocument id: ${record.id} (use read_document for follow-ups)`
        : formatDocumentReply(record.id, photo.analysis);
    const keyboard = pending ? documentKeyboard(record.id) : undefined;
    await ctx.reply(reply, keyboard ? { reply_markup: keyboard } : undefined);
    return { documentId: record.id, answeredPrompt: false };
  } catch (error) {
    console.error(
      `Document ${record.id} analysis failed (${error instanceof Error ? error.message : String(error)}).`,
    );
    await ctx.reply(IMAGE_READ_ERROR);
    return { documentId: record.id, answeredPrompt: false };
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
