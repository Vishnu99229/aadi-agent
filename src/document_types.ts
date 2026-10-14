export type DocumentKind = "contract" | "rfp" | "questionnaire" | "other";

const CONTRACT_RE =
  /\b(msa|nda|nca|sow|mou|loa|agreement|amendment|contract|master services|statement of work|non[- ]disclosure)\b/i;
const RFP_RE =
  /\b(rfp|rfq|rfi|tender|eot|eoi|invitation to (?:bid|tender)|request for (?:proposal|quote|quotation|information))\b/i;
const QUESTIONNAIRE_RE =
  /\b(questionnaire|vendor onboarding|security (?:assessment|questionnaire|form)|due diligence(?: form| questionnaire)?|vendor (?:form|assessment|pack)|info(?:rmation)? sec(?:urity)? questionnaire)\b/i;

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|tiff?)$/i;
const SKIP_INLINE_RE = /^(image\/|audio\/|video\/)/i;

export function detectDocumentKind(
  filename: string,
  subject = "",
  textSnippet = "",
): DocumentKind {
  const haystack = `${filename.replace(/[_-]+/g, " ")}\n${subject}\n${textSnippet.slice(0, 4000)}`;
  if (RFP_RE.test(haystack)) {
    return "rfp";
  }
  if (QUESTIONNAIRE_RE.test(haystack)) {
    return "questionnaire";
  }
  if (CONTRACT_RE.test(haystack)) {
    return "contract";
  }
  return "other";
}

export function attachmentAlertLabel(
  kind: DocumentKind,
  filename: string,
  subject = "",
): string {
  const hay = `${filename.replace(/[_-]+/g, " ")} ${subject}`;
  if (/\bmsa\b/i.test(hay) || /master services/i.test(hay)) {
    return "MSA";
  }
  if (/\bnda\b/i.test(hay) || /non[- ]disclosure/i.test(hay)) {
    return "NDA";
  }
  if (/\bsow\b/i.test(hay) || /statement of work/i.test(hay)) {
    return "SOW";
  }
  if (/\brfq\b/i.test(hay)) {
    return "RFQ";
  }
  if (/\brfp\b/i.test(hay) || /request for proposal/i.test(hay)) {
    return "RFP";
  }
  if (/\btender\b/i.test(hay)) {
    return "Tender";
  }
  if (kind === "questionnaire") {
    return "Questionnaire";
  }
  if (kind === "contract") {
    return "Contract";
  }
  if (kind === "rfp") {
    return "RFP";
  }
  return "Document";
}

export function looksLikeReviewAttachment(params: {
  filename: string;
  mimeType: string;
  subject: string;
}): boolean {
  const mime = params.mimeType.toLowerCase();
  if (SKIP_INLINE_RE.test(mime) || IMAGE_RE.test(params.filename)) {
    return false;
  }
  const kind = detectDocumentKind(params.filename, params.subject);
  return kind !== "other";
}

export function isSupportedAttachment(
  filename: string,
  mimeType = "",
): boolean {
  const lower = filename.toLowerCase();
  const mime = mimeType.toLowerCase();
  if (lower.endsWith(".pdf") || mime === "application/pdf") {
    return true;
  }
  if (
    lower.endsWith(".docx") ||
    mime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return true;
  }
  if (
    lower.endsWith(".xlsx") ||
    lower.endsWith(".xls") ||
    mime ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mime === "application/vnd.ms-excel"
  ) {
    return true;
  }
  if (
    lower.endsWith(".jpg") ||
    lower.endsWith(".jpeg") ||
    lower.endsWith(".png") ||
    lower.endsWith(".webp") ||
    mime === "image/jpeg" ||
    mime === "image/png" ||
    mime === "image/webp"
  ) {
    return true;
  }
  return false;
}

export function attachmentKindFromMime(
  filename: string,
  mimeType = "",
): "pdf" | "docx" | "xlsx" | "image" | "unsupported" {
  const lower = filename.toLowerCase();
  const mime = mimeType.toLowerCase();
  if (lower.endsWith(".pdf") || mime === "application/pdf") {
    return "pdf";
  }
  if (
    lower.endsWith(".docx") ||
    mime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return "docx";
  }
  if (
    lower.endsWith(".xlsx") ||
    lower.endsWith(".xls") ||
    mime ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mime === "application/vnd.ms-excel"
  ) {
    return "xlsx";
  }
  if (
    lower.endsWith(".jpg") ||
    lower.endsWith(".jpeg") ||
    lower.endsWith(".png") ||
    lower.endsWith(".webp") ||
    mime === "image/jpeg" ||
    mime === "image/png" ||
    mime === "image/webp"
  ) {
    return "image";
  }
  return "unsupported";
}
