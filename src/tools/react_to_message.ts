import type { LlmTool } from "../llm.js";
import type { ToolTurn } from "./index.js";

const FALLBACK_EMOJI = "👍";

/** Telegram's reaction list uses ❤ without a variation selector. */
function normalizeEmoji(emoji: string): string {
  const trimmed = emoji.trim();
  if (trimmed === "❤️" || trimmed === "❤︎") {
    return "❤";
  }
  return trimmed;
}

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
  const emoji = normalizeEmoji(raw);
  if (!emoji) {
    return "Not reacted: I need an emoji.";
  }
  const ctx = turn.ctx;
  if (!ctx?.react) {
    return "Not reacted: no Telegram message to react to.";
  }

  try {
    await ctx.react(emoji);
    console.log("react_to_message: applied");
    return `Reacted with ${emoji}.`;
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.log(`react_to_message: rejected (${errorType})`);
    if (emoji === FALLBACK_EMOJI) {
      return "Not reacted: Telegram rejected the reaction.";
    }
    try {
      await ctx.react(FALLBACK_EMOJI);
      console.log("react_to_message: fallback applied");
      return `Reacted with ${FALLBACK_EMOJI}.`;
    } catch (fallbackError) {
      const fallbackType =
        fallbackError instanceof Error ? fallbackError.name : "UnknownError";
      console.log(`react_to_message: fallback rejected (${fallbackType})`);
      return "Not reacted: Telegram rejected the reaction.";
    }
  }
}
