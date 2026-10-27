import { shouldForceCalendarTool } from "../src/calendar_guard.ts";
import { mailboxMatchesName } from "../src/owner_meeting.ts";
import {
  createOwnerMeeting,
  resetOwnerMeetingTestHooks,
  setOwnerMeetingTestHooks,
} from "../src/owner_meeting.ts";
import type { OwnerMeetingInsert } from "../src/owner_meeting.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const confirmation = { chatId: 1, messageId: 10 };

resetOwnerMeetingTestHooks();

assert(
  mailboxMatchesName("Nitish Bhardwaj", {
    name: "Nitish Bhardwaj",
    email: "nitish.bhardwaj@epicode.in",
  }),
  "full name matches",
);
assert(
  !mailboxMatchesName("Nitish Bhardwaj", {
    name: "Nitin Kapoor",
    email: "nitin@conversely.in",
  }),
  "Nitin is not Nitish",
);

assert(
  !shouldForceCalendarTool("create a meeting with Nitish tomorrow at 4pm", []),
  "create intent is not a calendar read",
);

{
  setOwnerMeetingTestHooks({
    lookup: async () => ({
      kind: "several",
      mailboxes: [
        { name: "Nitish Bhardwaj", email: "a@epicode.in" },
        { name: "Nitish B", email: "b@epicode.in" },
      ],
    }),
  });
  const reply = await createOwnerMeeting({
    person: "Nitish",
    startTime: "2026-10-28T16:00:00+05:30",
    confirmation,
  });
  assert(reply.startsWith("Not created: several matches"), "several matches ask");
  assert(reply.includes("a@epicode.in") && reply.includes("b@epicode.in"), "options listed");
}

{
  setOwnerMeetingTestHooks({
    lookup: async () => ({ kind: "none" }),
  });
  const reply = await createOwnerMeeting({
    person: "Nitish",
    startTime: "2026-10-28T16:00:00+05:30",
    confirmation,
  });
  assert(reply.includes("Paste their email"), "no match asks for the email");
}

{
  const inserts: OwnerMeetingInsert[] = [];
  setOwnerMeetingTestHooks({
    lookup: async () => ({
      kind: "one",
      mailbox: { name: "Nitish Bhardwaj", email: "nitish.bhardwaj@epicode.in" },
    }),
    loadBusy: async () => [],
    insert: async (event) => {
      inserts.push(event);
      return { hangoutLink: "https://meet.google.com/abc-defg-hij" };
    },
  });
  const reply = await createOwnerMeeting({
    person: "Nitish Bhardwaj",
    title: "Catch up",
    startTime: "2026-10-28T16:00:00+05:30",
    confirmation,
  });
  assert(inserts.length === 1, "one event inserted");
  assert(inserts[0]!.sendUpdates === "all", "invite is emailed");
  assert(inserts[0]!.guestsCanSeeOtherGuests === true, "attendees see each other");
  assert(inserts[0]!.title === "Catch up", "given title is used");
  assert(inserts[0]!.attendeeEmail === "nitish.bhardwaj@epicode.in", "looked-up attendee");
  assert(reply.includes("Created: Catch up"), "reply names the title");
  assert(reply.includes("https://meet.google.com/abc-defg-hij"), "Meet link is in the reply");
  assert(reply.includes("Invite emailed"), "reply says the invite was emailed");
}

{
  const inserts: OwnerMeetingInsert[] = [];
  setOwnerMeetingTestHooks({
    lookup: async () => ({
      kind: "one",
      mailbox: { name: "Nitish Bhardwaj", email: "nitish.bhardwaj@epicode.in" },
    }),
    loadBusy: async () => [],
    insert: async (event) => {
      inserts.push(event);
      return { hangoutLink: "https://meet.google.com/xyz" };
    },
  });
  await createOwnerMeeting({
    person: "Nitish Bhardwaj",
    startTime: "2026-10-28T16:00:00+05:30",
    confirmation,
  });
  assert(
    inserts[0]!.title === "Vishnu <> Nitish Bhardwaj",
    "default title is Vishnu <> name",
  );
}

{
  const inserts: OwnerMeetingInsert[] = [];
  setOwnerMeetingTestHooks({
    lookup: async () => ({
      kind: "one",
      mailbox: { name: "Nitish", email: "nitish.bhardwaj@epicode.in" },
    }),
    loadBusy: async () => [],
    insert: async (event) => {
      inserts.push(event);
      return { hangoutLink: "https://meet.google.com/no-confirm" };
    },
  });
  const reply = await createOwnerMeeting({
    person: "Nitish",
    startTime: "2026-10-28T16:00:00+05:30",
    confirmation: undefined,
  });
  assert(inserts.length === 0, "no insert without owner confirmation");
  assert(reply.startsWith("Not created: only Vishnu's own chat"), "refused without confirmation");
}

resetOwnerMeetingTestHooks();
console.log("Create meeting checks passed.");
