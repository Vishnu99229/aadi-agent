import "dotenv/config";

process.env.AADI_DB_PATH ??= ":memory:";
process.env.LLM_PROVIDER ??= "claude";
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.OWNER_TELEGRAM_ID ??= "1";
process.env.CLAUDE_MODEL ??= "claude-sonnet-5-5";
process.env.ANTHROPIC_API_KEY ??= "test-key";
process.env.BRIEF_TIME ??= "08:00";
process.env.SARVAM_API_KEY ??= "test-sarvam-key";
process.env.VOICE_REPLIES_ENABLED ??= "false";

import { readFileSync } from "node:fs";
import { listUsageLogs } from "../src/db.ts";
import {
  VOICE_CARD_TRAILER,
  VOICE_SPEAK_CHAR_CAP,
  VOICE_TRUNCATION_TRAILER,
  detectVoiceLanguage,
  looksLikePendingActionCard,
  maybeSendVoiceReply,
  prepareSpokenText,
  resetVoiceReplyTestHooks,
  setVoiceRepliesEnabled,
  setVoiceReplyTestHooks,
  stripForSpeech,
  voiceRepliesEnabled,
} from "../src/voice_reply.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const fakeApi = {} as never;

{
  assert(detectVoiceLanguage("hello there") === "en", "default English");
  assert(detectVoiceLanguage("नमस्ते भाई") === "hi", "Hindi script");
  assert(detectVoiceLanguage("നമസ്കാരം") === "ml", "Malayalam script");
  console.log("language detection: ok");
}

{
  const stripped = stripForSpeech(
    "See **bold** and [docs](https://example.com/path) plus https://evil.test/x and `code`.",
  );
  assert(!/https?:\/\//.test(stripped), "urls stripped");
  assert(!/\*\*/.test(stripped), "markdown bold markers stripped");
  assert(stripped.includes("bold"), "bold text kept");
  assert(stripped.includes("docs"), "link label kept");
  assert(stripped.includes("code"), "inline code kept");
  console.log("markdown/url strip: ok");
}

{
  const long = `${"Sentence one is short. ".repeat(3)}${"word ".repeat(200)}`;
  const spoken = prepareSpokenText(long);
  assert(
    spoken.includes(VOICE_TRUNCATION_TRAILER),
    "over-cap adds truncation trailer",
  );
  assert(
    spoken.length < long.length,
    "spoken text shorter than raw long reply",
  );
  assert(
    prepareSpokenText("Short reply.").includes("Short reply."),
    "short reply unchanged aside from trim",
  );
  assert(VOICE_SPEAK_CHAR_CAP === 500, "cap constant is 500");
  console.log("length cap: ok");
}

{
  const card = [
    "Draft waiting for approval",
    "",
    "Account: work (Epicode)",
    "To: someone@acme.com",
    "Subject: Hello",
    "",
    "Long body that must not be read aloud.",
  ].join("\n");
  assert(looksLikePendingActionCard(card), "card detected");
  const spoken = prepareSpokenText(card);
  assert(
    spoken.startsWith("Draft waiting for approval"),
    "card speaks summary line",
  );
  assert(spoken.includes(VOICE_CARD_TRAILER), "card trailer present");
  assert(!/someone@acme\.com/.test(spoken), "card body not spoken");
  console.log("pending-action card speech: ok");
}

{
  setVoiceRepliesEnabled(true);
  assert(voiceRepliesEnabled(), "setting on enables replies");

  let ttsCalls = 0;
  let sendCalls = 0;
  const order: string[] = [];
  setVoiceReplyTestHooks({
    fetch: async () => {
      ttsCalls += 1;
      order.push("tts");
      return new Response(
        JSON.stringify({
          audios: [Buffer.from("fake-mp3").toString("base64")],
          request_id: "test",
        }),
        { status: 200 },
      );
    },
    sendVoice: async () => {
      sendCalls += 1;
      order.push("sendVoice");
    },
  });

  // Simulate text-first then voice (same order as completeChatReply).
  order.push("text");
  const sent = await maybeSendVoiceReply({
    api: fakeApi,
    chatId: 1,
    replyText: "Hello from Aadi.",
    sourceText: "what's up",
    inboundWasVoice: true,
    forwarded: false,
  });
  assert(sent === "sent", "non-forwarded voice note gets voice reply");
  assert(ttsCalls === 1 && sendCalls === 1, "tts + sendVoice once");
  assert(
    order.join(",") === "text,tts,sendVoice",
    `text always first, got ${order.join(",")}`,
  );

  const skippedForward = await maybeSendVoiceReply({
    api: fakeApi,
    chatId: 1,
    replyText: "Forwarded answer.",
    sourceText: "forwarded voice body",
    inboundWasVoice: true,
    forwarded: true,
  });
  assert(skippedForward === "skipped", "forwarded voice = text only");
  assert(ttsCalls === 1, "no TTS for forwarded");

  const skippedTyped = await maybeSendVoiceReply({
    api: fakeApi,
    chatId: 1,
    replyText: "Typed answer.",
    sourceText: "typed",
    inboundWasVoice: false,
    forwarded: false,
  });
  assert(skippedTyped === "skipped", "typed messages get no voice");

  setVoiceReplyTestHooks({
    fetch: async () => new Response("nope", { status: 503 }),
  });
  const failed = await maybeSendVoiceReply({
    api: fakeApi,
    chatId: 1,
    replyText: "Still a text reply.",
    sourceText: "hi",
    inboundWasVoice: true,
    forwarded: false,
  });
  assert(failed === "failed", "TTS failure returns failed");
  assert(sendCalls === 1, "failed TTS does not sendVoice");

  resetVoiceReplyTestHooks();
  setVoiceRepliesEnabled(false);
  console.log("voice reply gating + failure fallback: ok");
}

{
  const botSrc = readFileSync(new URL("../src/bot.ts", import.meta.url), "utf8");
  const textIdx = botSrc.indexOf("await sendPlainText(ctx, settled.reply)");
  const voiceIdx = botSrc.indexOf("maybeSendVoiceReply({");
  assert(textIdx > 0 && voiceIdx > textIdx, "bot sends text before scheduling voice");
  assert(
    /voiceReply:\s*options\.voiceReply === true && !forwarded/.test(botSrc),
    "handleUserText only requests voice for non-forwarded voice turns",
  );
  assert(
    /handleUserText\(ctx, ctx\.from\.id, transcript, \{ voiceReply: true \}\)/.test(
      botSrc,
    ),
    "non-forwarded voice path passes voiceReply: true",
  );
  assert(
    /handleForwardedContent\(ctx, transcript\)/.test(botSrc),
    "forwarded voice still uses handleForwardedContent",
  );
  console.log("bot wiring (text first, voice-only non-forwarded): ok");
}

{
  setVoiceRepliesEnabled(true);
  setVoiceReplyTestHooks({
    fetch: async () =>
      new Response(
        JSON.stringify({
          audios: [Buffer.from("x").toString("base64")],
        }),
        { status: 200 },
      ),
    sendVoice: async () => undefined,
  });
  const before = Date.now();
  await maybeSendVoiceReply({
    api: fakeApi,
    chatId: 1,
    replyText: "Usage check.",
    sourceText: "hi",
    inboundWasVoice: true,
    forwarded: false,
  });
  const rows = listUsageLogs(
    new Date(before - 1000).toISOString(),
    new Date(Date.now() + 1000).toISOString(),
  );
  assert(
    rows.some((row) => row.task === "tts"),
    "usage_log records task tts",
  );
  resetVoiceReplyTestHooks();
  setVoiceRepliesEnabled(false);
  console.log("usage_log tts: ok");
}

console.log("test-voice-reply: all passed");
