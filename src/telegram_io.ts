import { HttpError, type Api } from "grammy";

export const TELEGRAM_MESSAGE_LIMIT = 4000;

/** Telegram's limit counts UTF-16 code units, so emoji count double. Splits on
 *  a line break when one falls in the back half of the chunk, and never cuts a
 *  surrogate pair. */
export function splitForTelegram(
  text: string,
  limit = TELEGRAM_MESSAGE_LIMIT,
): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) {
      cut = limit;
    }
    const before = rest.charCodeAt(cut - 1);
    if (before >= 0xd800 && before <= 0xdbff) {
      cut -= 1;
    }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) {
    chunks.push(rest);
  }
  return chunks;
}

/** grammY network errors wrap a fetch error whose message is the request URL,
 *  and that URL contains the bot token. */
export function redactBotToken(text: string): string {
  return text.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>");
}

export function safeErrorText(error: unknown): string {
  const text =
    error instanceof Error
      ? (error.stack ?? `${error.name}: ${error.message}`)
      : String(error);
  return redactBotToken(text);
}

const RETRY_METHODS = new Set(["sendMessage", "editMessageText"]);
const RETRY_DELAYS_MS = [1_000, 3_000];

/** Retries plain-text sends and edits on network failures (HttpError), not on
 *  Telegram API rejections (GrammyError). A retry after a lost response can
 *  duplicate a message, which beats silently dropping a reply. */
export function installNetworkRetry(
  api: Api,
  delaysMs: readonly number[] = RETRY_DELAYS_MS,
): void {
  api.config.use(async (prev, method, payload, signal) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await prev(method, payload, signal);
      } catch (error) {
        const delay = delaysMs[attempt];
        if (
          !(error instanceof HttpError) ||
          !RETRY_METHODS.has(method) ||
          delay === undefined ||
          signal?.aborted
        ) {
          throw error;
        }
        console.warn(
          `Telegram ${method} network error; retry ${attempt + 1} in ${delay}ms.`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  });
}
