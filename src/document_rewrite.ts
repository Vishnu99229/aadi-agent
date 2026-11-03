/** Detect follow-ups that ask to rewrite a prior document reply. */

const REWRITE_REQUEST =
  /\b(?:make\s+it\s+)?(?:concise|shorter|tighter|briefer)\b|\brewrite\b|\bredo\b|\brephrase\b|\bshorten\b|\bsummarise\b|\bsummarize\b|\bmake\s+it\s+(?:short|brief)|(?:more\s+)?compact\b|\btighten\b|\bcondense\b|\btrim\s+it\b/i;

export function looksLikeDocumentRewrite(text: string): boolean {
  return REWRITE_REQUEST.test(text.trim());
}

export function documentRewriteRetryPrompt(documentId: number): string {
  return `Call read_document with id ${documentId} now. Rewrite from the document; do not repeat your previous reply.`;
}
