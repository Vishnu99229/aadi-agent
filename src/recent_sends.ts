import { parseAddressList } from "./address_list.js";
import { recentSendsTo } from "./db.js";
import { RECENT_SEND_WINDOW_MS, type RecentSend } from "./security/send_decision.js";
import { assertTestSeam } from "./test_seam.js";

let guardInTests = false;

/** Tests that send to one address many times a second turn the guard on only where
 *  they test it. Production (a real database) always has it on. */
export function setRecentSendGuardForTests(on: boolean): void {
  assertTestSeam("setRecentSendGuardForTests");
  guardInTests = on;
}

function guardOn(): boolean {
  return process.env.AADI_DB_PATH !== ":memory:" || guardInTests;
}

/** The To addresses of a header, lowercased. */
export function toAddresses(header: string | null | undefined): string[] {
  return [...new Set(parseAddressList(header ?? "").map((mailbox) => mailbox.email.toLowerCase()))];
}

/**
 * Aadi's sends to these To addresses in the last 30 minutes, from records, less any a
 * card he acted on already showed him: `acknowledged` maps an address to the newest
 * send that card warned about. A send after that warning still counts.
 */
export function recentSendsFor(
  to: readonly string[],
  acknowledged: ReadonlyMap<string, string> = new Map(),
  now = new Date(),
): RecentSend[] {
  if (!guardOn()) return [];
  const since = new Date(now.getTime() - RECENT_SEND_WINDOW_MS).toISOString();
  return recentSendsTo(to, since).filter((send) => {
    const shown = acknowledged.get(send.email);
    return !shown || shown < send.sentAt;
  });
}

/** Several acknowledgement maps as one: the newest warning per address wins. */
export function mergeAcknowledged(...maps: ReadonlyArray<ReadonlyMap<string, string> | undefined>): Map<string, string> {
  const merged = new Map<string, string>();
  for (const map of maps) {
    for (const [email, sentAt] of map ?? []) {
      const previous = merged.get(email);
      if (!previous || previous < sentAt) merged.set(email, sentAt);
    }
  }
  return merged;
}
