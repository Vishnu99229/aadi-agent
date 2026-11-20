import { Resolver } from "node:dns/promises";
import { listCanonicalContacts, listDocuments } from "./db.js";
import { assertTestSeam } from "./test_seam.js";

/** Generic mailboxes. A greeting may not treat the local part as a person's name. */
const GENERIC_LOCAL = new Set([
  "contact", "info", "sales", "hello", "team", "support", "admin", "enquiry", "inquiry", "office",
]);
const NOT_A_PERSON = new Set([
  "send", "email", "schedule", "tomorrow", "today", "monday", "tuesday", "wednesday", "thursday",
  "friday", "saturday", "sunday", "please", "thanks", "thank", "hello", "dear", "tell", "vishnu",
  "epicode", "bangalore", "contact", "address", "above", "photo", "mail",
]);
const PERSON = "[\\p{Lu}][\\p{L}'-]{1,}";
const CACHE_MS = 24 * 60 * 60 * 1000;
const LOOKUP_MS = 4000;

export type DomainStatus = "yes" | "no" | "unknown";
type Probe = "yes" | "no" | "timeout";

const cache = new Map<string, { at: number; result: DomainStatus }>();
let lookupOverride: ((domain: string) => Promise<DomainStatus>) | undefined;

export function setDomainLookupForTests(lookup: ((domain: string) => Promise<DomainStatus>) | undefined): void {
  assertTestSeam("setDomainLookupForTests");
  lookupOverride = lookup;
  cache.clear();
}

/** MX and A both missing is "no". A timeout on either side is "unknown" and must not block. */
export function outcomeFromLookup(mx: Probe, a: Probe): DomainStatus {
  if (mx === "yes" || a === "yes") {
    return "yes";
  }
  if (mx === "timeout" || a === "timeout") {
    return "unknown";
  }
  return "no";
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "ETIMEOUT" })), LOOKUP_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function probeCode(error: unknown): Probe {
  const code = (error as { code?: string }).code;
  return code === "ENOTFOUND" || code === "ENODATA" ? "no" : "timeout";
}

async function liveLookup(domain: string): Promise<DomainStatus> {
  const resolver = new Resolver();
  resolver.setServers(["1.1.1.1", "8.8.8.8"]);
  let mx: Probe;
  try {
    const records = await withTimeout(resolver.resolveMx(domain));
    mx = records.length > 0 ? "yes" : "no";
  } catch (error) {
    mx = probeCode(error);
  }
  if (mx === "yes") {
    return "yes";
  }
  if (mx === "timeout") {
    return "unknown";
  }
  let a: Probe;
  try {
    const records = await withTimeout(resolver.resolve4(domain));
    a = records.length > 0 ? "yes" : "no";
  } catch (error) {
    a = probeCode(error);
  }
  return outcomeFromLookup("no", a);
}

export async function domainAcceptsMail(domain: string): Promise<DomainStatus> {
  const key = domain.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return hit.result;
  }
  let result: DomainStatus;
  if (lookupOverride) {
    result = await lookupOverride(key);
  } else if (process.env.AADI_DB_PATH === ":memory:") {
    result = "unknown";
  } else {
    result = await liveLookup(key);
  }
  cache.set(key, { at: Date.now(), result });
  return result;
}

function emailDomain(email: string): string | undefined {
  const domain = email.split("@")[1]?.toLowerCase().replace(/\.$/, "");
  return domain && domain.includes(".") ? domain : undefined;
}

function titleCase(word: string): string {
  const letters = word.replace(/[^A-Za-z]/g, "");
  if (!letters) {
    return "";
  }
  return letters.charAt(0).toUpperCase() + letters.slice(1).toLowerCase();
}

export function companyLabel(email: string, ocrText?: string): string {
  const label = email.split("@")[1]?.split(".")[0] ?? "";
  const fromDomain = titleCase(label);
  if (!ocrText || label.length < 3) {
    return fromDomain;
  }
  const brand = ocrText
    .split(/\n/)
    .map((line) => line.trim())
    .find((line) => !line.includes("@") && line.toLowerCase().includes(label.toLowerCase()));
  const word = brand?.split(/[^A-Za-z]+/).find((part) => part.toLowerCase().startsWith(label.slice(0, 4).toLowerCase()));
  return word ? titleCase(word) : fromDomain;
}

export function neutralGreeting(email: string, ocrText?: string): string {
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  if (!GENERIC_LOCAL.has(local)) {
    return "Hi,";
  }
  const company = companyLabel(email, ocrText);
  return company ? `Hi ${company} team,` : "Hi,";
}

function takeName(match: RegExpMatchArray | null): string | undefined {
  if (!match) {
    return undefined;
  }
  const parts = [match[1], match[2]].filter((part): part is string => Boolean(part));
  if (parts.length === 0 || parts.some((part) => NOT_A_PERSON.has(part.toLowerCase()))) {
    return undefined;
  }
  return parts.join(" ");
}

/** A person he named for this recipient, not a name that only appears in the email body. */
export function nameTypedForRecipient(ownWords: string, toEmail: string): string | undefined {
  const beside = new RegExp(`\\b((?:${PERSON}\\s+){1,3})at\\s+(\\S+)`, "u").exec(ownWords);
  if (beside?.[2]?.toLowerCase().startsWith(toEmail.toLowerCase())) {
    const parts = beside[1]!.trim().split(/\s+/).filter((part) => !NOT_A_PERSON.has(part.toLowerCase()));
    if (parts.length > 0 && parts.length <= 3) {
      return parts.join(" ");
    }
  }
  const told = new RegExp(`\\b(?:tell|email|e-mail|dear|to)\\s+(${PERSON})(?:\\s+(${PERSON}))?\\b`, "u").exec(ownWords);
  const toldName = takeName(told);
  if (toldName) {
    return toldName;
  }
  return takeName(new RegExp(`\\bsend\\s+(${PERSON})(?:\\s+(${PERSON}))?\\b`, "u").exec(ownWords));
}

export function nameBesideAddress(ocrText: string | undefined, email: string): string | undefined {
  if (!ocrText || !ocrText.toLowerCase().includes(email.toLowerCase())) {
    return undefined;
  }
  const lines = ocrText.split(/\n/).map((line) => line.trim()).filter(Boolean);
  const at = lines.findIndex((line) => line.toLowerCase().includes(email.toLowerCase()));
  const nearby = lines.slice(Math.max(0, at - 4), at + 5);
  for (const line of nearby) {
    if (/@|\d|pvt|ltd|inc|llc|www\./i.test(line)) {
      continue;
    }
    if (new RegExp(`^${PERSON}(?:\\s+${PERSON}){0,2}$`, "u").test(line)) {
      return line;
    }
  }
  return undefined;
}

function usableContactName(name: string | undefined, email: string): string | undefined {
  const clean = name?.trim() ?? "";
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  if (
    !clean ||
    clean.includes("@") ||
    clean.toLowerCase() === email.toLowerCase() ||
    GENERIC_LOCAL.has(clean.toLowerCase()) ||
    clean.toLowerCase() === local
  ) {
    return undefined;
  }
  if (!/[A-Za-z]/.test(clean)) {
    return undefined;
  }
  return clean;
}

export function ocrTextForAddress(email: string): string | undefined {
  const want = email.toLowerCase();
  if (!want.includes("@")) {
    return undefined;
  }
  for (const doc of listDocuments(25)) {
    if (doc.extracted_text.toLowerCase().includes(want)) {
      return doc.extracted_text;
    }
  }
  return undefined;
}

export function contactNameForAddress(email: string): string | undefined {
  const want = email.toLowerCase();
  for (const row of listCanonicalContacts()) {
    let emails: unknown;
    try {
      emails = JSON.parse(row.emails_json);
    } catch {
      continue;
    }
    if (!Array.isArray(emails) || !emails.some((item) => String(item).toLowerCase() === want)) {
      continue;
    }
    const usable = usableContactName(row.display_name, email);
    if (usable) {
      return usable;
    }
  }
  return undefined;
}

export function recipientGrounding(
  ownWords: string,
  toEmail: string,
  knownName?: string,
): { allowedName?: string; line: string } {
  const ocr = ocrTextForAddress(toEmail);
  const allowedName =
    nameTypedForRecipient(ownWords, toEmail) ||
    nameBesideAddress(ocr, toEmail) ||
    usableContactName(contactNameForAddress(toEmail), toEmail) ||
    usableContactName(knownName, toEmail);
  const line = allowedName ? `Hi ${allowedName},` : neutralGreeting(toEmail, ocr);
  return { ...(allowedName ? { allowedName } : {}), line };
}

function sameLine(current: string, greeting: string): boolean {
  return current.replace(/[,.!\s]+$/g, "").toLowerCase() === greeting.replace(/[,.!\s]+$/g, "").toLowerCase();
}

/** The greeting may name only the allowed person. Any other name is replaced before send. */
export function groundGreeting(body: string, allowedName: string | undefined, greeting: string): string {
  const lines = body.split(/\r?\n/);
  const index = lines.findIndex((line) => line.trim().length > 0);
  if (index < 0) {
    return body;
  }
  const current = lines[index]!.trim();
  if (!/^(?:hi|hello|dear)\b/i.test(current) || sameLine(current, greeting)) {
    return body;
  }
  const named = /^(?:hi|hello|dear)\s+([^,\n!]+)/i.exec(current)?.[1]?.trim();
  if (!named) {
    return body;
  }
  if (allowedName) {
    const got = named.replace(/\s+team$/i, "").toLowerCase();
    const allowed = allowedName.toLowerCase();
    if (got === allowed || got === allowed.split(/\s+/)[0]) {
      return body;
    }
  } else {
    const neutralName = greeting.replace(/^hi\s+/i, "").replace(/[,!\s]+$/g, "");
    if (named.toLowerCase() === neutralName.toLowerCase()) {
      return body;
    }
  }
  lines[index] = greeting;
  return lines.join("\n");
}

/** Topic words for memory and past-chat. Never the generic mailbox word or the To local part. */
export function writerSearchText(ownWords: string, instruction: string, toAddresses: readonly string[]): string {
  const banned = new Set(GENERIC_LOCAL);
  for (const email of toAddresses) {
    const local = email.split("@")[0]?.toLowerCase();
    if (local) {
      banned.add(local);
    }
  }
  const tokens = `${instruction} ${ownWords}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4 && !banned.has(token));
  return [...new Set(tokens)].slice(0, 12).join(" ");
}

function levenshtein(left: string, right: string): number {
  if (Math.abs(left.length - right.length) > 2) {
    return 3;
  }
  const row = [new Array<number>(right.length + 1), new Array<number>(right.length + 1)];
  for (let column = 0; column <= right.length; column += 1) {
    row[0]![column] = column;
  }
  for (let i = 1; i <= left.length; i += 1) {
    const current = row[i % 2]!;
    const previous = row[(i + 1) % 2]!;
    current[0] = i;
    let best = current[0]!;
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[i - 1] === right[column - 1] ? 0 : 1;
      current[column] = Math.min(current[column - 1]! + 1, previous[column]! + 1, previous[column - 1]! + cost);
      if (current[column]! < best) {
        best = current[column]!;
      }
    }
    if (best > 2) {
      return 3;
    }
  }
  return row[left.length % 2]![right.length]!;
}

function knownAddresses(): string[] {
  const found = new Set<string>();
  const email = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
  for (const doc of listDocuments(25)) {
    for (const match of doc.extracted_text.match(email) ?? []) {
      found.add(match.toLowerCase());
    }
  }
  for (const row of listCanonicalContacts()) {
    try {
      const emails = JSON.parse(row.emails_json) as unknown;
      if (Array.isArray(emails)) {
        for (const item of emails) {
          if (typeof item === "string" && item.includes("@")) {
            found.add(item.toLowerCase());
          }
        }
      }
    } catch {
      // A bad contact row cannot suggest an address.
    }
  }
  return [...found];
}

async function suggestionFor(typed: string, candidates: readonly string[]): Promise<string | undefined> {
  const want = typed.toLowerCase();
  let best: { email: string; dist: number } | undefined;
  for (const candidate of candidates) {
    if (candidate === want || Math.abs(candidate.length - want.length) > 2) {
      continue;
    }
    const dist = levenshtein(want, candidate);
    if (dist < 1 || dist > 2 || (best && dist >= best.dist)) {
      continue;
    }
    const domain = emailDomain(candidate);
    if (!domain || (await domainAcceptsMail(domain)) !== "yes") {
      continue;
    }
    best = { email: candidate, dist };
  }
  return best?.email;
}

/** Blocks only a domain that clearly has no MX and no A record. */
export async function mailDomainRefusal(emails: readonly string[]): Promise<string | undefined> {
  const candidates = knownAddresses();
  for (const email of emails) {
    const domain = emailDomain(email);
    if (!domain || (await domainAcceptsMail(domain)) !== "no") {
      continue;
    }
    const hint = await suggestionFor(email, candidates);
    return hint
      ? `Not sent: ${domain} doesn't accept email. Did you mean ${hint}?`
      : `Not sent: ${domain} doesn't accept email.`;
  }
  return undefined;
}
