import "dotenv/config";

process.env.AADI_DB_PATH ??= ":memory:";
process.env.LLM_PROVIDER ??= "claude";
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.OWNER_TELEGRAM_ID ??= "1";
process.env.CLAUDE_MODEL ??= "claude-sonnet-5-5";
process.env.ANTHROPIC_API_KEY ??= "test-key";
process.env.BRIEF_TIME ??= "08:00";

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { runAgent, setToolInterceptorForTests } from "../src/agent.ts";
import { createDocument, getDocument } from "../src/db.ts";
import {
  looksLikeDocumentRewrite,
  documentRewriteRetryPrompt,
} from "../src/document_rewrite.ts";
import { ingestDocumentBytes } from "../src/documents.ts";
import { setCompleteForTests, type CompleteResult } from "../src/llm.ts";
import {
  RECENT_UPLOAD_WINDOW_MS,
  recordRecentUpload,
} from "../src/recent_upload.ts";
import { modelReply } from "./fakes.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

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

async function buildTextPdf(marker: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  for (let line = 0; line < 8; line += 1) {
    page.drawText(marker, {
      x: 48,
      y: 720 - line * 18,
      size: 14,
      font,
      color: rgb(0, 0, 0),
    });
  }
  return new Uint8Array(await doc.save());
}

{
  assert(RECENT_UPLOAD_WINDOW_MS === 4 * 60 * 60 * 1_000, "recent-upload window is 4 hours");
  assert(looksLikeDocumentRewrite("make it concise"), "concise");
  assert(looksLikeDocumentRewrite("shorter please"), "shorter");
  assert(looksLikeDocumentRewrite("rewrite that"), "rewrite");
  assert(looksLikeDocumentRewrite("redo it"), "redo");
  assert(looksLikeDocumentRewrite("make it tighter"), "tighter");
  assert(!looksLikeDocumentRewrite("what is the price?"), "plain question is not rewrite");
  assert(
    /Rewrite from the document/.test(documentRewriteRetryPrompt(9)),
    "nudge mentions rewrite from document",
  );
  console.log("rewrite detection + window: ok");
}

{
  let analysisCalls = 0;
  setCompleteForTests(async () => {
    analysisCalls += 1;
    return fakeResult(analysisJson("wasted summary"));
  });
  const bytes = await buildTextPdf("CAPTION PATH FIGURES 42 CRORE WHATSAPP");
  const ingested = await ingestDocumentBytes({
    fileName: "brief.pdf",
    mimeType: "application/pdf",
    bytes,
    tag: "personal",
    skipSummaryAnalysis: true,
  });
  assert(analysisCalls === 0, "captioned path must not call summary analysis LLM");
  assert(ingested.reply === "", "no template reply when summary skipped");
  assert(ingested.answeredPrompt !== true, "answeredPrompt stays false");
  const row = getDocument(ingested.documentId);
  assert(
    Boolean(row?.extracted_text.includes("CAPTION PATH")),
    "text stored for read_document",
  );
  assert(
    !/^Type:/m.test(ingested.reply) && !/Summary:/i.test(ingested.reply),
    "reply is not the summary template",
  );
  setCompleteForTests(undefined);
  console.log("captioned PDF: extract+store only, one agent reply expected upstream: ok");
}

{
  let analysisCalls = 0;
  setCompleteForTests(async () => {
    analysisCalls += 1;
    return fakeResult(analysisJson("standard uncaptioned summary"));
  });
  const bytes = await buildTextPdf("UNCAPTIONED SUMMARY MARKER LIABILITY");
  const ingested = await ingestDocumentBytes({
    fileName: "plain.pdf",
    mimeType: "application/pdf",
    bytes,
    tag: "personal",
  });
  assert(analysisCalls >= 1, "uncaptioned PDF still runs summary analysis");
  assert(/Summary:/i.test(ingested.reply), "uncaptioned reply is the summary template");
  assert(/Type:/i.test(ingested.reply), "uncaptioned reply has Type line");
  setCompleteForTests(undefined);
  console.log("uncaptioned PDF summary unchanged: ok");
}

{
  const prior =
    "Type: note (personal)\n\nSummary:\n• Long template dump about Epicode figures and every section of the PDF.";
  const rewritten = "WhatsApp brief: revenue up; focus on 3 wins. Ask for the deck.";
  const doc = createDocument(
    "figures.pdf",
    "personal",
    "Revenue 12 crore. Three wins: X, Y, Z. Deck attached.",
    null,
  );
  recordRecentUpload(doc.id, "figures.pdf", "PDF");

  let readCalled = false;
  let sawRewriteNudge = false;
  setToolInterceptorForTests((call) => {
    if (call.name === "read_document") {
      readCalled = true;
      const id = (call.input as { id?: number }).id;
      assert(id === doc.id, `read_document id ${id} matches recent upload`);
      return getDocument(doc.id)!.extracted_text;
    }
    throw new Error(`unexpected tool ${call.name}`);
  });
  setCompleteForTests(async (params) => {
    if (params.tools.length === 0) {
      return modelReply({ text: '{"facts":[]}' });
    }
    const last = params.messages.at(-1);
    if (
      last?.role === "user" &&
      typeof last.content === "string" &&
      /Rewrite from the document/i.test(last.content)
    ) {
      sawRewriteNudge = true;
      return modelReply({
        text: "",
        tools: [{ name: "read_document", input: { id: doc.id, question: "make it concise" } }],
      });
    }
    if (last?.role === "tool") {
      return modelReply({ text: rewritten });
    }
    // First attempt: lazy copy of prior reply, no tool.
    return modelReply({ text: prior });
  });

  const reply = await runAgent("make it concise", {
    saveUserMessage: false,
    saveAssistantMessage: false,
    skipHistory: true,
  });
  assert(sawRewriteNudge, "agent sent the rewrite-from-document nudge");
  assert(readCalled, "make it concise forces read_document");
  assert(reply === rewritten, `got rewritten text, not prior: ${reply.slice(0, 80)}`);
  assert(reply !== prior, "reply is not identical to the previous assistant message");
  setCompleteForTests(undefined);
  setToolInterceptorForTests(undefined);
  console.log("make it concise forces read_document: ok");
}

console.log("test-document-caption: all passed");
