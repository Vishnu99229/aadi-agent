import type { gmail_v1 } from "googleapis";
import {
  addressesInMemory,
  addressIn,
  isAutomatedAddress,
  mailboxMatches,
  nameTokens,
} from "./command_logic.js";
import { searchMemories } from "./db.js";
import { parseAddressList, type ParsedMailbox } from "./followup_logic.js";
import { messageHeader } from "./gmail_attachments.js";
import { isSelfEmail } from "./mom_logic.js";

const SEARCH_ROUNDS = 6;
const SEARCH_RESULTS = 25;
const MEMORY_RESULTS = 8;

export type RecipientMatch =
  | { kind: "one"; mailbox: ParsedMailbox }
  | { kind: "none" }
  | { kind: "many"; options: ParsedMailbox[] };

/** The fixed list as well as the looked-up one: the lookup can fail, and an email to
 *  himself must not be how anyone finds out. */
function isSelf(email: string, selfAddresses: ReadonlySet<string>): boolean {
  return selfAddresses.has(email) || isSelfEmail(email);
}

function fromFound(found: Map<string, string>): RecipientMatch {
  const options = [...found].map(([email, name]) => ({ email, name }));
  if (options.length === 0) {
    return { kind: "none" };
  }
  return options.length === 1 ? { kind: "one", mailbox: options[0]! } : { kind: "many", options };
}

function note(found: Map<string, string>, mailbox: ParsedMailbox): void {
  const email = mailbox.email.toLowerCase();
  const known = found.get(email) ?? "";
  found.set(email, mailbox.name.length > known.length ? mailbox.name : known);
}

/** Mail he never took part in, such as a newsletter, doesn't make someone a contact. */
function countsAsContact(message: gmail_v1.Schema$Message): boolean {
  if (message.labelIds?.includes("SENT")) {
    return true;
  }
  const precedence = messageHeader(message, "Precedence").toLowerCase();
  return (
    messageHeader(message, "List-Unsubscribe") === "" &&
    precedence !== "bulk" &&
    precedence !== "list"
  );
}

/** Each round leaves out the addresses already found, so a second person turns up
 *  however much mail the first one has. */
async function searchMailHistory(
  gmail: gmail_v1.Gmail,
  tokens: readonly string[],
  selfAddresses: ReadonlySet<string>,
  found: Map<string, string>,
): Promise<void> {
  const wanted = tokens.map((token) => `(from:${token} OR to:${token} OR cc:${token})`).join(" ");
  for (let round = 0; round < SEARCH_ROUNDS; round += 1) {
    const excluded = [...found.keys()]
      .map((email) => `-from:${email} -to:${email} -cc:${email}`)
      .join(" ");
    const listed = await gmail.users.messages.list({
      userId: "me",
      q: `${wanted} ${excluded}`.trim(),
      maxResults: SEARCH_RESULTS,
    });
    const before = found.size;
    for (const item of listed.data.messages ?? []) {
      if (!item.id) {
        continue;
      }
      const { data: message } = await gmail.users.messages.get({
        userId: "me",
        id: item.id,
        format: "metadata",
        metadataHeaders: ["From", "To", "Cc", "List-Unsubscribe", "Precedence"],
      });
      if (message.labelIds?.includes("DRAFT") || !countsAsContact(message)) {
        continue;
      }
      for (const header of ["From", "To", "Cc"]) {
        for (const mailbox of parseAddressList(messageHeader(message, header))) {
          if (
            mailboxMatches(mailbox, tokens) &&
            !isSelf(mailbox.email, selfAddresses) &&
            !isAutomatedAddress(mailbox.email)
          ) {
            note(found, mailbox);
          }
        }
      }
    }
    if (found.size === before) {
      return;
    }
  }
}

/** Finds who he means. An address he typed is taken as it is. A name is looked up
 *  on the thread first, then across his mail and memories. Never picks between two. */
export async function resolveRecipient(input: {
  gmail: gmail_v1.Gmail;
  query: string;
  selfAddresses: ReadonlySet<string>;
  threadMailboxes?: readonly ParsedMailbox[];
}): Promise<RecipientMatch> {
  const typed = addressIn(input.query);
  if (typed) {
    return isSelf(typed, input.selfAddresses)
      ? { kind: "none" }
      : { kind: "one", mailbox: { email: typed, name: "" } };
  }
  const tokens = nameTokens(input.query);
  if (tokens.length === 0) {
    return { kind: "none" };
  }
  const onThread = new Map<string, string>();
  for (const mailbox of input.threadMailboxes ?? []) {
    if (
      mailboxMatches(mailbox, tokens) &&
      !isSelf(mailbox.email, input.selfAddresses) &&
      !isAutomatedAddress(mailbox.email)
    ) {
      note(onThread, mailbox);
    }
  }
  if (onThread.size > 0) {
    return fromFound(onThread);
  }
  const found = new Map<string, string>();
  await searchMailHistory(input.gmail, tokens, input.selfAddresses, found);
  for (const memory of searchMemories(tokens.join(" "), MEMORY_RESULTS)) {
    // Only what he told Aadi or confirmed: an automatic memory may have come from
    // something it read, and read text can't choose a recipient.
    if (memory.source === "auto") {
      continue;
    }
    for (const email of addressesInMemory(memory.content, tokens)) {
      if (!isSelf(email, input.selfAddresses)) {
        note(found, { email, name: "" });
      }
    }
  }
  return fromFound(found);
}
