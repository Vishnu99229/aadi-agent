import { randomUUID } from "node:crypto";
import { google, type gmail_v1 } from "googleapis";
import {
  accountsForFilter,
  GOOGLE_API_TIMEOUT_MS,
  isGoogleNotFound,
  type GoogleAccountId,
  type LoadedGoogleAccount,
} from "./auth.js";
import { encodeMimeHeader } from "./mime.js";
import {
  DEFAULT_SIGNATURE_HTML,
  htmlFromSchedulingBody,
} from "../security/auto_book.js";
import { assertTestSeam } from "../test_seam.js";

export interface ResolvedGmailMessage {
  account: LoadedGoogleAccount;
  message: gmail_v1.Schema$Message;
}

let fakeGmailClient:
  | ((account: LoadedGoogleAccount) => gmail_v1.Gmail)
  | undefined;

export function setGmailClientForTests(
  fake: ((account: LoadedGoogleAccount) => gmail_v1.Gmail) | undefined,
): void {
  assertTestSeam("setGmailClientForTests");
  fakeGmailClient = fake;
  signatureCache.clear();
}

export function gmailClient(account: LoadedGoogleAccount): gmail_v1.Gmail {
  if (fakeGmailClient) {
    return fakeGmailClient(account);
  }
  return google.gmail({
    version: "v1",
    auth: account.client,
    timeout: GOOGLE_API_TIMEOUT_MS,
  });
}

const SIGNATURE_TTL_MS = 60 * 60 * 1000;
const signatureCache = new Map<
  GoogleAccountId,
  { html: string; fetchedAt: number }
>();

/** The sending account's Gmail send-as signature (HTML), cached for an hour.
 *  Work falls back to the scheduling default; personal has none if unset. */
export async function signatureHtmlFor(
  account: LoadedGoogleAccount,
): Promise<string> {
  const cached = signatureCache.get(account.id);
  if (cached && Date.now() - cached.fetchedAt < SIGNATURE_TTL_MS) {
    return cached.html;
  }
  const fallback = account.id === "work" ? DEFAULT_SIGNATURE_HTML : "";
  try {
    const response = await gmailClient(account).users.settings.sendAs.list({
      userId: "me",
    });
    const entries = response.data.sendAs ?? [];
    const chosen =
      entries.find((entry) => entry.isDefault) ??
      entries.find((entry) => entry.isPrimary);
    const html = chosen?.signature?.trim() || fallback;
    signatureCache.set(account.id, { html, fetchedAt: Date.now() });
    return html;
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(`Signature fetch failed for ${account.id} (${errorType}).`);
    return fallback;
  }
}

const SIGNATURE_DELIMITER = "\n\n-- \n";

function decodeHtmlEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
    }
    if (code.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
    }
    return named[code.toLowerCase()] ?? entity;
  });
}

/** Plain-text fallback for an HTML signature. */
export function signaturePlainText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(div|p|tr|li|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

/** Splits a plain-text draft body from the signature Aadi appended after the
 *  standard "-- " line, so edits and previews only see the body. */
export function stripSignature(plain: string): { body: string; signed: boolean } {
  const index = plain.lastIndexOf(SIGNATURE_DELIMITER);
  return index < 0
    ? { body: plain, signed: false }
    : { body: plain.slice(0, index).trimEnd(), signed: true };
}

function mimeBodyLines(body: string, signatureHtml: string): string[] {
  if (!signatureHtml) {
    return [
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      encodeBody(body),
    ];
  }
  const boundary = `aadi_${randomUUID().replace(/-/g, "")}`;
  const plain = `${body.trimEnd()}${SIGNATURE_DELIMITER}${signaturePlainText(signatureHtml)}`;
  return [
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    encodeBody(plain),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    encodeBody(htmlFromSchedulingBody(body, signatureHtml)),
    `--${boundary}--`,
  ];
}

/** Full RFC 5322 message. Empty headers are dropped, Subject is RFC 2047
 *  encoded, and a non-empty signature makes it multipart/alternative with an
 *  HTML part plus a plain-text fallback, like the scheduling emails. */
export function buildMimeMessage(
  headers: ReadonlyArray<readonly [string, string]>,
  body: string,
  signatureHtml = "",
): string {
  const headerLines = headers
    .filter(([, value]) => value.trim())
    .map(([name, value]) =>
      name.toLowerCase() === "subject"
        ? `${name}: ${encodeMimeHeader(value)}`
        : `${name}: ${safeHeader(value)}`,
    );
  return [...headerLines, "MIME-Version: 1.0", ...mimeBodyLines(body, signatureHtml)].join(
    "\r\n",
  );
}

/** Header names only, for logs: recipients and subjects stay out of them. */
export function mimeHeaderNames(raw: string): string {
  return (mimeHeaderBlock(raw).match(/^[A-Za-z-]+(?=:)/gm) ?? []).join(", ");
}

export async function resolveGmailMessage(
  id: string,
  accountFilter?: GoogleAccountId,
  format: "full" | "metadata" = "full",
  metadataHeaders?: string[],
): Promise<ResolvedGmailMessage> {
  const accounts = await accountsForFilter(accountFilter);
  let lastError: unknown;

  for (const account of accounts) {
    try {
      const response = await gmailClient(account).users.messages.get({
        userId: "me",
        id,
        format,
        metadataHeaders,
      });
      return { account, message: response.data };
    } catch (error) {
      if (isGoogleNotFound(error)) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }

  void lastError;
  throw new Error("No Gmail message with that ID was found in the connected accounts.");
}

export async function resolveGmailDraft(
  draftId: string,
  accountFilter?: GoogleAccountId,
): Promise<{ account: LoadedGoogleAccount; draft: gmail_v1.Schema$Draft }> {
  const accounts = await accountsForFilter(accountFilter);
  let lastError: unknown;

  for (const account of accounts) {
    try {
      const response = await gmailClient(account).users.drafts.get({
        userId: "me",
        id: draftId,
        format: "full",
      });
      return { account, draft: response.data };
    } catch (error) {
      if (isGoogleNotFound(error)) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }

  void lastError;
  throw new Error("No Gmail draft with that ID was found in the connected accounts.");
}

export function messageHeader(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string {
  return (
    headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())
      ?.value ?? ""
  );
}

/** Every inline text/plain part of a message, decoded and joined. Skips
 *  text/plain attachments. */
export function plainTextBody(part: gmail_v1.Schema$MessagePart): string {
  const own =
    part.mimeType?.toLowerCase() === "text/plain" &&
    !part.filename &&
    part.body?.data
      ? [Buffer.from(part.body.data, "base64url").toString("utf8")]
      : [];
  return [...own, ...(part.parts ?? []).map(plainTextBody)]
    .filter(Boolean)
    .join("\n")
    .replace(/\r\n?/g, "\n");
}

function safeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function encodeBody(body: string): string {
  return Buffer.from(body, "utf8")
    .toString("base64")
    .match(/.{1,76}/g)!
    .join("\r\n");
}

export async function createNewEmailDraft(params: {
  account: LoadedGoogleAccount;
  to: string[];
  subject: string;
  body: string;
  /** HTML send-as signature; omitted means a plain-text-only draft. */
  signatureHtml?: string;
}): Promise<{ draftId: string; threadId: string }> {
  const gmail = gmailClient(params.account);
  const toHeader = params.to.map(safeHeader).filter(Boolean).join(", ");
  if (!toHeader) {
    throw new Error("Missing To header for draft");
  }
  const raw = buildMimeMessage(
    [
      ["To", toHeader],
      ["Subject", params.subject],
    ],
    params.body,
    params.signatureHtml,
  );
  console.log(`Draft MIME headers: ${mimeHeaderNames(raw)}`);

  const result = await gmail.users.drafts.create({
    userId: "me",
    requestBody: {
      message: {
        raw: Buffer.from(raw, "utf8").toString("base64url"),
      },
    },
  });

  if (!result.data.id) {
    throw new Error("Gmail created the draft without returning a draft ID.");
  }
  const threadId = result.data.message?.threadId || result.data.id;
  return { draftId: result.data.id, threadId };
}

export interface ThreadReplyMimeInput {
  to: string;
  cc?: string;
  subject: string;
  inReplyTo: string;
  references: string;
  body: string;
  /** HTML send-as signature; omitted means a plain-text-only draft. */
  signatureHtml?: string;
}

export function buildThreadReplyMime(params: ThreadReplyMimeInput): string {
  const to = safeHeader(params.to ?? "");
  if (!to) {
    // Hard safeguard: Gmail defaults to the authenticated user when the raw
    // MIME has no To. Refuse rather than silently addressing the owner.
    throw new Error("Missing To header for draft");
  }
  const references = [params.references, params.inReplyTo]
    .map(safeHeader)
    .filter(Boolean)
    .join(" ");
  return buildMimeMessage(
    [
      ["To", to],
      ["Cc", params.cc ?? ""],
      ["Subject", params.subject],
      ["In-Reply-To", params.inReplyTo],
      ["References", references],
    ],
    params.body,
    params.signatureHtml,
  );
}

/** The top-level MIME header block (contains recipients and subject, so it is
 *  for tests and inspection, not logs; log mimeHeaderNames instead). */
export function mimeHeaderBlock(raw: string): string {
  return raw.split("\r\n\r\n")[0] ?? raw;
}

export async function createThreadReplyDraft(params: {
  account: LoadedGoogleAccount;
  threadId: string;
  to: string;
  cc?: string;
  subject: string;
  inReplyTo: string;
  references: string;
  body: string;
  signatureHtml?: string;
}): Promise<{ draftId: string }> {
  const gmail = gmailClient(params.account);
  const raw = buildThreadReplyMime(params);
  console.log(`Draft MIME headers: ${mimeHeaderNames(raw)}`);

  const result = await gmail.users.drafts.create({
    userId: "me",
    requestBody: {
      message: {
        threadId: params.threadId,
        raw: Buffer.from(raw, "utf8").toString("base64url"),
      },
    },
  });

  if (!result.data.id) {
    throw new Error("Gmail created the draft without returning a draft ID.");
  }
  return { draftId: result.data.id };
}
