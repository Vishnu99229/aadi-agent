import type { AccountRecord } from "./account_logic.js";
import { addressIn, nameTokens } from "./command_logic.js";
import { companyFromEmail } from "./mail_helpers.js";

/** Where a person was seen. "known" is a prospect or something Vishnu told Aadi. */
export type ContactSource = "known" | "relationship" | "gmail" | "calendar";

export interface Contact {
  /** The fullest display name seen. Empty when only an address is known. */
  name: string;
  /** Every address known for this one person, most recently seen first. */
  emails: string[];
  company?: string;
  sources: ContactSource[];
  /** When they last appeared in mail or on the calendar. */
  lastSeenMs?: number;
}

export type ContactResolution =
  | { kind: "one"; contact: Contact }
  | { kind: "many"; options: Contact[] }
  /**
   * `company` is set when the words name a company rather than a person.
   * `knownAs` is a person on an account who matches but has no address on record.
   */
  | { kind: "none"; company?: string; knownAs?: string };

/** One appearance of an address in a source, before people are merged. */
export interface Sighting {
  name: string;
  email: string;
  source: ContactSource;
  seenMs?: number;
  /** The source itself tied this address to the name asked for, so it needs no name match. */
  matched?: boolean;
}

/** A person named on an account record. These carry no address. */
export interface AccountPerson {
  name: string;
  account: AccountRecord;
}

const MAX_OPTIONS_SHOWN = 6;

function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

function localPart(email: string): string {
  return email.slice(0, Math.max(0, email.lastIndexOf("@")));
}

function isConsumerAddress(email: string): boolean {
  return companyFromEmail(email, []) === undefined;
}

function titleCase(words: readonly string[]): string {
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

/** How a name is shown back to Vishnu: "hardik  SINGH" becomes "Hardik Singh". */
export function displayQuery(query: string): string {
  const address = addressIn(query);
  return address ?? (titleCase(nameTokens(query)) || query.trim());
}

/** Same people asked for the same way share a key: order, case and spacing don't matter. */
export function nameKey(query: string): string {
  return [...new Set(nameTokens(query))].sort().join(" ");
}

/** Words that say which company: the account name or the domain, never "gmail". */
function companyWords(email: string, accounts: readonly AccountRecord[]): Set<string> {
  const words = new Set<string>();
  if (!isConsumerAddress(email)) {
    for (const word of nameTokens(domainOf(email).split(".").slice(0, -1).join(" "))) {
      words.add(word);
    }
  }
  const company = companyFromEmail(email, [...accounts]);
  for (const word of nameTokens(company ?? "")) {
    words.add(word);
  }
  return words;
}

/** Words that say which person: the display name and the part before the @. */
function personWords(name: string, email: string, company: ReadonlySet<string>): Set<string> {
  const words = new Set(nameTokens(`${name} ${localPart(email)}`));
  // "Pinnacle Support <support@pinnacle.com>" is the company's mailbox, not a person called Pinnacle.
  for (const word of company) {
    words.delete(word);
  }
  return words;
}

/**
 * True when every word asked for fits this address and at least one of them is
 * the person's own name. A first name alone matches; so does a full name, or a
 * name with the company ("hardik pinnacle").
 */
export function sightingMatches(
  sighting: Sighting,
  tokens: readonly string[],
  accounts: readonly AccountRecord[],
): boolean {
  if (tokens.length === 0) {
    return false;
  }
  if (sighting.matched) {
    return true;
  }
  const company = companyWords(sighting.email, accounts);
  const person = personWords(sighting.name, sighting.email, company);
  return (
    tokens.every((token) => person.has(token) || company.has(token)) &&
    tokens.some((token) => person.has(token))
  );
}

/** The account these words name, when they name a company and nobody in particular. */
export function companyNamed(
  tokens: readonly string[],
  accounts: readonly AccountRecord[],
): string | undefined {
  if (tokens.length === 0) {
    return undefined;
  }
  for (const account of accounts) {
    const names = [account.name, ...account.aliases];
    if (names.some((name) => nameTokens(name).join(" ") === tokens.join(" "))) {
      return account.name;
    }
    const domains = account.email_domains.map((domain) => domain.toLowerCase().replace(/^@/, ""));
    if (tokens.length === 1 && domains.some((domain) => domain.split(".")[0] === tokens[0])) {
      return account.name;
    }
  }
  return undefined;
}

/** People on account records whose names fit. They have no address, so they only add detail. */
export function accountPeopleMatching(
  tokens: readonly string[],
  accounts: readonly AccountRecord[],
): AccountPerson[] {
  const found: AccountPerson[] = [];
  for (const account of accounts) {
    const company = new Set(nameTokens([account.name, ...account.aliases].join(" ")));
    for (const name of account.people) {
      const person = new Set(nameTokens(name));
      if (
        tokens.every((token) => person.has(token) || company.has(token)) &&
        tokens.some((token) => person.has(token))
      ) {
        found.push({ name: name.trim(), account });
      }
    }
  }
  return found;
}

/** Two addresses are one person only when the full name is the same and they
 *  can't be at two different companies. Anything less stays two people. */
function samePerson(contact: Contact, name: string, email: string): boolean {
  const words = nameTokens(name);
  if (words.length < 2 || words.join(" ") !== nameTokens(contact.name).join(" ")) {
    return false;
  }
  const companies = new Set(
    [...contact.emails, email].filter((item) => !isConsumerAddress(item)).map(domainOf),
  );
  return companies.size <= 1;
}

/**
 * Turns matching sightings into people. Addresses are merged per person, never
 * dropped, and nobody is preferred over anybody else: the caller decides what
 * one, several or no people means.
 */
export function contactsFrom(
  sightings: readonly Sighting[],
  tokens: readonly string[],
  accounts: readonly AccountRecord[],
  people: readonly AccountPerson[] = [],
): Contact[] {
  const byEmail = new Map<string, Contact>();
  for (const sighting of sightings) {
    const email = sighting.email.trim().toLowerCase();
    if (!email || !sightingMatches({ ...sighting, email }, tokens, accounts)) {
      continue;
    }
    const known = byEmail.get(email);
    const name = sighting.name.trim();
    if (!known) {
      byEmail.set(email, {
        name,
        emails: [email],
        company: companyFromEmail(email, [...accounts]),
        sources: [sighting.source],
        lastSeenMs: sighting.seenMs,
      });
      continue;
    }
    if (name.length > known.name.length) {
      known.name = name;
    }
    if (!known.sources.includes(sighting.source)) {
      known.sources.push(sighting.source);
    }
    if (sighting.seenMs !== undefined && sighting.seenMs > (known.lastSeenMs ?? 0)) {
      known.lastSeenMs = sighting.seenMs;
    }
  }

  const ordered = [...byEmail.values()].sort(
    (left, right) => (right.lastSeenMs ?? 0) - (left.lastSeenMs ?? 0),
  );
  const contacts: Contact[] = [];
  for (const entry of ordered) {
    const same = contacts.find((contact) => samePerson(contact, entry.name, entry.emails[0]!));
    if (!same) {
      contacts.push(entry);
      continue;
    }
    same.emails.push(...entry.emails);
    same.company ??= entry.company;
    for (const source of entry.sources) {
      if (!same.sources.includes(source)) {
        same.sources.push(source);
      }
    }
  }

  // An account record can give the full name of someone whose mail only says "Hardik".
  for (const contact of contacts) {
    const fits = people.filter(
      (person) =>
        contact.emails.some((email) => companyFromEmail(email, [person.account]) === person.account.name) &&
        nameTokens(`${contact.name} ${localPart(contact.emails[0]!)}`).some((word) =>
          nameTokens(person.name).includes(word),
        ),
    );
    if (fits.length === 1) {
      if (nameTokens(fits[0]!.name).length > nameTokens(contact.name).length) {
        contact.name = fits[0]!.name;
      }
      if (!contact.sources.includes("relationship")) {
        contact.sources.push("relationship");
      }
    }
  }
  return contacts;
}

/** One, several or nobody. Several is never narrowed to the first. */
export function resolutionFrom(contacts: readonly Contact[]): ContactResolution {
  if (contacts.length === 0) {
    return { kind: "none" };
  }
  return contacts.length === 1
    ? { kind: "one", contact: contacts[0]! }
    : { kind: "many", options: [...contacts] };
}

function shownName(contact: Contact): string {
  return contact.name || titleCase(nameTokens(localPart(contact.emails[0] ?? ""))) || (contact.emails[0] ?? "");
}

/** "Hardik Singh, Pinnacle", or with the address when there is no company to tell by. */
export function contactLabel(contact: Contact): string {
  const name = shownName(contact);
  return contact.company ? `${name}, ${contact.company}` : `${name} (${contact.emails[0] ?? ""})`;
}

/** Labels for a list of choices. Two that would read the same get their address added. */
export function optionLabels(options: readonly Contact[]): string[] {
  const labels = options.map(contactLabel);
  return labels.map((label, index) =>
    labels.filter((other) => other === label).length > 1 && options[index]!.company
      ? `${label} (${options[index]!.emails[0] ?? ""})`
      : label,
  );
}

/** How a resolved person is described to the model: name, address and company. */
export function describeContact(contact: Contact): string {
  const name = shownName(contact);
  const addresses = contact.emails.join(", ");
  return `${name} <${addresses}>${contact.company ? `, ${contact.company}` : ""}`;
}

/** The question for several matches, with the choices listed. */
export function whichQuestion(query: string, options: readonly Contact[]): string {
  const shown = optionLabels(options.slice(0, MAX_OPTIONS_SHOWN));
  const more = options.length - shown.length;
  return [
    `Which ${displayQuery(query)} are you referring to?`,
    ...shown.map((label) => `- ${label}`),
    ...(more > 0 ? [`…and ${more} more. Tell me their company or email address.`] : []),
  ].join("\n");
}

/** The question when nobody matches. */
export function unknownQuestion(query: string, knownAs?: string): string {
  const known = knownAs ? ` ${knownAs} is on your accounts, but with no email address.` : "";
  return `I couldn't find anyone called ${displayQuery(query)} in your contacts, Gmail, calendar or accounts.${known} What's their email address, or their full name or company?`;
}

export function optionsShown(options: readonly Contact[]): Contact[] {
  return options.slice(0, MAX_OPTIONS_SHOWN);
}

const ORDINALS: Record<string, number> = {
  first: 0, "1st": 0, one: 0,
  second: 1, "2nd": 1, two: 1,
  third: 2, "3rd": 2, three: 2,
  fourth: 3, "4th": 3, four: 3,
  fifth: 4, "5th": 4, five: 4,
  sixth: 5, "6th": 5, six: 5,
};

/** Words that pad an answer without saying who: "the Pinnacle one, please". */
const FILLER = new Set([
  "one", "guy", "person", "option", "number", "please", "pls", "with", "who", "works", "work", "is",
  "he", "she", "him", "her", "his", "it", "its", "mean", "meant", "that", "this", "yes", "yeah", "from",
  "wala", "company",
]);

const DROP_ANSWER =
  /^\s*(?:never\s*mind|nvm|cancel|skip(?:\s+it)?|leave\s+it|forget\s+it|drop\s+it|none(?:\s+of\s+(?:them|these|those))?|neither|nobody|no\s*one|stop)\b[\s.!]*$/i;

/** He said to leave it rather than choosing. */
export function isDropAnswer(answer: string): boolean {
  return DROP_ANSWER.test(answer);
}

export type AnswerMatch =
  | { kind: "one"; index: number }
  /** The answer fits more than one choice, so it settles nothing. */
  | { kind: "several" }
  /** An address he typed that isn't one of the choices. */
  | { kind: "address"; email: string }
  /** Not an answer to the question at all. */
  | { kind: "nobody" };

/**
 * Reads Vishnu's reply to "which one?". It has to point at exactly one choice:
 * by number, by address, or by words that fit only that person. A reply that
 * fits two is "several", and nothing here ever falls back to the first.
 */
export function matchAnswer(options: readonly Contact[], answer: string): AnswerMatch {
  const text = answer.trim();
  if (!text || options.length === 0) {
    return { kind: "nobody" };
  }
  const address = addressIn(text);
  if (address) {
    const index = options.findIndex((option) => option.emails.includes(address));
    return index >= 0 ? { kind: "one", index } : { kind: "address", email: address };
  }
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const ordinalWords = words.filter((word) => word !== "the" && word !== "option" && word !== "number");
  if (ordinalWords.length > 0 && ordinalWords.length <= 2) {
    const [head, tail] = ordinalWords;
    const position = /^\d{1,2}$/.test(head!) ? Number(head) - 1 : ORDINALS[head!];
    // "one" on its own is a number; "the Pinnacle one" is not.
    if (position !== undefined && (tail === undefined || (tail === "one" && head !== "one"))) {
      return position >= 0 && position < options.length ? { kind: "one", index: position } : { kind: "nobody" };
    }
  }
  const tokens = nameTokens(text).filter((word) => !FILLER.has(word));
  if (tokens.length === 0) {
    return { kind: "nobody" };
  }
  const fits: number[] = [];
  options.forEach((option, index) => {
    const known = new Set(
      nameTokens(
        `${option.name} ${option.company ?? ""} ${option.emails.map((email) => email.replace("@", " ")).join(" ")}`,
      ),
    );
    if (tokens.every((token) => known.has(token))) {
      fits.push(index);
    }
  });
  if (fits.length === 1) {
    return { kind: "one", index: fits[0]! };
  }
  return fits.length > 1 ? { kind: "several" } : { kind: "nobody" };
}

/** A person named in a Gmail query: from:hardik, to:"hardik singh", cc:(hardik singh). */
export interface NamedInQuery {
  start: number;
  end: number;
  operator: string;
  name: string;
}

/** Shared mailboxes, not anybody's name: "from:support" means whoever's support desk wrote. */
const SHARED_MAILBOX = new Set([
  "support", "info", "sales", "admin", "billing", "accounts", "hello", "contact", "help", "hr",
  "careers", "service", "care", "orders", "invoices", "newsletter", "notifications", "noreply",
]);

const OPERATOR = /(^|[\s({])(from|to|cc|bcc):(?:"([^"]*)"|\(([^()]*)\)|([^\s(){}"]+))/gi;

/**
 * The people a Gmail query names by name. Addresses, domains, "me", wildcards
 * and OR lists are left exactly as written: they already say who is meant.
 */
export function peopleNamedInQuery(query: string): NamedInQuery[] {
  const found: NamedInQuery[] = [];
  for (const match of query.matchAll(OPERATOR)) {
    const value = (match[3] ?? match[4] ?? match[5] ?? "").trim();
    if (
      !value ||
      /[@*|{}]/.test(value) ||
      /\bOR\b/.test(value) ||
      /\.[a-z]{2,}$/i.test(value) ||
      /^(?:me|myself)$/i.test(value) ||
      nameTokens(value).length === 0 ||
      nameTokens(value).every((word) => SHARED_MAILBOX.has(word))
    ) {
      continue;
    }
    const start = match.index + match[1]!.length;
    found.push({
      start,
      end: match.index + match[0].length,
      operator: match[2]!.toLowerCase(),
      name: value,
    });
  }
  return found;
}

/** The query with each name swapped for that person's addresses. */
export function rewriteQuery(
  query: string,
  resolved: ReadonlyArray<{ named: NamedInQuery; contact: Contact }>,
): string {
  let result = query;
  for (const { named, contact } of [...resolved].sort((left, right) => right.named.start - left.named.start)) {
    const addresses = contact.emails.join(" OR ");
    result = `${result.slice(0, named.start)}${named.operator}:(${addresses})${result.slice(named.end)}`;
  }
  return result;
}
