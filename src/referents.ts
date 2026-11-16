import { getPresentedReferents, upsertPresentedReferents } from "./db.js";

const REFERENT_TTL_MS = 15 * 60 * 1000;

export type ReferentType =
  | "bill"
  | "task"
  | "reminder"
  | "contact"
  | "event"
  | "account"
  | "date";

export interface ReferentEntity {
  type: ReferentType;
  id: string;
  label: string;
  matchKey?: string;
  tag?: string;
}

export type PendingKind = "ignore_which" | "list" | "contact_which" | "meeting_time";

export type ReferentResolution =
  | { kind: "none" }
  | { kind: "singular"; entity: ReferentEntity }
  | { kind: "collection"; entities: ReferentEntity[] }
  | { kind: "indexes"; entities: ReferentEntity[] }
  | { kind: "yes" }
  | { kind: "no" };

const ORDINALS: Record<string, number> = {
  first: 0,
  "1st": 0,
  second: 1,
  "2nd": 1,
  third: 2,
  "3rd": 2,
  fourth: 3,
  "4th": 3,
  fifth: 4,
  "5th": 4,
  sixth: 5,
  "6th": 5,
};

function fresh(updatedAt: string, now: Date): boolean {
  return now.getTime() - Date.parse(updatedAt) <= REFERENT_TTL_MS;
}

export function recordPresentedEntities(
  chatId: number,
  entities: readonly ReferentEntity[],
  pendingKind?: PendingKind,
  now = new Date(),
): void {
  if (entities.length === 0) {
    return;
  }
  upsertPresentedReferents({
    chatId,
    entitiesJson: JSON.stringify(entities),
    pendingKind: pendingKind ?? (entities.length === 1 ? "list" : "list"),
    updatedAt: now.toISOString(),
  });
}

export function lastPresentedEntities(
  chatId: number,
  now = new Date(),
): { entities: ReferentEntity[]; pendingKind: PendingKind | undefined } {
  const row = getPresentedReferents(chatId);
  if (!row || !fresh(row.updated_at, now)) {
    return { entities: [], pendingKind: undefined };
  }
  try {
    const parsed = JSON.parse(row.entities_json) as ReferentEntity[];
    const entities = Array.isArray(parsed) ? parsed.filter((item) => item && item.id && item.type) : [];
    const pendingKind = (row.pending_kind ?? undefined) as PendingKind | undefined;
    return { entities, pendingKind };
  } catch {
    return { entities: [], pendingKind: undefined };
  }
}

export function countWord(count: number): string | undefined {
  const words = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  return words[count - 1];
}

/** Deterministic "it / them / all three / the second one / yes". */
export function resolveReferentPhrase(
  text: string,
  chatId: number | undefined,
  now = new Date(),
): ReferentResolution {
  if (chatId === undefined) {
    return { kind: "none" };
  }
  const clean = text.trim();
  if (!clean) {
    return { kind: "none" };
  }
  if (/^(?:yes|yeah|yep|yup|that(?:'s| is) (?:him|her|it)|that one)\.?$/i.test(clean)) {
    return { kind: "yes" };
  }
  if (/^(?:no|nope|not that|neither)\.?$/i.test(clean)) {
    return { kind: "no" };
  }
  const { entities, pendingKind } = lastPresentedEntities(chatId, now);
  if (entities.length === 0) {
    return { kind: "none" };
  }
  if (
    /^(?:(?:ignore|resume)\s+)?(?:it|that|this)\.?$/i.test(clean) ||
    /\b(?:ignore|resume)\s+(?:it|that|this)\b/i.test(clean)
  ) {
    return { kind: "singular", entity: entities[0]! };
  }
  const allCount = new RegExp(
    `\\ball\\s+(?:of\\s+)?(?:them|those|these)(?:\\s+${countWord(entities.length)})?\\b|\\ball\\s+${countWord(entities.length)}\\b|\\ball\\s+${entities.length}\\b`,
    "i",
  );
  if (
    allCount.test(clean) ||
    /^(?:(?:ignore|resume)\s+)?(?:them|those|these)\.?$/i.test(clean)
  ) {
    return { kind: "collection", entities };
  }
  const ordinal =
    /\b(?:the\s+)?(first|second|third|fourth|fifth|sixth|1st|2nd|3rd|4th|5th|6th)\b/i.exec(clean);
  if (ordinal) {
    const index = ORDINALS[ordinal[1]!.toLowerCase()];
    if (index !== undefined && entities[index]) {
      return { kind: "indexes", entities: [entities[index]!] };
    }
  }
  const numbers = [...clean.matchAll(/\b(\d{1,2})\b/g)]
    .map((match) => Number(match[1]) - 1)
    .filter((index) => index >= 0 && index < entities.length);
  if (
    numbers.length > 0 &&
    numbers.length <= entities.length &&
    !/\b(?:ignore|resume)\b/i.test(clean) &&
    pendingKind === "ignore_which"
  ) {
    return {
      kind: "indexes",
      entities: [...new Set(numbers)].map((index) => entities[index]!),
    };
  }
  return { kind: "none" };
}

function asBill(value: unknown): ReferentEntity | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const row = value as { id?: unknown; biller?: unknown };
  if (typeof row.id !== "number" || typeof row.biller !== "string") {
    return undefined;
  }
  return {
    type: "bill",
    id: String(row.id),
    label: row.biller,
    matchKey: row.biller,
    tag: "personal",
  };
}

function asTasks(content: string): ReferentEntity[] {
  const entities: ReferentEntity[] = [];
  for (const line of content.split("\n")) {
    const match = /^#(\d+)\s+\[([^\]]+)\]\s+\(([^)]+)\)\s+(?:\[ignored\]\s+)?(.+?)(?:\s+—|$)/.exec(
      line.trim(),
    );
    if (!match) {
      continue;
    }
    entities.push({
      type: "task",
      id: match[1]!,
      label: match[4]!.trim(),
      matchKey: match[4]!.trim(),
      tag: match[3],
    });
  }
  return entities;
}

/** Pulls the entities a list tool just showed, so later "it" / "them" can resolve. */
export function entitiesFromToolResult(tool: string, content: string): ReferentEntity[] {
  if (tool === "list_bills") {
    try {
      const parsed = JSON.parse(content) as unknown;
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.map(asBill).filter((item): item is ReferentEntity => item !== undefined);
    } catch {
      return [];
    }
  }
  if (tool === "list_tasks") {
    return asTasks(content);
  }
  if (tool === "list_reminders") {
    const entities: ReferentEntity[] = [];
    for (const line of content.split("\n")) {
      const match = /^#(\d+)\b[^\n]*$/.exec(line.trim());
      if (match) {
        entities.push({
          type: "reminder",
          id: match[1]!,
          label: line.trim(),
          matchKey: line.trim(),
        });
      }
    }
    return entities;
  }
  return [];
}

export function notePresentedFromTool(
  tool: string,
  content: string,
  chatId: number | undefined,
): void {
  if (chatId === undefined) {
    return;
  }
  const entities = entitiesFromToolResult(tool, content);
  if (entities.length === 0) {
    return;
  }
  recordPresentedEntities(chatId, entities, "list");
}
