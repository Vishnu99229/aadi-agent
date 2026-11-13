import type { gmail_v1 } from "googleapis";
import type { LlmTool } from "../llm.js";
import {
  accountsForFilter,
  parseGoogleAccountFilter,
  type LoadedGoogleAccount,
} from "../google/auth.js";
import { gmailClient } from "../google/mail.js";
import { peopleNamedInQuery, rewriteQuery, type Contact, type NamedInQuery } from "../contact_logic.js";
import { askWhichContact, type UnresolvedContact } from "../contact_questions.js";
import { resolveContact } from "../contacts.js";
import type { ToolTurn } from "./index.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "search_emails",
  description:
    'Search personal and work Gmail. Returns metadata and snippets, not full bodies. Gmail query syntax, e.g. "is:unread newer_than:1d". Omit account to search both mailboxes. For mail from or to a person, put their name as Vishnu said it in from: or to: (from:hardik, from:"hardik singh"): the name is resolved to that one person\'s address, and if several people share it Vishnu is asked which one.',
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
        metadataHeaders: ["From", "To", "Cc", "Subject", "Date"],
      });
      const headers = response.data.payload?.headers;

      return {
        account: account.id,
        tag: account.tag,
        id: response.data.id ?? message.id,
        from: header(headers, "From"),
        to: header(headers, "To"),
        cc: header(headers, "Cc"),
        subject: header(headers, "Subject"),
        date: header(headers, "Date"),
        snippet: response.data.snippet ?? "",
      };
    }),
  );
}

/** True when any mail at all carries this name, whatever the rest of the query asked for. */
async function nameAppearsInMail(accounts: LoadedGoogleAccount[], name: string): Promise<boolean> {
  const found = await Promise.all(
    accounts.map(async (account) => {
      const result = await gmailClient(account).users.messages.list({
        userId: "me",
        q: `from:(${name}) OR to:(${name}) OR cc:(${name})`,
        maxResults: 1,
      });
      return (result.data.messages ?? []).length > 0;
    }),
  );
  return found.some(Boolean);
}

export async function handler(input: unknown, turn?: ToolTurn): Promise<string> {
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
  const accounts = await accountsForFilter(
    parseGoogleAccountFilter(values.account),
  );

  // A name in from:/to:/cc: means one person. Gmail would match everyone who
  // shares it, so the name is resolved first: one person becomes their address,
  // and several are Vishnu's to choose between on his own turn.
  const ownTurn = turn?.confirmation !== undefined && Boolean(turn.userText?.trim());
  const resolved: Array<{ named: NamedInQuery; contact: Contact }> = [];
  let unknown: { name: string; resolution: UnresolvedContact } | undefined;
  for (const named of peopleNamedInQuery(values.query)) {
    const resolution = await resolveContact(named.name);
    if (resolution.kind === "one") {
      resolved.push({ named, contact: resolution.contact });
    } else if (resolution.kind === "many" && ownTurn) {
      return askWhichContact(turn ?? {}, named.name, resolution);
    } else if (resolution.kind === "none" && !resolution.company) {
      unknown ??= { name: named.name, resolution };
    }
  }
  const query = rewriteQuery(values.query, resolved).trim();

  const emails = (
    await Promise.all(
      accounts.map((account) => searchAccount(account, query, maxResults)),
    )
  ).flat();

  if (emails.length === 0) {
    // Nothing matched and the name is nowhere in his mail or contacts: that's
    // an unknown person, not an empty inbox.
    if (unknown && ownTurn && !(await nameAppearsInMail(accounts, unknown.name))) {
      return askWhichContact(turn ?? {}, unknown.name, unknown.resolution);
    }
    return "No emails found.";
  }

  return JSON.stringify(emails, null, 2);
}
