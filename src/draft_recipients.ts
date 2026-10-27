import {
  accountMatchesEmail,
  accountMatchesText,
  findAccountByName,
  type AccountRecord,
} from "./account_logic.js";
import type { ParsedMailbox } from "./followup_logic.js";
import { isSelfEmail } from "./mom_logic.js";

const EPICODE_SUFFIX = "@epicode.in";

export function isEpicodeEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith(EPICODE_SUFFIX);
}

export function formatMailbox(item: ParsedMailbox): string {
  const name = item.name.trim();
  if (name && !name.includes("@") && name.toLowerCase() !== item.email) {
    return `${name} <${item.email}>`;
  }
  return item.email;
}

export function formatMailboxList(items: ParsedMailbox[]): string {
  return items.map(formatMailbox).join(", ");
}

function dedupe(recipients: ParsedMailbox[]): ParsedMailbox[] {
  const seen = new Set<string>();
  const result: ParsedMailbox[] = [];
  for (const item of recipients) {
    const email = item.email.trim().toLowerCase();
    if (!email || isSelfEmail(email) || seen.has(email)) {
      continue;
    }
    seen.add(email);
    result.push({ name: item.name, email });
  }
  return result;
}

function domainOf(email: string): string {
  return email.split("@")[1]?.toLowerCase() ?? "";
}

function personNamedInHint(item: ParsedMailbox, hint: string): boolean {
  const lower = hint.toLowerCase();
  if (lower.includes(item.email)) {
    return true;
  }
  const local = item.email.split("@")[0] ?? "";
  if (local.length >= 3 && lower.includes(local.toLowerCase())) {
    return true;
  }
  return item.name
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length >= 3)
    .some((token) => lower.includes(token));
}

function pickProspect(
  externals: ParsedMailbox[],
  hint: string,
  accounts: AccountRecord[],
): ParsedMailbox[] {
  const trimmed = hint.trim();
  if (!trimmed) {
    return [];
  }
  const named = externals.filter((item) => personNamedInHint(item, trimmed));
  if (named.length > 0 && named.length < externals.length) {
    return named;
  }
  const matchedAccounts = [
    ...findAccountByName(accounts, trimmed),
    ...accounts.filter((account) => accountMatchesText(account, trimmed)),
  ];
  const seen = new Set<number>();
  const uniqueAccounts = matchedAccounts.filter((account) => {
    if (seen.has(account.id)) {
      return false;
    }
    seen.add(account.id);
    return true;
  });
  const fromAccount = externals.filter((item) =>
    uniqueAccounts.some((account) => accountMatchesEmail(account, item.email)),
  );
  if (fromAccount.length > 0 && fromAccount.length < externals.length) {
    return fromAccount;
  }
  return [];
}

/** Default To/Cc for a meeting reminder or new mail to attendees.
 *  External (non-epicode.in) in To; epicode.in in Cc. When more than one
 *  external company is present, the prospect (matched account or a person
 *  named in `hint`) stays in To and other externals move to Cc. */
export function splitDraftRecipients(
  recipients: ParsedMailbox[],
  hint: string,
  accounts: AccountRecord[],
): { to: ParsedMailbox[]; cc: ParsedMailbox[] } {
  const unique = dedupe(recipients);
  const internal = unique.filter((item) => isEpicodeEmail(item.email));
  const external = unique.filter((item) => !isEpicodeEmail(item.email));
  if (external.length === 0) {
    return { to: internal, cc: [] };
  }
  const domains = new Set(external.map((item) => domainOf(item.email)));
  if (domains.size <= 1) {
    return { to: external, cc: internal };
  }
  const prospect = pickProspect(external, hint, accounts);
  if (prospect.length === 0) {
    return { to: external, cc: internal };
  }
  const prospectEmails = new Set(prospect.map((item) => item.email));
  return {
    to: prospect,
    cc: [
      ...internal,
      ...external.filter((item) => !prospectEmails.has(item.email)),
    ],
  };
}
