/**
 * The approval card already shows the draft. The chat must not send a second
 * copy of it. One successful draft tool this turn is one draft.
 */

const DRAFT_TOOLS = new Set(["draft_new_email", "draft_reply", "draft_mom"]);

/** Non-empty marker. The chat sender drops it so the card is the only message. */
export const DRAFT_CARD_ONLY = "\u2063";

export function isDraftCardOnly(reply: string): boolean {
  return reply === DRAFT_CARD_ONLY;
}

/**
 * Structural, not a reading of the words: when the reply repeats the body this
 * turn's one draft tool was given, everything from that body on is dropped (the
 * card shows it), and an empty remainder means the card is the only message.
 */
export function shortenDraftReply(reply: string, bodies: readonly string[]): string {
  const unique = [...new Set(bodies.map((body) => body.trim()).filter((body) => body.length >= 40))];
  if (unique.length !== 1) {
    return reply;
  }
  const body = unique[0]!;
  const needle = body.slice(0, Math.min(80, body.length));
  if (!reply.includes(needle)) {
    return reply;
  }
  const at = reply.indexOf(needle);
  const kept = reply.slice(0, at).trim();
  return kept ? kept : DRAFT_CARD_ONLY;
}

export function draftBodyFromCall(name: string, input: unknown, success: boolean): string | undefined {
  if (!success || !DRAFT_TOOLS.has(name)) {
    return undefined;
  }
  const body = (input as { body?: unknown } | null)?.body;
  return typeof body === "string" ? body : undefined;
}
