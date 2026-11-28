/**
 * Who an email, an invite or a follow-up is for, from facts only: never from whether a
 * name happens to be in his message.
 *
 * Asked for a person (the model's argument), this finds exactly one address among, in
 * this order:
 *   1. the conversation: an address he typed (this message or his recent ones), a
 *      participant of an email, draft, event or contact a read tool showed on his own
 *      turn, the people on the Aadi message he replied to, the chat's open email or its
 *      last closed one, and the addresses a card just offered him;
 *   2. what is saved: a confirmed contact, the person he picked for this name before, an
 *      address he has sent to, a memory he told Aadi himself, and the To/Cc headers of
 *      his own Sent mail.
 * Headers and attendee lists only: an address that is only in an email body or a photo's
 * text is never one of these. (An address from a photo he replied to is send_email's
 * alone, and always goes through the new-address card: see sendEmailFromTool.) The first tier with any match decides; several there is a
 * question, none at all is a question. Downstream checks (the new-address card, the
 * recent-send card, domain blocks) still apply to whatever this returns.
 *
 * Matching a name against these records is a lookup, not a reading of what he meant:
 * every word of the name must be a word of the person's name or address.
 */
import type { gmail_v1 } from "googleapis";
import { parseAddressList, type ParsedMailbox } from "./address_list.js";
import { getPendingAction, lastEmailReference } from "./action_context.js";
import { addressesInMemory, isAutomatedAddress, mailboxMatches, nameTokens } from "./command_logic.js";
import {
  cardRecipientsOnMessage,
  conversationParticipants,
  draftCardForTelegramMessage,
  externalAddresses,
  latestDraftAction,
  listCanonicalContacts,
  listKnownRecipientEmails,
  recordConversationParticipants,
  searchMemories,
  telegramMessageParticipants,
} from "./db.js";
import { chosenContact } from "./contacts.js";
import { CONVERSATION_WINDOW_MS, repliedMessageForTurn } from "./email_references.js";
import { messageHeader } from "./gmail_attachments.js";
import { getGoogleAccount, type GoogleAccountId } from "./google/auth.js";
import { gmailClient } from "./google/mail.js";
import { knownRecipients } from "./known_recipients.js";
import { loadFollowupSelfAddresses } from "./mail_helpers.js";
import { isSelfEmail } from "./mom_logic.js";

const SENT_SEARCH_RESULTS = 25;
const SENT_SEARCH_TIMEOUT_MS = 5_000;
const MEMORY_RESULTS = 8;

export interface PeopleContext {
  chatId: number;
  /** His own message this turn. */
  messageId: number;
  /** His own words this turn: an address typed there is a fact he gave. */
  ownerText: string;
  /** Addresses a card in this chat just offered him to pick from. */
  offered?: readonly ParsedMailbox[];
  threadPeople?: readonly ParsedMailbox[];
  now?: Date;
}

export type FactMatch =
  | { kind: "one"; mailbox: ParsedMailbox; tier: "conversation" | "saved" }
  | { kind: "many"; options: ParsedMailbox[] }
  | { kind: "none"; reason: "address_not_known" | "no_match" | "self" };

interface Candidate {
  email: string;
  name: string;
}

function lower(email: string): string {
  return email.trim().toLowerCase();
}

function add(found: Map<string, string>, candidate: Candidate): void {
  const email = lower(candidate.email);
  if (!email.includes("@")) return;
  const name = (candidate.name ?? "").trim();
  const known = found.get(email) ?? "";
  found.set(email, name.length > known.length ? name : known);
}

function fromHeader(header: string | null | undefined): Candidate[] {
  return parseAddressList(header ?? "").map((mailbox) => ({ email: mailbox.email, name: mailbox.name }));
}

/** Tier 1: the people this conversation is about, from records. */
export function conversationPeople(context: PeopleContext): Map<string, string> {
  const now = context.now ?? new Date();
  const found = new Map<string, string>();
  for (const candidate of fromHeader(context.ownerText)) add(found, candidate);
  const pending = getPendingAction(context.chatId, now);
  for (const supplied of pending?.ownerSupplied ?? []) add(found, supplied);
  for (const person of [...(pending?.email?.to ?? []), ...(pending?.email?.cc ?? []), ...(pending?.meeting?.attendees ?? [])]) {
    if (person.resolved && person.email) add(found, person);
  }
  const closed = lastEmailReference(context.chatId, now);
  for (const candidate of fromHeader(closed?.to)) add(found, candidate);
  const since = new Date(now.getTime() - CONVERSATION_WINDOW_MS).toISOString();
  const participants = conversationParticipants(context.chatId, since);
  for (const person of participants) add(found, person);
  for (const person of context.threadPeople ?? []) add(found, person);
  const replied = repliedMessageForTurn(context.chatId, context.messageId, now.getTime());
  if (replied !== undefined) {
    for (const person of telegramMessageParticipants(replied)) add(found, person);
    const card = draftCardForTelegramMessage(replied);
    const action = card?.draft_id ? latestDraftAction(card.draft_id, card.google_account) : undefined;
    const named = new Map(
      [...fromHeader(action?.live_to_header ?? action?.to_header), ...fromHeader(action?.cc_header)].map((item) => [lower(item.email), item.name]),
    );
    for (const email of cardRecipientsOnMessage(replied)) add(found, { email, name: named.get(email) ?? "" });
  }
  for (const option of context.offered ?? []) add(found, option);
  // Draft and card records can carry a photo recipient. Independent sources can still establish the address.
  const independent = new Set([
    ...fromHeader(context.ownerText).map((item) => lower(item.email)),
    ...(pending?.ownerSupplied ?? []).map((item) => lower(item.email)),
    ...participants.filter(person => person.source === "email" || person.source === "owner_text").map(person => person.email),
    ...(context.threadPeople ?? []).map(person => person.email),
  ]);
  for (const email of externalAddresses(context.chatId)) {
    if (!independent.has(email)) found.delete(email);
  }
  return found;
}

/** The people on an Aadi message he replied to (a meeting brief's attendees, a draft
 *  card's To and Cc), recorded for this chat so his next messages can mean them too.
 *  Only called for his own reply, never a forward. */
export function noteRepliedPeople(chatId: number, repliedMessageId: number, now = new Date()): void {
  const people: Candidate[] = telegramMessageParticipants(repliedMessageId).map((person) => ({ email: person.email, name: person.name }));
  const card = draftCardForTelegramMessage(repliedMessageId);
  const action = card?.draft_id ? latestDraftAction(card.draft_id, card.google_account) : undefined;
  const named = new Map(
    [...fromHeader(action?.live_to_header ?? action?.to_header), ...fromHeader(action?.cc_header)].map((item) => [lower(item.email), item.name]),
  );
  for (const email of cardRecipientsOnMessage(repliedMessageId)) people.push({ email, name: named.get(email) ?? "" });
  if (people.length === 0) return;
  try {
    recordConversationParticipants(chatId, people, "reply", String(repliedMessageId), now);
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(`Recipient facts: replied people not recorded (${errorType})`);
  }
}

/** His confirmed contacts (email to name), and the addresses he picked for exactly this
 *  name before. Records only. */
export function confirmedContacts(query = ""): { people: Map<string, string>; picked: Set<string> } {
  const people = new Map<string, string>();
  for (const row of listCanonicalContacts()) {
    if (!row.confirmed) continue;
    let emails: string[] = [];
    try {
      emails = JSON.parse(row.emails_json) as string[];
    } catch {
      continue;
    }
    for (const email of emails) add(people, { email, name: row.display_name });
  }
  const choice = query ? chosenContact(query) : undefined;
  for (const email of choice?.emails ?? []) add(people, { email, name: choice?.name || query });
  return { people, picked: new Set((choice?.emails ?? []).map(lower)) };
}

/** Tier 2, without Gmail: confirmed contacts, the person he picked for this name before,
 *  known recipients and his own memories. */
function savedPeople(query: string, tokens: readonly string[]): Map<string, string> {
  const found = new Map<string, string>();
  const picked = query ? chosenContact(query) : undefined;
  for (const email of picked?.emails ?? []) add(found, { email, name: picked?.name || query });
  for (const row of listCanonicalContacts()) {
    if (!row.confirmed) continue;
    let emails: string[] = [];
    try {
      emails = JSON.parse(row.emails_json) as string[];
    } catch {
      continue;
    }
    for (const email of emails) add(found, { email, name: row.display_name });
  }
  for (const email of listKnownRecipientEmails()) add(found, { email, name: "" });
  if (tokens.length > 0) {
    for (const memory of searchMemories(tokens.join(" "), MEMORY_RESULTS)) {
      // Only what he told Aadi or confirmed: an automatic memory may have come from
      // something Aadi read.
      if (memory.source === "auto") continue;
      for (const email of addressesInMemory(memory.content, tokens)) add(found, { email, name: "" });
    }
  }
  return found;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("lookup timed out")), ms);
    work.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}

/** People he has sent to whose name or address has every one of these words: the To
 *  and Cc headers of his own Sent mail, in either mailbox. */
async function sentPeople(tokens: readonly string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (tokens.length === 0) return found;
  const wanted = tokens.map((token) => `(to:${token} OR cc:${token})`).join(" ");
  for (const accountId of ["work", "personal"] as GoogleAccountId[]) {
    try {
      await withTimeout((async () => {
        const gmail: gmail_v1.Gmail = gmailClient(await getGoogleAccount(accountId));
        const listed = await gmail.users.messages.list({ userId: "me", q: `in:sent ${wanted}`, maxResults: SENT_SEARCH_RESULTS });
        for (const item of listed.data.messages ?? []) {
          if (!item.id) continue;
          const { data: message } = await gmail.users.messages.get({
            userId: "me", id: item.id, format: "metadata", metadataHeaders: ["To", "Cc"],
          });
          if (message.labelIds && !message.labelIds.includes("SENT")) continue;
          for (const header of ["To", "Cc"]) {
            for (const mailbox of parseAddressList(messageHeader(message, header))) {
              if (mailboxMatches(mailbox, tokens)) add(found, mailbox);
            }
          }
        }
      })(), SENT_SEARCH_TIMEOUT_MS);
    } catch (error) {
      const errorType = error instanceof Error ? error.name : "UnknownError";
      console.error(`Recipient facts: ${accountId} Sent lookup failed (${errorType}); no evidence from it`);
    }
  }
  return found;
}

function eligible(found: Map<string, string>, selfAddresses: ReadonlySet<string>): Map<string, string> {
  return new Map([...found].filter(([email]) => !selfAddresses.has(email) && !isSelfEmail(email) && !isAutomatedAddress(email)));
}

function decide(
  found: Map<string, string>,
  tokens: readonly string[],
  tier: "conversation" | "saved",
  /** Addresses saved under exactly this name (his own earlier pick): a match as they are. */
  pickedFor: ReadonlySet<string> = new Set(),
): FactMatch | undefined {
  const matches = [...found]
    .map(([email, name]) => ({ email, name }))
    .filter((mailbox) => pickedFor.has(mailbox.email) || mailboxMatches(mailbox, tokens));
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return { kind: "one", mailbox: matches[0]!, tier };
  return { kind: "many", options: matches };
}

/** Exactly one address for this person, several to ask between, or none. */
export async function resolvePersonFromFacts(query: string, context: PeopleContext): Promise<FactMatch> {
  const selfAddresses = await loadFollowupSelfAddresses();
  const conversation = eligible(conversationPeople(context), selfAddresses);
  const typed = parseAddressList(query)[0]?.email;
  if (typed) {
    const email = lower(typed);
    if (selfAddresses.has(email) || isSelfEmail(email)) return { kind: "none", reason: "self" };
    if (conversation.has(email)) return { kind: "one", mailbox: { email, name: conversation.get(email) ?? "" }, tier: "conversation" };
    const saved = savedPeople("", []);
    if (saved.has(email) || (await knownRecipients([email])).has(email)) {
      return { kind: "one", mailbox: { email, name: saved.get(email) ?? "" }, tier: "saved" };
    }
    return { kind: "none", reason: "address_not_known" };
  }
  const tokens = nameTokens(query);
  if (tokens.length === 0) return { kind: "none", reason: "no_match" };
  const inConversation = decide(conversation, tokens, "conversation");
  if (inConversation) return inConversation;
  const saved = eligible(savedPeople(query, tokens), selfAddresses);
  for (const [email, name] of await sentPeople(tokens)) {
    if (!selfAddresses.has(email) && !isSelfEmail(email) && !isAutomatedAddress(email)) add(saved, { email, name });
  }
  const picked = new Set((chosenContact(query)?.emails ?? []).map(lower));
  return decide(saved, tokens, "saved", picked) ?? { kind: "none", reason: "no_match" };
}

/** What a refused person means for the model: never a guess at someone else. */
export function personRefusal(refusal: string, query: string, match: Extract<FactMatch, { kind: "none" }>): string {
  if (match.reason === "self") return `${refusal}: "${query}" is Vishnu's own address, so nothing went out.`;
  if (match.reason === "address_not_known") {
    return `${refusal}: ${query} isn't in Vishnu's own message, this conversation, his contacts or anyone he has emailed, so nothing went out. An address only inside an email body or a photo is never used. Ask Vishnu to confirm the address.`;
  }
  return `${refusal}: I have no address for "${query}" from this conversation or his contacts, so nothing went out. Look the person up with resolve_contact or search_emails and pass the address shown there, or ask Vishnu who he means.`;
}
