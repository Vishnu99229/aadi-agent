/**
 * Spoken replies for non-forwarded owner voice notes.
 * Every answer is one voice note, captioned with Aadi's own words. Buttons from
 * cards made during the turn ride on it (voice_cards.ts).
 * Text goes only when he asks for it in writing, or when the voice fails.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InputFile, type Api, type InlineKeyboard } from "grammy";
import { config } from "./config.js";
import { getSetting, setSetting } from "./db.js";
import { assertTestSeam } from "./test_seam.js";
import { logLlmUsage } from "./usage.js";
import type { VoiceCard } from "./voice_cards.js";

export const VOICE_REPLIES_SETTING = "voice_replies";
/** Telegram Bot API caption limit for sendVoice / sendPhoto / etc. */
export const TELEGRAM_CAPTION_LIMIT = 1024;
/** Spoken answers are cut at a sentence here, well inside Sarvam's 2,500. */
export const SPEECH_CHAR_CAP = 1800;
export const WRITING_OFFER = "Want me to send that in writing?";

const SARVAM_TTS_URL = "https://api.sarvam.ai/text-to-speech";
const TTS_PACE = 1.0;

export type VoiceReplyLang = "en" | "hi" | "ml";

export interface VoicePersona {
  model: string;
  speaker: string;
  language_code: string;
  pace: number;
}

/** Named constants — Stage A confirmed. */
export const VOICE_PERSONAS: Record<VoiceReplyLang, VoicePersona> = {
  en: {
    model: "bulbul:v4-flash",
    speaker: "ashwin_en_sports_energetic",
    language_code: "en-IN",
    pace: TTS_PACE,
  },
  hi: {
    model: "bulbul:v4-flash",
    speaker: "shubh_hi_customer",
    language_code: "hi-IN",
    pace: TTS_PACE,
  },
  ml: {
    model: "bulbul:v3",
    speaker: "shubh",
    language_code: "ml-IN",
    pace: TTS_PACE,
  },
};

type TtsFetch = typeof fetch;
type SendVoiceFn = (
  api: Api,
  chatId: number,
  audioPath: string,
  caption?: string,
  keyboard?: InlineKeyboard,
) => Promise<number | undefined>;

const realSendVoice: SendVoiceFn = async (api, chatId, audioPath, caption, keyboard) => {
  const message = await api.sendVoice(chatId, new InputFile(audioPath), {
    ...(caption ? { caption } : {}),
    ...(keyboard ? { reply_markup: keyboard } : {}),
  });
  return message.message_id;
};

let ttsFetch: TtsFetch = fetch;
let sendVoiceFn: SendVoiceFn = realSendVoice;

export function setVoiceReplyTestHooks(hooks: {
  fetch?: TtsFetch;
  sendVoice?: SendVoiceFn;
}): void {
  assertTestSeam("setVoiceReplyTestHooks");
  if (hooks.fetch) {
    ttsFetch = hooks.fetch;
  }
  if (hooks.sendVoice) {
    sendVoiceFn = hooks.sendVoice;
  }
}

export function resetVoiceReplyTestHooks(): void {
  assertTestSeam("resetVoiceReplyTestHooks");
  ttsFetch = fetch;
  sendVoiceFn = realSendVoice;
}

export function voiceRepliesEnvEnabled(): boolean {
  return config.voiceRepliesEnabled;
}

/** Setting overrides env when set to on/off; otherwise env default. */
export function voiceRepliesEnabled(): boolean {
  const setting = getSetting(VOICE_REPLIES_SETTING);
  if (setting === "on") {
    return true;
  }
  if (setting === "off") {
    return false;
  }
  return voiceRepliesEnvEnabled();
}

export function setVoiceRepliesEnabled(on: boolean): void {
  setSetting(VOICE_REPLIES_SETTING, on ? "on" : "off");
}

/** Language of the inbound transcript (Malayalam / Hindi scripts; else English). */
export function detectVoiceLanguage(text: string): VoiceReplyLang {
  if (/[\u0D00-\u0D7F]/.test(text)) {
    return "ml";
  }
  if (/[\u0900-\u097F]/.test(text)) {
    return "hi";
  }
  return "en";
}

/** Strip markdown, links, and bare URLs before TTS. */
export function stripForSpeech(text: string): string {
  let out = text.replace(/\r\n/g, "\n");
  out = out.replace(/```[\s\S]*?```/g, " ");
  out = out.replace(/`([^`]+)`/g, "$1");
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/gi, "$1");
  out = out.replace(/https?:\/\/\S+/gi, " ");
  out = out.replace(/www\.\S+/gi, " ");
  out = out.replace(/^#{1,6}\s+/gm, "");
  out = out.replace(/(\*\*|__)(.*?)\1/g, "$2");
  out = out.replace(/(\*|_)(.*?)\1/g, "$2");
  out = out.replace(/~~(.*?)~~/g, "$1");
  out = out.replace(/[ \t]+\n/g, "\n");
  out = out.replace(/\n{3,}/g, "\n\n");
  out = out.replace(/[ \t]{2,}/g, " ");
  return out.trim();
}

/** What Aadi says aloud: no markdown, links or list markers, and cut at a sentence
 *  with an offer of the written version when it runs long. */
export function speechText(reply: string): string {
  const out = stripForSpeech(reply)
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, "")
    .trim();
  if (out.length <= SPEECH_CHAR_CAP) {
    return out;
  }
  const cut = out.slice(0, SPEECH_CHAR_CAP);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  const kept = end > SPEECH_CHAR_CAP / 2 ? cut.slice(0, end + 1) : cut;
  return `${kept.trim()} ${WRITING_OFFER}`;
}

/** Aadi's words, then the short text any buttons need. The buttons' text always
 *  fits; Aadi's words are cut if they must be. */
export function voiceCaption(spoken: string, cardCaptions: readonly string[]): string {
  const cards = cardCaptions.filter((item) => item.trim()).join("\n\n");
  if (!cards) {
    return spoken.length <= TELEGRAM_CAPTION_LIMIT
      ? spoken
      : `${spoken.slice(0, TELEGRAM_CAPTION_LIMIT - 1)}…`;
  }
  const room = TELEGRAM_CAPTION_LIMIT - cards.length - 2;
  if (room < 2) {
    return cards.slice(0, TELEGRAM_CAPTION_LIMIT);
  }
  const said = spoken.length <= room ? spoken : `${spoken.slice(0, room - 1)}…`;
  return `${said}\n\n${cards}`;
}

const WRITING_REQUEST =
  /\b(?:note (?:it|that|this|them) down|write (?:it|that|this|them) down|(?:send|give|put) (?:it|that|this|them|me)?\s*(?:in|as)\s*(?:a\s*)?(?:text|writing|message)|in writing|text (?:it to )?me|(?:give|send) me the list)\b/i;
const YES =
  /^(?:yes|yeah|yep|yup|sure|ok(?:ay)?|please|go ahead|do it|please do|send it|haan|ha|ji|ho|seri|athe)\b[\s\S]{0,30}$/i;

/** He asked for the answer written down, or said yes to Aadi's offer to send it. */
export function wantsItInWriting(transcript: string, lastAssistantReply: string): boolean {
  if (WRITING_REQUEST.test(transcript)) {
    return true;
  }
  return YES.test(transcript.trim()) && lastAssistantReply.trim().endsWith(WRITING_OFFER);
}

interface SarvamTtsResponse {
  audios?: unknown;
  request_id?: unknown;
}

export async function synthesizeSpeech(
  text: string,
  lang: VoiceReplyLang,
): Promise<{ audio: Buffer; model: string }> {
  const persona = VOICE_PERSONAS[lang];
  const response = await ttsFetch(SARVAM_TTS_URL, {
    method: "POST",
    headers: {
      "api-subscription-key": config.sarvamApiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      model: persona.model,
      speaker: persona.speaker,
      language_code: persona.language_code,
      pace: persona.pace,
      speech_sample_rate: 24000,
      output_audio_codec: "mp3",
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`Sarvam TTS HTTP ${response.status}`);
  }
  const json = (await response.json()) as SarvamTtsResponse;
  const parts = Array.isArray(json.audios)
    ? json.audios.filter((part): part is string => typeof part === "string")
    : [];
  if (parts.length === 0) {
    throw new Error(`Sarvam TTS empty audios status=${response.status}`);
  }
  return {
    audio: Buffer.from(parts.join(""), "base64"),
    model: persona.model,
  };
}

/** Synthesize and send the voice note. Its message id, or undefined if it didn't go. */
export async function sendSpokenReply(input: {
  api: Api;
  chatId: number;
  spoken: string;
  caption: string;
  keyboard?: InlineKeyboard;
  sourceText: string;
}): Promise<number | undefined> {
  if (!input.spoken.trim()) {
    return undefined;
  }
  if (ttsFetch === fetch && !config.sarvamApiKey) {
    console.error("Voice reply skipped: Sarvam TTS status=no_key");
    return undefined;
  }
  const lang = detectVoiceLanguage(input.sourceText);
  const tempDirectory = await mkdtemp(join(tmpdir(), "aadi-tts-"));
  const audioPath = join(tempDirectory, "reply.mp3");
  try {
    const { audio, model } = await synthesizeSpeech(input.spoken, lang);
    await writeFile(audioPath, audio);
    const messageId = await sendVoiceFn(
      input.api,
      input.chatId,
      audioPath,
      input.caption || undefined,
      input.keyboard,
    );
    logLlmUsage({
      task: "tts",
      model,
      inputTokens: input.spoken.length,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
    console.log(
      `Voice reply sent: lang=${lang} model=${model} chars=${input.spoken.length} bytes=${audio.length}`,
    );
    return messageId ?? 0;
  } catch (error) {
    const status =
      error instanceof Error
        ? error.message.replace(/\s+/g, " ").slice(0, 120)
        : "UnknownError";
    console.error(`Voice reply failed: provider=sarvam status=${status}`);
    return undefined;
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/**
 * A spoken turn's answer: one voice note, captioned with Aadi's words, carrying the
 * first card's buttons and the short text they need. Any other button cards follow
 * as messages of their own. If the voice can't be made, the text and the cards go
 * as text, so he's never left with nothing. History is the caller's job.
 */
export async function deliverVoiceTurn(input: {
  api: Api;
  chatId: number;
  replyText: string;
  sourceText: string;
  cards?: VoiceCard[];
  sendText: (text: string) => Promise<void>;
  postCard: (card: VoiceCard) => Promise<void>;
}): Promise<{ sentVoice: boolean; sentText: boolean }> {
  const cards = input.cards ?? [];
  const withButtons = cards.filter((card) => card.keyboard);
  const onVoice = [...cards.filter((card) => !card.keyboard), ...withButtons.slice(0, 1)];
  const spoken = speechText(input.replyText);
  const messageId = spoken
    ? await sendSpokenReply({
        api: input.api,
        chatId: input.chatId,
        spoken,
        caption: voiceCaption(spoken, onVoice.map((card) => card.caption)),
        keyboard: withButtons[0]?.keyboard,
        sourceText: input.sourceText,
      })
    : undefined;
  if (messageId !== undefined) {
    for (const card of onVoice) {
      card.posted = true;
      card.onPosted?.(messageId);
    }
    for (const card of withButtons.slice(1)) {
      await input.postCard(card);
    }
    return { sentVoice: true, sentText: false };
  }
  // Never silence: the full text, then every card as it would have been.
  await input.sendText(input.replyText);
  for (const card of cards) {
    await input.postCard(card);
  }
  return { sentVoice: false, sentText: true };
}
