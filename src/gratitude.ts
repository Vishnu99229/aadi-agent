export const SIMPLE_GRATITUDE =
  /^(thanks|thank you|good work|great job|appreciate it|thx|nice work)([.,!]|\s+aadi)*$/i;

export function isSimpleGratitude(text: string): boolean {
  return SIMPLE_GRATITUDE.test(text.trim());
}

/** Heart reaction only — no chat reply. Returns true when the text was handled. */
export async function reactToSimpleGratitude(
  text: string,
  ctx: { react: (emoji: string) => Promise<unknown> },
): Promise<boolean> {
  if (!isSimpleGratitude(text)) {
    return false;
  }
  await ctx.react("❤️");
  return true;
}
