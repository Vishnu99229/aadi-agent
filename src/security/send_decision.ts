/**
 * The one decision for every email Aadi sends on Vishnu's word (not sequence
 * follow-ups or meeting auto-booking, which keep their own gates). Code decides,
 * from facts code gathered: anything uncertain is a card, never a send.
 */

import { createHash } from "node:crypto";

const DECIDED = Symbol("send-decision");

/** Only decideSendAction makes one of these, and every Gmail send checks it. */
export interface SendDecision {
  readonly action: "send";
  readonly recipients: readonly string[];
  readonly [DECIDED]: true;
}

/** An email Aadi sent to this To address within the recent-send window, from records. */
export interface RecentSend {
  readonly email: string;
  readonly name: string;
  /** ISO, UTC. */
  readonly sentAt: string;
}

/** How far back another email to the same person needs his confirmation. */
export const RECENT_SEND_WINDOW_MS = 30 * 60 * 1000;

export type SendVerdict =
  | SendDecision
  /** Show him the card; nothing goes out until his tap. */
  | { action: "card"; newAddresses: string[]; notOwnTurn: boolean; recentSends?: RecentSend[] }
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
  /** Aadi's sends to these To addresses in the last 30 minutes that no card he acted
   *  on has shown him. Any of them makes this a card, never a second silent send. */
  recentSends?: readonly RecentSend[];
  /** Addresses taken from something he pointed at (a photo's text, a quoted message):
   *  new on the card even if he has emailed them, until a card he tapped showed them. */
  external?: ReadonlySet<string>;
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
    (email) => !(facts.confirmed?.has(email) ?? false) &&
      (!facts.known.has(email) || (facts.external?.has(email) ?? false)),
  );
  const repeats = (facts.recentSends ?? []).filter((send) => recipients.includes(normalize(send.email)));
  if (!facts.ownTurn || newAddresses.length > 0 || repeats.length > 0) {
    return {
      action: "card", newAddresses, notOwnTurn: !facts.ownTurn,
      ...(repeats.length > 0 ? { recentSends: repeats } : {}),
    };
  }
  return { action: "send", recipients, [DECIDED]: true };
}

const IST_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

/** "You emailed Ashwin Kumar at 12:04. Send another?" */
export function recentSendLine(sends: readonly RecentSend[]): string {
  const people = sends.map((send) => {
    const at = new Date(send.sentAt);
    const time = Number.isFinite(at.getTime()) ? ` at ${IST_TIME.format(at)}` : "";
    return `${send.name.trim() || send.email}${time}`;
  });
  const list = people.length <= 1 ? people.join("") : `${people.slice(0, -1).join(", ")} and ${people.at(-1)}`;
  return `You emailed ${list}. Send another?`;
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
  const repeats = verdict.recentSends ?? [];
  if (verdict.newAddresses.length > 0 || repeats.length > 0) {
    const parts = [
      ...(verdict.newAddresses.length > 0 ? [`New address: ${verdict.newAddresses.join(", ")}.`] : []),
      ...(repeats.length > 0 ? [recentSendLine(repeats)] : []),
    ];
    return `${parts.join(" ")} Tap Send to confirm.`;
  }
  if (!verdict.notOwnTurn) {
    // His own message, but code couldn't read who it goes to: never a guess.
    return "I couldn't confirm who it goes to, so nothing was sent. Check the card and tap Send to confirm.";
  }
  return `Ready to send to ${to}, but this didn't come straight from your own message. Tap Send to confirm.`;
}

/** Who a card showed, as a short fingerprint: the same people give the same value. */
export function recipientFingerprint(recipients: readonly string[]): string {
  const people = [...new Set(recipients.map(normalize).filter(Boolean))].sort();
  return createHash("sha256").update(people.join(",")).digest("hex").slice(0, 12);
}

