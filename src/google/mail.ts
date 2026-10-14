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
