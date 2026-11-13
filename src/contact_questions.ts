import type { CardButton } from "./agents/helpers.js";
import { decodedAccounts } from "./accounts.js";
import { addressIn, nameTokens } from "./command_logic.js";
import {
  describeContact,
  displayQuery,
  isDropAnswer,
  matchAnswer,
  optionLabels,
  optionsShown,
  unknownQuestion,
  whichQuestion,
  type Contact,
  type ContactResolution,
} from "./contact_logic.js";
import { rememberContactChoice, resolveContact } from "./contacts.js";
import {
  closeContactQuestion,
  getContactQuestion,
  getOpenContactQuestion,
  latestContactQuestionId,
  openContactQuestion,
  type ContactQuestionRecord,
} from "./db.js";
import { companyFromEmail } from "./mail_helpers.js";

/**
 * "Which Hardik are you referring to?" as a question that survives the turn.
 * A tool that can't tell who Vishnu means opens one here; the turn ends with
 * the question, and his answer re-runs the request he made, so he never has to
 * repeat it.
 *
 * Only his own chat or voice turn can open a question, and only his own reply
 * or tap can answer it. The answer decides who is looked up. It is not a
 * send approval: the re-run passes the same gates as any other turn.
 */

const QUESTION_MS = 15 * 60 * 1000;
const BUTTON_TEXT_MAX = 48;
const DROPPED_REPLY =
  "Okay, leaving that. Send me their email address or full name if you want me to look again.";

/** The parts of a tool turn that say whose turn it is. */
export interface AskingTurn {
  confirmation?: { chatId: number };
  userText?: string;
}

export type UnresolvedContact = Exclude<ContactResolution, { kind: "one" }>;

interface StoredOptions {
  options: Contact[];
  knownAs?: string;
}

export interface AskedQuestion {
  id: number;
  text: string;
  buttons: CardButton[][];
}

export type ContactAnswer =
  /** No question is open, or his message isn't an answer to it. */
  | { kind: "none" }
  /** He chose. Carry out `request`, his earlier message, telling the model `note`. */
  | { kind: "resume"; request: string; note: string }
  /** Say this and wait. */
  | { kind: "reply"; text: string; buttons: CardButton[][] };

function since(): string {
  return new Date(Date.now() - QUESTION_MS).toISOString();
}

function stored(row: ContactQuestionRecord): StoredOptions {
  try {
    const parsed = JSON.parse(row.options) as StoredOptions;
    return { options: Array.isArray(parsed.options) ? parsed.options : [], knownAs: parsed.knownAs };
  } catch {
    return { options: [] };
  }
}

function questionText(row: ContactQuestionRecord): string {
  const { options, knownAs } = stored(row);
  return options.length > 0 ? whichQuestion(row.query, options) : unknownQuestion(row.query, knownAs);
}

function questionButtons(row: ContactQuestionRecord): CardButton[][] {
  const shown = optionsShown(stored(row).options);
  if (shown.length === 0) {
    return [];
  }
  return [
    ...optionLabels(shown).map((label, index) => [
      {
        text: label.length > BUTTON_TEXT_MAX ? `${label.slice(0, BUTTON_TEXT_MAX - 1)}…` : label,
        data: `contact:pick:${row.id}:${index}`,
      },
    ]),
    [{ text: "Someone else", data: `contact:drop:${row.id}` }],
  ];
}

function present(row: ContactQuestionRecord): AskedQuestion {
  return { id: row.id, text: questionText(row), buttons: questionButtons(row) };
}

/**
 * For a tool that can't tell who Vishnu means. On his own turn this opens the
 * question for him; either way it returns the text for the tool result, which
 * starts with "Not" so nothing counts it as a successful lookup.
 */
export function askWhichContact(turn: AskingTurn, query: string, resolution: UnresolvedContact): string {
  const question =
    resolution.kind === "many"
      ? whichQuestion(query, resolution.options)
      : unknownQuestion(query, resolution.knownAs);
  const why =
    resolution.kind === "many"
      ? `${resolution.options.length} people match "${displayQuery(query)}"`
      : `nobody called "${displayQuery(query)}" was found`;
  const chatId = turn.confirmation?.chatId;
  const request = turn.userText?.trim();
  if (chatId === undefined || !request) {
    return `Not looked up: ${why}. Don't pick one and don't guess an address. Ask Vishnu:\n${question}`;
  }
  const options: StoredOptions =
    resolution.kind === "many" ? { options: resolution.options } : { options: [], knownAs: resolution.knownAs };
  openContactQuestion({
    chatId,
    request,
    query,
    options: JSON.stringify(options),
    createdAt: new Date().toISOString(),
  });
  return `Not looked up: ${why}. Vishnu is being asked now, and his request is carried out when he answers. Stop here: don't search another way and don't guess.\n\n${question}`;
}

/** Marks where a turn starts, to tell later whether it asked a question. */
export function contactQuestionMark(chatId: number | undefined): number {
  return chatId === undefined ? 0 : latestContactQuestionId(chatId);
}

/** The question a turn opened since `mark`, if it opened one. */
export function contactQuestionAsked(chatId: number | undefined, mark: number): AskedQuestion | undefined {
  if (chatId === undefined) {
    return undefined;
  }
  const row = getOpenContactQuestion(chatId, since());
  return row && row.id > mark ? present(row) : undefined;
}

export function hasOpenContactQuestion(chatId: number): boolean {
  return getOpenContactQuestion(chatId, since()) !== undefined;
}

function chosen(row: ContactQuestionRecord, contact: Contact): ContactAnswer {
  if (!closeContactQuestion(row.id, "answered")) {
    return { kind: "reply", text: "That one's already answered.", buttons: [] };
  }
  rememberContactChoice(row.query, contact);
  return {
    kind: "resume",
    request: row.request,
    note: `[Aadi asked which ${displayQuery(row.query)} he meant. Vishnu chose: ${describeContact(contact)}. Carry out the request above for that person without asking again.]`,
  };
}

function typedAddress(row: ContactQuestionRecord, email: string): Contact {
  const asked = addressIn(row.query) ? "" : displayQuery(row.query);
  return { name: asked, emails: [email], company: companyFromEmail(email, decodedAccounts()), sources: [] };
}

/** A new request ("email Hardik Singh the deck") is not an answer, even if it names one of the choices. */
const NEW_REQUEST =
  /\?|\b(?:send|e-?mail|mail|find|search|show|check|book|schedule|remind|draft|write|reply|forward|list|add|delete|cancel|summari[sz]e|read|call|tell)\b/i;

/** Acknowledgements and requests are new messages, not a name or a company. */
const NOT_IDENTIFYING =
  /\b(?:ok|okay|hmm+|thanks?|thank\s+you|fine|sure|yes|no|hi|hello|send|email|mail|find|search|show|check|book|schedule|remind|draft|what|when|who|why|how|list|add|delete|cancel|open|call|tell|get|give|summari[sz]e|read)\b/i;

function looksIdentifying(text: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return (
    words.length > 0 &&
    words.length <= 5 &&
    !/[?/]/.test(text) &&
    !NOT_IDENTIFYING.test(text) &&
    nameTokens(text).length > 0
  );
}

/**
 * Reads Vishnu's next message against the open question. A reply that points
 * at exactly one person resumes his request. One that fits several asks again,
 * and one that isn't an answer drops the question and is handled as usual.
 */
export async function answerContactQuestion(chatId: number, text: string): Promise<ContactAnswer> {
  const row = getOpenContactQuestion(chatId, since());
  if (!row) {
    return { kind: "none" };
  }
  if (isDropAnswer(text)) {
    closeContactQuestion(row.id, "dropped");
    return { kind: "reply", text: DROPPED_REPLY, buttons: [] };
  }
  const { options } = stored(row);
  if (options.length > 0) {
    const match: ReturnType<typeof matchAnswer> =
      NEW_REQUEST.test(text) && !addressIn(text) ? { kind: "nobody" } : matchAnswer(options, text);
    if (match.kind === "one") {
      return chosen(row, options[match.index]!);
    }
    if (match.kind === "address") {
      return chosen(row, typedAddress(row, match.email));
    }
    if (match.kind === "several") {
      return {
        kind: "reply",
        text: `That fits more than one of them.\n${questionText(row)}`,
        buttons: questionButtons(row),
      };
    }
    closeContactQuestion(row.id, "dropped");
    return { kind: "none" };
  }

  // Nobody matched before: he is giving an address, or a fuller name or company.
  const address = addressIn(text);
  if (address) {
    return chosen(row, typedAddress(row, address));
  }
  if (!looksIdentifying(text)) {
    closeContactQuestion(row.id, "dropped");
    return { kind: "none" };
  }
  // What he typed may stand alone ("Meera Iyer") or add to the name ("Pinnacle").
  let fuller = text.trim();
  let resolution = await resolveContact(fuller);
  if (resolution.kind === "none") {
    fuller = `${row.query} ${text.trim()}`;
    resolution = await resolveContact(fuller);
  }
  if (resolution.kind === "one") {
    return chosen(row, resolution.contact);
  }
  if (resolution.kind === "many") {
    const id = openContactQuestion({
      chatId,
      request: row.request,
      query: fuller,
      options: JSON.stringify({ options: resolution.options } satisfies StoredOptions),
      createdAt: new Date().toISOString(),
    });
    const next = getContactQuestion(id)!;
    return { kind: "reply", text: questionText(next), buttons: questionButtons(next) };
  }
  return {
    kind: "reply",
    text: `I still can't find ${displayQuery(fuller)}. What's their email address?`,
    buttons: [],
  };
}

/** A tap on one of the choices. */
export function pickContactOption(id: number, index: number): ContactAnswer {
  const row = getContactQuestion(id);
  const contact = row ? stored(row).options[index] : undefined;
  if (!row || !contact || row.status !== "open" || row.created_at < since()) {
    return { kind: "reply", text: "That question has expired. Ask me again.", buttons: [] };
  }
  return chosen(row, contact);
}

/** A tap on "Someone else". */
export function dropContactQuestion(id: number): ContactAnswer {
  closeContactQuestion(id, "dropped");
  return { kind: "reply", text: DROPPED_REPLY, buttons: [] };
}
