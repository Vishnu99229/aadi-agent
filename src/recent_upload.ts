/** Tracks the most recent document upload so "the document" resolves without an id. */

const RECENT_WINDOW_MS = 30 * 60 * 1_000;

interface RecentUpload {
  documentId: number;
  fileName: string;
  kind: string;
  uploadedAt: number;
}

let latest: RecentUpload | null = null;

export function recordRecentUpload(
  documentId: number,
  fileName: string,
  kind: string,
): void {
  latest = { documentId, fileName, kind, uploadedAt: Date.now() };
}

export function recentUploadLine(now = Date.now()): string | null {
  if (!latest || now - latest.uploadedAt > RECENT_WINDOW_MS) {
    return null;
  }
  const minutes = Math.max(
    1,
    Math.round((now - latest.uploadedAt) / 60_000),
  );
  return `Most recent document upload: id ${latest.documentId}, file "${latest.fileName}" (${latest.kind}), uploaded ${minutes} minute(s) ago. When Vishnu says "the document", use read_document with id ${latest.documentId} without asking for an id.`;
}
