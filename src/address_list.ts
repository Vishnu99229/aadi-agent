export interface ParsedMailbox {
  name: string;
  email: string;
}

/** Parse actual mailbox addresses, excluding address-like text in display names. */
export function parseAddressList(raw: string): ParsedMailbox[] {
  const results: ParsedMailbox[] = [];
  const seen = new Set<string>();
  const pattern =
    /(?:"([^"]+)"|([^,<>]+?))?\s*<([^>]+)>|([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const email = (match[3] ?? match[4] ?? "").trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    const quoted = match[1]?.trim() ?? "";
    const unquoted = match[2]?.trim() ?? "";
    const display = quoted || unquoted;
    results.push({ name: displayName(display, email), email });
  }
  return results;
}

function displayName(rawName: string, email: string): string {
  const cleaned = rawName.replace(/^['"]|['"]$/g, "").trim();
  if (cleaned && !cleaned.includes("@")) return cleaned.replace(/\s+/g, " ");
  return (email.split("@")[0] ?? "")
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
