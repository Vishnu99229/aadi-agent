import { documentRefForTelegramMessage, externalAddresses, getDocument, pendingDraftActionForMessage, recordExternalAddress } from "./db.js";
import { config } from "./config.js";
import { parseAddressList } from "./address_list.js";

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

export function unlinkedPhotoAddress(chatId: number | undefined, ownerText: string, headers: string[]): string | undefined {
  if (chatId === undefined) return undefined;
  const typed = new Set(addressesFromReference(ownerText));
  const external = new Set(externalAddresses(chatId));
  return headers.flatMap(header => parseAddressList(header)).map(({ email }) => email.toLowerCase())
    .find(email => external.has(email) && !typed.has(email));
}

/** A model-provided address is data and must match one extracted from the linked photo. */
export function selectedPhotoAddress(value: unknown, photo: PhotoBinding | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const address = value.trim().toLowerCase();
  return photo?.emails.includes(address) && parseAddressList(address)[0]?.email === address ? address : undefined;
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
