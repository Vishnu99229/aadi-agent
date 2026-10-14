export type WaitingOn = "me" | "them" | "nobody";

export interface AccountFields {
  name: string;
  aliases: string[];
  email_domains: string[];
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
  stage: string;
  next_step: string;
  next_step_due: string | null;
  waiting_on: WaitingOn;
  last_activity_at: string | null;
  created_at: string;
}): AccountRecord {
  return {
    id: row.id,
    name: row.name,
    aliases: parseJsonList(row.aliases),
    email_domains: parseJsonList(row.email_domains).map(normalizeDomain),
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
  const address = email.toLowerCase();
  const domain = address.includes("@")
    ? address.slice(address.lastIndexOf("@") + 1)
    : "";
  return account.email_domains.some((item) => {
    const wanted = normalizeDomain(item);
    return wanted !== "" && (domain === wanted || domain.endsWith(`.${wanted}`));
  });
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

export function formatAccountListLine(account: AccountRecord): string {
  const stage = account.stage.trim() || "no stage";
  const activity = account.last_activity_at
    ? account.last_activity_at.slice(0, 10)
    : "no activity";
  return `#${account.id} ${account.name} — ${stage} — last ${activity}`;
}

export function formatAccountStatus(params: {
  account: AccountRecord;
  interactions: InteractionLine[];
  openItems: OpenItemLine[];
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
  return [
    `${params.account.name} — ${params.account.stage.trim() || "no stage"}`,
    `Next step: ${params.account.next_step.trim() || "none"}${due}`,
    `Waiting on: ${params.account.waiting_on}`,
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

export function gmailQueryForAccount(account: AccountFields): string {
  const parts: string[] = [];
  for (const domain of account.email_domains.map(normalizeDomain).filter(Boolean)) {
    parts.push(`from:@${domain}`, `to:@${domain}`);
  }
  for (const alias of account.aliases) {
    const trimmed = alias.trim();
    if (trimmed.includes("@")) {
      parts.push(`from:${trimmed}`, `to:${trimmed}`);
    } else if (trimmed.length >= 3) {
      parts.push(`"${trimmed}"`);
    }
  }
  return parts.join(" OR ");
}
