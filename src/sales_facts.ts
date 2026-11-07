import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  addSalesFact,
  deleteAddedSalesFact,
  listAddedSalesFacts,
  type AddedSalesFact,
} from "./db.js";
import { allowOwnerChatSalesFacts } from "./security/send_approval.js";
import type { ToolTurn } from "./tools/index.js";

export const SALES_FACTS_PATH = fileURLToPath(
  new URL("../docs/sales_facts.md", import.meta.url),
);

const ADDED_HEADING = "Added facts";

export function readSalesFactsFile(path: string = SALES_FACTS_PATH): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

function squash(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** "under demo" finds "## The demo (15-20 minutes)"; no match starts a section. */
function sectionMatches(heading: string, section: string): boolean {
  const left = squash(heading);
  const right = squash(section);
  if (!left || !right) {
    return false;
  }
  return left === right || (right.length >= 3 && left.includes(right)) || (left.length >= 3 && right.includes(left));
}

/** The file with every added fact under the section it names, or under "Added
 *  facts" when it names none. A section the file lacks is added at the end. */
export function mergeSalesFacts(
  fileText: string,
  added: ReadonlyArray<Pick<AddedSalesFact, "id" | "section" | "fact">>,
  options: { tagAdded?: boolean } = {},
): string {
  const lines = fileText ? fileText.split(/\r?\n/) : [];
  const headings = lines
    .map((line, index) => ({ index, match: /^##\s+(.+?)\s*$/.exec(line) }))
    .filter((item) => item.match)
    .map((item) => ({ index: item.index, title: item.match![1]! }));
  const inserts = new Map<number, string[]>();
  const extra = new Map<string, string[]>();
  for (const item of added) {
    const bullet = `- ${item.fact}${options.tagAdded ? ` [added #${item.id}]` : ""}`;
    const wanted = item.section?.trim() || ADDED_HEADING;
    const target = headings.find((heading) => sectionMatches(heading.title, wanted));
    if (target) {
      inserts.set(target.index, [...(inserts.get(target.index) ?? []), bullet]);
      continue;
    }
    const key = [...extra.keys()].find((title) => sectionMatches(title, wanted)) ?? wanted;
    extra.set(key, [...(extra.get(key) ?? []), bullet]);
  }
  const out = lines.slice(0, headings[0]?.index ?? lines.length);
  headings.forEach((heading, position) => {
    const block = lines.slice(heading.index, headings[position + 1]?.index ?? lines.length);
    while (block.length > 1 && block[block.length - 1]!.trim() === "") {
      block.pop();
    }
    out.push(...block, ...(inserts.get(heading.index) ?? []), "");
  });
  for (const [title, bullets] of extra) {
    out.push(`## ${title}`, ...bullets, "");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Everything the writer draws on: the file plus what Vishnu has added. Read
 *  fresh for every follow-up, so a new fact is used from the next one on. */
export function salesFactsText(path: string = SALES_FACTS_PATH): string {
  return mergeSalesFacts(readSalesFactsFile(path), listAddedSalesFacts());
}

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

export function addSalesFactFromTool(input: unknown, turn: Pick<ToolTurn, "confirmation">): string {
  allowOwnerChatSalesFacts(turn.confirmation);
  const values = (input ?? {}) as { fact?: unknown; section?: unknown };
  const fact = cleanText(values.fact, 600).replace(/^[-*•]\s*/, "");
  const section = cleanText(values.section, 80) || null;
  if (!fact) {
    return "Nothing added: what's the fact? Say \"add to sales facts: <point>\".";
  }
  const row = addSalesFact(fact, section);
  const file = readSalesFactsFile();
  const placed = section
    ? (file.split(/\r?\n/).map((line) => /^##\s+(.+?)\s*$/.exec(line)?.[1]).find(
        (title) => title !== undefined && sectionMatches(title, section),
      ) ?? section)
    : ADDED_HEADING;
  return `Added to sales facts (#${row.id}) under "${placed}": ${fact}\nFollow-ups use it from the next one written.`;
}

export function listSalesFactsFromTool(turn: Pick<ToolTurn, "confirmation">): string {
  allowOwnerChatSalesFacts(turn.confirmation);
  const merged = mergeSalesFacts(readSalesFactsFile(), listAddedSalesFacts(), { tagAdded: true });
  if (!merged) {
    return "There are no sales facts yet.";
  }
  return `Show Vishnu this list as it is. Lines marked [added #N] are ones he added by chat and can remove; the rest come from docs/sales_facts.md.\n\n${merged}`;
}

export function removeSalesFactFromTool(input: unknown, turn: Pick<ToolTurn, "confirmation">): string {
  allowOwnerChatSalesFacts(turn.confirmation);
  const target = cleanText((input as { fact?: unknown } | null)?.fact, 600);
  const added = listAddedSalesFacts();
  const listing = (rows: AddedSalesFact[]): string =>
    rows.map((row) => `- #${row.id}${row.section ? ` (${row.section})` : ""}: ${row.fact}`).join("\n");
  if (added.length === 0) {
    return "Nothing removed: there are no added sales facts. Facts in docs/sales_facts.md can only be changed by editing that file.";
  }
  const id = /^#?(\d+)$/.exec(target)?.[1];
  const wanted = squash(target);
  const matches = id
    ? added.filter((row) => row.id === Number(id))
    : wanted
      ? added.filter((row) => squash(row.fact).includes(wanted))
      : [];
  if (matches.length === 0) {
    return `Nothing removed: no added fact matches "${target}". Facts in docs/sales_facts.md can only be changed by editing that file. Added facts:\n${listing(added)}`;
  }
  if (matches.length > 1) {
    return `Nothing removed yet: "${target}" matches more than one added fact. Ask Vishnu which:\n${listing(matches)}`;
  }
  const row = matches[0]!;
  deleteAddedSalesFact(row.id);
  return `Removed sales fact #${row.id}: ${row.fact}`;
}
