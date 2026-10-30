import type { LlmTool } from "../llm.js";
import { applyTelegramReaction } from "../telegram_react.js";
import type { ToolTurn } from "./index.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "react_to_message",
  description:
    "Add an emoji reaction to Vishnu's current Telegram message. Use sparingly for emotional context, not on every turn. ❤️ when he thanks you, apologizes, or says something nice. 👍 when he confirms a task is done or says yes. 🤔 on a complex question (react first, then answer in text). 🔥 for good news or a win. 🙏 when he is grateful or the moment calls for it. Never react to your own messages. Never announce the reaction in chat.",
  inputSchema: {
    type: "object",
    properties: {
      emoji: {
        type: "string",
        description: "Emoji reaction, for example ❤️, 👍, 🤔, 🔥, or 🙏.",
      },
    },
    required: ["emoji"],
  },
};

export async function handler(input: unknown, turn: ToolTurn): Promise<string> {
  const values = (input ?? {}) as { emoji?: unknown };
  const raw = typeof values.emoji === "string" ? values.emoji : "";
  if (!raw.trim()) {
    return "Not reacted: I need an emoji.";
  }
  const ctx = turn.ctx;
  if (!ctx?.react) {
    return "Not reacted: no Telegram message to react to.";
  }
  const applied = await applyTelegramReaction(ctx.react, raw);
  if (!applied) {
    return "Not reacted: Telegram rejected the reaction.";
  }
  return `Reacted with ${applied}.`;
}
