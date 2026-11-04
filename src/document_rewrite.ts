/** Detect follow-ups that ask to rewrite a prior document reply,
 *  or that refer to multiple / named recent uploads. */

import type { RecentUpload } from "./recent_upload.js";

const REWRITE_REQUEST =
  /\b(?:make\s+it\s+)?(?:concise|shorter|tighter|briefer)\b|\brewrite\b|\bredo\b|\brephrase\b|\bshorten\b|\bsummarise\b|\bsummarize\b|\bmake\s+it\s+(?:short|brief)|(?:more\s+)?compact\b|\btighten\b|\bcondense\b|\btrim\s+it\b/i;

/** Plural / comparative references to more than one document. */
const PLURAL_DOC_REF =
  /\bboth(?:\s+(?:docs?|documents?|files?))?\b|\bthe\s+two\s+(?:docs?|documents?|files?)\b|\beach\s+(?:doc|document|file)\b|\ball\s+(?:the\s+)?(?:docs?|documents?|files?)\b|\bcompare\s+(?:them|these|the\s+(?:two\s+)?(?:docs?|documents?|files?))\b|\bboth\s+of\s+(?:them|these)\b/i;

export function looksLikeDocumentRewrite(text: string): boolean {
  return REWRITE_REQUEST.test(text.trim());
}

export function looksLikePluralDocumentRef(text: string): boolean {
  return PLURAL_DOC_REF.test(text.trim());
}

export function documentRewriteRetryPrompt(documentId: number): string {
  return `Call read_document with id ${documentId} now. Rewrite from the document; do not repeat your previous reply.`;
}

export function documentMultiReadRetryPrompt(documentIds: number[]): string {
  const ids = documentIds.join(", ");
  return `Call read_document for each of these ids now: ${ids}. Answer from those documents; do not reply until you have read every listed id.`;
}

function fileStem(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "").toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when the user text names this upload (stem / token match). */
export function matchesNamedDocument(
  text: string,
  upload: RecentUpload,
): boolean {
  const hay = text.toLowerCase();
  const stem = fileStem(upload.fileName);
  const parts = stem
    .split(/[^a-z0-9]+/i)
    .map((p) => p.trim())
    .filter((p) => p.length >= 3);
  if (stem.length >= 3 && hay.includes(stem)) {
    return true;
  }
  return parts.some((part) =>
    new RegExp(`\\b${escapeRegExp(part)}\\b`, "i").test(hay),
  );
}

/**
 * Ids the model should read_document for this turn, from the recent-upload
 * list: all listed uploads on plural refs; named matches otherwise.
 */
export function resolveReferencedDocumentIds(
  text: string,
  uploads: readonly RecentUpload[],
): number[] {
  if (uploads.length === 0) {
    return [];
  }
  const named = uploads.filter((u) => matchesNamedDocument(text, u));
  if (looksLikePluralDocumentRef(text) && uploads.length >= 2) {
    if (named.length >= 2) {
      return named.map((u) => u.documentId);
    }
    return uploads.map((u) => u.documentId);
  }
  if (named.length > 0) {
    return named.map((u) => u.documentId);
  }
  return [];
}
