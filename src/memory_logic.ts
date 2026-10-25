import type {
  ItemTag,
  MemoryCategory,
  MemoryRecord,
  MemorySource,
} from "./db.js";

const TIME_ZONE = "Asia/Kolkata";

const CATEGORIES = new Set<MemoryCategory>([
  "deal",
  "plan",
  "event",
  "person",
  "preference",
  "other",
]);

const UPDATE_STOPWORDS = new Set([
  "that",
  "this",
  "with",
  "from",
  "have",
  "will",
  "been",
  "were",
  "they",
  "them",
  "then",
  "than",
  "also",
  "just",
  "into",
  "over",
  "after",
  "before",
  "about",
  "there",
  "their",
  "would",
  "could",
  "should",
  "meeting",
  "moved",
  "going",
  "today",
  "tomorrow",
  "next",
  "week",
  "month",
]);

const SENSITIVE_PATTERNS = [
  /\bpasswords?\b/i,
  /\bpasscode\b/i,
  /\botps?\b/i,
  /\bone[ -]?time (code|password|pin)\b/i,
  /\bcvv\b/i,
  /\b(credit|debit) cards?\b/i,
  /\bcard numbers?\b/i,
  /\b(?:\d[ -]?){13,19}\d\b/,
  /\bbank accounts?\b/i,
  /\baccount numbers?\b/i,
  /\bifsc\b/i,
  /\baadhaar\b/i,
  /\bdiagnos(?:is|ed)\b/i,
  /\bprescriptions?\b/i,
  /\bmedical (record|history|condition)s?\b/i,
  /\bblood (pressure|sugar|test)s?\b/i,
  /\bhealth (issue|condition|record)s?\b/i,
];

const EXPLICIT_RE =
  /^(remember that|remember this|remember:|note that|note this|note:)\s*(.*)$/i;
const FORGET_ALL_RE =
  /^forget (everything|all( memories)?|all of (them|it|that))\s*[.!]?\s*$/i;
const FORGET_NOISE_RE = /^forget (it|about it|that|this)\s*[.!]?\s*$/i;
const FORGET_RE = /^forget\s+(.+)$/i;
/** Imperative reminder/scheduling commands. The agent's set_reminder tool
 *  handles these; the memory system must never swallow them. */
const REMINDER_COMMAND_RE =
  /^\s*(?:please\s+)?(?:can\s+you\s+)?(?:remind|ping|nudge|alert|wake|buzz)\s+(?:me|us)\b/i;
const FOLLOWUP_COMMAND_RE =
  /^\s*(?:please\s+)?(?:can\s+you\s+)?(?:let\s+me\s+know|follow\s+up(?:\s+with\s+me)?)\b/i;

export interface ExtractedFact {
  content: string;
  category: MemoryCategory;
  tag: ItemTag;
  event_date: string | null;
  weight: "important" | "unsure" | "trivial";
  update_of_id: number | null;
}

export function isMemoryCategory(value: string): value is MemoryCategory {
  return CATEGORIES.has(value as MemoryCategory);
}

export function isSensitiveMemoryText(text: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));
}

export function parseExplicitRemember(
  text: string,
): { matched: true; body: string } | { matched: false } {
  const match = text.trim().match(EXPLICIT_RE);
  if (!match) {
    return { matched: false };
  }
  return { matched: true, body: (match[2] ?? "").trim() };
}

export function isForgetEverything(text: string): boolean {
  return FORGET_ALL_RE.test(text.trim());
}

export function parseForgetQuery(text: string): string | null {
  const trimmed = text.trim();
  if (FORGET_ALL_RE.test(trimmed) || FORGET_NOISE_RE.test(trimmed)) {
    return null;
  }
  const match = trimmed.match(FORGET_RE);
  return match?.[1]?.trim() || null;
}

export function isReminderCommand(text: string): boolean {
  const trimmed = text.trim();
  return (
    REMINDER_COMMAND_RE.test(trimmed) || FOLLOWUP_COMMAND_RE.test(trimmed)
  );
}

const IMPERATIVE_VERBS = [
  "ignore",
  "delete",
  "remove",
  "drop",
  "dismiss",
  "mark",
  "change",
  "update",
  "clear",
  "cancel",
  "stop",
  "unignore",
  "undo",
  "complete",
  "finish",
] as const;

const IMPERATIVE_START_RE = new RegExp(
  `^(?:please\\s+|pls\\s+|hey\\s+aadi[,\\s]+|aadi[,\\s]+|just\\s+|can\\s+you\\s+|could\\s+you\\s+)*(?:${IMPERATIVE_VERBS.join("|")})\\b`,
  "i",
);

export function isImperativeMutationCommand(text: string): boolean {
  return IMPERATIVE_START_RE.test(text.trim());
}

export function shouldSkipAutoCapture(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 12) {
    return true;
  }
  if (trimmed.startsWith("/")) {
    return true;
  }
  if (parseExplicitRemember(trimmed).matched) {
    return true;
  }
  if (isForgetEverything(trimmed) || parseForgetQuery(trimmed) !== null) {
    return true;
  }
  // Imperative reminder commands are handled by set_reminder, not memory.
  if (isReminderCommand(trimmed)) {
    return true;
  }
  // Action commands ("ignore that bill", "delete the task", "mark it paid")
  // are routed to tools, not stored as long-term facts.
  if (isImperativeMutationCommand(trimmed)) {
    return true;
  }
  return false;
}

export function kolkataYmd(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function addDaysYmd(ymd: string, days: number): string {
  const [year, month, day] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function formatEventDate(ymd: string): string {
  const [year, month, day] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(year, (month ?? 1) - 1, day ?? 1));
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

export function isPastEventDate(ymd: string | null, today = kolkataYmd()): boolean {
  if (!ymd) {
    return false;
  }
  return ymd < today;
}

function significantTokens(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter(
      (token) => !UPDATE_STOPWORDS.has(token),
    ),
  );
}

export function scoreMemoryUpdate(
  existing: Pick<MemoryRecord, "content" | "category">,
  incoming: Pick<ExtractedFact, "content" | "category">,
): number {
  const left = significantTokens(existing.content);
  const right = significantTokens(incoming.content);
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) {
      overlap += 1;
    }
  }
  if (overlap === 0) {
    return 0;
  }
  const union = new Set([...left, ...right]).size;
  let score = overlap / union;
  if (existing.category === incoming.category) {
    score += 0.15;
  }
  return score;
}

export function findMemoryToUpdate(
  existing: MemoryRecord[],
  incoming: Pick<ExtractedFact, "content" | "category" | "update_of_id">,
): MemoryRecord | undefined {
  if (incoming.update_of_id) {
    const named = existing.find((item) => item.id === incoming.update_of_id);
    if (named) {
      return named;
    }
  }
  let best: MemoryRecord | undefined;
  let bestScore = 0;
  for (const item of existing) {
    const score = scoreMemoryUpdate(item, incoming);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return bestScore >= 0.35 ? best : undefined;
}

export function confirmationLine(
  kind: "Noted" | "Updated",
  content: string,
  tag: ItemTag,
): string {
  const preview = content.length > 140 ? `${content.slice(0, 137)}...` : content;
  return `${kind}: ${preview} (${tag})`;
}

export function formatMemoryLine(
  memory: MemoryRecord,
  today = kolkataYmd(),
): string {
  const past =
    isPastEventDate(memory.event_date, today) ? " [past]" : "";
  const date = memory.event_date
    ? ` — ${formatEventDate(memory.event_date)}`
    : "";
  return `#${memory.id} [${memory.category}, ${memory.tag}]${past} ${memory.content}${date}`;
}

export function formatMemoryContextBlock(
  relevant: MemoryRecord[],
  upcoming: MemoryRecord[],
  today = kolkataYmd(),
): string {
  const byId = new Map<number, MemoryRecord>();
  for (const item of [...relevant, ...upcoming]) {
    byId.set(item.id, item);
  }
  const rows = [...byId.values()];
  if (rows.length === 0) {
    return "";
  }
  const upcomingIds = new Set(upcoming.map((item) => item.id));
  const lines = rows.map((item) => {
    const when = upcomingIds.has(item.id) && !isPastEventDate(item.event_date, today)
      ? " upcoming"
      : "";
    return formatMemoryLine(item, today) + when;
  });
  return `Long-term memories (use these; dated items marked [past] are not upcoming):\n${lines.join("\n")}`;
}

export function groupedMemoryText(
  memories: MemoryRecord[],
  today = kolkataYmd(),
): string {
  if (memories.length === 0) {
    return "No memories saved.";
  }
  const order: MemoryCategory[] = [
    "deal",
    "plan",
    "event",
    "person",
    "preference",
    "other",
  ];
  const groups: string[] = [];
  for (const category of order) {
    const items = memories.filter((item) => item.category === category);
    if (items.length === 0) {
      continue;
    }
    groups.push(
      category.toUpperCase(),
      ...items.map((item) => formatMemoryLine(item, today)),
    );
  }
  return groups.join("\n");
}

export function reminderAtNine(eventDate: string): string {
  return `${eventDate}T09:00:00+05:30`;
}

export function looksLikeDatedEvent(fact: Pick<ExtractedFact, "category" | "event_date">): boolean {
  return Boolean(fact.event_date) && (fact.category === "event" || fact.category === "plan" || fact.category === "deal");
}

export function parseExtractedFacts(raw: string): ExtractedFact[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) {
    const objectStart = raw.indexOf("{");
    const objectEnd = raw.lastIndexOf("}");
    if (objectStart < 0 || objectEnd <= objectStart) {
      return [];
    }
    const parsed = JSON.parse(raw.slice(objectStart, objectEnd + 1)) as {
      facts?: unknown;
    };
    return normalizeFacts(parsed.facts);
  }
  return normalizeFacts(JSON.parse(raw.slice(start, end + 1)));
}

function normalizeFacts(value: unknown): ExtractedFact[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const facts: ExtractedFact[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const entry = item as Record<string, unknown>;
    if (typeof entry.content !== "string" || !entry.content.trim()) {
      continue;
    }
    const category = isMemoryCategory(String(entry.category ?? ""))
      ? (entry.category as MemoryCategory)
      : "other";
    const tag: ItemTag = entry.tag === "personal" ? "personal" : "work";
    const weight =
      entry.weight === "important" || entry.weight === "unsure"
        ? entry.weight
        : "trivial";
    const eventDate =
      typeof entry.event_date === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(entry.event_date)
        ? entry.event_date
        : null;
    const updateOfId =
      typeof entry.update_of_id === "number" &&
      Number.isSafeInteger(entry.update_of_id)
        ? entry.update_of_id
        : null;
    facts.push({
      content: entry.content.trim(),
      category,
      tag,
      event_date: eventDate,
      weight,
      update_of_id: updateOfId,
    });
  }
  return facts;
}

export function defaultCategoryForExplicit(content: string): MemoryCategory {
  if (/\b(demo|meeting|call|deadline|launch)\b/i.test(content)) {
    return "event";
  }
  if (/\b(deal|msa|sow|pilot|proposal)\b/i.test(content)) {
    return "deal";
  }
  if (/\b(prefer|always|never|don't)\b/i.test(content)) {
    return "preference";
  }
  return "other";
}

const MONTHS: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};

export function parseEventDateFromText(content: string): string | null {
  const iso = content.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) {
    return iso[1]!;
  }
  const named = content.match(
    /\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{4})\b/i,
  );
  if (!named) {
    return null;
  }
  const day = named[1]!.padStart(2, "0");
  const month = MONTHS[named[2]!.slice(0, 3).toLowerCase()];
  if (!month) {
    return null;
  }
  return `${named[3]}-${month}-${day}`;
}

export function defaultTagForExplicit(content: string): ItemTag {
  if (/\b(amma|home|personal|family)\b/i.test(content)) {
    return "personal";
  }
  return "work";
}

export type { MemoryCategory, MemorySource };
