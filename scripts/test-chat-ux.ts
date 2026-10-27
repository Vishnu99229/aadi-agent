import { Api, HttpError } from "grammy";
import {
  createPendingAction,
  createPendingEventAction,
  getLatestPendingSendAction,
  setPendingActionTelegramMessage,
} from "../src/db.ts";
import { plainTextBody } from "../src/google/mail.ts";
import {
  isAmbiguousSendAck,
  isSendDraftCommand,
} from "../src/send_triggers.ts";
import {
  installNetworkRetry,
  redactBotToken,
  safeErrorText,
  splitForTelegram,
} from "../src/telegram_io.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

function testSendCommands(): void {
  for (const text of ["send", "send it", "Send it.", "SEND IT!", "  send it  "]) {
    assert(isSendDraftCommand(text), `fast path: ${JSON.stringify(text)}`);
  }
  // Everything else, including real send intents, is left to the model.
  const notFastPath = [
    "send that",
    "yes send it",
    "ok send",
    "go ahead and send",
    "haan bhej do",
    "done",
    "sent",
    "don't send it",
    "send me the report",
    "send it to Priya",
    "send it tomorrow",
    "ok",
    "",
  ];
  for (const text of notFastPath) {
    assert(!isSendDraftCommand(text), `not fast path: ${JSON.stringify(text)}`);
  }
  for (const text of ["ok", "Okay.", "k", "KK"]) {
    assert(isAmbiguousSendAck(text), `ambiguous ack: ${JSON.stringify(text)}`);
  }
  for (const text of ["send it", "haan bhej do", "ok send", "yes"]) {
    assert(!isAmbiguousSendAck(text), `not ambiguous ack: ${JSON.stringify(text)}`);
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

function testSplitForTelegram(): void {
  assert(splitForTelegram("").length === 0, "empty text sends nothing");
  assert(splitForTelegram("short").join("|") === "short", "short text is one chunk");

  const emoji = "😀".repeat(3000);
  const emojiChunks = splitForTelegram(emoji, 4000);
  assert(
    emojiChunks.every((chunk) => chunk.length <= 4000),
    "chunks stay within the UTF-16 limit",
  );
  assert(
    emojiChunks.every((chunk) => !/^[\udc00-\udfff]|[\ud800-\udbff]$/.test(chunk)),
    "no chunk starts or ends mid surrogate pair",
  );
  assert(emojiChunks.join("") === emoji, "emoji chunks rejoin losslessly");

  const lines = Array.from({ length: 300 }, (_, i) => `line ${i} ${"x".repeat(20)}`);
  const lineChunks = splitForTelegram(lines.join("\n"), 1000);
  assert(
    lineChunks.every((chunk) => chunk.length <= 1000),
    "line chunks stay within limit",
  );
  assert(
    lineChunks.every((chunk) => chunk.split("\n").every((line) => lines.includes(line))),
    "splits fall on line breaks when available",
  );
}

function testRedaction(): void {
  const leaked =
    "request to https://api.telegram.org/bot123456789:AAH-fake_Token-xyz/sendMessage failed";
  const redacted = redactBotToken(leaked);
  assert(!redacted.includes("AAH-fake_Token-xyz"), "token removed");
  assert(redacted.includes("bot<redacted>/sendMessage"), "url shape kept");
  const wrapped = new HttpError("Network request for 'sendMessage' failed!", new Error(leaked));
  assert(!safeErrorText(wrapped).includes("AAH-fake"), "safeErrorText never prints the inner URL");
}

async function testNetworkRetry(): Promise<void> {
  const api = new Api("123:test");
  let calls = 0;
  api.config.use(async (_prev, method) => {
    calls += 1;
    if (method === "sendMessage" && calls < 3) {
      throw new HttpError("Network request for 'sendMessage' failed!", new Error("ECONNABORTED"));
    }
    if (method === "getMe") {
      throw new HttpError("Network request for 'getMe' failed!", new Error("ECONNABORTED"));
    }
    return { ok: true, result: { message_id: 7 } } as never;
  });
  installNetworkRetry(api, [0, 0]);

  const sent = await api.sendMessage(1, "hi");
  assert(sent.message_id === 7 && calls === 3, "sendMessage retried twice then succeeded");

  calls = 0;
  let threw = false;
  try {
    await api.getMe();
  } catch {
    threw = true;
  }
  assert(threw && calls === 1, "methods outside the retry list are not retried");
}

function testLatestPendingIsDraftOnly(): void {
  const draft = createPendingAction("draft-standalone", null, "work");
  setPendingActionTelegramMessage(draft.id, 101);
  assert(draft.thread_id === null, "standalone draft stores a null thread_id");
  const event = createPendingEventAction({
    title: "Sync",
    startIso: "2026-10-28T10:00:00+05:30",
    endIso: "2026-10-28T10:30:00+05:30",
    attendees: [],
  });
  setPendingActionTelegramMessage(event.id, 102);
  assert(
    getLatestPendingSendAction()?.id === draft.id,
    "a newer calendar card does not shadow the pending email draft",
  );
}

testSendCommands();
testPlainTextBody();
testSplitForTelegram();
testRedaction();
await testNetworkRetry();
testLatestPendingIsDraftOnly();
console.log("Chat UX checks passed.");
