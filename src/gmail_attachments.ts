import type { gmail_v1 } from "googleapis";
import { gmailClient, type ResolvedGmailMessage } from "./google/mail.js";

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface GmailPartLike {
  filename?: string | null;
  mimeType?: string | null;
  body?: {
    attachmentId?: string | null;
    size?: number | null;
    data?: string | null;
  } | null;
  parts?: GmailPartLike[] | null;
  headers?: Array<{ name?: string | null; value?: string | null }> | null;
}

export interface GmailAttachmentMeta {
  id: string;
  attachmentId: string | null;
  filename: string;
  mimeType: string;
  size: number;
  inlineData?: string;
}

function header(
  headers: GmailPartLike["headers"],
  name: string,
): string {
  return (
    headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())
      ?.value ?? ""
  );
}

function isInlineImage(part: GmailPartLike): boolean {
  const mime = (part.mimeType ?? "").toLowerCase();
  const disposition = header(part.headers, "Content-Disposition").toLowerCase();
  const filename = (part.filename ?? "").toLowerCase();
  if (!mime.startsWith("image/")) {
    return false;
  }
  if (disposition.includes("inline")) {
    return true;
  }
  if (!filename && mime.startsWith("image/")) {
    return true;
  }
  return false;
}

export function collectAttachmentParts(
  payload: GmailPartLike | null | undefined,
): GmailAttachmentMeta[] {
  const found: GmailAttachmentMeta[] = [];
  let inlineIndex = 0;

  const walk = (part: GmailPartLike | null | undefined): void => {
    if (!part) {
      return;
    }
    const mime = (part.mimeType ?? "application/octet-stream").toLowerCase();
    if (mime.startsWith("multipart/")) {
      for (const child of part.parts ?? []) {
        walk(child);
      }
      return;
    }
    if (isInlineImage(part)) {
      return;
    }
    const filename = (part.filename ?? "").trim();
    const attachmentId = part.body?.attachmentId?.trim() || null;
    const inlineData = part.body?.data || undefined;
    const size = Number(part.body?.size) || (inlineData ? 0 : 0);
    if (!filename && !attachmentId) {
      return;
    }
    if (!attachmentId && !inlineData) {
      return;
    }
    inlineIndex += 1;
    found.push({
      id: attachmentId ?? `inline-${inlineIndex}`,
      attachmentId,
      filename: filename || `attachment-${inlineIndex}`,
      mimeType: mime,
      size,
      inlineData: attachmentId ? undefined : inlineData,
    });
  };

  walk(payload);
  return found;
}

export function attachmentTooLarge(size: number): boolean {
  return Number.isFinite(size) && size > MAX_ATTACHMENT_BYTES;
}

export function matchAttachment(
  attachments: GmailAttachmentMeta[],
  needle: string,
): GmailAttachmentMeta[] {
  const query = needle.trim().toLowerCase();
  if (!query) {
    return attachments;
  }
  const exactId = attachments.filter(
    (item) =>
      item.id.toLowerCase() === query ||
      (item.attachmentId && item.attachmentId.toLowerCase() === query),
  );
  if (exactId.length === 1) {
    return exactId;
  }
  const exactName = attachments.filter(
    (item) => item.filename.toLowerCase() === query,
  );
  if (exactName.length > 0) {
    return exactName;
  }
  return attachments.filter((item) => item.filename.toLowerCase().includes(query));
}

export async function downloadGmailAttachment(
  resolved: ResolvedGmailMessage,
  attachment: GmailAttachmentMeta,
): Promise<Uint8Array> {
  if (attachmentTooLarge(attachment.size)) {
    throw new Error(
      "That attachment is over 25 MB, so I skipped it.",
    );
  }
  if (attachment.inlineData) {
    const bytes = Buffer.from(attachment.inlineData, "base64url");
    if (attachmentTooLarge(bytes.byteLength)) {
      throw new Error(
        "That attachment is over 25 MB, so I skipped it.",
      );
    }
    return new Uint8Array(bytes);
  }
  if (!attachment.attachmentId) {
    throw new Error("That attachment could not be downloaded.");
  }
  const gmail = gmailClient(resolved.account);
  const response = await gmail.users.messages.attachments.get({
    userId: "me",
    messageId: resolved.message.id!,
    id: attachment.attachmentId,
  });
  const data = response.data.data;
  if (!data) {
    throw new Error("Gmail returned an empty attachment.");
  }
  const bytes = Buffer.from(data, "base64url");
  if (attachmentTooLarge(bytes.byteLength)) {
    throw new Error(
      "That attachment is over 25 MB, so I skipped it.",
    );
  }
  return new Uint8Array(bytes);
}

export function messageHeader(
  message: gmail_v1.Schema$Message,
  name: string,
): string {
  return (
    message.payload?.headers?.find(
      (item) => item.name?.toLowerCase() === name.toLowerCase(),
    )?.value ?? ""
  );
}

export function senderDisplay(fromHeader: string): string {
  const trimmed = fromHeader.trim();
  const named = trimmed.match(/^(.*)<.*>$/);
  if (named) {
    const name = named[1]!.replace(/['"]/g, "").trim();
    if (name) {
      return name;
    }
  }
  const email = trimmed.replace(/^.*<|>.*$/g, "").trim();
  return email || "unknown sender";
}
