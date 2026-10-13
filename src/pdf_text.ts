import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const MIN_TEXT_LAYER_CHARS = 80;

export interface PdfTextExtract {
  text: string;
  pages: number;
  hasTextLayer: boolean;
}

function itemText(item: unknown): string {
  if (
    item &&
    typeof item === "object" &&
    "str" in item &&
    typeof (item as { str: unknown }).str === "string"
  ) {
    return (item as { str: string }).str;
  }
  return "";
}

function hasEol(item: unknown): boolean {
  return Boolean(
    item &&
      typeof item === "object" &&
      "hasEOL" in item &&
      (item as { hasEOL?: boolean }).hasEOL,
  );
}

export async function extractPdfText(
  bytes: Uint8Array,
  maxPages: number,
): Promise<PdfTextExtract> {
  const document = await getDocument({
    // Copy: pdf.js transfers/detaches the ArrayBuffer.
    data: bytes.slice(),
    disableWorker: true,
    useSystemFonts: true,
    isEvalSupported: false,
  }).promise;

  const pages = Math.min(document.numPages, maxPages);
  const parts: string[] = [];
  let letters = 0;

  for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    let pageText = "";
    for (const item of content.items) {
      pageText += itemText(item);
      if (hasEol(item)) {
        pageText += "\n";
      } else {
        pageText += " ";
      }
    }
    pageText = pageText.replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
    letters += (pageText.match(/[A-Za-z0-9]/g) ?? []).length;
    parts.push(`--- page ${pageNumber} ---\n${pageText}`);
  }

  const text = parts.join("\n\n").trim();
  return {
    text,
    pages,
    hasTextLayer: letters >= MIN_TEXT_LAYER_CHARS,
  };
}

export function composedSummaryText(parts: {
  document_type?: string;
  summary_bullets: string[];
  dates: string[];
  money: string[];
  risks: string[];
  action_items?: { text: string }[];
}): string {
  return [
    parts.document_type ?? "",
    ...parts.summary_bullets,
    ...parts.dates,
    ...parts.money,
    ...parts.risks,
    ...(parts.action_items ?? []).map((item) => item.text),
  ]
    .filter(Boolean)
    .join("\n");
}

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "for",
  "is",
  "it",
  "this",
  "that",
  "with",
  "from",
  "what",
  "when",
  "where",
  "who",
  "how",
  "document",
  "about",
]);

function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9@.+/-]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3 && !STOPWORDS.has(term));
}

function scoreChunk(chunk: string, terms: string[]): number {
  const lower = chunk.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (lower.includes(term)) {
      score += 1;
    }
  }
  return score;
}

/** Prefer page chunks that mention the question; keep original order. */
export function selectDocumentText(
  text: string,
  query: string | undefined,
  maxChars: number,
): string {
  if (text.length <= maxChars) {
    return text;
  }

  const chunks = text.includes("--- page ")
    ? text.split(/\n(?=--- page \d+ ---)/)
    : text.split(/\n{2,}/).filter(Boolean);
  const terms = query ? queryTerms(query) : [];

  if (terms.length === 0 || chunks.length <= 1) {
    return `${text.slice(0, maxChars)}\n\n[Truncated for token cost. Later pages omitted.]`;
  }

  const ranked = chunks
    .map((chunk, index) => ({ chunk, index, score: scoreChunk(chunk, terms) }))
    .sort((left, right) => right.score - left.score || left.index - right.index);

  const chosen = new Set<number>();
  chosen.add(0);
  let used = chunks[0]?.length ?? 0;
  for (const item of ranked) {
    if (chosen.has(item.index)) {
      continue;
    }
    if (item.score === 0) {
      break;
    }
    if (used + item.chunk.length + 2 > maxChars) {
      continue;
    }
    chosen.add(item.index);
    used += item.chunk.length + 2;
  }

  const selected = chunks.filter((_, index) => chosen.has(index));
  const body = selected.join("\n\n");
  const omitted = chunks.length - selected.length;
  const suffix =
    omitted > 0
      ? `\n\n[Showing ${selected.length} of ${chunks.length} page sections most relevant to the question.]`
      : "";
  if (body.length <= maxChars) {
    return `${body}${suffix}`;
  }
  return `${body.slice(0, maxChars)}\n\n[Truncated for token cost.]`;
}
