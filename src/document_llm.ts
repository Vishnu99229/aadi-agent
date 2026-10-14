import Anthropic from "@anthropic-ai/sdk";
import type {
  DocumentBlockParam,
  ImageBlockParam,
  TextBlockParam,
} from "@anthropic-ai/sdk/resources/messages/messages";
import { getTaskBackend } from "./chat_backend.js";
import { config } from "./config.js";
import type { DocumentActionItem, ItemTag } from "./db.js";

const MAX_PDF_PAGES = 50;
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

function estimateCostUsd(inputTokens: number, outputTokens: number): number {
  const rates = config.chatCostRates;
  return (
    (inputTokens * rates.inputCostPerMillion +
      outputTokens * rates.outputCostPerMillion) /
    1_000_000
  );
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
      const response = await anthropic.messages.create({
        model: config.claudeModel,
        max_tokens: SUMMARY_MAX_TOKENS,
        output_config: {
          format: { type: "json_schema", schema: analysisSchema },
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
  const response = await anthropic.messages.create({
    model: config.claudeModel,
    max_tokens: SUMMARY_MAX_TOKENS,
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
  const backend = getTaskBackend("documents");
  if (backend !== "claude") {
    const errorType = "UnsupportedDocumentBackend";
    console.error(
      `Document analysis (${logLabel}) on ${backend} failed (${errorType}); retrying on Claude.`,
    );
  }
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

/** Plain-text transcription for image-only PDFs. Not used when a local text layer exists. */
export async function transcribePdfVisibleText(
  pdfBytes: Uint8Array,
  pagesProcessed: number,
): Promise<{ text: string; usage: DocumentAnalysisUsage }> {
  const response = await anthropic.messages.create({
    model: config.claudeModel,
    max_tokens: SUMMARY_MAX_TOKENS,
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
  const usage = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    estimatedCostUsd: estimateCostUsd(
      response.usage.input_tokens,
      response.usage.output_tokens,
    ),
  };
  console.log(
    `Document transcription: pages=${pagesProcessed}, input_tokens=${usage.inputTokens}, output_tokens=${usage.outputTokens}, estimated_cost_usd=${usage.estimatedCostUsd.toFixed(6)}`,
  );
  return { text, usage };
}

export async function analyzePdf(
  pdfBytes: Uint8Array,
  pagesProcessed: number,
  truncated: boolean,
): Promise<DocumentAnalysis> {
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

export async function analyzeImage(
  imageBytes: Uint8Array,
  mediaType: "image/jpeg" | "image/png" | "image/webp",
): Promise<DocumentAnalysis> {
  return analyzeContent(
    [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: mediaType,
          data: Buffer.from(imageBytes).toString("base64"),
        },
      },
    ],
    "This is a photo of a document.",
    1,
    false,
    "photo",
  );
}

export async function analyzeText(
  body: string,
  sourceLabel: string,
): Promise<DocumentAnalysis> {
  return analyzeContent(
    [
      {
        type: "text",
        text: `Source: ${sourceLabel}\n\n<document_text>\n${body}\n</document_text>`,
      },
    ],
    "",
    0,
    false,
    "text",
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
