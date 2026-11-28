import {
  conversationParticipants, documentRefForTelegramMessage, externalAddresses, getDocument,
  listCanonicalContacts, pendingDraftActionForMessage, recordConversationParticipants, recordExternalAddress,
} from "./db.js";
import { config } from "./config.js";
import { parseAddressList, type ParsedMailbox } from "./address_list.js";
import { knownRecipients } from "./known_recipients.js";

export const CONVERSATION_WINDOW_MS = 3 * 60 * 60 * 1000;

const REPLY_WINDOW_MS = 4 * 60 * 60_000;
const BINDING_WINDOW_MS = 10 * 60_000;
const EMAILS = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

export interface RepliedTelegramMessage {
  message_id: number;
  photo?: unknown;
}

interface PhotoBinding {
  emails: string[];
  documentId: number;
}

const bindings = new Map<string, { photo: PhotoBinding; expiresAt: number }>();

function key(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

export function bindPhotoForTurn(input: {
  chatId: number;
  messageId: number;
  currentPhoto?: boolean;
  replyTo?: RepliedTelegramMessage;
  now?: number;
}): PhotoBinding | undefined {
  const now = input.now ?? Date.now();
  // The current message can have its own photo. Only an actual photo reply
  // may select an older document; a reply to an OCR summary does not.
  const current = input.currentPhoto
    ? documentRefForTelegramMessage(input.chatId, input.messageId, now - REPLY_WINDOW_MS)
    : undefined;
  const documentId = current ?? (input.replyTo?.photo
    ? documentRefForTelegramMessage(input.chatId, input.replyTo.message_id, now - REPLY_WINDOW_MS)
    : undefined);
  if (documentId === undefined) return undefined;
  const photo = { documentId, emails: addressesFromReference(getDocument(documentId)?.extracted_text ?? "") };
  for (const [id, entry] of bindings) {
    if (entry.expiresAt <= now) bindings.delete(id);
  }
  bindings.set(key(input.chatId, input.messageId), { photo, expiresAt: now + BINDING_WINDOW_MS });
  for (const email of photo.emails) recordExternalAddress(input.chatId, email, `document:${documentId}`, new Date(now));
  return photo;
}

export function photoForTurn(chatId: number | undefined, messageId: number | undefined, now = Date.now()): PhotoBinding | undefined {
  if (chatId === undefined || messageId === undefined) return undefined;
  const entry = bindings.get(key(chatId, messageId));
  return entry && entry.expiresAt > now ? entry.photo : undefined;
}

export function addressesFromReference(text: string): string[] {
  return [...new Set((text.match(EMAILS) ?? []).map(email => email.toLowerCase()))];
}

export function recordOwnerTypedEmailAddresses(chatId: number, text: string): void {
  const addresses = parseAddressList(text);
  if (addresses.length > 0) recordConversationParticipants(chatId, addresses, "owner_text", "");
}

interface RecipientSourceContext {
  confirmation?: { chatId: number; messageId: number };
  ownTurn?: boolean;
  userText?: string;
}

function independentlyRecordedRecipients(chatId: number, now: Date): Set<string> {
  const confirmed = new Set<string>();
  for (const contact of listCanonicalContacts()) {
    if (!contact.confirmed) continue;
    try {
      const emails: unknown = JSON.parse(contact.emails_json);
      if (!Array.isArray(emails)) continue;
      for (const email of emails) if (typeof email === "string") confirmed.add(email.trim().toLowerCase());
    } catch {
      // An unreadable contact supplies no recipient evidence.
    }
  }
  const since = new Date(now.getTime() - CONVERSATION_WINDOW_MS).toISOString();
  for (const person of conversationParticipants(chatId, since)) {
    if (person.source === "owner_text" || person.source === "email") confirmed.add(person.email);
  }
  return confirmed;
}

/** An address from a photo needs separate handling only until another source establishes it. */
export async function photoOnlyRecipients(
  context: RecipientSourceContext,
  recipients: readonly ParsedMailbox[],
  options: { photoAddress?: string; threadPeople?: readonly ParsedMailbox[]; now?: Date } = {},
): Promise<Set<string>> {
  const chatId = context.confirmation?.chatId;
  const exposed = chatId === undefined ? new Set<string>() : externalAddresses(chatId);
  if (options.photoAddress) exposed.add(options.photoAddress);
  const candidates = new Set(recipients.map(({ email }) => email).filter(email => exposed.has(email)));
  if (candidates.size === 0) return candidates;
  const independent = chatId === undefined ? new Set<string>() : independentlyRecordedRecipients(chatId, options.now ?? new Date());
  const typed = context.ownTurn ? parseAddressList(context.userText ?? "") : [];
  for (const { email } of [...typed, ...(options.threadPeople ?? [])]) independent.add(email);
  const unchecked = [...candidates].filter(email => !independent.has(email));
  const sent = await knownRecipients(unchecked);
  return new Set(unchecked.filter(email => !sent.has(email)));
}

export async function photoRecipientForNewEmail(
  context: RecipientSourceContext,
  to: readonly ParsedMailbox[],
  cc: readonly ParsedMailbox[],
  value: unknown,
  options: { threadPeople?: readonly ParsedMailbox[]; now?: Date } = {},
): Promise<{ recipient?: string; error?: string }> {
  const selected = typeof value === "string" ? value.trim().toLowerCase() : undefined;
  if (value !== undefined && (!selected || to.length !== 1 || to[0]?.email !== selected)) {
    return { error: "To must match the selected photo address." };
  }
  const restricted = await photoOnlyRecipients(context, [...to, ...cc], { ...options, photoAddress: selected });
  if (restricted.size === 0) return {};
  const photo = photoForTurn(context.confirmation?.chatId, context.confirmation?.messageId, options.now?.getTime());
  if ([...restricted].some(email => !photo?.emails.includes(email))) {
    return { error: "That photo address is unavailable. Reply directly to the photo or attach it to this message." };
  }
  const address = to[0]?.email;
  if (to.length !== 1 || !address || !restricted.has(address) || cc.some(({ email }) => restricted.has(email))) {
    return { error: "Use the linked photo address as the sole To recipient on a new email." };
  }
  return { recipient: address };
}

/** The Telegram message his own message replied to, for this turn only. It says which
 *  email he means ("put this email in a follow-up sequence"); it is never an instruction. */
const REPLIED_WINDOW_MS = 10 * 60_000;
const replied = new Map<string, { messageId: number; expiresAt: number }>();

export function bindRepliedMessageForTurn(
  chatId: number,
  messageId: number,
  repliedMessageId: number,
  now = Date.now(),
): void {
  for (const [id, entry] of replied) {
    if (entry.expiresAt <= now) {
      replied.delete(id);
    }
  }
  replied.set(key(chatId, messageId), { messageId: repliedMessageId, expiresAt: now + REPLIED_WINDOW_MS });
}

export function repliedMessageForTurn(
  chatId: number | undefined,
  messageId: number | undefined,
  now = Date.now(),
): number | undefined {
  if (chatId === undefined || messageId === undefined) {
    return undefined;
  }
  const entry = replied.get(key(chatId, messageId));
  return entry && entry.expiresAt > now ? entry.messageId : undefined;
}

/** Approval cards are posted to the owner's private chat. Telegram message IDs are chat-local. */
export function repliedDraftForTurn(chatId: number, messageId: number) {
  if (chatId !== config.ownerTelegramId) return undefined;
  const repliedTo = repliedMessageForTurn(chatId, messageId);
  return repliedTo === undefined ? undefined : pendingDraftActionForMessage(repliedTo);
}
