import type { Api } from "grammy";
import { config } from "./config.js";
import { getRecentMessages, saveMessage } from "./db.js";

export function shouldStoreOutbound(
  previousAssistant: string | undefined,
  text: string,
): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  return previousAssistant !== trimmed;
}

export function storeOutboundText(text: string): void {
  const recent = getRecentMessages(1);
  const previous =
    recent.at(-1)?.role === "assistant" ? recent.at(-1)!.content : undefined;
  if (!shouldStoreOutbound(previous, text)) {
    return;
  }
  saveMessage("assistant", text.trim());
}

function ownerChat(chatId: number | string): boolean {
  return String(chatId) === String(config.ownerTelegramId);
}

export function installOutboundHistory(api: Api): void {
  const sendMessage = api.sendMessage.bind(api);
  api.sendMessage = (async (...args: Parameters<Api["sendMessage"]>) => {
    const result = await sendMessage(...args);
    const text = args[1];
    if (ownerChat(args[0]) && typeof text === "string") {
      storeOutboundText(text);
    }
    return result;
  }) as Api["sendMessage"];

  const sendDocument = api.sendDocument.bind(api);
  api.sendDocument = (async (...args: Parameters<Api["sendDocument"]>) => {
    const result = await sendDocument(...args);
    const extra = args[2] as { caption?: string } | undefined;
    if (ownerChat(args[0]) && extra?.caption) {
      storeOutboundText(extra.caption);
    }
    return result;
  }) as Api["sendDocument"];
}
