import { parseAddressList } from "./address_list.js";
import { recordConversationParticipants } from "./db.js";

/**
 * A read tool showed these people on his own chat turn. Only header fields (From, To,
 * Cc), calendar attendees and a contact lookup's one match are passed here, never body
 * text. They become who a name can mean in this chat for a while (recipient_facts.ts).
 * A forwarded message, a delegated goal or a background job records nothing.
 */
export function noteShownPeople(
  turn: { ownTurn?: boolean; confirmation?: { chatId: number } } | undefined,
  people: ReadonlyArray<{ email: string; name?: string }>,
  source: "email" | "draft" | "event" | "contact",
  sourceRef: string,
): void {
  if (turn?.ownTurn !== true || !turn.confirmation || people.length === 0) return;
  try {
    recordConversationParticipants(turn.confirmation.chatId, people, source, sourceRef);
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(`Conversation people: not recorded (${errorType})`);
  }
}

/** The mailboxes in these header values. */
export function headerPeople(...headers: ReadonlyArray<string | null | undefined>): Array<{ email: string; name: string }> {
  return headers.flatMap((header) => parseAddressList(header ?? "").map((mailbox) => ({ email: mailbox.email, name: mailbox.name })));
}
