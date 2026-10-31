import "dotenv/config";

process.env.AADI_DB_PATH ??= ":memory:";

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { getDocument } from "../src/db.ts";
import { sanitizeActionItems } from "../src/document_llm.ts";
import {
  documentFailureReply,
  documentKeyboard,
  ingestDocumentBytes,
} from "../src/documents.ts";
import {
  setCompleteForTests,
  type CompleteParams,
  type CompleteResult,
  type LlmContentPart,
} from "../src/llm.ts";
import { extractPdfText } from "../src/pdf_text.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const TEXT_MARKER = "AADI TEXT PDF MARKER LIABILITY CAP";
const SCAN_MARKER =
  "SCANNED PDF TRANSCRIPT MARKER from the image layer with enough letters";
const SAMPLE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function fakeResult(text: string): CompleteResult {
  return {
    textParts: [text],
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 },
    stopReason: "end_turn",
  };
}

function analysisJson(summary: string): string {
  return JSON.stringify({
    tag: "personal",
    document_type: "note",
    summary_bullets: [summary],
    dates: [],
    money: [],
    risks: [],
    action_items: [],
  });
}

function userParts(params: CompleteParams): LlmContentPart[] {
  const user = params.messages[0];
  if (user?.role !== "user" || !Array.isArray(user.content)) {
    return [];
  }
  return user.content;
}

function userText(params: CompleteParams): string {
  const user = params.messages[0];
  if (user?.role !== "user") {
    return "";
  }
  if (typeof user.content === "string") {
    return user.content;
  }
  return user.content
    .filter((part): part is Extract<LlmContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

async function buildTextPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  for (let line = 0; line < 8; line += 1) {
    page.drawText(TEXT_MARKER, {
      x: 48,
      y: 720 - line * 18,
      size: 14,
      font,
      color: rgb(0, 0, 0),
    });
  }
  return new Uint8Array(await doc.save());
}

async function buildScannedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const png = await doc.embedPng(Buffer.from(SAMPLE_PNG_BASE64, "base64"));
  const page = doc.addPage([612, 792]);
  page.drawImage(png, { x: 40, y: 40, width: 200, height: 200 });
  return new Uint8Array(await doc.save());
}

assert(
  documentFailureReply(
    new Error(
      '400 {"type":"error","error":{"message":"Your credit balance is too low to access the Anthropic API."}}',
    ),
  ) === "I extracted the file but couldn't analyse it: Anthropic credit is too low.",
  "credit error names the cause",
);
assert(
  documentFailureReply(new Error("Telegram download failed with HTTP 404.")) ===
    "I couldn't download that file. Try sending it again.",
  "download error names the cause",
);
assert(
  documentFailureReply(new Error("No text found — is it a scanned PDF?")) ===
    "No text found — is it a scanned PDF?",
  "empty scan names the cause",
);
assert(
  documentFailureReply(new Error("The operation was aborted due to timeout")) ===
    "Reading that file timed out. Try sending it again.",
  "timeout names the cause",
);

const textBytes = await buildTextPdf();
const scannedBytes = await buildScannedPdf();

const textExtract = await extractPdfText(textBytes);
assert(textExtract.hasTextLayer === true, "text PDF has a real text layer");
assert(textExtract.text.includes(TEXT_MARKER), "pdfjs extracted the drawn text");

const scanExtract = await extractPdfText(scannedBytes);
assert(scanExtract.hasTextLayer === false, "image-only PDF has no text layer");

const calls: CompleteParams[] = [];
setCompleteForTests(async (params: CompleteParams) => {
  calls.push(params);
  const blob = userText(params);
  if (/Transcribe all readable text/i.test(blob)) {
    return fakeResult(`--- page 1 ---\n${SCAN_MARKER} ${SCAN_MARKER}`);
  }
  return fakeResult(analysisJson("Summarised from extracted PDF text."));
});

const textIngest = await ingestDocumentBytes({
  fileName: "note.pdf",
  mimeType: "application/pdf",
  bytes: textBytes,
  tag: "personal",
});
const textRow = getDocument(textIngest.documentId);
assert(textRow !== undefined, "text PDF stored a document row");
assert(
  (textRow?.extracted_text ?? "").includes(TEXT_MARKER),
  "text PDF saved pdfjs output, not a mocked extract",
);
assert(
  textIngest.reply.includes("Summarised from extracted PDF text."),
  "text PDF analysis reply used the model output",
);
assert(
  calls.some((call) => userText(call).includes(TEXT_MARKER)),
  "analysis saw the real extracted text",
);
assert(
  !calls.some((call) => userParts(call).some((part) => part.type === "document")),
  "text PDF does not send the PDF bytes to the model",
);

calls.length = 0;
const scanIngest = await ingestDocumentBytes({
  fileName: "scan.pdf",
  mimeType: "application/pdf",
  bytes: scannedBytes,
  tag: "personal",
});
const scanRow = getDocument(scanIngest.documentId);
assert(scanRow !== undefined, "scanned PDF stored a document row");
assert(
  (scanRow?.extracted_text ?? "").includes("SCANNED PDF TRANSCRIPT MARKER"),
  "scanned PDF stored the transcription",
);
assert(
  scanIngest.reply.includes("Summarised from extracted PDF text."),
  "scanned PDF analysis reply used the model output",
);
assert(
  calls.some((call) =>
    userParts(call).some((part) => part.type === "document"),
  ),
  "scanned PDF transcription used the real PDF bytes",
);
assert(
  calls.some((call) => /Transcribe all readable text/i.test(userText(call))),
  "scanned PDF ran the transcription prompt",
);

assert(
  sanitizeActionItems([
    { text: ";;;;", tag: "personal", due_at: null },
    { text: "   ", tag: "work", due_at: null },
    { text: "", tag: "personal", due_at: null },
    { text: "...", tag: "personal", due_at: null },
    "!!!",
    {
      text: "File the GST return",
      tag: "work",
      due_at: "2026-11-01T10:00:00+05:30",
    },
  ]).map((item) => item.text).join("|") === "File the GST return",
  "sanitize drops empty, whitespace, and punctuation-only action items",
);
assert(sanitizeActionItems([]).length === 0, "empty action_items stays []");

function keyboardLabels(addTasks: boolean): string[] {
  return documentKeyboard(99, addTasks)
    .inline_keyboard.flat()
    .map((button) => ("text" in button ? String(button.text) : ""));
}
assert(
  keyboardLabels(false).join("|") === "Skip",
  "no valid action items → Skip only",
);
assert(
  keyboardLabels(true).join("|") === "Add as tasks|Skip",
  "valid action items → Add as tasks and Skip",
);

setCompleteForTests(async () =>
  fakeResult(
    JSON.stringify({
      tag: "personal",
      document_type: "note",
      summary_bullets: ["Junk actions"],
      dates: [],
      money: [],
      risks: [],
      action_items: [
        { text: ";;;;", tag: "personal", due_at: null },
        { text: "  ", tag: "work", due_at: null },
      ],
    }),
  ),
);
const junkIngest = await ingestDocumentBytes({
  fileName: "junk.pdf",
  mimeType: "application/pdf",
  bytes: textBytes,
  tag: "personal",
});
assert(
  junkIngest.pendingActionItems === null,
  "junk-only action_items do not queue Add as tasks",
);

setCompleteForTests(async () =>
  fakeResult(
    JSON.stringify({
      tag: "work",
      document_type: "note",
      summary_bullets: ["Has a real task"],
      dates: [],
      money: [],
      risks: [],
      action_items: [
        { text: ";;;;", tag: "personal", due_at: null },
        {
          text: "Send the signed NDA",
          tag: "work",
          due_at: "2026-11-02T09:00:00+05:30",
        },
      ],
    }),
  ),
);
const mixedIngest = await ingestDocumentBytes({
  fileName: "mixed.pdf",
  mimeType: "application/pdf",
  bytes: textBytes,
  tag: "personal",
});
assert(
  mixedIngest.pendingActionItems?.length === 1 &&
    mixedIngest.pendingActionItems[0]?.text === "Send the signed NDA",
  "valid action item is kept after sanitising junk",
);

setCompleteForTests(undefined);
console.log(
  `test-pdf-ingest: ok text_chars=${textExtract.text.length} scan_layer=${scanExtract.hasTextLayer} text_id=${textIngest.documentId} scan_id=${scanIngest.documentId}`,
);
