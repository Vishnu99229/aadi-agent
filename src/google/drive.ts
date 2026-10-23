import { google, type drive_v3 } from "googleapis";
import { getGoogleClient } from "./auth.js";

/** Google editor mime types that must be exported, not downloaded. */
const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";
const GOOGLE_SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const GOOGLE_SLIDES_MIME = "application/vnd.google-apps.presentation";

/** URL patterns we accept. Captures the file id in group 1. */
const URL_PATTERNS: RegExp[] = [
  /https?:\/\/docs\.google\.com\/(?:document|spreadsheets|presentation)\/d\/([a-zA-Z0-9_-]+)/,
  /https?:\/\/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/,
  /https?:\/\/drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/,
  /https?:\/\/drive\.google\.com\/uc\?[^"\s]*id=([a-zA-Z0-9_-]+)/,
];

/** Pull the Google Drive file id out of any supported URL. Returns undefined
 *  if the string is not a Drive / Docs / Sheets / Slides link. */
export function extractDriveFileId(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  for (const pattern of URL_PATTERNS) {
    const match = pattern.exec(trimmed);
    if (match?.[1]) return match[1];
  }
  // Bare id (25-60 chars of base64url) — only accept if the whole string is it.
  if (/^[a-zA-Z0-9_-]{25,80}$/.test(trimmed)) {
    return trimmed;
  }
  return undefined;
}

/** True when the input text has at least one Google Drive / Docs URL. */
export function hasDriveLink(text: string): boolean {
  return URL_PATTERNS.some((pattern) => pattern.test(text));
}

/** All drive file ids referenced in `text`, in order of appearance, deduped. */
export function allDriveFileIds(text: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  for (const pattern of URL_PATTERNS) {
    const regex = new RegExp(pattern.source, "g");
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const id = match[1];
      if (id && !seen.has(id)) {
        seen.add(id);
        results.push(id);
      }
    }
  }
  return results;
}

export interface DriveFetchResult {
  fileId: string;
  fileName: string;
  mimeType: string;
  /** Set for Google editor files: UTF-8 text exported from Drive. */
  text?: string;
  /** Set for binary files (PDF, DOCX, XLSX, images). */
  bytes?: Uint8Array;
  /** The mime type the ingestion pipeline should treat `bytes` as (PDF/DOCX/
   *  XLSX/image). Copied from `mimeType` for binaries; synthesized for the
   *  text-only Google editor branch. */
  ingestMimeType: string;
  webViewLink?: string;
}

function driveClient(): drive_v3.Drive {
  // Lazy per-call client avoids caching the auth before the token file is
  // present (tests load this module without touching Drive).
  return google.drive({ version: "v3" });
}

async function getAuthedDrive(): Promise<drive_v3.Drive> {
  const auth = await getGoogleClient();
  return google.drive({ version: "v3", auth });
}

/** Fetch a Drive file's metadata + content. Google editor files are exported
 *  as UTF-8 text (Docs/Slides → text/plain, Sheets → text/csv). Everything
 *  else is downloaded via alt=media as an octet-stream buffer. */
export async function fetchDriveFile(fileId: string): Promise<DriveFetchResult> {
  void driveClient; // keep the lazy constructor exported-for-tests sibling
  const drive = await getAuthedDrive();
  const metaResponse = await drive.files.get({
    fileId,
    fields: "id, name, mimeType, size, webViewLink",
    supportsAllDrives: true,
  });
  const meta = metaResponse.data;
  const mimeType = meta.mimeType ?? "application/octet-stream";
  const fileName = meta.name ?? `drive-${fileId}`;
  const webViewLink = meta.webViewLink ?? undefined;

  if (mimeType === GOOGLE_DOC_MIME || mimeType === GOOGLE_SLIDES_MIME) {
    const exported = await drive.files.export(
      { fileId, mimeType: "text/plain" },
      { responseType: "text" },
    );
    const text =
      typeof exported.data === "string"
        ? exported.data
        : String(exported.data ?? "");
    return {
      fileId,
      fileName,
      mimeType,
      text,
      ingestMimeType: "text/plain",
      webViewLink,
    };
  }

  if (mimeType === GOOGLE_SHEET_MIME) {
    const exported = await drive.files.export(
      { fileId, mimeType: "text/csv" },
      { responseType: "text" },
    );
    const text =
      typeof exported.data === "string"
        ? exported.data
        : String(exported.data ?? "");
    return {
      fileId,
      fileName,
      mimeType,
      text,
      ingestMimeType: "text/csv",
      webViewLink,
    };
  }

  // Binary files (PDF, DOCX, XLSX, images, …): alt=media returns the raw
  // bytes. responseType "arraybuffer" delivers an ArrayBuffer we wrap in a
  // Uint8Array for the document pipeline.
  const binary = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" },
  );
  const data = binary.data as ArrayBuffer;
  const bytes = new Uint8Array(data);
  return {
    fileId,
    fileName,
    mimeType,
    bytes,
    ingestMimeType: mimeType,
    webViewLink,
  };
}

export interface DriveSearchHit {
  id: string;
  name: string;
  mimeType: string;
  webViewLink: string;
  modifiedTime?: string;
}

/** List up to `limit` files matching `query` by name (case-insensitive).
 *  Trashed items are excluded. Query strings are safely escaped. */
export async function searchDriveFiles(
  query: string,
  limit = 5,
): Promise<DriveSearchHit[]> {
  const drive = await getAuthedDrive();
  const safe = query.replace(/'/g, "\\'").replace(/\\/g, "\\\\");
  const response = await drive.files.list({
    q: `name contains '${safe}' and trashed = false`,
    pageSize: Math.max(1, Math.min(limit, 10)),
    fields: "files(id, name, mimeType, webViewLink, modifiedTime)",
    orderBy: "modifiedTime desc",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return (response.data.files ?? []).map((file) => ({
    id: file.id ?? "",
    name: file.name ?? "(untitled)",
    mimeType: file.mimeType ?? "application/octet-stream",
    webViewLink: file.webViewLink ?? "",
    modifiedTime: file.modifiedTime ?? undefined,
  }));
}
