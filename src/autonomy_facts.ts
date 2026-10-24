import { decodedAccounts } from "./accounts.js";
import { getFollowups } from "./db.js";
import type { DraftApprovalPreview } from "./approvals.js";

/** Lowercase host portion of a comma-separated address header. */
function recipientDomains(toHeader: string): string[] {
  const matches = toHeader
    .toLowerCase()
    .match(/[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})/g);
  if (!matches) return [];
  return [
    ...new Set(
      matches.map((item) => {
        const at = item.indexOf("@");
        return at >= 0 ? item.slice(at + 1) : item;
      }),
    ),
  ];
}

/** True if ANY recipient domain is in the accounts table. */
function isKnownClientDomain(domains: string[]): boolean {
  const known = new Set<string>();
  for (const account of decodedAccounts()) {
    for (const domain of account.email_domains) known.add(domain.toLowerCase());
  }
  return domains.some((d) => known.has(d));
}

/** Count prior sent threads whose recipient matched any of these domains.
 *  Used as a tenure signal: domain_seen_count < 2 = essentially new. */
function priorSendsToDomains(domains: string[]): number {
  if (domains.length === 0) return 0;
  const followups = getFollowups();
  let count = 0;
  for (const row of followups) {
    const rowMatches = recipientDomains(row.recipient).some((d) =>
      domains.includes(d),
    );
    if (rowMatches) count += 1;
  }
  return count;
}

/** Build autonomy facts for a draft reply. The caller MUST pass
 *  hasAttachment deterministically; we don't fish it out of the Gmail
 *  draft to avoid an extra API call in the approval path. */
export function buildAutonomyFacts(input: {
  toHeader: string;
  hasAttachment: boolean;
}): NonNullable<DraftApprovalPreview["autonomyFacts"]> {
  const domains = recipientDomains(input.toHeader);
  const is_known_client = isKnownClientDomain(domains);
  const domain_seen_count = priorSendsToDomains(domains);
  return {
    is_known_client,
    has_attachment: input.hasAttachment,
    domain_seen_count,
  };
}
