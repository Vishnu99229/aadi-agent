import type { gmail_v1 } from "googleapis";
import { accountMatchesEmail, type AccountRecord } from "./account_logic.js";
import { config } from "./config.js";
import { loadGoogleAccounts, type LoadedGoogleAccount } from "./google/auth.js";
import { gmailClient } from "./google/mail.js";
import { isSelfEmail } from "./mom_logic.js";

/** Mail helpers shared by sequences, sends, drafts, meetings and promises.
 *  Moved unchanged out of the old follow-up tracker (followups.ts and
 *  followup_logic.ts) when it was removed. */

const CONSUMER_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "outlook.com",
  "hotmail.com",
  "icloud.com",
  "me.com",
  "live.com",
]);

export interface ParsedMailbox {
  name: string;
  email: string;
}

export function parseAddressList(raw: string): ParsedMailbox[] {
  const results: ParsedMailbox[] = [];
  const seen = new Set<string>();
  const pattern =
    /(?:"([^"]+)"|([^,<>]+?))?\s*<([^>]+)>|([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const email = (match[3] ?? match[4] ?? "").trim().toLowerCase();
    if (!email || seen.has(email)) {
      continue;
    }
    seen.add(email);
    const quoted = match[1]?.trim() ?? "";
    const unquoted = match[2]?.trim() ?? "";
    const display = quoted || unquoted;
    results.push({
      name: displayName(display, email),
      email,
    });
  }
  return results;
}

function displayName(rawName: string, email: string): string {
  const cleaned = rawName.replace(/^["']|["']$/g, "").trim();
  if (cleaned && !cleaned.includes("@")) {
    return cleaned.replace(/\s+/g, " ");
  }
  const local = email.split("@")[0] ?? "";
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function titleCaseDomainLabel(domain: string): string {
  const label = domain.split(".")[0] ?? "";
  if (!label) {
    return "";
  }
  return label
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function companyFromEmail(
  email: string,
  accounts: AccountRecord[],
): string | undefined {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) {
    return undefined;
  }
  const matched = accounts.find((account) => accountMatchesEmail(account, email));
  if (matched) {
    return matched.name;
  }
  if (CONSUMER_DOMAINS.has(domain)) {
    return undefined;
  }
  return titleCaseDomainLabel(domain) || undefined;
}

export function isSelfSentRecipient(recipientHeader: string): boolean {
  const mailboxes = parseAddressList(recipientHeader);
  if (mailboxes.length === 0) {
    return false;
  }
  return mailboxes.every((item) => isSelfEmail(item.email));
}

/** Threads whose To+Cc land entirely on these domains are team-internal and
 *  don't need a client/partner follow-up (e.g. Epicode-only chatter). */
const INTERNAL_FOLLOWUP_DOMAINS = ["epicode.in"];
/** Recipient domains Vishnu never wants nudged about: food delivery, big
 *  consumer platforms, dev-ops notifications. Any sent email whose To ends
 *  on one of these is dropped before touching the LLM. */
const IGNORED_DOMAINS = new Set<string>([
  "swiggy.in",
  "zomato.com",
  "linkedin.com",
  "google.com",
  "amazon.in",
  "amazon.com",
  "github.com",
  "noreply.github.com",
]);

/** The two fields isAllInternal reads. */
interface SentCandidate {
  recipient: string;
  cc: string;
}

/** Pull the domain out of "Name <addr@host.tld>" or "addr@host.tld".
 *  Returns the lowercased host, or undefined when the input has no @. */
export function recipientDomain(recipientHeader: string): string | undefined {
  const match = recipientHeader
    .toLowerCase()
    .match(/[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})/);
  return match?.[1];
}

/** Profile addresses, send-as aliases, and SELF_EMAIL_ADDRESSES, lowercased. */
export function mergeSelfAddresses(
  ...groups: Array<Iterable<string>>
): Set<string> {
  const self = new Set<string>();
  for (const group of groups) {
    for (const item of group) {
      const email = item.trim().toLowerCase();
      if (email.includes("@")) {
        self.add(email);
      }
    }
  }
  return self;
}

export async function loadFollowupSelfAddresses(): Promise<Set<string>> {
  const found = [...config.selfEmailAddresses];
  let accounts: LoadedGoogleAccount[] = [];
  try {
    accounts = await loadGoogleAccounts();
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(`Follow-up self addresses: accounts failed (${errorType})`);
  }
  for (const account of accounts) {
    try {
      const gmail = gmailClient(account);
      const profile = await gmail.users.getProfile({ userId: "me" });
      if (profile.data.emailAddress) {
        found.push(profile.data.emailAddress);
      }
      const aliases = await gmail.users.settings.sendAs.list({ userId: "me" });
      for (const alias of aliases.data.sendAs ?? []) {
        if (alias.sendAsEmail) {
          found.push(alias.sendAsEmail);
        }
      }
    } catch (error) {
      const errorType = error instanceof Error ? error.name : "UnknownError";
      console.error(
        `Follow-up self addresses: ${account.id} lookup failed (${errorType})`,
      );
    }
  }
  return mergeSelfAddresses(found);
}

export function isAlgorithmicallyExcluded(
  recipient: string,
  cc: string,
  ownAddress: string,
  selfAddresses?: ReadonlySet<string>,
): boolean {
  const recipientAddresses = addresses(recipient);
  if (recipientAddresses.length === 0) {
    return true;
  }
  if (isSelfSentRecipient(recipient)) {
    return true;
  }
  const self = new Set<string>();
  if (ownAddress.trim()) {
    self.add(ownAddress.trim().toLowerCase());
  }
  for (const address of selfAddresses ?? []) {
    self.add(address.trim().toLowerCase());
  }
  if (
    recipientAddresses.every(
      (address) => self.has(address) || isSelfEmail(address),
    )
  ) {
    return true;
  }
  if (recipientAddresses.every(isNoReplyAddress)) {
    return true;
  }
  const primaryDomain = recipientDomain(recipient);
  if (primaryDomain && INTERNAL_FOLLOWUP_DOMAINS.includes(primaryDomain)) {
    return true;
  }
  if (primaryDomain && IGNORED_DOMAINS.has(primaryDomain)) {
    return true;
  }
  if (isAllInternal({ recipient, cc } as SentCandidate)) {
    return true;
  }
  return false;
}

function header(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string {
  return (
    headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())
      ?.value ?? ""
  );
}

function addresses(value: string): string[] {
  return (
    value
      .match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)
      ?.map((address) => address.toLowerCase()) ?? []
  );
}

function isNoReplyAddress(address: string): boolean {
  return /(?:^|[._-])(?:no-?reply|do-?not-?reply|mailer-daemon)(?:[._-]|@)/i.test(
    address,
  );
}

function isInternalAddress(address: string): boolean {
  return INTERNAL_FOLLOWUP_DOMAINS.some((domain) =>
    address.endsWith(`@${domain}`),
  );
}

function isAllInternal(candidate: SentCandidate): boolean {
  const list = [
    ...addresses(candidate.recipient),
    ...addresses(candidate.cc),
  ];
  return list.length > 0 && list.every(isInternalAddress);
}

export function isCalendarMessage(
  message: gmail_v1.Schema$Message,
  subject: string,
): boolean {
  const contentType = header(message.payload?.headers, "Content-Type");
  return (
    message.payload?.mimeType === "text/calendar" ||
    /text\/calendar/i.test(contentType) ||
    /^(?:accepted|declined|tentative|canceled|updated invitation):/i.test(
      subject.trim(),
    ) ||
    /\bcalendar invitation\b/i.test(subject)
  );
}

export async function getSentThreadMetadata(
  gmail: gmail_v1.Gmail,
  threadId: string,
): Promise<gmail_v1.Schema$Thread> {
  const response = await gmail.users.threads.get({
    userId: "me",
    id: threadId,
    format: "metadata",
    metadataHeaders: [
      "To",
      "Cc",
      "From",
      "Subject",
      "Message-ID",
      "References",
      "Content-Type",
      "List-Unsubscribe",
      "Auto-Submitted",
    ],
  });
  return response.data;
}
