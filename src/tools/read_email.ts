import type { gmail_v1 } from "googleapis";
import type { LlmTool } from "../llm.js";
import { parseGoogleAccountFilter } from "../google/auth.js";
import { resolveGmailMessage } from "../google/mail.js";

const BODY_LIMIT = 3000;

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "read_email",
  description:
    "Read one Gmail message by id from search_emails. Returns headers and a cleaned body (quoted replies stripped, 3000-character cap).",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The Gmail message ID returned by search_emails.",
      },
      account: {
        type: "string",
        enum: ["personal", "work"],
        description:
          "Optional mailbox. Omit to try connected accounts until the ID is found.",
      },
    },
    required: ["id"],
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

function decodeBody(data: string | null | undefined): string {
  return data ? Buffer.from(data, "base64url").toString("utf8") : "";
}

function collectParts(
  part: gmail_v1.Schema$MessagePart,
  mimeType: "text/plain" | "text/html",
): string[] {
  const content: string[] = [];

  if (part.mimeType?.toLowerCase() === mimeType && part.body?.data) {
    content.push(decodeBody(part.body.data));
  }

  for (const child of part.parts ?? []) {
    content.push(...collectParts(child, mimeType));
  }

  return content;
}

function decodeHtmlEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };

  return text.replace(
    /&(#x[\da-f]+|#\d+|[a-z]+);/gi,
    (entity, code: string) => {
      if (code.startsWith("#x")) {
        return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
      }
      if (code.startsWith("#")) {
        return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
      }
      return named[code.toLowerCase()] ?? entity;
    },
  );
}

function htmlToText(html: string): string {
  const quoteStarts = [
    html.search(/<[^>]+class=["'][^"']*\bgmail_quote\b/i),
    html.search(/<blockquote\b/i),
  ].filter((index) => index >= 0);
  const withoutQuotes =
    quoteStarts.length > 0 ? html.slice(0, Math.min(...quoteStarts)) : html;

  return decodeHtmlEntities(
    withoutQuotes
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(div|p|li|tr|h[1-6])>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, ""),
  );
}

function removeQuotedReplies(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n");
  const markers = [
    /^On .+wrote:\s*$/im,
    /^-{2,}\s*Original Message\s*-{2,}\s*$/im,
    /^From:\s.+\n(?:Sent|Date):\s/im,
    /^_{5,}\s*$/m,
  ];
  const markerIndexes = markers
    .map((marker) => normalized.search(marker))
    .filter((index) => index >= 0);
  const currentMessage =
    markerIndexes.length > 0
      ? normalized.slice(0, Math.min(...markerIndexes))
      : normalized;

  return currentMessage
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncate(text: string): string {
  const characters = Array.from(text);
  if (characters.length <= BODY_LIMIT) {
    return text;
  }
  return `${characters.slice(0, BODY_LIMIT).join("")}\n[truncated]`;
}

export async function handler(input: unknown): Promise<string> {
  const values = input as { id?: unknown; account?: unknown };
  if (typeof values.id !== "string" || !values.id.trim()) {
    throw new Error("id must be a non-empty Gmail message ID.");
  }

  const { account, message } = await resolveGmailMessage(
    values.id.trim(),
    parseGoogleAccountFilter(values.account),
  );
  const payload = message.payload;
  if (!payload) {
    throw new Error("The email did not contain a readable MIME payload.");
  }

  const plainParts = collectParts(payload, "text/plain");
  const htmlParts = collectParts(payload, "text/html");
  const rawBody =
    plainParts.length > 0
      ? plainParts.join("\n")
      : htmlToText(htmlParts.join("\n"));
  const body = truncate(removeQuotedReplies(rawBody));
  const headers = payload.headers;

  return [
    `Account: ${account.label}`,
    `Tag: ${account.tag}`,
    `From: ${header(headers, "From")}`,
    `To: ${header(headers, "To")}`,
    `Subject: ${header(headers, "Subject")}`,
    `Date: ${header(headers, "Date")}`,
    "",
    body || "(No plain-text body found.)",
  ].join("\n");
}
