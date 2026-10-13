import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { runAgent } from "../src/agent.ts";
import { createDocument, updateDocument } from "../src/db.ts";
import {
  analyzePdf,
  formatDocumentReply,
  transcribePdfVisibleText,
  trimPdfToMaxPages,
  MAX_PDF_PAGES,
} from "../src/document_llm.ts";
import { composedSummaryText, extractPdfText } from "../src/pdf_text.ts";
import { recordRecentUpload } from "../src/recent_upload.ts";
import { handler as readDocument } from "../src/tools/read_document.ts";

const fixturesDir = fileURLToPath(new URL("../test-fixtures/", import.meta.url));
const files = (await readdir(fixturesDir)).filter((name) =>
  name.toLowerCase().endsWith(".pdf"),
);
if (files.length === 0) {
  console.error("No PDF found in test-fixtures/.");
  process.exit(1);
}
const fileName = files.sort()[0]!;
const bytes = new Uint8Array(await readFile(join(fixturesDir, fileName)));
console.log(`File: ${fileName} (${(bytes.byteLength / 1024 / 1024).toFixed(2)} MB)`);

const record = createDocument(fileName, "personal", "", null);
recordRecentUpload(record.id, fileName, "PDF");

const trimmed = await trimPdfToMaxPages(bytes, MAX_PDF_PAGES);
const pageCount = Math.min(trimmed.totalPages, MAX_PDF_PAGES);
const local = await extractPdfText(trimmed.pdf, pageCount);
console.log(
  JSON.stringify({
    has_text_layer: local.hasTextLayer,
    pages: local.pages,
    local_chars: local.text.length,
  }),
);

let storedText = local.hasTextLayer ? local.text : "";
if (storedText) {
  updateDocument(record.id, {
    tag: "personal",
    extractedText: storedText,
    pendingActionItems: null,
  });
}

const analysis = await analyzePdf(trimmed.pdf, pageCount, trimmed.truncated);
let limitedFollowup = false;
if (!storedText) {
  const transcript = await transcribePdfVisibleText(trimmed.pdf, pageCount);
  if (transcript.text.replace(/\s+/g, "").length >= 80) {
    storedText = transcript.text;
  } else {
    storedText = composedSummaryText(analysis);
    limitedFollowup = true;
  }
}

updateDocument(record.id, {
  tag: analysis.tag,
  extractedText: storedText,
  pendingActionItems:
    analysis.action_items.length > 0 ? analysis.action_items : null,
});

console.log("--- summary ---");
console.log(
  formatDocumentReply(record.id, analysis, { limitedFollowup }),
);

const summaryBlob = composedSummaryText(analysis).toLowerCase();
const laterPages = storedText
  .split(/\n(?=--- page \d+ ---)/i)
  .slice(8)
  .join("\n");
const phoneMatch = laterPages.match(
  /(?:\+\d{1,3}[\s-]?)?(?:\d[\s-]?){8,14}\d/,
);
const uniqueLine =
  laterPages
    .split("\n")
    .map((line) => line.trim())
    .find(
      (line) =>
        line.length >= 12 &&
        line.length <= 90 &&
        !summaryBlob.includes(line.toLowerCase()) &&
        !/^--- page/i.test(line) &&
        !line.includes("@"),
    ) ?? "";
const expectedSnippet = (() => {
  const phone = phoneMatch?.[0]?.trim() ?? "";
  if (phone && !summaryBlob.includes(phone.toLowerCase())) {
    return phone;
  }
  return uniqueLine.trim();
})();
const detailQuestion = phoneMatch && expectedSnippet === phoneMatch[0]?.trim()
  ? "What phone numbers are listed on the later pages of the document?"
  : uniqueLine
    ? `What does the later pages of the document say about ${uniqueLine.slice(0, 48)}?`
    : "What details appear on the later pages of the document?";
const inSummary = expectedSnippet
  ? summaryBlob.includes(expectedSnippet.toLowerCase())
  : true;
console.log("--- detail probe ---");
console.log(
  JSON.stringify({
    question: detailQuestion,
    expected_snippet: expectedSnippet,
    in_summary: inSummary,
    stored_chars: storedText.length,
    limited_followup: limitedFollowup,
  }),
);

const viaTool = readDocument({
  id: record.id,
  question: detailQuestion,
});
console.log("--- read_document excerpt ---");
console.log(viaTool.slice(0, 600));

const answer = await runAgent(detailQuestion, {
  saveUserMessage: false,
  saveAssistantMessage: false,
});
console.log(`--- follow-up: ${detailQuestion} ---`);
console.log(answer);
if (!expectedSnippet) {
  console.error("Could not find a later-page detail to test.");
  process.exit(1);
}
if (inSummary) {
  console.error("Chosen detail was also in the summary.");
  process.exit(1);
}
if (!answer.toLowerCase().includes(expectedSnippet.toLowerCase())) {
  console.error(`Expected answer to mention ${expectedSnippet}`);
  process.exit(1);
}
console.log("Detail follow-up passed.");
