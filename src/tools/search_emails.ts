import { google, type gmail_v1 } from "googleapis";
import type { LlmTool } from "../llm.js";
import { getGoogleClient } from "../google/auth.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "search_emails",
  description:
    'Search Vishnu\'s Gmail using Gmail search syntax and return message metadata plus snippets, never full bodies. Use queries such as "is:unread newer_than:1d", "from:person@example.com", "after:2026/10/01", or combinations of Gmail operators.',
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
          "Maximum messages to return. Defaults to 10 and is capped at 50.",
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

export async function handler(input: unknown): Promise<string> {
  const values = input as { query?: unknown; max_results?: unknown };
  if (typeof values.query !== "string" || !values.query.trim()) {
    throw new Error("query must be a non-empty Gmail search query.");
  }

  const requestedMax =
    typeof values.max_results === "number" &&
    Number.isFinite(values.max_results)
      ? values.max_results
      : 10;
  const maxResults = Math.min(50, Math.max(1, Math.floor(requestedMax)));
  const auth = await getGoogleClient();
  const gmail = google.gmail({ version: "v1", auth });
  const result = await gmail.users.messages.list({
    userId: "me",
    q: values.query,
    maxResults,
  });

  const messages = result.data.messages ?? [];
  if (messages.length === 0) {
    return "No emails found.";
  }

  const emails = await Promise.all(
    messages.map(async (message) => {
      const response = await gmail.users.messages.get({
        userId: "me",
        id: message.id!,
        format: "metadata",
        metadataHeaders: ["From", "Subject", "Date"],
      });
      const headers = response.data.payload?.headers;

      return {
        id: response.data.id ?? message.id,
        from: header(headers, "From"),
        subject: header(headers, "Subject"),
        date: header(headers, "Date"),
        snippet: response.data.snippet ?? "",
      };
    }),
  );

  return JSON.stringify(emails, null, 2);
}
