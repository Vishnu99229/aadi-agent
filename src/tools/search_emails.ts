import type { gmail_v1 } from "googleapis";
import type { LlmTool } from "../llm.js";
import {
  accountsForFilter,
  parseGoogleAccountFilter,
  type LoadedGoogleAccount,
} from "../google/auth.js";
import { gmailClient } from "../google/mail.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "search_emails",
  description:
    'Search Vishnu\'s Gmail (personal) and Epicode (work) accounts using Gmail search syntax. Returns message metadata plus snippets, never full bodies, each tagged account/tag (personal or work). Use queries such as "is:unread newer_than:1d", "from:person@example.com", "after:2026/10/01", or combinations of Gmail operators. Pass account "work" or "personal" to search one mailbox; omit it to search both.',
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "A Gmail search query using Gmail search operators.",
      },
      max_results: {
        type: "number",
        description:
          "Maximum messages to return per account. Defaults to 10 and is capped at 50.",
      },
      account: {
        type: "string",
        enum: ["personal", "work"],
        description:
          "Optional mailbox filter. Omit to search both connected accounts.",
      },
    },
    required: ["query"],
  },
};

function header(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string {
  return (
    headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())
      ?.value ?? ""
  );
}

async function searchAccount(
  account: LoadedGoogleAccount,
  query: string,
  maxResults: number,
): Promise<object[]> {
  const gmail = gmailClient(account);
  const result = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults,
  });

  const messages = result.data.messages ?? [];
  return Promise.all(
    messages.map(async (message) => {
      const response = await gmail.users.messages.get({
        userId: "me",
        id: message.id!,
        format: "metadata",
        metadataHeaders: ["From", "Subject", "Date"],
      });
      const headers = response.data.payload?.headers;

      return {
        account: account.id,
        tag: account.tag,
        id: response.data.id ?? message.id,
        from: header(headers, "From"),
        subject: header(headers, "Subject"),
        date: header(headers, "Date"),
        snippet: response.data.snippet ?? "",
      };
    }),
  );
}

export async function handler(input: unknown): Promise<string> {
  const values = input as {
    query?: unknown;
    max_results?: unknown;
    account?: unknown;
  };
  if (typeof values.query !== "string" || !values.query.trim()) {
    throw new Error("query must be a non-empty Gmail search query.");
  }

  const requestedMax =
    typeof values.max_results === "number" &&
    Number.isFinite(values.max_results)
      ? values.max_results
      : 10;
  const maxResults = Math.min(50, Math.max(1, Math.floor(requestedMax)));
  const query = values.query.trim();
  const accounts = await accountsForFilter(
    parseGoogleAccountFilter(values.account),
  );

  const emails = (
    await Promise.all(
      accounts.map((account) => searchAccount(account, query, maxResults)),
    )
  ).flat();

  if (emails.length === 0) {
    return "No emails found.";
  }

  return JSON.stringify(emails, null, 2);
}
