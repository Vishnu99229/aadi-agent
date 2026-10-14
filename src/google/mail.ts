import { google, type gmail_v1 } from "googleapis";
import {
  accountsForFilter,
  isGoogleNotFound,
  type GoogleAccountId,
  type LoadedGoogleAccount,
} from "./auth.js";

export interface ResolvedGmailMessage {
  account: LoadedGoogleAccount;
  message: gmail_v1.Schema$Message;
}

export function gmailClient(account: LoadedGoogleAccount): gmail_v1.Gmail {
  return google.gmail({ version: "v1", auth: account.client });
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
  const raw = [
    `To: ${params.to.map(safeHeader).join(", ")}`,
    `Subject: ${safeHeader(params.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    encodeBody(params.body),
  ].join("\r\n");

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
