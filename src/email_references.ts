import {
  documentRefForTelegramMessage,
  getDocument,
  latestTelegramDocumentRef,
} from "./db.js";
import { addressIn, splitOwnerEmailCommand } from "./command_logic.js";

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

/** A Send/Edit/Discard card. Replying "send it" confirms that draft; it is not a new recipient. */
export function isDraftApprovalText(text: string | undefined): boolean {
  return /draft waiting for approval|draft approval|waiting for your send tap/i.test(text ?? "");
}

/** "Don't send", "cancel it", "stop sending". A meeting or task cancel is not an email cancel.
 *  Only the command part counts, so "saying we had to cancel the order" is not a cancel. */
export function isNegativeSendCommand(text: string): boolean {
  const command = splitOwnerEmailCommand(text).command;
  if (/\b(?:meeting|calendar|reminder|task|bill|event)\b/i.test(command) && !/\b(?:don'?t|do not|never)\s+send\b|\bstop\s+sending\b/i.test(command)) {
    return false;
  }
  return /\b(?:don'?t|do not|never)\s+send\b|\bstop\s+sending\b|\b(?:cancel|discard|unschedule)\b|\bstop\s+(?:it|that|this|the email|sending)\b/i.test(command);
}

export type OwnerEmailIntent = "cancel" | "resolve" | "draft" | "schedule" | "send" | "confirm_draft" | "none";

/** What this message asks for. OCR text is never consulted; only the owner's words.
 *  Intent words in the email body ("please send me the proposal") do not count. */
export function classifyOwnerEmailIntent(text: string, replyingToApproval = false): OwnerEmailIntent {
  const clean = text.trim();
  const command = splitOwnerEmailCommand(clean).command;
  if (isNegativeSendCommand(clean)) {
    return "cancel";
  }
  if (replyingToApproval && /^(?:please\s+)?send(?:\s+it)?(?:\s+now)?[.!]*$/i.test(clean)) {
    return "confirm_draft";
  }
  if (
    /\b(?:refer|extract|read|show)\b/i.test(command) &&
    /\b(?:address|e-?mail|photo|image|ocr)\b/i.test(command) &&
    !/\b(?:send|draft|schedule|compose|write)\b/i.test(command)
  ) {
    return "resolve";
  }
  if (/\b(?:draft|write|compose|prepare)\b/i.test(command) && !/\bsend\b/i.test(command)) {
    return "draft";
  }
  if (/\bschedule\b/i.test(command) && !/\bsend\s+(?:it\s+)?now\b/i.test(command)) {
    return "schedule";
  }
  if (/\bsend\b/i.test(command)) {
    return "send";
  }
  return "none";
}

/** A recipient being discussed is not the same as one explicitly referenced. */
export function refersToEarlierEmail(text: string, replying = false): boolean {
  // Cancellation belongs to its own workflow and must run before OCR discovery.
  if (isNegativeSendCommand(text)) {
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
    /\b(?:use|refer(?:ring)?(?:\s+to)?)\s+(?:this|that|the)\s+(?:e-?mail|email|address|contact)\b/i.test(text) ||
    /\b(?:e-?mail|address|recipient|contact)\b.{0,40}\b(?:in|from|on)\s+(?:the\s+)?(?:this|that)\b(?:\s+(?:message|photo|card|image|ocr|text))?(?:\s*[.!?])?$/i.test(text) ||
    /\b(?:in|from)\s+(?:the\s+)?(?:photo|image|ocr)\b/i.test(text);
  // Replying "send it" is a draft confirmation, not a request to mine a new address.
  const repliedAboutAddress = replying && hasEmailTopic && /\b(?:this|that|it|above)\b/i.test(text) && pointsBack;
  return (hasEmailTopic && pointsBack) || repliedAboutAddress;
}

/** "send it now" confirms the draft already in hand. A new email, even one that says "now", does not. */
export function confirmsExistingDraft(text: string): boolean {
  if (isNegativeSendCommand(text) || refersToEarlierEmail(text) || addressIn(text)) {
    return false;
  }
  if (/\b(?:cc|bcc|about|regarding|saying)\b/i.test(text)) {
    return false;
  }
  return /^(?:please\s+)?send(?:\s+(?:it|this|that))?(?:\s+(?:draft|e-?mail|card))?(?:\s+now)?[.!]*$/i.test(text.trim());
}

export interface ReferencedEmailRequest {
  intent: OwnerEmailIntent;
  to: string;
  cc: string[];
  bcc: string[];
  /** What the email should say. Not the raw Telegram command when he named the point. */
  instruction: string;
}

/** Cc and Bcc he named. The address or name is data; it does not authorize a send. */
export function copyRecipients(text: string): { cc: string[]; bcc: string[] } {
  const take = (field: "cc" | "bcc"): string[] => {
    const found: string[] = [];
    const pattern = new RegExp(`\\b${field}\\s+([^\\n.]+)`, "gi");
    for (const match of text.matchAll(pattern)) {
      const chunk = match[1]!.replace(/\s+\b(?:and\s+)?(?:about|regarding|saying|say|telling)\b[\s\S]*$/i, "").trim();
      for (const part of chunk.split(/\s*(?:,|;|\band\b)\s*/i)) {
        const name = part.replace(/^(?:the|to)\s+/i, "").trim();
        if (name && !/^(?:cc|bcc)$/i.test(name)) {
          found.push(name);
        }
      }
    }
    return [...new Set(found)];
  };
  return { cc: take("cc"), bcc: take("bcc") };
}

/** The point of the email, without the routing words or a trailing Cc list. */
export function compositionInstruction(text: string): string {
  const said = /\b(?:saying|say|telling|tell(?:\s+them)?)\s+([\s\S]+)$/i.exec(text);
  const about = /\b(?:about|regarding)\s+([\s\S]+)$/i.exec(text);
  const raw = (said?.[1] ?? about?.[1] ?? text).trim();
  return raw.replace(/\s*(?:,|;)?\s*\b(?:and\s+)?(?:cc|bcc)\b[\s\S]*$/i, "").trim() || text.trim();
}

export function buildReferencedEmailRequest(
  text: string,
  to: string,
  replyingToApproval = false,
): ReferencedEmailRequest {
  const copies = copyRecipients(text);
  return {
    intent: classifyOwnerEmailIntent(text, replyingToApproval),
    to,
    cc: copies.cc,
    bcc: copies.bcc,
    instruction: compositionInstruction(text),
  };
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
