// 39 UTF-8 bytes -> 52 base64 chars, so "Subject: " plus one encoded word
// stays under the 78-character line guideline.
const ENCODED_WORD_BYTES = 39;

/** RFC 2047 header value: ASCII passes through; anything else becomes UTF-8
 *  base64 encoded-words, folded onto continuation lines, never splitting a
 *  character across words. Raw UTF-8 in a header is what produced the
 *  mojibake subjects (an em dash arriving as several Latin-1 characters). */
export function encodeMimeHeader(value: string): string {
  const clean = value.replace(/[\r\n]+/g, " ").trim();
  if (/^[\x20-\x7e]*$/.test(clean)) {
    return clean;
  }
  const words: string[] = [];
  let chunk = "";
  for (const char of clean) {
    if (Buffer.byteLength(chunk + char, "utf8") > ENCODED_WORD_BYTES) {
      words.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) {
    words.push(chunk);
  }
  return words
    .map((word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`)
    .join("\r\n ");
}
