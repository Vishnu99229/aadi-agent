import { config, type LlmProvider } from "./config.js";
import { getSetting, setSetting } from "./db.js";

const SETTING_KEY = "llm_backend";

export type ChatBackend = LlmProvider;

export function isChatBackend(value: string): value is ChatBackend {
  return value === "claude" || value === "cloud-gemma";
}

export function getChatBackend(): ChatBackend {
  const stored = getSetting(SETTING_KEY);
  if (stored && isChatBackend(stored)) {
    return stored;
  }
  return config.llmProvider;
}

export function setChatBackend(backend: ChatBackend): void {
  setSetting(SETTING_KEY, backend);
}

export function chatBackendLabel(backend: ChatBackend): string {
  return backend === "claude" ? "Claude" : "cloud Gemma";
}
