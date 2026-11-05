/**
 * Spoken replies for non-forwarded owner voice notes.
 * Plain short answers: voice only (transcript as caption).
 * Cards / links / long replies: text first, then a short voice pointer.
 * TTS failure never leaves silence — text is sent instead.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InputFile, type Api } from "grammy";
import { config } from "./config.js";
import { getSetting, setSetting } from "./db.js";
import { assertTestSeam } from "./test_seam.js";
import { logLlmUsage } from "./usage.js";

export const VOICE_REPLIES_SETTING = "voice_replies";
export const VOICE_SPEAK_CHAR_CAP = 500;
/** Telegram Bot API caption limit for sendVoice / sendPhoto / etc. */
export const TELEGRAM_CAPTION_LIMIT = 1024;
export const VOICE_DETAILS_ABOVE =
  "I've put the details in the message above.";

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
    speaker: "shubh_en_narration_gentle",
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

export type VoiceDeliveryMode = "voice_only" | "text_and_voice" | "text_only";

export interface VoiceDeliveryPlan {
  mode: VoiceDeliveryMode;
  /** Text to synthesize, if any. */
  spoken: string;
  /** sendVoice caption (You said: …), if any. */
  caption: string;
}

type TtsFetch = typeof fetch;
type SendVoiceFn = (
  api: Api,
  chatId: number,
  audioPath: string,
  caption?: string,
) => Promise<void>;

let ttsFetch: TtsFetch = fetch;
let sendVoiceFn: SendVoiceFn = async (api, chatId, audioPath, caption) => {
  await api.sendVoice(
    chatId,
    new InputFile(audioPath),
    caption ? { caption } : {},
  );
};

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
  sendVoiceFn = async (api, chatId, audioPath, caption) => {
    await api.sendVoice(
      chatId,
      new InputFile(audioPath),
      caption ? { caption } : {},
    );
  };
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

export function looksLikePendingActionCard(text: string): boolean {
  const trimmed = text.trim();
  return (
    /^Draft waiting for approval\b/im.test(trimmed) ||
    /^Event waiting for approval\b/im.test(trimmed)
  );
}

export function replyHasLinks(text: string): boolean {
  return (
    /https?:\/\/\S+/i.test(text) ||
    /\bwww\.\S+/i.test(text) ||
    /\[[^\]]+\]\(https?:\/\/[^)]+\)/i.test(text)
  );
}

/** True when the Telegram text channel is required (card / draft / buttons / links / long). */
export function replyNeedsTextChannel(replyText: string): boolean {
  if (looksLikePendingActionCard(replyText)) {
    return true;
  }
  if (replyHasLinks(replyText)) {
    return true;
  }
  if (
    /\b(tap|taps|button|buttons|inline)\b/i.test(replyText) ||
    /\b(send|edit|discard)\b.*\b(send|edit|discard)\b/i.test(replyText) ||
    /\bapproval\b/i.test(replyText)
  ) {
    return true;
  }
  if (
    /\bdraft\b/i.test(replyText) &&
    /\b(send|edit|waiting|approval|gmail|discard)\b/i.test(replyText)
  ) {
    return true;
  }
  const stripped = stripForSpeech(replyText);
  return stripped.length > VOICE_SPEAK_CHAR_CAP;
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

/** Caption on the voice bubble: "You said: …" truncated to Telegram's limit. */
export function voiceReplyCaption(transcript: string): string {
  const prefix = "You said: ";
  const body = transcript.replace(/\s+/g, " ").trim();
  const budget = TELEGRAM_CAPTION_LIMIT - prefix.length;
  if (budget <= 0) {
    return prefix.slice(0, TELEGRAM_CAPTION_LIMIT);
  }
  if (body.length <= budget) {
    return `${prefix}${body}`;
  }
  if (budget <= 1) {
    return `${prefix}${body.slice(0, budget)}`;
  }
  return `${prefix}${body.slice(0, budget - 1)}…`;
}

/**
 * Decide how to deliver a reply for a voice-in turn.
 * History storage is the caller's job (runAgent) — this only plans Telegram I/O.
 */
export function planVoiceDelivery(input: {
  replyText: string;
  transcript: string;
  inboundWasVoice: boolean;
  forwarded: boolean;
}): VoiceDeliveryPlan {
  const empty: VoiceDeliveryPlan = { mode: "text_only", spoken: "", caption: "" };
  if (!input.inboundWasVoice || input.forwarded || !voiceRepliesEnabled()) {
    return empty;
  }
  const caption = voiceReplyCaption(input.transcript);
  if (replyNeedsTextChannel(input.replyText)) {
    return {
      mode: "text_and_voice",
      spoken: VOICE_DETAILS_ABOVE,
      caption,
    };
  }
  const spoken = stripForSpeech(input.replyText);
  if (!spoken) {
    return empty;
  }
  return { mode: "voice_only", spoken, caption };
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

/** Synthesize + sendVoice. Does not send text. */
export async function sendSpokenReply(input: {
  api: Api;
  chatId: number;
  spoken: string;
  caption: string;
  sourceText: string;
}): Promise<"sent" | "failed" | "skipped"> {
  if (!input.spoken.trim()) {
    return "skipped";
  }
  if (ttsFetch === fetch && !config.sarvamApiKey) {
    console.error("Voice reply skipped: Sarvam TTS status=no_key");
    return "failed";
  }
  const lang = detectVoiceLanguage(input.sourceText);
  const tempDirectory = await mkdtemp(join(tmpdir(), "aadi-tts-"));
  const audioPath = join(tempDirectory, "reply.mp3");
  try {
    const { audio, model } = await synthesizeSpeech(input.spoken, lang);
    await writeFile(audioPath, audio);
    await sendVoiceFn(
      input.api,
      input.chatId,
      audioPath,
      input.caption || undefined,
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
    return "sent";
  } catch (error) {
    const status =
      error instanceof Error
        ? error.message.replace(/\s+/g, " ").slice(0, 120)
        : "UnknownError";
    console.error(`Voice reply failed: provider=sarvam status=${status}`);
    return "failed";
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/**
 * Deliver a voice-in turn to Telegram. Caller has already persisted the
 * full reply in messages/history. Returns what was sent on the wire.
 */
export async function deliverVoiceTurn(input: {
  api: Api;
  chatId: number;
  replyText: string;
  transcript: string;
  inboundWasVoice: boolean;
  forwarded: boolean;
  sendText: (text: string) => Promise<void>;
}): Promise<{
  mode: VoiceDeliveryMode;
  sentText: boolean;
  sentVoice: boolean;
}> {
  const plan = planVoiceDelivery({
    replyText: input.replyText,
    transcript: input.transcript,
    inboundWasVoice: input.inboundWasVoice,
    forwarded: input.forwarded,
  });

  if (plan.mode === "text_only") {
    await input.sendText(input.replyText);
    return { mode: "text_only", sentText: true, sentVoice: false };
  }

  if (plan.mode === "voice_only") {
    const voice = await sendSpokenReply({
      api: input.api,
      chatId: input.chatId,
      spoken: plan.spoken,
      caption: plan.caption,
      sourceText: input.transcript,
    });
    if (voice === "sent") {
      return { mode: "voice_only", sentText: false, sentVoice: true };
    }
    // Never silence: fall back to the full text reply.
    await input.sendText(input.replyText);
    return { mode: "voice_only", sentText: true, sentVoice: false };
  }

  // text_and_voice: text first (with any keyboard from the reply path), then short voice.
  await input.sendText(input.replyText);
  const voice = await sendSpokenReply({
    api: input.api,
    chatId: input.chatId,
    spoken: plan.spoken,
    caption: plan.caption,
    sourceText: input.transcript,
  });
  return {
    mode: "text_and_voice",
    sentText: true,
    sentVoice: voice === "sent",
  };
}
