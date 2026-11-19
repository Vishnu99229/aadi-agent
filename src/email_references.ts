import {
  documentRefForTelegramMessage,
  getDocument,
  latestTelegramDocumentRef,
} from "./db.js";
import { addressIn } from "./command_logic.js";

/** Only a recent, explicitly referenced source can select an email recipient.
 * The OCR text itself is data, never a command or send authorization. */
const ABOVE_WINDOW_MS = 30 * 60_000;
const REPLY_WINDOW_MS = 4 * 60 * 60_000;
const BINDING_WINDOW_MS = 2 * 60_000;
const EMAILS = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

export interface RepliedTelegramMessage {
  message_id: number;
  text?: string;
  caption?: string;
}

export type EmailReference =
  | { kind: "none" }
  | { kind: "missing" }
  | { kind: "many"; emails: string[] }
  | { kind: "one"; email: string; documentId?: number };

interface BoundRecipient {
  email: string;
  expiresAt: number;
}

/** In-flight only; keyed to a specific owner's message, not the chat's latest draft. */
const bindings = new Map<string, BoundRecipient>();

function key(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

export function bindEmailReferenceForTurn(
  chatId: number,
  messageId: number,
  email: string,
  now = Date.now(),
): void {
  for (const [id, entry] of bindings) {
    if (entry.expiresAt <= now) {
      bindings.delete(id);
    }
  }
  bindings.set(key(chatId, messageId), { email: email.toLowerCase(), expiresAt: now + BINDING_WINDOW_MS });
}

export function emailReferenceForTurn(
  chatId: number | undefined,
  messageId: number | undefined,
  now = Date.now(),
): string | undefined {
  if (chatId === undefined || messageId === undefined) {
    return undefined;
  }
  const entry = bindings.get(key(chatId, messageId));
  return entry && entry.expiresAt > now ? entry.email : undefined;
}

/** A recipient being discussed is not the same as one explicitly referenced. */
export function refersToEarlierEmail(text: string, replying = false): boolean {
  // Cancelling or editing an already scheduled email belongs to its own
  // workflow; OCR recipient discovery must never delay that cancellation.
  if (/\b(?:cancel|stop|discard|unschedule)\b/i.test(text)) {
    return false;
  }
  if (addressIn(text) && !/\b(?:verify|compare|check)\b/i.test(text)) {
    return false;
  }
  const hasEmailTopic = /\b(?:e-?mail(?:\s+id|\s+address)?|recipient|contact|address|photo|card|image)\b/i.test(text);
  const pointsBack =
    /\b(?:above|quoted)\b/i.test(text) ||
    /\b(?:previous|earlier|last|prior)\s+(?:message|photo|card|image|ocr)\b/i.test(text) ||
    /\b(?:this|that)\s+(?:message|photo|card|image|ocr)\b/i.test(text) ||
    /\b(?:e-?mail|address|recipient|contact)\b.{0,40}\b(?:in|from|on)\s+(?:the\s+)?(?:this|that)\b(?:\s+(?:message|photo|card|image|ocr|text))?(?:\s*[.!?])?$/i.test(text);
  const repliedToIt = replying && /\b(?:send|draft|compose|write|schedule|mail|email)\b.*\b(?:it|this|that)\b/i.test(text);
  return (hasEmailTopic && pointsBack) || repliedToIt;
}

export function addressesFromReference(text: string): string[] {
  return [...new Set((text.match(EMAILS) ?? []).map((email) => email.toLowerCase()))];
}

/** Reply target wins over recent OCR, even when the reply target has no address.
 * An unrelated older Gmail draft or contact is never used as a fallback. */
export function resolveEmailReference(input: {
  chatId: number;
  ownerText: string;
  replyTo?: RepliedTelegramMessage;
  now?: number;
}): EmailReference {
  if (!refersToEarlierEmail(input.ownerText, Boolean(input.replyTo))) {
    return { kind: "none" };
  }
  const now = input.now ?? Date.now();
  const reply = input.replyTo;
  const documentId = reply
    ? documentRefForTelegramMessage(input.chatId, reply.message_id, now - REPLY_WINDOW_MS)
    : latestTelegramDocumentRef(input.chatId, now - ABOVE_WINDOW_MS);
  // A quote names that exact visible Telegram message. If Aadi corrected an
  // OCR reading in its displayed answer, the quoted address takes precedence
  // over the raw OCR text; replying directly to a photo uses stored OCR.
  const documentEmails = documentId ? addressesFromReference(getDocument(documentId)?.extracted_text ?? "") : [];
  const quotedEmails = reply ? addressesFromReference(reply.text ?? reply.caption ?? "") : [];
  const emails = quotedEmails.length > 0 ? quotedEmails : documentEmails;
  if (emails.length === 0) {
    return { kind: "missing" };
  }
  if (emails.length > 1) {
    return { kind: "many", emails };
  }
  return { kind: "one", email: emails[0]!, ...(documentId ? { documentId } : {}) };
}
