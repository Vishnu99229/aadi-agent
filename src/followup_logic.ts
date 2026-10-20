import { accountMatchesEmail, type AccountRecord } from "./account_logic.js";
import { isSelfEmail } from "./mom_logic.js";

const TIME_ZONE = "Asia/Kolkata";
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

export function formatToLine(
  recipientHeader: string,
  accounts: AccountRecord[],
): string {
  const mailboxes = parseAddressList(recipientHeader);
  if (mailboxes.length === 0) {
    const fallback = recipientHeader.trim();
    return fallback ? `To: ${fallback}` : "To: unknown";
  }
  if (isSelfSentRecipient(recipientHeader)) {
    return "To: (sent to yourself)";
  }
  const parts = mailboxes
    .filter((item) => !isSelfEmail(item.email))
    .map((item) => {
      const company = companyFromEmail(item.email, accounts);
      if (company && company.toLowerCase() !== item.name.toLowerCase()) {
        return `${item.name}, ${company}`;
      }
      return company ? company : item.name || item.email;
    });
  if (parts.length === 0) {
    return "To: (sent to yourself)";
  }
  return `To: ${parts.join("; ")}`;
}

function kolkataParts(
  iso: string,
  options: Intl.DateTimeFormatOptions,
): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    ...options,
  }).formatToParts(new Date(iso));
  return Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

export function formatSentAt(iso: string): string {
  const values = kolkataParts(iso, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const period = (values.dayPeriod ?? "am").toLowerCase().replace(/\./g, "");
  return `${values.weekday} ${values.day} ${values.month}, ${values.hour}:${values.minute} ${period}`;
}

export function formatSnoozeUntil(iso: string): string {
  const values = kolkataParts(iso, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  return `${values.weekday} ${values.day} ${values.month}`;
}

export function waitingDays(lastSentAt: string, now = Date.now()): number {
  return Math.max(
    0,
    Math.floor((now - new Date(lastSentAt).getTime()) / (24 * 60 * 60 * 1_000)),
  );
}

export function formatWaitingPhrase(days: number): string {
  if (days === 1) {
    return "waiting 1 day";
  }
  return `waiting ${days} days`;
}

export function cleanSubjectTitle(subject: string): string {
  return subject.replace(/^(?:re|fwd|fw)\s*:\s*/gi, "").trim() || "(no subject)";
}

export function neededLine(snippet: string | undefined): string {
  const cleaned = (snippet ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    return "a reply to this thread";
  }
  return cleaned.length > 140 ? `${cleaned.slice(0, 137)}...` : cleaned;
}

export function firstNameFromRecipient(recipientHeader: string): string {
  const mailbox = parseAddressList(recipientHeader).find(
    (item) => !isSelfEmail(item.email),
  );
  const name = mailbox?.name.trim() ?? "";
  const first = name.split(/\s+/)[0];
  return first && first !== "(sent" ? first : "there";
}

export function followupDraftBody(recipientHeader: string): string {
  return [
    `Hi ${firstNameFromRecipient(recipientHeader)},`,
    "",
    "Just following up on this — did you get a chance to look?",
    "",
    "Thanks,",
    "Vishnu",
  ].join("\n");
}

export interface FollowupDisplay {
  id: number;
  title: string;
  toLine: string;
  sentLine: string;
  needed: string;
  note?: string;
}

export function formatFollowupBlock(
  index: number,
  display: FollowupDisplay,
): string {
  const lines = [
    `${index}. ${display.title}`,
    `   ${display.toLine}`,
    `   ${display.sentLine}`,
    `   Needed: ${display.needed}`,
  ];
  if (display.note) {
    lines.push(`   ${display.note}`);
  }
  return lines.join("\n");
}

export function formatFollowupPanelText(
  displays: FollowupDisplay[],
  heading?: string,
): string {
  if (displays.length === 0) {
    return heading ? `${heading}\nNone.` : "No emails waiting on a reply.";
  }
  const blocks = displays.map((display, index) =>
    formatFollowupBlock(index + 1, display),
  );
  return heading ? `${heading}\n\n${blocks.join("\n\n")}` : blocks.join("\n\n");
}
