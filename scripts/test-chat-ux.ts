import { plainTextBody } from "../src/google/mail.ts";
import { isSendDraftCommand } from "../src/send_triggers.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

function testSendCommands(): void {
  const positives = [
    "send",
    "send it",
    "Send it.",
    "send this",
    "yes send it",
    "Yes, send it!",
    "yes please send it",
    "please send",
    "please send it",
    "go ahead and send",
    "Go ahead and send it.",
    "send the email",
    "send the draft",
    "  send it  ",
  ];
  for (const text of positives) {
    assert(isSendDraftCommand(text), `should match: ${JSON.stringify(text)}`);
  }
  const negatives = [
    "don't send it",
    "do not send",
    "send me the report",
    "send it to Priya",
    "can you send the deck?",
    "resend it",
    "sending",
    "send it tomorrow",
    "yes",
    "",
  ];
  for (const text of negatives) {
    assert(!isSendDraftCommand(text), `should not match: ${JSON.stringify(text)}`);
  }
}

function testPlainTextBody(): void {
  assert(
    plainTextBody({
      mimeType: "text/plain",
      body: { data: b64("Hi Ravi,\r\n\r\nThanks.\r\nVishnu") },
    }) === "Hi Ravi,\n\nThanks.\nVishnu",
    "single-part text/plain decodes with LF line endings",
  );
  assert(
    plainTextBody({
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { data: b64("Body text") } },
            { mimeType: "text/html", body: { data: b64("<p>Body text</p>") } },
          ],
        },
        {
          mimeType: "text/plain",
          filename: "notes.txt",
          body: { data: b64("attachment contents") },
        },
      ],
    }) === "Body text",
    "nested multipart picks the inline text/plain part and skips attachments",
  );
  assert(
    plainTextBody({ mimeType: "text/html", body: { data: b64("<p>x</p>") } }) === "",
    "html-only payload returns empty string",
  );
}

testSendCommands();
testPlainTextBody();
console.log("Chat UX checks passed.");
