// Subject encoding and signatures on outgoing drafts, using a fake Gmail
// client. No Google account or token is touched.
import type { LoadedGoogleAccount } from "../src/google/auth.ts";
import {
  buildThreadReplyMime,
  createNewEmailDraft,
  mimeHeaderBlock,
  mimeHeaderNames,
  setGmailClientForTests,
  signatureHtmlFor,
  stripSignature,
} from "../src/google/mail.ts";
import { encodeMimeHeader } from "../src/google/mime.ts";
import { DRAFT_CARD_ONLY, isDraftCardOnly, shortenDraftReply } from "../src/draft_confirm.ts";
import { unreceiptedClaims } from "../src/receipt.ts";
import { fakeGmail, TEST_SIGNATURE_HTML, type GmailLog } from "./fakes.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

/** Strict RFC 2047 "B" decoder for the test: unfold, then join adjacent
 *  encoded-words (whitespace between them is not part of the text). */
function decodeHeader(value: string): string {
  const unfolded = value.replace(/\r\n[ \t]/g, " ");
  return unfolded
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/gi, (_m, data: string) =>
      Buffer.from(data, "base64").toString("utf8"),
    );
}

function headerValue(raw: string, name: string): string {
  const block = mimeHeaderBlock(raw);
  const match = new RegExp(`^${name}: ((?:.*)(?:\\r\\n[ \\t].*)*)`, "m").exec(block);
  return match?.[1] ?? "";
}

function partBody(raw: string, contentType: string): string {
  const index = raw.indexOf(`Content-Type: ${contentType}`);
  assert(index >= 0, `${contentType} part present`);
  const start = raw.indexOf("\r\n\r\n", index) + 4;
  const end = raw.indexOf("\r\n--", start);
  return Buffer.from(raw.slice(start, end).replace(/\r\n/g, ""), "base64").toString("utf8");
}

const tricky = "Epicode demo — ₹5,000 plan 🚀 as discussed";

// Subject encoding round-trips and stays plain ASCII on the wire.
{
  const encoded = encodeMimeHeader(tricky);
  assert(/^[\x20-\x7e\r\n]*$/.test(encoded), "encoded subject is ASCII");
  assert(decodeHeader(encoded) === tricky, "subject with — ₹ and an emoji round-trips");
  assert(
    `Subject: ${encoded}`.split("\r\n").every((line) => line.length <= 78),
    "encoded subject lines stay within 78 characters",
  );
  const long = `${tricky} — ${"é".repeat(80)}`;
  assert(decodeHeader(encodeMimeHeader(long)) === long, "long subjects fold without splitting characters");
  assert(encodeMimeHeader("Plain ASCII subject") === "Plain ASCII subject", "ASCII subjects pass through");
}

const log: GmailLog = { sent: [], created: [] };
setGmailClientForTests(() => fakeGmail(log));
const workAccount = {
  id: "work",
  tag: "work",
  label: "work (Epicode)",
  client: {},
} as unknown as LoadedGoogleAccount;

// A new email from the work account carries the send-as signature as HTML,
// with a plain-text fallback, and an encoded subject.
{
  const signature = await signatureHtmlFor(workAccount);
  assert(signature === TEST_SIGNATURE_HTML, "signature comes from the account's default send-as");
  const body = "Hi Priya,\n\nThe demo moves to Thursday.\n\nVishnu";
  await createNewEmailDraft({
    account: workAccount,
    to: ["priya@acme.com"],
    subject: tricky,
    body,
    signatureHtml: signature,
  });
  const raw = log.created.at(-1)!;
  assert(decodeHeader(headerValue(raw, "Subject")) === tricky, "draft subject decodes exactly");
  assert(/^Content-Type: multipart\/alternative;/m.test(mimeHeaderBlock(raw)), "signed draft is multipart/alternative");
  const html = partBody(raw, 'text/html; charset="UTF-8"');
  assert(html.includes(TEST_SIGNATURE_HTML), "HTML part includes the signature HTML");
  assert(html.includes("The demo moves to Thursday."), "HTML part includes the body");
  const plain = partBody(raw, 'text/plain; charset="UTF-8"');
  assert(plain.includes("\n\n-- \nVishnu Rajan\nGTM, Epicode & Partners"), "plain part has the text signature");
  const stripped = stripSignature(plain);
  assert(stripped.signed && stripped.body === body, "stripping the signature gives back the exact body");
  assert(
    mimeHeaderNames(raw) === "To, Subject, MIME-Version, Content-Type",
    "logged header summary has names only",
  );
}

// Without a signature (scheduling drafts) the message stays plain text.
{
  const raw = buildThreadReplyMime({
    to: "Ravi <ravi@acme.com>",
    subject: "Re: Pricing — next steps",
    inReplyTo: "<a@acme.com>",
    references: "<a@acme.com>",
    body: "Hi Ravi,\n\nThanks.\n\nVishnu",
  });
  assert(/^Content-Type: text\/plain;/m.test(mimeHeaderBlock(raw)), "unsigned reply stays text/plain");
  assert(decodeHeader(headerValue(raw, "Subject")) === "Re: Pricing — next steps", "reply subject decodes exactly");
  assert(stripSignature("Hi\n\nVishnu").signed === false, "unsigned body is left alone");
}

// Personal account with no send-as signature gets none (never the Epicode one).
{
  setGmailClientForTests(
    () =>
      ({
        users: { settings: { sendAs: { list: async () => ({ data: { sendAs: [{ isDefault: true }] } }) } } },
      }) as never,
  );
  const personal = { id: "personal", tag: "personal", label: "personal (Gmail)", client: {} } as unknown as LoadedGoogleAccount;
  assert((await signatureHtmlFor(personal)) === "", "personal account without a signature gets none");
}

setGmailClientForTests(undefined);

{
  const body = "Testing the Email Agent's drafting functionality. This sentence is long enough to count as the draft body itself.";
  const repeated = `Draft ready for review.\n\nTo: Qa Draft <qa-draft@example.com>\nSubject: Aadi Draft Test\n\n${body}`;
  const short = shortenDraftReply(repeated, [body]);
  assert(isDraftCardOnly(short), "a reply that only repeats the draft is not sent again");
  assert(short === DRAFT_CARD_ONLY, "the card is the only Telegram message");
  assert(shortenDraftReply("Draft ready.", [body]) === "Draft ready.", "a short reply that does not quote the body is left alone");
  assert(shortenDraftReply(repeated, [body, "A different draft body that is also longer than forty characters."]).includes(body), "two different drafts are not rewritten");
  const review = `Account review: stage Prospect.\n\n${body}`;
  const kept = shortenDraftReply(review, [body]);
  assert(kept.startsWith("Account review") && !kept.includes(body.slice(0, 40)), "other findings stay; the draft body does not");
  assert(
    unreceiptedClaims("Draft ready for approval. Waiting for your Send tap.", []).includes("offered"),
    "a draft card is not claimed without a tool",
  );
  assert(
    unreceiptedClaims("Draft ready for approval.", [{ name: "draft_new_email", success: true }]).length === 0,
    "a successful draft tool covers the card claim",
  );
}

console.log("Email format checks passed.");
