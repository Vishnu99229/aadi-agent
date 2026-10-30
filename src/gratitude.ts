import { applyTelegramReaction } from "./telegram_react.js";

const MAX_GRATITUDE_CHARS = 80;
const GRATITUDE_PHRASE =
  /\b(thanks|thank you|thx|appreciate(?:\s+it)?|good work|great job|nice work|well done)\b/i;
const GRATITUDE_PHRASE_ALL =
  /\b(thanks|thank you|thx|appreciate(?:\s+it)?|good work|great job|nice work|well done)\b/gi;
const FILLER = /\b(aadi|a lot|so much|really|very much)\b/gi;
const REQUEST =
  /\b(check|send|draft|remind|calendar|email|meeting|schedule|delete|add|create|what|when|who|how|please|can you|could you|would you)\b/i;

export function isSimpleGratitude(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_GRATITUDE_CHARS) {
    return false;
  }
  if (trimmed.includes("?")) {
    return false;
  }
  if (REQUEST.test(trimmed)) {
    return false;
  }
  if (!GRATITUDE_PHRASE.test(trimmed)) {
    return false;
  }
  const stripped = trimmed
    .replace(GRATITUDE_PHRASE_ALL, " ")
    .replace(FILLER, " ")
    .replace(/[.,!'’]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length === 0;
}

/** Heart reaction only — no chat reply. Returns true when the text was handled. */
export async function reactToSimpleGratitude(
  text: string,
  ctx: { react: (emoji: string) => Promise<unknown> },
): Promise<boolean> {
  if (!isSimpleGratitude(text)) {
    return false;
  }
  console.log("gratitude intercept: matched");
  const applied = await applyTelegramReaction(ctx.react, "❤");
  if (!applied) {
    console.log("gratitude intercept: reaction did not apply");
  }
  return true;
}
