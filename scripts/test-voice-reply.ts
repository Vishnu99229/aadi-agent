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
import { getRecentMessages, listUsageLogs, saveMessage } from "../src/db.ts";
import {
  TELEGRAM_CAPTION_LIMIT,
  VOICE_DETAILS_ABOVE,
  VOICE_SPEAK_CHAR_CAP,
  deliverVoiceTurn,
  detectVoiceLanguage,
  planVoiceDelivery,
  replyNeedsTextChannel,
  resetVoiceReplyTestHooks,
  setVoiceRepliesEnabled,
  setVoiceReplyTestHooks,
  stripForSpeech,
  synthesizeSpeech,
  voiceReplyCaption,
  voiceRepliesEnabled,
} from "../src/voice_reply.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const fakeApi = {} as never;

function stubOkTts(): void {
  setVoiceReplyTestHooks({
    fetch: async () =>
      new Response(
        JSON.stringify({
          audios: [Buffer.from("fake-mp3").toString("base64")],
          request_id: "test",
        }),
        { status: 200 },
      ),
  });
}

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
  console.log("markdown/url strip: ok");
}

{
  const caption = voiceReplyCaption("hello world");
  assert(caption === "You said: hello world", `caption=${caption}`);
  const long = "x".repeat(TELEGRAM_CAPTION_LIMIT + 50);
  const capped = voiceReplyCaption(long);
  assert(capped.startsWith("You said: "), "caption prefix");
  assert(capped.length <= TELEGRAM_CAPTION_LIMIT, "caption within Telegram limit");
  assert(capped.endsWith("…"), "long caption truncated with ellipsis");
  console.log("transcript caption: ok");
}

{
  setVoiceRepliesEnabled(true);
  assert(
    planVoiceDelivery({
      replyText: "All good — meeting at 3.",
      transcript: "how's my afternoon",
      inboundWasVoice: true,
      forwarded: false,
    }).mode === "voice_only",
    "plain short → voice_only",
  );
  assert(
    !replyNeedsTextChannel("All good — meeting at 3."),
    "plain short needs no text channel",
  );

  const card = [
    "Draft waiting for approval",
    "",
    "To: a@b.com",
    "Subject: Hi",
  ].join("\n");
  assert(replyNeedsTextChannel(card), "card needs text");
  assert(
    planVoiceDelivery({
      replyText: card,
      transcript: "draft that",
      inboundWasVoice: true,
      forwarded: false,
    }).spoken === VOICE_DETAILS_ABOVE,
    "card speaks details-above line",
  );

  const long = `Hello. ${"word ".repeat(200)}`;
  assert(long.length > VOICE_SPEAK_CHAR_CAP, "fixture is long");
  assert(replyNeedsTextChannel(long), "long needs text");
  assert(
    planVoiceDelivery({
      replyText: long,
      transcript: "tell me more",
      inboundWasVoice: true,
      forwarded: false,
    }).mode === "text_and_voice",
    "long → text_and_voice",
  );

  assert(
    replyNeedsTextChannel("See https://example.com for the deck"),
    "links need text",
  );
  assert(
    planVoiceDelivery({
      replyText: "ok",
      transcript: "hi",
      inboundWasVoice: true,
      forwarded: true,
    }).mode === "text_only",
    "forwarded → text_only plan",
  );
  assert(
    planVoiceDelivery({
      replyText: "ok",
      transcript: "hi",
      inboundWasVoice: false,
      forwarded: false,
    }).mode === "text_only",
    "text-in → text_only plan",
  );
  console.log("delivery plan: ok");
}

{
  setVoiceRepliesEnabled(true);
  stubOkTts();
  const captions: string[] = [];
  const spoken: string[] = [];
  const texts: string[] = [];
  setVoiceReplyTestHooks({
    fetch: async () =>
      new Response(
        JSON.stringify({ audios: [Buffer.from("x").toString("base64")] }),
        { status: 200 },
      ),
    sendVoice: async (_api, _chat, _path, caption) => {
      captions.push(caption ?? "");
      spoken.push("voice");
    },
  });

  const plain = await deliverVoiceTurn({
    api: fakeApi,
    chatId: 1,
    replyText: "Sure, you're free after 4.",
    transcript: "am I free after four",
    inboundWasVoice: true,
    forwarded: false,
    sendText: async (text) => {
      texts.push(text);
    },
  });
  assert(plain.mode === "voice_only", "plain short mode voice_only");
  assert(plain.sentVoice && !plain.sentText, "plain short: voice only, no text");
  assert(texts.length === 0, "plain short sends no text message");
  assert(
    captions[0] === "You said: am I free after four\n\nSure, you're free after 4.",
    `caption has the transcript and the reply, got ${captions[0]}`,
  );

  // Markdown is stripped from the caption, as it is from the speech.
  captions.length = 0;
  await deliverVoiceTurn({
    api: fakeApi,
    chatId: 1,
    replyText: "**Yes**, you're free.",
    transcript: "am I free",
    inboundWasVoice: true,
    forwarded: false,
    sendText: async (text) => {
      texts.push(text);
    },
  });
  assert(captions[0] === "You said: am I free\n\nYes, you're free.", `plain caption, got ${captions[0]}`);

  // At the limit it still fits; one over and the reply follows as a message.
  const heard = "h".repeat(600);
  const prefix = "You said: ".length + heard.length + 2;
  const fits = "y".repeat(TELEGRAM_CAPTION_LIMIT - prefix);
  assert(fits.length < VOICE_SPEAK_CHAR_CAP, "the reply is short enough to speak");
  captions.length = 0;
  texts.length = 0;
  const exact = await deliverVoiceTurn({
    api: fakeApi, chatId: 1, replyText: fits, transcript: heard, inboundWasVoice: true, forwarded: false,
    sendText: async (text) => {
      texts.push(text);
    },
  });
  assert(captions[0]!.length === TELEGRAM_CAPTION_LIMIT && captions[0]!.endsWith(fits), "exactly at the limit, both are in the caption");
  assert(exact.sentVoice && !exact.sentText && texts.length === 0, "and no message follows");

  const order: string[] = [];
  const over = `${fits}y`;
  captions.length = 0;
  setVoiceReplyTestHooks({
    sendVoice: async (_api, _chat, _path, caption) => {
      captions.push(caption ?? "");
      order.push("voice");
    },
  });
  const overflow = await deliverVoiceTurn({
    api: fakeApi, chatId: 1, replyText: over, transcript: heard, inboundWasVoice: true, forwarded: false,
    sendText: async (text) => {
      order.push(`text:${text}`);
    },
  });
  assert(captions[0] === `You said: ${heard}`, "over the limit, the caption keeps the transcript");
  assert(order.join("|") === `voice|text:${over}`, `the voice, then the full reply, got ${order.join("|")}`);
  assert(overflow.sentVoice && overflow.sentText, "both are reported");

  // If the voice fails, the reply still arrives once.
  const failedTexts: string[] = [];
  setVoiceReplyTestHooks({ fetch: async () => new Response("nope", { status: 500 }) });
  const voiceFailed = await deliverVoiceTurn({
    api: fakeApi, chatId: 1, replyText: over, transcript: heard, inboundWasVoice: true, forwarded: false,
    sendText: async (text) => {
      failedTexts.push(text);
    },
  });
  assert(!voiceFailed.sentVoice && failedTexts.length === 1 && failedTexts[0] === over, "no voice: the text arrives once");
  setVoiceReplyTestHooks({
    fetch: async () => new Response(JSON.stringify({ audios: [Buffer.from("x").toString("base64")] }), { status: 200 }),
    sendVoice: async (_api, _chat, _path, caption) => {
      captions.push(caption ?? "");
      spoken.push("voice");
    },
  });
  texts.length = 0;

  captions.length = 0;
  spoken.length = 0;
  texts.length = 0;
  const cardReply = await deliverVoiceTurn({
    api: fakeApi,
    chatId: 1,
    replyText: "Draft waiting for approval\n\nTo: a@b.com\nSubject: Hi\n\nBody",
    transcript: "draft a reply to Priya",
    inboundWasVoice: true,
    forwarded: false,
    sendText: async (text) => {
      texts.push(text);
    },
  });
  assert(cardReply.mode === "text_and_voice", "card → text_and_voice");
  assert(cardReply.sentText && cardReply.sentVoice, "card: text + voice");
  assert(texts.length === 1, "card sends text");
  assert(texts[0]!.includes("Draft waiting for approval"), "text is full card");

  captions.length = 0;
  texts.length = 0;
  const longReply = `Intro. ${"detail ".repeat(120)}`;
  const long = await deliverVoiceTurn({
    api: fakeApi,
    chatId: 1,
    replyText: longReply,
    transcript: "give me the long version",
    inboundWasVoice: true,
    forwarded: false,
    sendText: async (text) => {
      texts.push(text);
    },
  });
  assert(long.mode === "text_and_voice", "long → text_and_voice");
  assert(long.sentText && long.sentVoice, "long: text + short voice");
  assert(texts[0] === longReply, "long text is full reply");

  setVoiceReplyTestHooks({
    fetch: async () => new Response("nope", { status: 503 }),
    sendVoice: async () => {
      throw new Error("should not sendVoice on TTS fail");
    },
  });
  texts.length = 0;
  const failed = await deliverVoiceTurn({
    api: fakeApi,
    chatId: 1,
    replyText: "Fallback text reply.",
    transcript: "say hi",
    inboundWasVoice: true,
    forwarded: false,
    sendText: async (text) => {
      texts.push(text);
    },
  });
  assert(failed.sentText && !failed.sentVoice, "TTS failure → text, no voice");
  assert(texts[0] === "Fallback text reply.", "fallback sends full reply");

  texts.length = 0;
  stubOkTts();
  setVoiceReplyTestHooks({
    fetch: async () =>
      new Response(
        JSON.stringify({ audios: [Buffer.from("x").toString("base64")] }),
        { status: 200 },
      ),
    sendVoice: async () => {
      throw new Error("typed should not send voice");
    },
  });
  const typed = await deliverVoiceTurn({
    api: fakeApi,
    chatId: 1,
    replyText: "Typed answer.",
    transcript: "typed",
    inboundWasVoice: false,
    forwarded: false,
    sendText: async (text) => {
      texts.push(text);
    },
  });
  assert(typed.mode === "text_only" && typed.sentText && !typed.sentVoice, "text-in → text only");
  assert(texts[0] === "Typed answer.", "text-in sends text");

  resetVoiceReplyTestHooks();
  setVoiceRepliesEnabled(false);
  console.log("deliverVoiceTurn behaviours: ok");
}

{
  setVoiceRepliesEnabled(true);
  stubOkTts();
  const captions: string[] = [];
  setVoiceReplyTestHooks({
    fetch: async () =>
      new Response(
        JSON.stringify({ audios: [Buffer.from("x").toString("base64")] }),
        { status: 200 },
      ),
    sendVoice: async (_a, _c, _p, caption) => {
      captions.push(caption ?? "");
    },
  });
  const full = "History must keep this exact assistant reply.";
  saveMessage("assistant", full);
  await deliverVoiceTurn({
    api: fakeApi,
    chatId: 1,
    replyText: full,
    transcript: "remember this",
    inboundWasVoice: true,
    forwarded: false,
    sendText: async () => {
      throw new Error("voice-only must not send text");
    },
  });
  const recent = getRecentMessages(5);
  assert(
    recent.some((row) => row.role === "assistant" && row.content === full),
    "history still has full reply text after voice-only delivery",
  );
  assert(
    !recent.some((row) => /Heard:/i.test(row.content)),
    "no Heard: transcript message in history",
  );
  assert(captions[0]?.startsWith("You said:"), "voice caption has You said:");

  const cardText = "Draft waiting for approval\n\nTo: x@y.com";
  saveMessage("assistant", cardText);
  await deliverVoiceTurn({
    api: fakeApi,
    chatId: 1,
    replyText: cardText,
    transcript: "draft it",
    inboundWasVoice: true,
    forwarded: false,
    sendText: async () => undefined,
  });
  assert(
    getRecentMessages(10).some(
      (row) => row.role === "assistant" && row.content === cardText,
    ),
    "history stores card reply text too",
  );

  resetVoiceReplyTestHooks();
  setVoiceRepliesEnabled(false);
  console.log("history stores reply text: ok");
}

{
  const botSrc = readFileSync(new URL("../src/bot.ts", import.meta.url), "utf8");
  assert(!/Heard: \$\{transcript\}/.test(botSrc), "Heard: transcript message removed");
  assert(/deliverVoiceTurn\(/.test(botSrc), "bot uses deliverVoiceTurn");
  assert(
    /voiceReply:\s*options\.voiceReply === true && !forwarded/.test(botSrc),
    "voice only for non-forwarded voice turns",
  );
  assert(
    /handleUserText\(ctx, ctx\.from\.id, transcript, \{ voiceReply: true \}\)/.test(
      botSrc,
    ),
    "voice path passes voiceReply: true",
  );
  assert(
    /handleForwardedContent\(ctx, transcript\)/.test(botSrc),
    "forwarded voice uses handleForwardedContent",
  );
  console.log("bot wiring: ok");
}

{
  setVoiceRepliesEnabled(true);
  setVoiceReplyTestHooks({
    fetch: async () =>
      new Response(
        JSON.stringify({ audios: [Buffer.from("x").toString("base64")] }),
        { status: 200 },
      ),
    sendVoice: async () => undefined,
  });
  const before = Date.now();
  await deliverVoiceTurn({
    api: fakeApi,
    chatId: 1,
    replyText: "Usage check.",
    transcript: "hi",
    inboundWasVoice: true,
    forwarded: false,
    sendText: async () => undefined,
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

assert(voiceRepliesEnabled() === false || true, "toggle helper reachable");
{
  // The voices: English is Ashwin, energetic; Hindi and Malayalam unchanged.
  const bodies: Array<Record<string, unknown>> = [];
  setVoiceReplyTestHooks({
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ audios: [Buffer.from("x").toString("base64")] }), { status: 200 });
    },
  });
  for (const lang of ["en", "hi", "ml"] as const) {
    await synthesizeSpeech("hello", lang);
  }
  const voice = (index: number) => `${bodies[index]!.model} ${bodies[index]!.speaker} ${bodies[index]!.language_code} ${bodies[index]!.pace}`;
  assert(voice(0) === "bulbul:v4-flash ashwin_en_sports_energetic en-IN 1", `English voice, got ${voice(0)}`);
  assert(voice(1) === "bulbul:v4-flash shubh_hi_customer hi-IN 1", `Hindi voice, got ${voice(1)}`);
  assert(voice(2) === "bulbul:v3 shubh ml-IN 1", `Malayalam voice, got ${voice(2)}`);
  console.log("voices: ok");
}

console.log("test-voice-reply: all passed");
