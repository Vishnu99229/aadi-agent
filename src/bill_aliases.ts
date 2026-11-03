/**
 * Canonical biller names for merge. Extend BILLER_ALIASES as new spellings appear.
 * Keys and values are matched case-insensitively after light punctuation cleanup.
 */

/** alias (lowercase) → canonical display name */
export const BILLER_ALIASES: Record<string, string> = {
  anthropic: "Anthropic",
  "anthropic claude": "Anthropic",
  "anthropic (claude)": "Anthropic",
  "anthropic, pbc": "Anthropic",
  "anthropic pbc": "Anthropic",
};

/** Strip punctuation/noise so "Anthropic, PBC" and "Anthropic (Claude)" share a key. */
export function normalizeBillerKey(biller: string): string {
  return biller
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Map a raw LLM/extract biller to a stable canonical name. */
export function canonicalBiller(biller: string): string {
  const key = normalizeBillerKey(biller);
  if (!key) {
    return biller.trim() || "Unknown";
  }
  if (BILLER_ALIASES[key]) {
    return BILLER_ALIASES[key]!;
  }
  // Prefix match: "anthropic something" → Anthropic when alias base is registered.
  for (const [alias, canonical] of Object.entries(BILLER_ALIASES)) {
    if (key === alias || key.startsWith(`${alias} `) || key.endsWith(` ${alias}`)) {
      return canonical;
    }
  }
  // Title-case the cleaned words for a stable display when unknown.
  return key
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function billersMatch(left: string, right: string): boolean {
  return (
    normalizeBillerKey(canonicalBiller(left)) ===
    normalizeBillerKey(canonicalBiller(right))
  );
}
