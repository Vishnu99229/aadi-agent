const FALLBACK_EMOJI = "👍";

/** Telegram Bot API ReactionTypeEmoji list. Variation selectors are not allowed. */
const ALLOWED_REACTIONS = new Set([
  "👍",
  "👎",
  "❤",
  "🔥",
  "🥰",
  "👏",
  "😁",
  "🤔",
  "🤯",
  "😱",
  "🤬",
  "😢",
  "🎉",
  "🤩",
  "🤮",
  "💩",
  "🙏",
  "👌",
  "🕊",
  "🤡",
  "🥱",
  "🥴",
  "😍",
  "🐳",
  "❤‍🔥",
  "🌚",
  "🌭",
  "💯",
  "🤣",
  "⚡",
  "🍌",
  "🏆",
  "💔",
  "🤨",
  "😐",
  "🍓",
  "🍾",
  "💋",
  "🖕",
  "😈",
  "😴",
  "😭",
  "🤓",
  "👻",
  "👨‍💻",
  "👀",
  "🎃",
  "🙈",
  "😇",
  "😨",
  "🤝",
  "✍",
  "🤗",
  "🫡",
  "🎅",
  "🎄",
  "☃",
  "💅",
  "🤪",
  "🗿",
  "🆒",
  "💘",
  "🙉",
  "🦄",
  "😘",
  "💊",
  "🙊",
  "😎",
  "👾",
  "🤷‍♂",
  "🤷",
  "🤷‍♀",
  "😡",
]);

export function normalizeReactionEmoji(emoji: string): string {
  const stripped = [...emoji.trim()]
    .filter((ch) => ch !== "\uFE0F")
    .join("");
  if (ALLOWED_REACTIONS.has(stripped)) {
    return stripped;
  }
  return FALLBACK_EMOJI;
}

function reactionErrorMeta(error: unknown): {
  error_code: string | number;
  description: string;
} {
  if (error && typeof error === "object") {
    const rec = error as { error_code?: unknown; description?: unknown };
    if (rec.error_code != null || typeof rec.description === "string") {
      return {
        error_code:
          typeof rec.error_code === "number" || typeof rec.error_code === "string"
            ? rec.error_code
            : "unknown",
        description:
          typeof rec.description === "string" ? rec.description : "unknown",
      };
    }
  }
  return {
    error_code: "unknown",
    description: error instanceof Error ? error.name : "unknown",
  };
}

export async function applyTelegramReaction(
  react: (emoji: string) => Promise<unknown>,
  emoji: string,
): Promise<string | undefined> {
  const primary = normalizeReactionEmoji(emoji);
  const attempts =
    primary === FALLBACK_EMOJI ? [FALLBACK_EMOJI] : [primary, FALLBACK_EMOJI];
  for (const attempt of attempts) {
    try {
      await react(attempt);
      console.log("telegram react: ok");
      return attempt;
    } catch (error) {
      const meta = reactionErrorMeta(error);
      console.log(
        `telegram react: failed error_code=${meta.error_code} description=${meta.description}`,
      );
    }
  }
  return undefined;
}
