import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SALES_FACTS_PATH = fileURLToPath(
  new URL("../docs/sales_facts.md", import.meta.url),
);

export interface SalesFacts {
  claims: string[];
  proofNames: string[];
  caseResults: string[];
  demo: string[];
  neverSay: string[];
  links: string[];
}

export type SalesFactsStatus =
  | { ready: true; facts: SalesFacts }
  | { ready: false; reason: "missing" | "todo_markers" | "missing_section" };

const SECTIONS: Record<string, keyof SalesFacts> = {
  "product claims": "claims",
  "approved customer and proof names": "proofNames",
  "approved case results": "caseResults",
  "demo description": "demo",
  "never say": "neverSay",
  "link allowlist": "links",
};

/** Null when a required heading is gone: a renamed section must not quietly
 *  empty the never-say list or the allowlist. */
export function parseSalesFacts(text: string): SalesFacts | null {
  const facts: SalesFacts = {
    claims: [],
    proofNames: [],
    caseResults: [],
    demo: [],
    neverSay: [],
    links: [],
  };
  const seen = new Set<keyof SalesFacts>();
  let current: keyof SalesFacts | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) {
      current = SECTIONS[heading[1]!.trim().toLowerCase()];
      if (current) {
        seen.add(current);
      }
      continue;
    }
    if (current && line.startsWith("- ")) {
      const value = line.slice(2).trim();
      if (value) {
        facts[current].push(value);
      }
    }
  }
  return seen.size === Object.keys(SECTIONS).length ? facts : null;
}

/** Writing and sending are both refused unless this says ready. */
export function salesFactsStatus(path: string = SALES_FACTS_PATH): SalesFactsStatus {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { ready: false, reason: "missing" };
  }
  if (/\bTODO\b/i.test(text)) {
    return { ready: false, reason: "todo_markers" };
  }
  const facts = parseSalesFacts(text);
  return facts ? { ready: true, facts } : { ready: false, reason: "missing_section" };
}

/** The facts as prompt text. Never-say and links are rules, so they are left to
 *  the caller and never count as approved content. */
export function approvedFactsText(facts: SalesFacts): string {
  const block = (title: string, items: string[]): string =>
    `${title}:\n${items.length ? items.map((item) => `- ${item}`).join("\n") : "(none)"}`;
  return [
    block("Product claims", facts.claims),
    block("Approved customer and proof names", facts.proofNames),
    block("Approved case results", facts.caseResults),
    block("Demo description", facts.demo),
  ].join("\n\n");
}
