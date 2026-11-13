import { google, type calendar_v3, type gmail_v1 } from "googleapis";
import type { AccountRecord } from "./account_logic.js";
import { decodedAccounts } from "./accounts.js";
import { addressIn, isAutomatedAddress, nameTokens } from "./command_logic.js";
import { config } from "./config.js";
import {
  accountPeopleMatching,
  companyNamed,
  contactsFrom,
  nameKey,
  resolutionFrom,
  sightingMatches,
  type Contact,
  type ContactResolution,
  type Sighting,
} from "./contact_logic.js";
import { getContactChoice, listSequenceProspects, saveContactChoice, searchMemories } from "./db.js";
import { messageHeader } from "./gmail_attachments.js";
import {
  getGoogleAccount,
  GOOGLE_API_TIMEOUT_MS,
  type GoogleAccountId,
  type LoadedGoogleAccount,
} from "./google/auth.js";
import { gmailClient } from "./google/mail.js";
import { companyFromEmail, parseAddressList } from "./mail_helpers.js";
import { isSelfEmail } from "./mom_logic.js";
import { assertTestSeam } from "./test_seam.js";

/**
 * Who Vishnu means by a name. One service for the Email, Calendar and Sales
 * agents: it looks in known contacts (prospects and what he told Aadi), Gmail
 * correspondence, calendar attendees and account records, and answers one
 * person, several people or nobody. It never picks between several.
 *
 * This is for reading and for asking "which one?". It authorizes nothing: every
 * send and booking still resolves its recipient from his own words in
 * src/security/, exactly as before.
 */

const CACHE_MS = 5 * 60 * 1000;
/** His own answer to "which Hardik?" stands for this long, then the name is looked up afresh. */
const CHOICE_MS = 60 * 60 * 1000;
const MAIL_ROUNDS = 3;
const MAIL_RESULTS = 25;
const CALENDAR_RESULTS = 100;
const CALENDAR_PAST_DAYS = 365;
const CALENDAR_AHEAD_DAYS = 90;
const MEMORY_RESULTS = 8;
const DAY_MS = 24 * 60 * 60 * 1000;
const ADDRESS_TEXT = "[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}";
const ACCOUNT_IDS: readonly GoogleAccountId[] = ["work", "personal"];

let fakeCalendar: ((account: LoadedGoogleAccount) => calendar_v3.Calendar) | undefined;
const lookedUp = new Map<string, { at: number; sightings: Sighting[] }>();
const ownAddresses = new Map<GoogleAccountId, string>();

export function setContactCalendarForTests(
  fake: ((account: LoadedGoogleAccount) => calendar_v3.Calendar) | undefined,
): void {
  assertTestSeam("setContactCalendarForTests");
  fakeCalendar = fake;
}

export function clearContactCacheForTests(): void {
  assertTestSeam("clearContactCacheForTests");
  lookedUp.clear();
  ownAddresses.clear();
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

async function connectedAccounts(): Promise<LoadedGoogleAccount[]> {
  const found: LoadedGoogleAccount[] = [];
  for (const id of ACCOUNT_IDS) {
    try {
      found.push(await getGoogleAccount(id));
    } catch {
      // Not connected: the other sources still answer.
    }
  }
  return found;
}

async function ownAddress(account: LoadedGoogleAccount, gmail: gmail_v1.Gmail): Promise<string> {
  const known = ownAddresses.get(account.id);
  if (known !== undefined) {
    return known;
  }
  const profile = await gmail.users.getProfile({ userId: "me" });
  const address = profile.data.emailAddress?.toLowerCase() ?? "";
  ownAddresses.set(account.id, address);
  return address;
}

function isSelf(email: string): boolean {
  const address = email.toLowerCase();
  return (
    isSelfEmail(address) ||
    config.selfEmailAddresses.some((item) => item.toLowerCase() === address) ||
    [...ownAddresses.values()].includes(address)
  );
}

/** Mail he never took part in, such as a newsletter, doesn't make someone a contact. */
function countsAsContact(message: gmail_v1.Schema$Message): boolean {
  if (message.labelIds?.includes("DRAFT")) {
    return false;
  }
  if (message.labelIds?.includes("SENT")) {
    return true;
  }
  const precedence = messageHeader(message, "Precedence").toLowerCase();
  return (
    messageHeader(message, "List-Unsubscribe") === "" && precedence !== "bulk" && precedence !== "list"
  );
}

/** Each round leaves out the people already found, so a second Hardik turns up
 *  however much mail the first one has. */
async function mailSightings(
  account: LoadedGoogleAccount,
  tokens: readonly string[],
  accounts: readonly AccountRecord[],
): Promise<Sighting[]> {
  const gmail = gmailClient(account);
  await ownAddress(account, gmail);
  const wanted = tokens.map((token) => `(from:${token} OR to:${token} OR cc:${token})`).join(" ");
  const sightings: Sighting[] = [];
  const found = new Set<string>();
  for (let round = 0; round < MAIL_ROUNDS; round += 1) {
    const excluded = [...found].map((email) => `-from:${email} -to:${email} -cc:${email}`).join(" ");
    const listed = await gmail.users.messages.list({
      userId: "me",
      q: `${wanted} ${excluded}`.trim(),
      maxResults: MAIL_RESULTS,
    });
    const ids = (listed.data.messages ?? []).map((item) => item.id).filter((id): id is string => Boolean(id));
    const messages = await Promise.all(
      ids.map((id) =>
        gmail.users.messages.get({
          userId: "me",
          id,
          format: "metadata",
          metadataHeaders: ["From", "To", "Cc", "List-Unsubscribe", "Precedence"],
        }),
      ),
    );
    const before = found.size;
    for (const { data: message } of messages) {
      if (!countsAsContact(message)) {
        continue;
      }
      const seenMs = Number(message.internalDate) || undefined;
      for (const header of ["From", "To", "Cc"]) {
        for (const mailbox of parseAddressList(messageHeader(message, header))) {
          const sighting: Sighting = {
            name: mailbox.name,
            email: mailbox.email.toLowerCase(),
            source: "gmail",
            seenMs,
          };
          if (isAutomatedAddress(sighting.email) || !sightingMatches(sighting, tokens, accounts)) {
            continue;
          }
          sightings.push(sighting);
          found.add(sighting.email);
        }
      }
    }
    if (found.size === before) {
      break;
    }
  }
  return sightings;
}

async function calendarSightings(
  account: LoadedGoogleAccount,
  tokens: readonly string[],
): Promise<Sighting[]> {
  const calendar = fakeCalendar
    ? fakeCalendar(account)
    : google.calendar({ version: "v3", auth: account.client, timeout: GOOGLE_API_TIMEOUT_MS });
  const now = Date.now();
  const response = await calendar.events.list({
    calendarId: "primary",
    q: tokens.join(" "),
    timeMin: new Date(now - CALENDAR_PAST_DAYS * DAY_MS).toISOString(),
    timeMax: new Date(now + CALENDAR_AHEAD_DAYS * DAY_MS).toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: CALENDAR_RESULTS,
  });
  const sightings: Sighting[] = [];
  for (const event of response.data.items ?? []) {
    const startMs = Date.parse(event.start?.dateTime ?? event.start?.date ?? "");
    for (const attendee of event.attendees ?? []) {
      const email = attendee.email?.trim().toLowerCase();
      if (!email || attendee.self || attendee.resource) {
        continue;
      }
      sightings.push({
        name: attendee.displayName?.trim() ?? "",
        email,
        source: "calendar",
        // A meeting next month isn't a more recent contact than mail from yesterday.
        seenMs: Number.isFinite(startMs) ? Math.min(startMs, now) : undefined,
      });
    }
  }
  return sightings;
}

/** Gmail and both calendars, side by side. A source that fails is skipped, not fatal. */
async function googleSightings(
  tokens: readonly string[],
  accounts: readonly AccountRecord[],
): Promise<Sighting[]> {
  const key = [...tokens].sort().join(" ");
  const cached = lookedUp.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return cached.sightings;
  }
  const connected = await connectedAccounts();
  let failed = false;
  const lookups = connected.flatMap((account) => [
    mailSightings(account, tokens, accounts).catch((error: unknown) => {
      failed = true;
      console.error(`contacts: gmail lookup failed account=${account.id} (${errorName(error)})`);
      return [] as Sighting[];
    }),
    calendarSightings(account, tokens).catch((error: unknown) => {
      failed = true;
      console.error(`contacts: calendar lookup failed account=${account.id} (${errorName(error)})`);
      return [] as Sighting[];
    }),
  ]);
  const sightings = (await Promise.all(lookups)).flat();
  if (!failed) {
    lookedUp.set(key, { at: Date.now(), sightings });
  }
  return sightings;
}

/** Prospects from follow-up sequences, and addresses Vishnu told Aadi himself. */
function knownSightings(tokens: readonly string[]): Sighting[] {
  const sightings: Sighting[] = [];
  for (const prospect of listSequenceProspects()) {
    const seenMs = Date.parse(`${prospect.seen_at.replace(" ", "T")}Z`);
    sightings.push({
      name: prospect.name,
      email: prospect.email,
      source: "known",
      seenMs: Number.isFinite(seenMs) ? seenMs : undefined,
    });
  }
  for (const memory of searchMemories(tokens.join(" "), MEMORY_RESULTS)) {
    // Only what he told Aadi or confirmed: an automatic memory may have come from
    // something Aadi read.
    if (memory.source === "auto") {
      continue;
    }
    for (const sentence of memory.content.split(/(?<=[.!?])\s+|\n+/)) {
      // The name has to be in his sentence itself, not just inside the address.
      const email = addressIn(sentence);
      const words = new Set(nameTokens(email ? sentence.replace(new RegExp(ADDRESS_TEXT, "gi"), " ") : ""));
      if (email && tokens.every((token) => words.has(token))) {
        sightings.push({ name: "", email, source: "known", matched: true });
      }
    }
  }
  return sightings;
}

/** The person he picked the last time this name was asked about, while that still stands. */
export function chosenContact(query: string): Contact | undefined {
  const key = nameKey(query);
  if (!key) {
    return undefined;
  }
  const saved = getContactChoice(key, new Date(Date.now() - CHOICE_MS).toISOString());
  if (!saved) {
    return undefined;
  }
  try {
    const contact = JSON.parse(saved) as Contact;
    return Array.isArray(contact.emails) && contact.emails.length > 0 ? contact : undefined;
  } catch {
    return undefined;
  }
}

/** Records his own answer to "which one?". Called only for his reply or his tap. */
export function rememberContactChoice(query: string, contact: Contact): void {
  const key = nameKey(query);
  if (key) {
    saveContactChoice(key, JSON.stringify(contact), new Date().toISOString());
  }
}

/**
 * Resolves a name or address to a person. An address is taken as it is. A name
 * is matched on first name or full name, whatever the capitals and spacing.
 * Exactly one match is "one"; more than one is "many", for Vishnu to choose.
 */
export async function resolveContact(query: string): Promise<ContactResolution> {
  const accounts = decodedAccounts();
  const typed = addressIn(query);
  if (typed) {
    return {
      kind: "one",
      contact: { name: "", emails: [typed], company: companyFromEmail(typed, accounts), sources: [] },
    };
  }
  const tokens = nameTokens(query);
  if (tokens.length === 0) {
    return { kind: "none" };
  }
  const chosen = chosenContact(query);
  if (chosen) {
    return { kind: "one", contact: chosen };
  }
  const company = companyNamed(tokens, accounts);
  if (company) {
    return { kind: "none", company };
  }
  const startedAt = Date.now();
  const fromGoogle = await googleSightings(tokens, accounts);
  const sightings = [...knownSightings(tokens), ...fromGoogle].filter(
    (sighting) => !isSelf(sighting.email),
  );
  const people = accountPeopleMatching(tokens, accounts);
  const resolution = resolutionFrom(contactsFrom(sightings, tokens, accounts, people));
  console.log(
    `contacts: lookup kind=${resolution.kind} matches=${resolution.kind === "many" ? resolution.options.length : resolution.kind === "one" ? 1 : 0} ms=${Date.now() - startedAt}`,
  );
  if (resolution.kind === "none" && people.length > 0) {
    return { kind: "none", knownAs: `${people[0]!.name} (${people[0]!.account.name})` };
  }
  return resolution;
}
