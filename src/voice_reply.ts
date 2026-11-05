/**
 * Optional spoken replies after a non-forwarded owner voice note.
 * Text reply is always sent first; TTS is best-effort and never blocks it.
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
export const VOICE_CARD_TRAILER =
  "Details and buttons are in the message above.";
export const VOICE_TRUNCATION_TRAILER = "the rest is in the text";

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

type TtsFetch = typeof fetch;
type SendVoiceFn = (
  api: Api,
  chatId: number,
  audioPath: string,
) => Promise<void>;

let ttsFetch: TtsFetch = fetch;
let sendVoiceFn: SendVoiceFn = async (api, chatId, audioPath) => {
  await api.sendVoice(chatId, new InputFile(audioPath));
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
  sendVoiceFn = async (api, chatId, audioPath) => {
    await api.sendVoice(chatId, new InputFile(audioPath));
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

function firstSentences(text: string, maxChars: number): string {
  const parts = text.match(/[^.!?।…]+[.!?।…]*/gu) ?? [text];
  let out = "";
  for (const part of parts) {
    const next = `${out}${part}`.trim();
    if (out && next.length > maxChars) {
      break;
    }
    out = next;
    if (out.length >= Math.min(maxChars, 80) && /[.!?।…]/.test(part)) {
      const sentenceCount = (out.match(/[.!?।…]/g) ?? []).length;
      if (sentenceCount >= 2 || out.length >= maxChars * 0.6) {
        break;
      }
    }
  }
  return out.trim() || text.slice(0, maxChars).trim();
}

/**
 * Build the spoken string: card summary, or stripped+capped reply.
 */
export function prepareSpokenText(replyText: string): string {
  const stripped = stripForSpeech(replyText);
  if (!stripped) {
    return "";
  }
  if (looksLikePendingActionCard(stripped)) {
    const firstLine =
      stripped
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0) ?? "Draft waiting for approval";
    return `${firstLine}. ${VOICE_CARD_TRAILER}`;
  }
  if (stripped.length <= VOICE_SPEAK_CHAR_CAP) {
    return stripped;
  }
  const head = firstSentences(stripped, VOICE_SPEAK_CHAR_CAP);
  const clipped =
    head.length > VOICE_SPEAK_CHAR_CAP
      ? head.slice(0, VOICE_SPEAK_CHAR_CAP).trim()
      : head;
  return `${clipped} ${VOICE_TRUNCATION_TRAILER}`.trim();
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

/**
 * After the text reply has already been sent: synthesize and sendVoice.
 * Failures log provider/status only and leave the text reply as-is.
 */
export async function maybeSendVoiceReply(input: {
  api: Api;
  chatId: number;
  replyText: string;
  /** Inbound transcript (or source text) for language detection. */
  sourceText: string;
  inboundWasVoice: boolean;
  forwarded: boolean;
}): Promise<"sent" | "skipped" | "failed"> {
  if (!input.inboundWasVoice || input.forwarded) {
    return "skipped";
  }
  if (!voiceRepliesEnabled()) {
    return "skipped";
  }
  // Only require a real key when calling the live Sarvam endpoint.
  if (ttsFetch === fetch && !config.sarvamApiKey) {
    console.error("Voice reply skipped: Sarvam TTS status=no_key");
    return "skipped";
  }
  const spoken = prepareSpokenText(input.replyText);
  if (!spoken) {
    return "skipped";
  }
  const lang = detectVoiceLanguage(input.sourceText);
  const tempDirectory = await mkdtemp(join(tmpdir(), "aadi-tts-"));
  const audioPath = join(tempDirectory, "reply.mp3");
  try {
    const { audio, model } = await synthesizeSpeech(spoken, lang);
    await writeFile(audioPath, audio);
    await sendVoiceFn(input.api, input.chatId, audioPath);
    logLlmUsage({
      task: "tts",
      model,
      inputTokens: spoken.length,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
    console.log(
      `Voice reply sent: lang=${lang} model=${model} chars=${spoken.length} bytes=${audio.length}`,
    );
    return "sent";
  } catch (error) {
    const status =
      error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 120) : "UnknownError";
    console.error(`Voice reply failed: provider=sarvam status=${status}`);
    return "failed";
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}
