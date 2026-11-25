/**
 * The one decision for every email Aadi sends on Vishnu's word (not sequence
 * follow-ups or meeting auto-booking, which keep their own gates). Code decides,
 * from facts code gathered: anything uncertain is a card, never a send.
 */

const DECIDED = Symbol("send-decision");

/** Only decideSendAction makes one of these, and every Gmail send checks it. */
export interface SendDecision {
  readonly action: "send";
  readonly recipients: readonly string[];
  readonly [DECIDED]: true;
}

export type SendVerdict =
  | SendDecision
  /** Show him the card; nothing goes out until his tap. */
  | { action: "card"; newAddresses: string[]; notOwnTurn: boolean }
  /** He asked for a draft: never a send. */
  | { action: "draft" };

export interface SendFacts {
  /** What his own words ask for, by today's rules: "draft" never sends. */
  intent: "send" | "draft";
  /** Straight from his own chat turn (dispatch sets it from the turn context). */
  ownTurn: boolean;
  /** Every To and Cc address that would receive it. */
  recipients: readonly string[];
  /** He has sent to these before (Gmail Sent, either account). Checked by code. */
  known: ReadonlySet<string>;
  /** Confirmed by him: shown on the card he tapped Send on (or on this draft's card
   *  before his "send it"), an address button he tapped, or a schedule he confirmed. */
  confirmed?: ReadonlySet<string>;
}

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

export class SendNotDecidedError extends Error {
  constructor(readonly reason: string) {
    super(`send not decided: ${reason}`);
    this.name = "SendNotDecidedError";
  }
}

export function decideSendAction(facts: SendFacts): SendVerdict {
  if (facts.intent === "draft") {
    return { action: "draft" };
  }
  const recipients = [...new Set(facts.recipients.map(normalize).filter(Boolean))];
  if (recipients.length === 0) {
    return { action: "card", newAddresses: [], notOwnTurn: !facts.ownTurn };
  }
  const newAddresses = recipients.filter(
    (email) => !facts.known.has(email) && !(facts.confirmed?.has(email) ?? false),
  );
  if (!facts.ownTurn || newAddresses.length > 0) {
    return { action: "card", newAddresses, notOwnTurn: !facts.ownTurn };
  }
  return { action: "send", recipients, [DECIDED]: true };
}

/** Every Gmail send calls this right before it: a real "send" decision that covers
 *  exactly the people this message goes to. Anything else throws. */
export function assertSendDecision(decision: unknown, recipients: readonly string[]): asserts decision is SendDecision {
  const candidate = decision as Partial<SendDecision> | undefined;
  if (!candidate || candidate[DECIDED] !== true || candidate.action !== "send") {
    throw new SendNotDecidedError("no_send_decision");
  }
  const allowed = new Set(candidate.recipients ?? []);
  const actual = [...new Set(recipients.map(normalize).filter(Boolean))];
  if (actual.length === 0 || actual.some((email) => !allowed.has(email))) {
    throw new SendNotDecidedError("recipients_not_decided");
  }
}

/** What he's told when it's a card instead of a send. */
export function cardReason(verdict: Exclude<SendVerdict, SendDecision>, to: string): string {
  if (verdict.action === "draft") {
    return "Draft ready. Tap Send when you want it to go.";
  }
  if (verdict.newAddresses.length > 0) {
    return `New address: ${verdict.newAddresses.join(", ")}. Tap Send to confirm.`;
  }
  if (!verdict.notOwnTurn) {
    // His own message, but code couldn't read who it goes to: never a guess.
    return "I couldn't confirm who it goes to, so nothing was sent. Check the card and tap Send to confirm.";
  }
  return `Ready to send to ${to}, but this didn't come straight from your own message. Tap Send to confirm.`;
}
