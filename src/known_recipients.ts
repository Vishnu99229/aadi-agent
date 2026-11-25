import { isKnownRecipientCached, recordKnownRecipient } from "./db.js";
import { messageHeader } from "./gmail_attachments.js";
import { getGoogleAccount, type GoogleAccountId } from "./google/auth.js";
import { gmailClient } from "./google/mail.js";
import { parseAddressList } from "./mail_helpers.js";

/** One Gmail lookup per account; past this it counts as "couldn't check": new. */
const CHECK_TIMEOUT_MS = 5_000;
/** Enough Sent hits to find the exact address among Gmail's looser matches. */
const MAX_HITS = 5;
const ACCOUNTS: readonly GoogleAccountId[] = ["work", "personal"];

export function normalizeAddress(email: string): string {
  return email.trim().toLowerCase();
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("known-check timed out")), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** He has sent at least one email from this account with this exact address on its
 *  To, Cc or Bcc. Gmail's search only narrows it down; the headers decide. */
async function sentFrom(accountId: GoogleAccountId, email: string): Promise<boolean> {
  const account = await getGoogleAccount(accountId);
  const gmail = gmailClient(account);
  const listed = await gmail.users.messages.list({
    userId: "me",
    q: `in:sent (to:${email} OR cc:${email} OR bcc:${email})`,
    maxResults: MAX_HITS,
  });
  for (const item of (listed.data.messages ?? []).slice(0, MAX_HITS)) {
    if (!item.id) {
      continue;
    }
    const message = await gmail.users.messages.get({
      userId: "me",
      id: item.id,
      format: "metadata",
      metadataHeaders: ["To", "Cc", "Bcc"],
    });
    const labels = message.data.labelIds;
    if (labels && !labels.includes("SENT")) {
      continue;
    }
    const addresses = ["To", "Cc", "Bcc"].flatMap((name) =>
      parseAddressList(messageHeader(message.data, name)).map((mailbox) => normalizeAddress(mailbox.email)),
    );
    if (addresses.includes(email)) {
      return true;
    }
  }
  return false;
}

/**
 * Which of these addresses he already knows: he has sent to that exact address from
 * either of his accounts. Decided here, from Gmail, never from a model's arguments.
 * An account that can't be checked (error, timeout, not signed in) gives no evidence,
 * so if neither says "sent", the address is new. Only "known" is cached.
 */
export async function knownRecipients(emails: readonly string[]): Promise<Set<string>> {
  const known = new Set<string>();
  for (const email of new Set(emails.map(normalizeAddress))) {
    if (!email) {
      continue;
    }
    if (isKnownRecipientCached(email)) {
      known.add(email);
      continue;
    }
    for (const accountId of ACCOUNTS) {
      let sent = false;
      try {
        sent = await withTimeout(sentFrom(accountId, email), CHECK_TIMEOUT_MS);
      } catch (error) {
        const errorType = error instanceof Error ? error.name : "UnknownError";
        console.error(`Known-check: ${accountId} lookup failed (${errorType}); no evidence from it`);
      }
      if (sent) {
        recordKnownRecipient(email, `sent:${accountId}`);
        known.add(email);
        break;
      }
    }
  }
  return known;
}

/** Aadi just sent to these on his say-so: they are known from now on. */
export function markRecipientsKnown(emails: readonly string[]): void {
  for (const email of emails) {
    const address = normalizeAddress(email);
    if (address) {
      recordKnownRecipient(address, "aadi_sent");
    }
  }
}
