/**
 * One-time codes, the one place they are recognised. A 4-8 digit code (or a
 * split one: "482-913", "482 913", "4829 1301") is redacted only when a code
 * word is next to it: right after it in the same sentence ("OTP: 482913",
 * "your verification code is 551204", "आपका OTP 482913 है"), or right before it
 * ("482913 is your OTP"). Plain numbers are left alone: phone numbers, amounts,
 * dates, times, order and invoice numbers, and meeting IDs. A digit run that is
 * part of a longer number is never a code. Pure: no imports, so it can run anywhere.
 */

/** OTP, one-time, passcode, verification / security / auth / login code, PIN, 2FA. */
const CODE_WORD = String.raw`(?:otps?|one[-\s]?time(?:[-\s](?:password|passcode|pin|code))?|pass[-\s]?codes?|verification\s+codes?|verify\s+codes?|security\s+codes?|auth(?:entication)?\s+codes?|2fa(?:\s+codes?)?|two[-\s]factor(?:\s+codes?)?|login\s+codes?|pins?(?!\s*-?\s*codes?(?![\p{L}])))`;

/** "PIN code" alone is a postal code in India; "pincode" never matches as one word. */
const CODE_WORD_RE = new RegExp(String.raw`(?<![\p{L}\p{N}])${CODE_WORD}(?![\p{L}])`, "giu");

/** A code-shaped digit run that is not part of a longer number, a date, a time or an amount. */
const TOKEN_RE = new RegExp(
  String.raw`(?<![\p{N}]|[\p{N}][ \-/.:,]|[₹$€£]\s?|(?<![\p{L}])(?:rs|inr|usd|eur|gbp)\.?\s?)` +
    String.raw`(?:\d{3}[-\s]\d{3}|\d{4}[-\s]\d{4}|\d{4,8})` +
    String.raw`(?![\p{N}]|[ \-/.:,]?\p{N}|\s?(?:%|am|pm|hrs?|mins?|rs|inr|rupees?|usd|dollars?)(?![\p{L}]))`,
  "giu",
);

/** After the code word, the same line and sentence, this many characters at most. */
const AFTER_WINDOW = 40;
/** Before the code word: a few words of glue ("is your", "as the", "आपका"), nothing else. */
const BEFORE_GLUE = new RegExp(String.raw`^[ \t]*(?:[-–—:][ \t]*)?(?:[\p{L}\p{M}]+[ \t]+){0,4}${CODE_WORD}(?![\p{L}])`, "iu");

function codeWordEnds(text: string): number[] {
  return [...text.matchAll(CODE_WORD_RE)].map((match) => (match.index ?? 0) + match[0].length);
}

function followsCodeWord(text: string, start: number, ends: readonly number[]): boolean {
  return ends.some((end) => {
    if (end > start || start - end > AFTER_WINDOW) {
      return false;
    }
    // Same line and same sentence: a full stop, ! or ? followed by a space ends it.
    return !/\n|[.!?।](?:\s|$)/.test(text.slice(end, start));
  });
}

/** Replaces each one-time code next to a code word with "[redacted]". */
export function redactOtpCodes(text: string): string {
  const ends = codeWordEnds(text);
  if (ends.length === 0) {
    return text;
  }
  return text.replace(TOKEN_RE, (token: string, offset: number) =>
    followsCodeWord(text, offset, ends) || BEFORE_GLUE.test(text.slice(offset + token.length)) ? "[redacted]" : token,
  );
}

/** True when the text carries a one-time code next to a code word. */
export function hasOtpCode(text: string): boolean {
  return redactOtpCodes(text) !== text;
}
