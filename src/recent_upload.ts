/**
 * Tracks recent document uploads so "the document" / "both docs" resolve
 * without asking for ids. Same 4h window as the rewrite retry guard.
 */

import { assertTestSeam } from "./test_seam.js";

/** Four hours: long enough for a realistic same-session follow-up. */
export const RECENT_UPLOAD_WINDOW_MS = 4 * 60 * 60 * 1_000;
export const RECENT_UPLOAD_MAX = 5;

export interface RecentUpload {
  documentId: number;
  fileName: string;
  kind: string;
  uploadedAt: number;
}

/** Newest last; pruned to window + max length on each write/read. */
let uploads: RecentUpload[] = [];

function prune(now: number): RecentUpload[] {
  const cutoff = now - RECENT_UPLOAD_WINDOW_MS;
  uploads = uploads.filter((u) => u.uploadedAt >= cutoff);
  if (uploads.length > RECENT_UPLOAD_MAX) {
    uploads = uploads.slice(uploads.length - RECENT_UPLOAD_MAX);
  }
  return uploads;
}

export function recordRecentUpload(
  documentId: number,
  fileName: string,
  kind: string,
): void {
  const now = Date.now();
  prune(now);
  uploads = uploads.filter((u) => u.documentId !== documentId);
  uploads.push({ documentId, fileName, kind, uploadedAt: now });
  prune(now);
}

/** Most recent upload still inside the window, or null. */
export function getRecentUpload(now = Date.now()): RecentUpload | null {
  const live = prune(now);
  return live.length > 0 ? live[live.length - 1]! : null;
}

/** All uploads still inside the window, newest first. */
export function getRecentUploads(now = Date.now()): RecentUpload[] {
  return prune(now).slice().reverse();
}

export function recentUploadLine(now = Date.now()): string | null {
  const live = getRecentUploads(now);
  if (live.length === 0) {
    return null;
  }
  const lines = live.map((u) => {
    const minutes = Math.max(1, Math.round((now - u.uploadedAt) / 60_000));
    return `id ${u.documentId} — "${u.fileName}" (${u.kind}), ${minutes}m ago`;
  });
  const newest = live[0]!;
  return [
    "Recent document uploads (read_document by id):",
    ...lines,
    `When Vishnu says "the document", use id ${newest.documentId} ("${newest.fileName}") without asking for an id.`,
    'For "both docs", "the two docs", or a named file (e.g. "the pricing doc"), use the matching id(s) from this list.',
  ].join("\n");
}

/** Test-only: replace or clear the in-memory ring. */
export function setRecentUploadsForTests(next: RecentUpload[]): void {
  assertTestSeam("setRecentUploadsForTests");
  uploads = next.slice();
}
