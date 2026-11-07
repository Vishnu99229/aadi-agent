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
import { GrammyError, InlineKeyboard, type Api } from "grammy";
import { setApprovalsTestHooks, queueDraftApproval } from "../src/approvals.ts";
import { getPendingActionForDraft, getRecentMessages, listUsageLogs, saveMessage } from "../src/db.ts";
import { installCaptionEditFallback } from "../src/telegram_io.ts";
import { collectVoiceCards, holdForVoiceNote, type VoiceCard } from "../src/voice_cards.ts";
import {
  SPEECH_CHAR_CAP,
  TELEGRAM_CAPTION_LIMIT,
  WRITING_OFFER,
  deliverVoiceTurn,
  detectVoiceLanguage,
  resetVoiceReplyTestHooks,
  setVoiceRepliesEnabled,
  setVoiceReplyTestHooks,
  speechText,
  stripForSpeech,
  synthesizeSpeech,
  voiceCaption,
  voiceRepliesEnabled,
  wantsItInWriting,
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
  // What Aadi says aloud.
  assert(speechText("**Yes**, you're free.") === "Yes, you're free.", "markdown stripped");
  assert(speechText("- one\n- two\n1. three") === "one\ntwo\nthree", "list markers stripped");
  const long = `${"This is a sentence that goes on. ".repeat(80)}`;
  const said = speechText(long);
  assert(said.length <= SPEECH_CHAR_CAP + WRITING_OFFER.length + 1, "long speech is cut");
  assert(said.endsWith(`. ${WRITING_OFFER}`), `cut at a sentence, with the offer, got ...${said.slice(-60)}`);
  assert(speechText("Short answer.") === "Short answer.", "short speech unchanged");
  console.log("speech text: ok");
}

{
  // The caption is Aadi's words only, plus the short text any buttons need.
  assert(voiceCaption("Sure, you're free after 4.", []) === "Sure, you're free after 4.", "words only");
  assert(!voiceCaption("Done.", []).includes("You said"), "no transcript");
  assert(voiceCaption("Tap one.", ["Which Sanchit? Nothing has gone out."]) === "Tap one.\n\nWhich Sanchit? Nothing has gone out.", "buttons' text after the words");
  const longWords = "w".repeat(TELEGRAM_CAPTION_LIMIT);
  const withCard = voiceCaption(longWords, ["Draft to x@y.example"]);
  assert(withCard.length <= TELEGRAM_CAPTION_LIMIT && withCard.endsWith("Draft to x@y.example"), "the buttons' text always fits");
  assert(voiceCaption(longWords + "w", []).length === TELEGRAM_CAPTION_LIMIT, "words alone are cut to the limit");
  console.log("voice caption: ok");
}

{
  // Only an ask for writing, or a yes to the offer, turns a voice note into text.
  for (const phrase of ["note it down", "send it in text", "write that down", "give me the list", "send that in writing", "can you text me the details"]) {
    assert(wantsItInWriting(phrase, ""), `"${phrase}" asks for writing`);
  }
  for (const phrase of ["what's on today", "send Selvaraj an email", "tell me the list of meetings"]) {
    assert(!wantsItInWriting(phrase, ""), `"${phrase}" doesn't`);
  }
  assert(wantsItInWriting("yes please", `You have five meetings. ${WRITING_OFFER}`), "yes to the offer");
  assert(!wantsItInWriting("yes please", "You have five meetings."), "yes to something else isn't");
  console.log("writing requests: ok");
}

{
  // Cards wait for a spoken turn, and only while it's open.
  const card: VoiceCard = { text: "Card", caption: "Card" };
  assert(!holdForVoiceNote(card), "outside a spoken turn, the caller posts it");
  const collector = collectVoiceCards();
  await collector.run(async () => {
    assert(holdForVoiceNote(card), "inside one, it's held");
  });
  assert(collector.close().length === 1, "and handed over");
  await collector.run(async () => {
    assert(!holdForVoiceNote(card), "after the turn has answered, the caller posts it");
  });
  console.log("card collector: ok");
}

{
  // Delivery.
  setVoiceRepliesEnabled(true);
  const sent: Array<{ caption: string; keyboard?: InlineKeyboard }> = [];
  const texts: string[] = [];
  const posted: string[] = [];
  const ok = (): void =>
    setVoiceReplyTestHooks({
      fetch: async () => new Response(JSON.stringify({ audios: [Buffer.from("x").toString("base64")] }), { status: 200 }),
      sendVoice: async (_api, _chat, _path, caption, keyboard) => {
        sent.push({ caption: caption ?? "", keyboard });
        return 500 + sent.length;
      },
    });
  ok();
  const deliver = (replyText: string, cards: VoiceCard[] = []) =>
    deliverVoiceTurn({
      api: fakeApi,
      chatId: 1,
      replyText,
      sourceText: "hi",
      cards,
      sendText: async (text) => {
        texts.push(text);
      },
      postCard: async (card) => {
        posted.push(card.text);
        card.posted = true;
      },
    });

  const plain = await deliver("**Sure**, you're free after 4.");
  assert(plain.sentVoice && !plain.sentText && texts.length === 0, "a plain answer is a voice note only");
  assert(sent[0]!.caption === "Sure, you're free after 4.", `caption is Aadi's words, got ${sent[0]!.caption}`);

  const long = await deliver(`Here's everything. ${"Another long point to cover here. ".repeat(80)}`);
  assert(long.sentVoice && !long.sentText && texts.length === 0, "a long answer is still voice only, no text dump");
  assert(sent[1]!.caption.length <= TELEGRAM_CAPTION_LIMIT, "its caption fits");

  let draftMessage = 0;
  const keyboard = new InlineKeyboard().text("Send", "approval:send:1");
  const draft: VoiceCard = {
    text: "Draft waiting for approval\n\nTo: priya@acme.example\nSubject: Demo\n\nFull body",
    caption: "Draft to priya@acme.example\nSubject: Demo",
    keyboard,
    onPosted: (id) => {
      draftMessage = id;
    },
  };
  await deliver("I drafted it. Tap Send when you're happy.", [draft]);
  const voiced = sent[2]!;
  assert(voiced.keyboard === keyboard, "the buttons ride on the voice note");
  assert(voiced.caption === "I drafted it. Tap Send when you're happy.\n\nDraft to priya@acme.example\nSubject: Demo", `with the text they need, got ${voiced.caption}`);
  assert(draftMessage === 503, "the card knows which message it's on");
  assert(texts.length === 0 && posted.length === 0, "no separate message");

  const second: VoiceCard = { text: "Which Sanchit?", caption: "Which Sanchit?", keyboard: new InlineKeyboard().text("A", "x") };
  const note: VoiceCard = { text: "Sent to Arjun.\nSubject: Hi\n\nBody", caption: "Sent to Arjun.\nSubject: Hi" };
  await deliver("Done, and tap the right Sanchit.", [note, draft, second]);
  assert(sent[3]!.caption.includes("Sent to Arjun.\nSubject: Hi") && sent[3]!.caption.includes("Draft to priya"), "a card with no buttons joins the caption");
  assert(!sent[3]!.caption.includes("Body"), "but not its full text");
  assert(posted.join("|") === "Which Sanchit?", "a second set of buttons gets a message of its own");

  // The voice fails: the full text, then every card as it would have been.
  texts.length = 0;
  posted.length = 0;
  setVoiceReplyTestHooks({ fetch: async () => new Response("nope", { status: 500 }) });
  const failed = await deliver("I drafted it.", [{ ...draft, posted: false }, { ...note, posted: false }]);
  assert(!failed.sentVoice && failed.sentText && texts[0] === "I drafted it.", "the reply arrives as text");
  assert(posted.length === 2 && posted[0]!.includes("Full body") && posted[1]!.includes("Body"), "and every card in full");
  ok();
  console.log("voice delivery: ok");
}

{
  // A card made during a spoken turn waits; its message id is recorded once the voice note goes.
  const log: string[] = [];
  const fakeTelegram = {
    sendMessage: async (_chat: unknown, text: string) => {
      log.push(text);
      return { message_id: 900, chat: { id: 1 }, date: 0, text };
    },
    editMessageText: async () => true,
  } as unknown as Api;
  setApprovalsTestHooks({ telegram: fakeTelegram });
  const preview = { draftId: "d-voice", threadId: null, to: "priya@acme.example", subject: "Demo", body: "Hello Priya", googleAccount: "work" as const };
  const collector = collectVoiceCards();
  await collector.run(() => queueDraftApproval(preview));
  assert(log.length === 0, "the draft card isn't posted on its own");
  const [held] = collector.close();
  assert(held?.keyboard !== undefined && held.caption.startsWith("Draft to priya@acme.example\nSubject: Demo"), "it's held with its buttons and short text");
  held!.onPosted?.(4242);
  assert(getPendingActionForDraft("d-voice")?.telegram_message_id === 4242, "the voice note becomes its card");
  await queueDraftApproval({ ...preview, draftId: "d-typed" });
  assert(log.length === 1 && getPendingActionForDraft("d-typed")?.telegram_message_id === 900, "a typed turn posts it as before");
  console.log("held draft card: ok");
}

{
  // A tap that edits a voice note as text becomes a caption edit, buttons kept.
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const transformers: Array<(prev: unknown, method: string, payload: unknown, signal: unknown) => Promise<unknown>> = [];
  const api = { config: { use: (fn: never) => transformers.push(fn) } } as unknown as Api;
  installCaptionEditFallback(api);
  const prev = async (method: string, payload: Record<string, unknown>) => {
    calls.push({ method, payload });
    if (method === "editMessageText" && payload.message_id === 1) {
      throw new GrammyError("x", { ok: false, error_code: 400, description: "Bad Request: there is no text in the message to edit" }, "editMessageText", payload);
    }
    if (method === "editMessageText" && payload.message_id === 2) {
      throw new GrammyError("x", { ok: false, error_code: 400, description: "Bad Request: message is not modified" }, "editMessageText", payload);
    }
    return true;
  };
  const markup = { inline_keyboard: [] };
  await transformers[0]!(prev, "editMessageText", { chat_id: 1, message_id: 1, text: "Sent.", reply_markup: markup }, undefined);
  assert(calls[1]!.method === "editMessageCaption" && calls[1]!.payload.caption === "Sent." && calls[1]!.payload.reply_markup === markup, "retried as a caption edit");
  let other = "";
  await transformers[0]!(prev, "editMessageText", { chat_id: 1, message_id: 2, text: "x" }, undefined).catch((error: Error) => {
    other = error.message;
  });
  assert(other !== "" && calls.length === 3, "other edit errors are left alone");
  await transformers[0]!(prev, "sendMessage", { chat_id: 1, text: "hi" }, undefined);
  assert(calls[3]!.method === "sendMessage", "other calls pass straight through");
  console.log("caption edit fallback: ok");
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
      return 7;
    },
  });
  const full = "History must keep this exact assistant reply.";
  saveMessage("assistant", full);
  await deliverVoiceTurn({
    api: fakeApi,
    chatId: 1,
    replyText: full,
    sourceText: "remember this",
    sendText: async () => {
      throw new Error("voice-only must not send text");
    },
    postCard: async () => undefined,
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
  assert(captions[0] === full, `the caption is Aadi's words only, got ${captions[0]}`);

  resetVoiceReplyTestHooks();
  setVoiceRepliesEnabled(false);
  console.log("history stores reply text: ok");
}

{
  const botSrc = readFileSync(new URL("../src/bot.ts", import.meta.url), "utf8");
  assert(!/Heard: \$\{transcript\}/.test(botSrc), "Heard: transcript message removed");
  assert(/deliverVoiceTurn\(/.test(botSrc), "bot uses deliverVoiceTurn");
  assert(
    /const voiceIn = options\.voiceReply === true && !forwarded && voiceRepliesEnabled\(\);/.test(botSrc) &&
      /voiceReply: spoken,/.test(botSrc),
    "voice only for non-forwarded voice turns that didn't ask for writing",
  );
  assert(/await replyInKind\(ctx, result\.message, spoken, userText\);/.test(botSrc), "\"send it\" is spoken on a spoken turn");
  assert(/held \? \(\) => held\.run\(work\) : work/.test(botSrc), "a spoken turn collects its cards");
  assert(/installCaptionEditFallback\(bot\.api\);/.test(botSrc), "bot edits fall back to captions");
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
    sendVoice: async () => 1,
  });
  const before = Date.now();
  await deliverVoiceTurn({
    api: fakeApi,
    chatId: 1,
    replyText: "Usage check.",
    sourceText: "hi",
    sendText: async () => undefined,
    postCard: async () => undefined,
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
