import { readFile } from "node:fs/promises";
import { shouldForceCalendarTool } from "../src/calendar_guard.ts";
import {
  deleteOwnerCalendarEvent,
  resetOwnerCalendarTestHooks,
  setOwnerCalendarTestHooks,
  type OwnerCalendarEvent,
} from "../src/owner_calendar.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const confirmation = { chatId: 1, messageId: 10 };
const catchup: OwnerCalendarEvent = {
  accountId: "work",
  eventId: "evt-1",
  title: "Catch up",
  start: "2026-10-27T15:00:00+05:30",
  attendeeCount: 0,
};

resetOwnerCalendarTestHooks();

assert(
  !shouldForceCalendarTool("delete the Catch up event", []),
  "delete intent is not a calendar read",
);

{
  const reply = await deleteOwnerCalendarEvent({
    eventTitle: "Catch up",
    confirmation: undefined,
  });
  assert(reply.startsWith("Not deleted: only Vishnu's own chat"), "refused without confirmation");
}

{
  setOwnerCalendarTestHooks({ list: async () => [] });
  const reply = await deleteOwnerCalendarEvent({
    eventTitle: "Catch up",
    confirmation,
  });
  assert(reply.startsWith("Not deleted: no matching event"), "none asks nothing deleted");
}

{
  const deleted: OwnerCalendarEvent[] = [];
  setOwnerCalendarTestHooks({
    list: async () => [
      catchup,
      { ...catchup, eventId: "evt-2", start: "2026-10-28T10:00:00+05:30" },
    ],
    delete: async (event) => {
      deleted.push(event);
    },
  });
  const reply = await deleteOwnerCalendarEvent({
    eventTitle: "Catch up",
    confirmation,
  });
  assert(reply.startsWith("Not deleted: several matches"), "several matches ask");
  assert(reply.includes("evt-1") || reply.includes("27 Oct"), "options listed");
  assert(deleted.length === 0, "several matches deletes nothing");
}

{
  const deleted: OwnerCalendarEvent[] = [];
  setOwnerCalendarTestHooks({
    list: async () => [catchup],
    delete: async (event) => {
      deleted.push(event);
    },
  });
  const reply = await deleteOwnerCalendarEvent({
    eventTitle: "Catch up",
    date: "2026-10-27",
    confirmation,
  });
  assert(deleted.length === 1 && deleted[0]!.eventId === "evt-1", "one match is deleted");
  assert(reply === "Deleted event: Catch up on 27 Oct 2026.", `got ${reply}`);
}

{
  setOwnerCalendarTestHooks({
    list: async () => [{ ...catchup, accountId: "personal" }],
    delete: async () => {
      const error = new Error("insufficientPermissions");
      error.name = "Error";
      throw error;
    },
  });
  const reply = await deleteOwnerCalendarEvent({
    eventTitle: "Catch up",
    confirmation,
  });
  assert(reply.includes("personal calendar is read-only"), "personal 403 is explained");
}

const toolSrc = await readFile(
  new URL("../src/tools/delete_calendar_event.ts", import.meta.url),
  "utf8",
);
assert(!toolSrc.includes("events.delete"), "tool file does not call events.delete");

resetOwnerCalendarTestHooks();
console.log("Delete calendar checks passed.");
