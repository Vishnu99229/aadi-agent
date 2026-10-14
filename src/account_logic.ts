export type WaitingOn = "me" | "them" | "nobody";
export type AccountRelationship = "partner" | "end_client";

export interface AccountFields {
  name: string;
  aliases: string[];
  email_domains: string[];
  relationship: AccountRelationship;
  via_partner_id: number | null;
  people: string[];
  stage: string;
  next_step: string;
  next_step_due: string | null;
  waiting_on: WaitingOn;
  last_activity_at: string | null;
}

export interface AccountRecord extends AccountFields {
  id: number;
  created_at: string;
}

export function decodeAccount(row: {
  id: number;
  name: string;
  aliases: string;
  email_domains: string;
  relationship?: AccountRelationship | string | null;
  via_partner_id?: number | null;
  people?: string;
  stage: string;
  next_step: string;
  next_step_due: string | null;
  waiting_on: WaitingOn;
  last_activity_at: string | null;
  created_at: string;
}): AccountRecord {
  const relationship =
    row.relationship === "end_client" ? "end_client" : "partner";
  return {
    id: row.id,
    name: row.name,
    aliases: parseJsonList(row.aliases),
    email_domains: parseJsonList(row.email_domains).map(normalizeDomain),
    relationship,
    via_partner_id: row.via_partner_id ?? null,
    people: parseJsonList(row.people ?? "[]"),
    stage: row.stage,
    next_step: row.next_step,
    next_step_due: row.next_step_due,
    waiting_on: row.waiting_on,
    last_activity_at: row.last_activity_at,
    created_at: row.created_at,
  };
}

export interface InteractionLine {
  kind: "email" | "note";
  date: string;
  dateMs: number;
  text: string;
}

export interface OpenItemLine {
  kind: "follow-up" | "task" | "promised";
  text: string;
}

const STAGE_WORDS: Array<{ pattern: RegExp; stage: string }> = [
  { pattern: /\bwon\b/i, stage: "won" },
  { pattern: /\blost\b/i, stage: "lost" },
  { pattern: /\bon hold\b/i, stage: "on hold" },
  { pattern: /\bnegotiat/i, stage: "negotiation" },
  { pattern: /\bproposal\b/i, stage: "proposal" },
  { pattern: /\bdiscussion\b/i, stage: "discussion" },
];

export function parseWaitingOn(value: unknown): WaitingOn {
  if (value === "me" || value === "them" || value === "nobody") {
    return value;
  }
  throw new Error('waiting_on must be "me", "them", or "nobody".');
}

export function parseRelationship(value: unknown): AccountRelationship {
  if (value === "partner" || value === "end_client") {
    return value;
  }
  throw new Error('relationship must be "partner" or "end_client".');
}

export function parseStringList(value: unknown): string[] {
  if (value === undefined || value === null || value === "") {
    return [];
  }
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value !== "string") {
    throw new Error("aliases and email_domains must be a string or string array.");
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/^https?:\/\//, "")
    .split("/")[0] ?? "";
}

export function parseJsonList(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  } catch {
    return raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
}

export function accountNeedles(account: AccountFields): string[] {
  const needles = [
    account.name,
    ...account.aliases,
    ...account.email_domains.map(normalizeDomain),
  ]
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length >= 3);
  return [...new Set(needles)];
}

export function accountNameNeedles(account: AccountFields): string[] {
  return [...new Set(
    [account.name, ...account.aliases]
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length >= 3 && !item.includes("@")),
  )];
}

export function namesMatchText(account: AccountFields, haystack: string): boolean {
  const lower = haystack.toLowerCase();
  return accountNameNeedles(account).some((needle) => lower.includes(needle));
}

export function extractEmailAddresses(header: string): string[] {
  return [...header.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)].map(
    (match) => match[0]!.toLowerCase(),
  );
}

export function accountMatchesText(
  account: AccountFields,
  haystack: string,
): boolean {
  const lower = haystack.toLowerCase();
  return accountNeedles(account).some((needle) => lower.includes(needle));
}

export function accountMatchesEmail(
  account: AccountFields,
  email: string,
): boolean {
  const addresses = extractEmailAddresses(email);
  const domains =
    addresses.length > 0
      ? addresses.map((address) => address.slice(address.lastIndexOf("@") + 1))
      : [
          email.includes("@")
            ? email.toLowerCase().slice(email.lastIndexOf("@") + 1)
            : "",
        ];
  return account.email_domains.some((item) => {
    const wanted = normalizeDomain(item);
    return (
      wanted !== "" &&
      domains.some((domain) => domain === wanted || domain.endsWith(`.${wanted}`))
    );
  });
}

function headerInvolvesAccount(
  account: AccountFields,
  from: string,
  to: string,
): boolean {
  return (
    accountMatchesEmail(account, from) ||
    accountMatchesEmail(account, to) ||
    namesMatchText(account, `${from} ${to}`)
  );
}

export function accountMatchesThread(
  account: AccountFields,
  headers: { from: string; to: string; subject: string; body?: string },
  _partner?: AccountFields | null,
): boolean {
  if (account.relationship === "end_client") {
    if (accountMatchesEmail(account, headers.from) || accountMatchesEmail(account, headers.to)) {
      return true;
    }
    return namesMatchText(
      account,
      `${headers.subject}\n${headers.body ?? ""}`,
    );
  }
  if (headerInvolvesAccount(account, headers.from, headers.to)) {
    return true;
  }
  return namesMatchText(account, headers.subject);
}

export function partnerFor(
  account: AccountFields,
  accounts: AccountRecord[],
): AccountRecord | undefined {
  if (account.via_partner_id == null) {
    return undefined;
  }
  return accounts.find((item) => item.id === account.via_partner_id);
}

export function endClientsOf(
  partner: AccountRecord,
  accounts: AccountRecord[],
): AccountRecord[] {
  return accounts.filter(
    (item) =>
      item.relationship === "end_client" && item.via_partner_id === partner.id,
  );
}

export function findAccountsInText(
  accounts: AccountFields[],
  haystack: string,
): AccountFields[] {
  return accounts.filter((account) => accountMatchesText(account, haystack));
}

export function findAccountByName(
  accounts: AccountRecord[],
  query: string,
): AccountRecord[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [];
  }
  const exact = accounts.filter(
    (account) =>
      account.name.toLowerCase() === needle ||
      account.aliases.some((alias) => alias.toLowerCase() === needle),
  );
  if (exact.length > 0) {
    return exact;
  }
  return accounts.filter((account) =>
    accountNeedles(account).some((item) => item.includes(needle) || needle.includes(item)),
  );
}

export function suggestedNextStep(params: {
  account: AccountFields;
  openItems: OpenItemLine[];
  interactions: InteractionLine[];
}): string {
  if (params.account.next_step.trim()) {
    return params.account.next_step.trim();
  }
  const followup = params.openItems.find((item) => item.kind === "follow-up");
  if (followup) {
    return `Follow up on ${followup.text}`;
  }
  const promised = params.openItems.find((item) => item.kind === "promised");
  if (promised) {
    return `Chase: ${promised.text}`;
  }
  const task = params.openItems.find((item) => item.kind === "task");
  if (task) {
    return task.text;
  }
  if (params.interactions.length === 0 && params.openItems.length === 0) {
    return "No suggested next step from the current threads and notes.";
  }
  return "No suggested next step from the current threads and notes.";
}

export function suggestedStageFromText(text: string): string | undefined {
  for (const item of STAGE_WORDS) {
    if (item.pattern.test(text)) {
      return item.stage;
    }
  }
  return undefined;
}

export interface WrapUpBits {
  title: string;
  people: string;
  content: string;
  decisions: string[];
  action_items: Array<{ text: string; owner: "vishnu" | "other" }>;
}

export function suggestedUpdateFromWrapUp(
  account: AccountFields,
  wrapUp: WrapUpBits,
): { stage: string; next_step: string; waiting_on: WaitingOn } | undefined {
  const blob = [
    wrapUp.title,
    wrapUp.people,
    wrapUp.content,
    ...wrapUp.decisions,
    ...wrapUp.action_items.map((item) => item.text),
  ].join("\n");
  const mine = wrapUp.action_items.find((item) => item.owner === "vishnu");
  const theirs = wrapUp.action_items.find((item) => item.owner === "other");
  const stage = suggestedStageFromText(blob) ?? account.stage;
  let next_step = account.next_step;
  let waiting_on = account.waiting_on;
  if (mine?.text.trim()) {
    next_step = mine.text.trim();
    waiting_on = "me";
  } else if (theirs?.text.trim()) {
    next_step = theirs.text.trim();
    waiting_on = "them";
  }
  const changed =
    stage !== account.stage ||
    next_step !== account.next_step ||
    waiting_on !== account.waiting_on;
  if (!changed) {
    return undefined;
  }
  return { stage, next_step, waiting_on };
}

export function latestActivityIso(interactions: InteractionLine[]): string | null {
  if (interactions.length === 0) {
    return null;
  }
  const newest = [...interactions].sort((left, right) => right.dateMs - left.dateMs)[0];
  if (!newest || !Number.isFinite(newest.dateMs) || newest.dateMs <= 0) {
    return null;
  }
  return new Date(newest.dateMs).toISOString();
}

export function formatAccountListLine(
  account: AccountRecord,
  partnerName?: string,
): string {
  const stage = account.stage.trim() || "no stage";
  const activity = account.last_activity_at
    ? account.last_activity_at.slice(0, 10)
    : "no activity";
  const rel =
    account.relationship === "end_client"
      ? `end client via ${partnerName || "partner"}`
      : "partner";
  return `#${account.id} ${account.name} — ${rel} — ${stage} — last ${activity}`;
}

export function formatLinkedEndClientLine(account: AccountRecord): string {
  const stage = account.stage.trim() || "no stage";
  const activity = account.last_activity_at
    ? account.last_activity_at.slice(0, 10)
    : "no activity";
  const next = account.next_step.trim() || "no next step";
  return `• ${account.name} — ${stage} — last ${activity} — ${next}`;
}

export function formatAccountStatus(params: {
  account: AccountRecord;
  interactions: InteractionLine[];
  openItems: OpenItemLine[];
  viaPartnerName?: string;
  linkedEndClients?: AccountRecord[];
}): string {
  const recent = [...params.interactions]
    .sort((left, right) => right.dateMs - left.dateMs)
    .slice(0, 3);
  const open =
    params.openItems.length > 0
      ? params.openItems
          .slice(0, 8)
          .map((item) => `• ${item.kind}: ${item.text}`)
          .join("\n")
      : "• None";
  const threads =
    recent.length > 0
      ? recent
          .map((item) => `• ${item.kind} ${item.date} — ${item.text}`)
          .join("\n")
      : "• None";
  const due = params.account.next_step_due
    ? ` (due ${params.account.next_step_due.slice(0, 10)})`
    : "";
  const via =
    params.account.relationship === "end_client"
      ? `Via partner: ${params.viaPartnerName || "unknown"}`
      : "Relationship: partner";
  const people =
    params.account.people.length > 0
      ? `People: ${params.account.people.join(", ")}`
      : "";
  const linked =
    params.account.relationship === "partner" &&
    params.linkedEndClients &&
    params.linkedEndClients.length > 0
      ? [
          "",
          "End clients:",
          ...params.linkedEndClients.map(formatLinkedEndClientLine),
        ]
      : [];
  return [
    `${params.account.name} — ${params.account.stage.trim() || "no stage"}`,
    via,
    ...(people ? [people] : []),
    `Next step: ${params.account.next_step.trim() || "none"}${due}`,
    `Waiting on: ${params.account.waiting_on}`,
    ...linked,
    "",
    "Last interactions:",
    threads,
    "",
    "Open:",
    open,
    "",
    `Suggested next step: ${suggestedNextStep({
      account: params.account,
      openItems: params.openItems,
      interactions: params.interactions,
    })}`,
  ].join("\n");
}

export function gmailQueryForAccount(
  account: AccountFields,
  _partner?: AccountFields | null,
): string {
  const parts: string[] = [];
  if (account.relationship === "end_client") {
    for (const domain of account.email_domains.map(normalizeDomain).filter(Boolean)) {
      parts.push(`from:@${domain}`, `to:@${domain}`);
    }
    for (const needle of accountNameNeedles(account)) {
      parts.push(`"${needle}"`);
    }
    return parts.join(" OR ");
  }
  for (const domain of account.email_domains.map(normalizeDomain).filter(Boolean)) {
    parts.push(`from:@${domain}`, `to:@${domain}`);
  }
  for (const alias of [...account.aliases, account.name]) {
    const trimmed = alias.trim();
    if (trimmed.includes("@")) {
      parts.push(`from:${trimmed}`, `to:${trimmed}`);
    } else if (trimmed.length >= 3) {
      parts.push(`"${trimmed}"`);
    }
  }
  return parts.join(" OR ");
}
