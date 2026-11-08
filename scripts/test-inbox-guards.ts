import {
  createMemory,
  listMemories,
  listPendingMemoryConfirms,
} from "../src/db.ts";
import {
  isAlgorithmicallyExcluded,
  mergeSelfAddresses,
} from "../src/mail_helpers.ts";
import {
  meetingCardAlreadySent,
  notReplyingText,
} from "../src/meeting_book.ts";
import { queueRelationshipMemory } from "../src/memory.ts";
import {
  buildRelationshipFact,
  relationshipFactIsSafe,
} from "../src/memory_logic.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

{
  const self = mergeSelfAddresses(
    ["Vishnu.Rajan294@gmail.com"],
    ["alias@gmail.com"],
    ["not-an-email"],
  );
  assert(self.has("vishnu.rajan294@gmail.com"), "profile addresses are lowercased into the self set");
  assert(self.has("alias@gmail.com"), "send-as aliases join the self set");
  assert(!self.has("rajan.vish294@gmail.com"), "rajan.vish294@gmail.com is not treated as self");
  assert(
    isAlgorithmicallyExcluded(
      "Alias <alias@gmail.com>",
      "",
      "vishnu.rajan294@gmail.com",
      self,
    ),
    "a thread whose To addresses are all self is dropped",
  );
  assert(
    !isAlgorithmicallyExcluded(
      "Rajan Vish294 <rajan.vish294@gmail.com>",
      "",
      "vishnu.rajan294@gmail.com",
      self,
    ),
    "a thread to rajan.vish294@gmail.com is kept",
  );
  assert(
    !isAlgorithmicallyExcluded(
      "alias@gmail.com, priya@acme.com",
      "",
      "vishnu.rajan294@gmail.com",
      self,
    ),
    "a thread with any outside recipient is kept",
  );
}

{
  const alerted = {
    status: "handed_over",
    sender_type: "existing_customer_or_partner",
    last_kind: "asks_availability",
  };
  assert(
    meetingCardAlreadySent(alerted, "asks_availability", "existing_customer_or_partner"),
    "the same kind and sender type sends no new card",
  );
  assert(
    meetingCardAlreadySent(
      { ...alerted, status: "ignored" },
      "asks_availability",
      "existing_customer_or_partner",
    ),
    "an ignored thread of the same kind sends no new card",
  );
  assert(
    !meetingCardAlreadySent(alerted, "asks_availability", "prospect_enquiry"),
    "a different sender type can still alert",
  );
  assert(
    !meetingCardAlreadySent(alerted, "proposes_times", "existing_customer_or_partner"),
    "a different kind can still alert",
  );
  assert(
    !meetingCardAlreadySent(undefined, "asks_availability", "prospect_enquiry"),
    "a thread with no prior card can alert",
  );
}

{
  const text = notReplyingText("Sujoy", 0.55);
  assert(
    text === "Sujoy might be asking to meet (confidence 0.55).",
    "the not-replying card states confidence",
  );
  const keyboard = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/meeting_book.ts", import.meta.url), "utf8"),
  );
  const buttons = keyboard.slice(keyboard.indexOf("function vendorFyiKeyboard"));
  assert(buttons.includes('"Ignore"'), "the not-replying card has Ignore");
  assert(
    buttons.includes('"Actually, offer slots"'),
    "the not-replying card offers slots only as a second choice",
  );
  assert(!buttons.includes("Reply with slots"), "Reply with slots is not on the not-replying card");
}

{
  const safe = buildRelationshipFact({
    name: "Sujoy",
    company: "Supertron",
    senderType: "existing_customer_or_partner",
    subject: "Re: Voicebot Integration",
  });
  assert(relationshipFactIsSafe(safe), "a name, company, and topic is safe to propose");
  assert(!safe.includes("@"), "the proposed fact has no email address");
  assert(
    !relationshipFactIsSafe("Sujoy's number is +91 98470 12345"),
    "a phone number is not a relationship fact",
  );
  assert(
    !relationshipFactIsSafe("See the signature and the full email body: hello there"),
    "a signature is not stored",
  );
  const phone = queueRelationshipMemory({
    content: "Call Sujoy on 9847012345 about the bot",
    name: "Sujoy",
    company: "Supertron",
  });
  assert(phone.status === "skipped" && phone.reason === "unsafe", "a phone fact is not queued");
  assert(
    listPendingMemoryConfirms().every((row) => !row.content.includes("98470")),
    "no pending confirm stores a phone number",
  );
  assert(
    listMemories().every((row) => !row.content.includes("98470")),
    "no memory stores a phone number",
  );

  const queued = queueRelationshipMemory({
    content: safe,
    name: "Sujoy",
    company: "Supertron",
  });
  assert(queued.status === "queued", "a new relationship fact waits for a Yes tap");
  assert(
    listMemories().every((row) => row.content !== safe),
    "the fact is not saved before the tap",
  );
  const pending = listPendingMemoryConfirms().find((row) => row.content === safe);
  assert(pending !== undefined, "the confirm row holds the safe fact");

  createMemory({
    content: "Priya at Acme is a prospect. Thread topic: Pricing.",
    category: "person",
    tag: "work",
    source: "confirmed",
  });
  const duplicate = queueRelationshipMemory({
    content: "Priya at Acme is a prospect. Thread topic: Pricing call.",
    name: "Priya",
    company: "Acme",
  });
  assert(
    duplicate.status === "skipped" && duplicate.reason === "duplicate",
    "an equivalent memory is not proposed again",
  );
}

console.log("Inbox guard checks passed.");
