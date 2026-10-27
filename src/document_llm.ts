import Anthropic from "@anthropic-ai/sdk";
import type {
  DocumentBlockParam,
  ImageBlockParam,
  TextBlockParam,
} from "@anthropic-ai/sdk/resources/messages/messages";
import { getTaskBackend, getTaskEffort } from "./chat_backend.js";
import { config } from "./config.js";
import type { DocumentActionItem, ItemTag } from "./db.js";
import { complete, type LlmBackend, type LlmContentPart } from "./llm.js";
import { estimateLlmCostUsd, isHaiku55Model, logAnthropicUsage } from "./usage.js";

const MAX_PDF_PAGES = 50;
const HAIKU_PDF_PAGES_PER_CALL = 15;
const HAIKU_TEXT_CHUNK_CHARS = 32_000;
const SUMMARY_MAX_TOKENS = 8192;

export interface DocumentAnalysisUsage {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface DocumentAnalysis {
  tag: ItemTag;
  document_type: string;
  summary_bullets: string[];
  dates: string[];
  money: string[];
  risks: string[];
  action_items: DocumentActionItem[];
  extracted_text: string;
  pages_processed: number;
  truncated: boolean;
  fallback_summary: boolean;
  usage: DocumentAnalysisUsage;
}

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

// Structured output schema (Anthropic output_config.format, json_schema).
// Constrained decoding guarantees valid JSON matching this shape, so no
// free-form JSON.parse of model text is needed on the happy path.
const analysisSchema = {
  type: "object",
  properties: {
    tag: { type: "string", enum: ["work", "personal"] },
    document_type: { type: "string" },
    summary_bullets: { type: "array", items: { type: "string" } },
    dates: { type: "array", items: { type: "string" } },
    money: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    action_items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          tag: { type: "string", enum: ["work", "personal"] },
          due_at: { type: ["string", "null"] },
        },
        required: ["text", "tag", "due_at"],
        additionalProperties: false,
      },
    },
  },
  required: [
    "tag",
    "document_type",
    "summary_bullets",
    "dates",
    "money",
    "risks",
    "action_items",
  ],
  additionalProperties: false,
};

const analysisPrompt = `Analyze this document for Vishnu. Tag it work or personal.
Give exactly up to 5 short summary bullets, every key date or deadline (include the event date if this is a brochure or invitation), amounts mentioned, and risks or obligations.
List concrete action items with work/personal tags and ISO8601 due_at with offset, or null due_at when unclear.
Do not dump the full document. Keep each string short. Never invent figures or dates not present.`;

const fallbackPrompt = `Summarize this document for Vishnu in short plain-text bullets: what it is, key dates, amounts, and anything needing his action. Plain text only, no JSON. Never invent figures or dates not present.`;

function documentsModel(): string {
  return getTaskBackend("documents") === "claude"
    ? config.claudeModel
    : config.backgroundModel;
}

function documentsEffortFields(model: string): {
  thinking?: { type: "disabled" } | { type: "adaptive" };
  effort: "low" | "medium" | "high";
} {
  const effort = getTaskEffort("documents");
  if (!isHaiku55Model(model)) {
    return { effort };
  }
  if (effort === "low") {
    return { thinking: { type: "disabled" }, effort };
  }
  return { thinking: { type: "adaptive" }, effort };
}

function estimateCostUsd(
  inputTokens: number,
  outputTokens: number,
  model = documentsModel(),
): number {
  return estimateLlmCostUsd({ inputTokens, outputTokens }, model);
}

function uniqueStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.trim().toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(item.trim());
  }
  return out;
}

function normalizeAnalysis(parsed: unknown): Omit<DocumentAnalysis, "pages_processed" | "truncated" | "fallback_summary" | "usage"> {
  const value = parsed as Record<string, unknown>;
  if (!value || typeof value !== "object") {
    throw new Error("Document analysis returned an unexpected shape.");
  }
  const strings = (input: unknown): string[] =>
    Array.isArray(input)
      ? input.filter((item): item is string => typeof item === "string")
      : [];
  const actionItems = Array.isArray(value.action_items)
    ? value.action_items.map((item) => {
        const entry = item as Record<string, unknown>;
        return {
          text: typeof entry.text === "string" ? entry.text : "",
          tag: entry.tag === "work" ? "work" : "personal",
          due_at: typeof entry.due_at === "string" ? entry.due_at : null,
        } satisfies DocumentActionItem;
      })
    : [];
  const summary_bullets = strings(value.summary_bullets).slice(0, 5);
  const dates = strings(value.dates);
  const money = strings(value.money);
  const risks = strings(value.risks);
  const document_type =
    typeof value.document_type === "string" && value.document_type
      ? value.document_type
      : "document";
  const extracted_text = [
    document_type,
    ...summary_bullets,
    ...dates,
    ...money,
    ...risks,
    ...actionItems.map((item) => item.text),
  ]
    .filter(Boolean)
    .join("\n");
  return {
    tag: value.tag === "work" ? "work" : "personal",
    document_type,
    summary_bullets,
    dates,
    money,
    risks,
    action_items: actionItems,
    extracted_text,
  };
}

type DocumentContent = DocumentBlockParam | ImageBlockParam | TextBlockParam;

async function requestStructuredAnalysis(
  content: DocumentContent[],
  promptExtra: string,
): Promise<{ analysis: Omit<DocumentAnalysis, "pages_processed" | "truncated" | "fallback_summary" | "usage">; usage: DocumentAnalysisUsage }> {
  let inputTokens = 0;
  let outputTokens = 0;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const model = documentsModel();
      const effortFields = documentsEffortFields(model);
      const response = await anthropic.messages.create({
        model,
        max_tokens: SUMMARY_MAX_TOKENS,
        ...(effortFields.thinking ? { thinking: effortFields.thinking } : {}),
        output_config: {
          format: { type: "json_schema", schema: analysisSchema },
          effort: effortFields.effort,
        },
        messages: [
          {
            role: "user",
            content: [
              ...content,
              { type: "text", text: `${analysisPrompt}\n${promptExtra}` },
            ],
          },
        ],
      });
      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;
      logAnthropicUsage("document", model, response.usage);
      if (response.stop_reason === "refusal") {
        throw new Error("Document analysis was refused by the model.");
      }
      if (response.stop_reason === "max_tokens") {
        throw new Error("Document analysis hit max_tokens before finishing.");
      }
      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      return {
        analysis: normalizeAnalysis(JSON.parse(text)),
        usage: {
          inputTokens,
          outputTokens,
          estimatedCostUsd: estimateCostUsd(inputTokens, outputTokens),
        },
      };
    } catch (error) {
      lastError = error;
      console.error(
        `Document structured analysis attempt ${attempt} failed (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Document structured analysis failed twice.");
}

async function requestFallbackSummary(
  content: DocumentContent[],
  promptExtra: string,
  usage: DocumentAnalysisUsage,
): Promise<{ analysis: Omit<DocumentAnalysis, "pages_processed" | "truncated" | "fallback_summary" | "usage">; usage: DocumentAnalysisUsage }> {
  const model = documentsModel();
  const effortFields = documentsEffortFields(model);
  const response = await anthropic.messages.create({
    model,
    max_tokens: SUMMARY_MAX_TOKENS,
    ...(effortFields.thinking ? { thinking: effortFields.thinking } : {}),
    output_config: { effort: effortFields.effort },
    messages: [
      {
        role: "user",
        content: [
          ...content,
          { type: "text", text: `${fallbackPrompt}\n${promptExtra}` },
        ],
      },
    ],
  });
  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  logAnthropicUsage("document", model, response.usage);
  const lines = text
    .split("\n")
    .map((line) => line.replace(/^[-•\s]+/, "").trim())
    .filter(Boolean);
  const inputTokens = usage.inputTokens + response.usage.input_tokens;
  const outputTokens = usage.outputTokens + response.usage.output_tokens;
  return {
    analysis: {
      tag: "personal",
      document_type: "document",
      summary_bullets: lines.slice(0, 5),
      dates: [],
      money: [],
      risks: [],
      action_items: [],
      extracted_text: text,
    },
    usage: {
      inputTokens,
      outputTokens,
      estimatedCostUsd: estimateCostUsd(inputTokens, outputTokens),
    },
  };
}

function withPages(
  result: { analysis: Omit<DocumentAnalysis, "pages_processed" | "truncated" | "fallback_summary" | "usage">; usage: DocumentAnalysisUsage },
  pagesProcessed: number,
  truncated: boolean,
  fallbackSummary: boolean,
): DocumentAnalysis {
  return {
    ...result.analysis,
    pages_processed: pagesProcessed,
    truncated,
    fallback_summary: fallbackSummary,
    usage: result.usage,
  };
}

async function analyzeContent(
  content: DocumentContent[],
  promptExtra: string,
  pagesProcessed: number,
  truncated: boolean,
  logLabel: string,
): Promise<DocumentAnalysis> {
  try {
    const result = await requestStructuredAnalysis(content, promptExtra);
    console.log(
      `Document analysis (${logLabel}): pages=${pagesProcessed}, input_tokens=${result.usage.inputTokens}, output_tokens=${result.usage.outputTokens}, estimated_cost_usd=${result.usage.estimatedCostUsd.toFixed(6)}`,
    );
    return withPages(result, pagesProcessed, truncated, false);
  } catch (error) {
    console.error(
      `Document analysis (${logLabel}) structured output failed twice, using plain-text fallback (${error instanceof Error ? error.message : String(error)}).`,
    );
    const emptyUsage: DocumentAnalysisUsage = {
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
    };
    const result = await requestFallbackSummary(content, promptExtra, emptyUsage);
    console.log(
      `Document analysis (${logLabel}) fallback: pages=${pagesProcessed}, input_tokens=${result.usage.inputTokens}, output_tokens=${result.usage.outputTokens}, estimated_cost_usd=${result.usage.estimatedCostUsd.toFixed(6)}`,
    );
    return withPages(result, pagesProcessed, truncated, true);
  }
}

async function transcribePdfChunk(
  pdfBytes: Uint8Array,
  pagesProcessed: number,
  model: string,
): Promise<{ text: string; usage: DocumentAnalysisUsage }> {
  const effortFields = documentsEffortFields(model);
  const response = await anthropic.messages.create({
    model,
    max_tokens: SUMMARY_MAX_TOKENS,
    ...(effortFields.thinking ? { thinking: effortFields.thinking } : {}),
    output_config: { effort: effortFields.effort },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: Buffer.from(pdfBytes).toString("base64"),
            },
          },
          {
            type: "text",
            text: `Transcribe all readable text from this ${pagesProcessed}-page PDF in reading order.
Label each page as "--- page N ---". Include emails, phone numbers, prices, names, booth sizes, and fine print.
Plain text only. Do not summarize and do not use JSON.`,
          },
        ],
      },
    ],
  });
  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  logAnthropicUsage("document", model, response.usage);
  const usage = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    estimatedCostUsd: estimateCostUsd(
      response.usage.input_tokens,
      response.usage.output_tokens,
      model,
    ),
  };
  console.log(
    `Document transcription: pages=${pagesProcessed}, input_tokens=${usage.inputTokens}, output_tokens=${usage.outputTokens}, estimated_cost_usd=${usage.estimatedCostUsd.toFixed(6)}`,
  );
  return { text, usage };
}

/** Plain-text transcription for image-only PDFs. Not used when a local text layer exists. */
export async function transcribePdfVisibleText(
  pdfBytes: Uint8Array,
  pagesProcessed: number,
): Promise<{ text: string; usage: DocumentAnalysisUsage }> {
  const model = documentsModel();
  const batchSize = isHaiku55Model(model)
    ? HAIKU_PDF_PAGES_PER_CALL
    : MAX_PDF_PAGES;
  if (pagesProcessed <= batchSize) {
    return transcribePdfChunk(pdfBytes, pagesProcessed, model);
  }
  const texts: string[] = [];
  const usage: DocumentAnalysisUsage = {
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
  };
  for (let start = 0; start < pagesProcessed; start += batchSize) {
    const count = Math.min(batchSize, pagesProcessed - start);
    const slice = await slicePdfPages(pdfBytes, start, count);
    const part = await transcribePdfChunk(slice, count, model);
    texts.push(part.text);
    usage.inputTokens += part.usage.inputTokens;
    usage.outputTokens += part.usage.outputTokens;
    usage.estimatedCostUsd += part.usage.estimatedCostUsd;
  }
  return { text: texts.join("\n"), usage };
}

function mergeAnalyses(
  parts: Array<Omit<DocumentAnalysis, "pages_processed" | "truncated" | "fallback_summary" | "usage"> & { usage: DocumentAnalysisUsage }>,
): { analysis: Omit<DocumentAnalysis, "pages_processed" | "truncated" | "fallback_summary" | "usage">; usage: DocumentAnalysisUsage } {
  const summary = uniqueStrings(parts.flatMap((part) => part.summary_bullets)).slice(0, 5);
  const dates = uniqueStrings(parts.flatMap((part) => part.dates));
  const money = uniqueStrings(parts.flatMap((part) => part.money));
  const risks = uniqueStrings(parts.flatMap((part) => part.risks));
  const action_items = parts.flatMap((part) => part.action_items);
  const document_type =
    parts.find((part) => part.document_type && part.document_type !== "document")
      ?.document_type ?? "document";
  const usage = parts.reduce(
    (sum, part) => ({
      inputTokens: sum.inputTokens + part.usage.inputTokens,
      outputTokens: sum.outputTokens + part.usage.outputTokens,
      estimatedCostUsd: sum.estimatedCostUsd + part.usage.estimatedCostUsd,
    }),
    { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
  );
  return {
    analysis: {
      tag: parts.some((part) => part.tag === "work") ? "work" : "personal",
      document_type,
      summary_bullets: summary,
      dates,
      money,
      risks,
      action_items,
      extracted_text: [document_type, ...summary, ...dates, ...money, ...risks, ...action_items.map((item) => item.text)]
        .filter(Boolean)
        .join("\n"),
    },
    usage,
  };
}

export async function analyzePdf(
  pdfBytes: Uint8Array,
  pagesProcessed: number,
  truncated: boolean,
): Promise<DocumentAnalysis> {
  const model = documentsModel();
  const batchSize =
    isHaiku55Model(model) ? HAIKU_PDF_PAGES_PER_CALL : MAX_PDF_PAGES;
  if (pagesProcessed <= batchSize) {
    return analyzeContent(
      [
        {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: Buffer.from(pdfBytes).toString("base64"),
          },
        },
      ],
      `Pages sent: ${pagesProcessed}. truncated: ${truncated}.`,
      pagesProcessed,
      truncated,
      "pdf",
    );
  }
  const parts = [];
  for (let start = 0; start < pagesProcessed; start += batchSize) {
    const count = Math.min(batchSize, pagesProcessed - start);
    const slice = await slicePdfPages(pdfBytes, start, count);
    const part = await analyzeContent(
      [
        {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: Buffer.from(slice).toString("base64"),
          },
        },
      ],
      `Pages ${start + 1}-${start + count} of ${pagesProcessed}. truncated: ${truncated}.`,
      count,
      false,
      `pdf-${start + 1}`,
    );
    parts.push(part);
  }
  const merged = mergeAnalyses(parts);
  return withPages(merged, pagesProcessed, truncated, parts.some((part) => part.fallback_summary));
}

/** Image OCR never follows the Chat /model picker. DeepSeek has no vision. */
export const IMAGE_VISION_BACKENDS: readonly LlmBackend[] = ["haiku", "gemini"];

function parseJsonObject(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(trimmed);
}

export async function analyzeImage(
  imageBytes: Uint8Array,
  mediaType: "image/jpeg" | "image/png" | "image/webp",
): Promise<DocumentAnalysis> {
  const data = Buffer.from(imageBytes).toString("base64");
  const userContent: LlmContentPart[] = [
    { type: "image", mediaType, data },
    {
      type: "text",
      text: `${analysisPrompt}\nThis is a photo of a document.`,
    },
  ];
  let lastError: unknown;
  for (const backend of IMAGE_VISION_BACKENDS) {
    try {
      const result = await complete({
        backend,
        tools: [],
        task: "document",
        system: {
          cacheable:
            "Extract facts from this image for Vishnu. Reply with JSON only.",
        },
        messages: [{ role: "user", content: userContent }],
        jsonSchema: backend === "gemini" ? undefined : analysisSchema,
      });
      const text = result.textParts.join("\n").trim();
      if (!text) {
        throw new Error("Vision model returned empty text.");
      }
      const usage = {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        estimatedCostUsd: result.usage.estimatedCostUsd,
      };
      try {
        return withPages(
          { analysis: normalizeAnalysis(parseJsonObject(text)), usage },
          1,
          false,
          false,
        );
      } catch {
        const bullets = text
          .split("\n")
          .map((line) => line.replace(/^[-•\s]+/, "").trim())
          .filter(Boolean)
          .slice(0, 5);
        return withPages(
          {
            analysis: {
              tag: "personal",
              document_type: "document",
              summary_bullets: bullets,
              dates: [],
              money: [],
              risks: [],
              action_items: [],
              extracted_text: text,
            },
            usage,
          },
          1,
          false,
          true,
        );
      }
    } catch (error) {
      lastError = error;
      console.error(
        `Image vision (${backend}) failed (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Image vision failed on every vision backend.");
}

export async function analyzeText(
  body: string,
  sourceLabel: string,
  pagesProcessed = 0,
  truncated = false,
): Promise<DocumentAnalysis> {
  const model = documentsModel();
  if (!isHaiku55Model(model) || body.length <= HAIKU_TEXT_CHUNK_CHARS) {
    return analyzeContent(
      [
        {
          type: "text",
          text: `Source: ${sourceLabel}\n\n<document_text>\n${body}\n</document_text>`,
        },
      ],
      "",
      pagesProcessed,
      truncated,
      "text",
    );
  }
  const { chunkText } = await import("./document_review_logic.js");
  const chunks = chunkText(body, HAIKU_TEXT_CHUNK_CHARS, 400);
  const parts = [];
  for (const [index, chunk] of chunks.entries()) {
    const part = await analyzeContent(
      [
        {
          type: "text",
          text: `Source: ${sourceLabel} (chunk ${index + 1} of ${chunks.length})\n\n<document_text>\n${chunk}\n</document_text>`,
        },
      ],
      "",
      pagesProcessed,
      truncated,
      `text-${index + 1}`,
    );
    parts.push(part);
  }
  const merged = mergeAnalyses(parts);
  return withPages(
    merged,
    pagesProcessed,
    truncated,
    parts.some((part) => part.fallback_summary),
  );
}

export { MAX_PDF_PAGES };

export async function trimPdfToMaxPages(
  bytes: Uint8Array,
  maxPages: number,
): Promise<{ pdf: Uint8Array; totalPages: number; truncated: boolean }> {
  const { PDFDocument } = await import("pdf-lib");
  const source = await PDFDocument.load(bytes);
  const totalPages = source.getPageCount();
  if (totalPages <= maxPages) {
    return { pdf: bytes, totalPages, truncated: false };
  }
  const target = await PDFDocument.create();
  const indices = Array.from({ length: maxPages }, (_, index) => index);
  const copied = await target.copyPages(source, indices);
  for (const page of copied) {
    target.addPage(page);
  }
  const pdf = await target.save();
  return { pdf: new Uint8Array(pdf), totalPages, truncated: true };
}

async function slicePdfPages(
  bytes: Uint8Array,
  start: number,
  count: number,
): Promise<Uint8Array> {
  const { PDFDocument } = await import("pdf-lib");
  const source = await PDFDocument.load(bytes);
  const target = await PDFDocument.create();
  const indices = Array.from({ length: count }, (_, index) => start + index);
  const copied = await target.copyPages(source, indices);
  for (const page of copied) {
    target.addPage(page);
  }
  const pdf = await target.save();
  return new Uint8Array(pdf);
}

export function formatDocumentReply(
  documentId: number,
  analysis: DocumentAnalysis,
  options: { limitedFollowup?: boolean } = {},
): string {
  const lines = [
    `Type: ${analysis.document_type} (${analysis.tag})`,
    "",
    "Summary:",
    ...analysis.summary_bullets.map((bullet) => `• ${bullet}`),
    "",
    `Dates: ${analysis.dates.length ? analysis.dates.join("; ") : "None noted"}`,
    `Money: ${analysis.money.length ? analysis.money.join("; ") : "None noted"}`,
    `Risks/obligations: ${analysis.risks.length ? analysis.risks.join("; ") : "None noted"}`,
    "",
    `Action items: ${analysis.action_items.length ? analysis.action_items.map((item) => item.text).join("; ") : "None"}`,
  ];
  if (analysis.fallback_summary) {
    lines.push(
      "",
      "Note: Structured details couldn't be pulled out, so this is a plain-text summary. Ask me anything about the document and I'll read the saved copy.",
    );
  }
  if (options.limitedFollowup) {
    lines.push(
      "",
      "Note: This file has little or no selectable text (likely a scan or images), so detailed follow-up questions may be limited.",
    );
  }
  if (analysis.truncated) {
    lines.push(
      "",
      `Note: Only the first ${MAX_PDF_PAGES} pages were processed; the file was longer.`,
    );
  }
  lines.push("", `Document id: ${documentId} (use read_document for follow-ups)`);
  return lines.join("\n");
}
