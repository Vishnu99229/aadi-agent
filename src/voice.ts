import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "grammy";
import { config } from "./config.js";

const SARVAM_STT_URL = "https://api.sarvam.ai/speech-to-text";
const SARVAM_MODEL = "saaras:v4";
const MAX_VOICE_SECONDS = 30;
const MAX_TELEGRAM_FILE_BYTES = 20 * 1024 * 1024;

interface SarvamTranscription {
  transcript?: unknown;
}

function telegramFileUrl(filePath: string): string {
  const encodedPath = filePath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `https://api.telegram.org/file/bot${config.telegramBotToken}/${encodedPath}`;
}

async function downloadTelegramVoice(
  ctx: Context,
  destination: string,
): Promise<void> {
  const file = await ctx.getFile();
  if (!file.file_path) {
    throw new Error("Telegram did not provide a voice file path.");
  }

  const response = await fetch(telegramFileUrl(file.file_path), {
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`Telegram voice download failed with HTTP ${response.status}.`);
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_TELEGRAM_FILE_BYTES
  ) {
    throw new Error("Telegram voice file exceeds the 20 MB download limit.");
  }

  const audio = new Uint8Array(await response.arrayBuffer());
  if (audio.byteLength === 0) {
    throw new Error("Telegram returned an empty voice file.");
  }
  if (audio.byteLength > MAX_TELEGRAM_FILE_BYTES) {
    throw new Error("Telegram voice file exceeds the 20 MB download limit.");
  }
  await writeFile(destination, audio);
}

async function transcribeAudio(filePath: string): Promise<string> {
  const audio = await readFile(filePath);
  const form = new FormData();

  // Telegram voice notes are OGG/Opus, which Sarvam accepts directly. Saaras
  // v4 is the current recommended model. "unknown" enables language detection,
  // while codemix preserves mixed English/Indic speech in readable scripts.
  form.append(
    "file",
    new Blob([new Uint8Array(audio)], { type: "audio/ogg" }),
    "voice.ogg",
  );
  form.append("model", SARVAM_MODEL);
  form.append("mode", "codemix");
  form.append("language_code", "unknown");

  const response = await fetch(SARVAM_STT_URL, {
    method: "POST",
    headers: {
      "api-subscription-key": config.sarvamApiKey,
    },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`Sarvam transcription failed with HTTP ${response.status}.`);
  }

  const result = (await response.json()) as SarvamTranscription;
  if (typeof result.transcript !== "string" || !result.transcript.trim()) {
    throw new Error("Sarvam returned an empty transcript.");
  }
  return result.transcript.trim();
}

export async function transcribeTelegramVoice(ctx: Context): Promise<string> {
  const duration = ctx.message?.voice?.duration;
  if (typeof duration !== "number") {
    throw new Error("The Telegram update does not contain a voice note.");
  }
  if (duration > MAX_VOICE_SECONDS) {
    throw new Error("Voice notes must be 30 seconds or shorter.");
  }

  const tempDirectory = await mkdtemp(join(tmpdir(), "aadi-voice-"));
  const audioPath = join(tempDirectory, "voice.ogg");

  try {
    await downloadTelegramVoice(ctx, audioPath);
    return await transcribeAudio(audioPath);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}
