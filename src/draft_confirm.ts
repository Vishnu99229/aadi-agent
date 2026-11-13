/**
 * The approval card already shows the draft. The chat reply should not paste
 * that body again. One successful draft tool this turn is one draft.
 */

const DRAFT_TOOLS = new Set(["draft_new_email", "draft_reply", "draft_mom"]);

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
  const kept = reply.slice(0, at).replace(/\s+$/g, "").trim();
  const note = "The full draft is on the card, waiting for your Send tap. Nothing was sent.";
  if (!kept) {
    return note;
  }
  if (/send tap|nothing was sent/i.test(kept)) {
    return kept;
  }
  return `${kept}\n\n${note}`;
}

export function draftBodyFromCall(name: string, input: unknown, success: boolean): string | undefined {
  if (!success || !DRAFT_TOOLS.has(name)) {
    return undefined;
  }
  const body = (input as { body?: unknown } | null)?.body;
  return typeof body === "string" ? body : undefined;
}
