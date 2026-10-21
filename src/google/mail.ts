import { google, type gmail_v1 } from "googleapis";
import {
  accountsForFilter,
  GOOGLE_API_TIMEOUT_MS,
  isGoogleNotFound,
  type GoogleAccountId,
  type LoadedGoogleAccount,
} from "./auth.js";

export interface ResolvedGmailMessage {
  account: LoadedGoogleAccount;
  message: gmail_v1.Schema$Message;
}

export function gmailClient(account: LoadedGoogleAccount): gmail_v1.Gmail {
  return google.gmail({
    version: "v1",
    auth: account.client,
    timeout: GOOGLE_API_TIMEOUT_MS,
  });
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
}): Promise<{ draftId: string; threadId: string }> {
  const gmail = gmailClient(params.account);
  const toHeader = params.to.map(safeHeader).filter(Boolean).join(", ");
  if (!toHeader) {
    throw new Error("Missing To header for draft");
  }
  const raw = [
    `To: ${toHeader}`,
    `Subject: ${safeHeader(params.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    encodeBody(params.body),
  ].join("\r\n");
  console.log(
    `Draft MIME headers (body redacted):\n${mimeHeaderBlock(raw)}`,
  );

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
  const cc = params.cc ? safeHeader(params.cc) : "";
  return [
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    `Subject: ${safeHeader(params.subject)}`,
    `In-Reply-To: ${safeHeader(params.inReplyTo)}`,
    `References: ${references}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    encodeBody(params.body),
  ].join("\r\n");
}

/** The MIME header block only, used for logging before `drafts.create` so we
 *  can see exactly what Gmail receives without leaking the body. */
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
}): Promise<{ draftId: string }> {
  const gmail = gmailClient(params.account);
  const raw = buildThreadReplyMime(params);
  console.log(
    `Draft MIME headers (body redacted):\n${mimeHeaderBlock(raw)}`,
  );

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
