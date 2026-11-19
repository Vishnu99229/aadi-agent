// "Last Monday's meeting" means a meeting on that date. The date phrase is parsed into
// IST days and never searched for as a title word; he is asked only when several
// meetings really match. Fake calendar, nothing is changed in a real account.
import {
  attendeesForNewMeeting,
  noteCalendarReference,
  resetOwnerCalendarTestHooks,
  reviseReferencedMeeting,
  setOwnerCalendarTestHooks,
  type OwnerCalendarEvent,
} from "../src/owner_calendar.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

if (process.env.AADI_DB_PATH !== ":memory:") {
  throw new Error("test-calendar-dates.ts must run with AADI_DB_PATH=:memory:");
}

const log = console.log;
console.log = () => undefined;
console.error = () => undefined;

// Wednesday 18 Nov 2026, noon in Kolkata. Last Monday is the 16th, last Thursday the 12th.
const NOW = new Date("2026-11-18T06:30:00.000Z");

interface FakeEvent {
  id: string;
  title: string;
  start: string;
  guests: string[];
}
const calendar: FakeEvent[] = [
  { id: "sync-16", title: "Sync", start: "2026-11-16T10:00:00+05:30", guests: ["alice@example.com", "carl@example.com"] },
  { id: "sync-09", title: "Sync", start: "2026-11-09T10:00:00+05:30", guests: ["alice@example.com", "carl@example.com"] },
  { id: "standup-16", title: "Standup", start: "2026-11-16T09:00:00+05:30", guests: ["carl@example.com"] },
  { id: "review-16", title: "Review", start: "2026-11-16T16:00:00+05:30", guests: ["dev@example.com"] },
  { id: "planning-12", title: "Planning", start: "2026-11-12T15:00:00+05:30", guests: ["alice@example.com", "dev@example.com"] },
  { id: "demo-18", title: "Friday demo", start: "2026-11-18T09:00:00+05:30", guests: ["bob@example.com", "dev@example.com"] },
  { id: "acme-16", title: "Acme", start: "2026-11-16T12:00:00+05:30", guests: ["rita@acme.example"] },
  { id: "acme-10", title: "Acme", start: "2026-11-10T12:00:00+05:30", guests: ["sam@acme.example"] },
];
const dayOf = (start: string) => start.slice(0, 10);
const asEvent = (event: FakeEvent): OwnerCalendarEvent => ({
  accountId: "work",
  eventId: event.id,
  title: event.title,
  start: event.start,
  attendeeCount: event.guests.length,
});
const searches: Array<{ title: string; date?: string }> = [];
const patched: string[] = [];
setOwnerCalendarTestHooks({
  list: async ({ title, date }) => {
    searches.push({ title, date });
    const words = title === date ? [] : title.toLowerCase().split(/\s+/).filter(Boolean);
    return calendar
      .filter((event) => !date || dayOf(event.start) === date)
      .filter((event) => words.every((word) => event.title.toLowerCase().includes(word)))
      .map(asEvent);
  },
  getAttendees: async (event) => (calendar.find((item) => item.id === event.eventId)?.guests ?? []).map((email) => ({ email })),
  patch: async ({ event, attendees }) => {
    const stored = calendar.find((item) => item.id === event.eventId)!;
    stored.guests = attendees.map((person) => person.email ?? "").filter(Boolean);
    patched.push(event.eventId);
    return { attendees };
  },
});

let chat = 100;
const edit = (text: string) =>
  reviseReferencedMeeting({ chatId: ++chat, text, confirmation: { chatId: chat, messageId: 1 }, now: NOW });
const noWeekdayOrMonthSearched = (from: number) =>
  searches.slice(from).every((search) => !/monday|tuesday|wednesday|thursday|friday|saturday|sunday|\bnov\b|november/i.test(search.title === search.date ? "" : search.title));

// 1. "Last Monday" is 16 Nov. Four meetings that day; only one has Alice, so it isn't asked.
{
  const from = searches.length;
  const reply = await edit("Remove Alice from last Monday's meeting");
  assert(/^Updated Sync/.test(reply ?? ""), `the Monday Sync is updated, got ${reply}`);
  assert(patched.at(-1) === "sync-16", `on 16 Nov, not the 9 Nov Sync, got ${patched.at(-1)}`);
  assert(!calendar.find((item) => item.id === "sync-16")!.guests.includes("alice@example.com"), "Alice is removed");
  assert(calendar.find((item) => item.id === "sync-09")!.guests.includes("alice@example.com"), "the other Sync keeps her");
  assert(searches.slice(from).some((search) => search.date === "2026-11-16"), "the calendar is searched on that date");
  assert(noWeekdayOrMonthSearched(from), `"Monday" is never a title search word, got ${JSON.stringify(searches.slice(from))}`);
}

// 2. "Last Thursday" is 12 Nov.
{
  const from = searches.length;
  const reply = await edit("Remove Dev from last Thursday's meeting");
  assert(/^Updated Planning/.test(reply ?? "") && patched.at(-1) === "planning-12", `the Thursday Planning is updated, got ${reply}`);
  assert(noWeekdayOrMonthSearched(from), "Thursday is not a search word");
}

// 3. Two meetings on that Monday both have Carl: that is a real choice, so he is asked.
{
  const before = patched.length;
  const reply = await edit("Remove Carl from last Monday's meeting");
  assert(/^Which meeting\?/.test(reply ?? "") && /Standup/.test(reply ?? "") && /Sync/.test(reply ?? ""), `both are offered, got ${reply}`);
  assert(!/Review|Acme/.test(reply ?? ""), "only the meetings that match");
  assert(patched.length === before, "nothing is changed while asking");
  const named = await edit("Remove Carl from last Monday's Standup meeting");
  assert(/^Updated Standup/.test(named ?? "") && patched.at(-1) === "standup-16", `a title settles it, got ${named}`);
}

// 4. Explicit dates: "9 Nov" and "Nov 9th" are the 9th, and the month is not a title word.
{
  calendar.find((item) => item.id === "sync-09")!.guests.push("erin@example.com", "fay@example.com");
  const from = searches.length;
  const first = await edit("Remove Erin from the Sync meeting on 9 Nov");
  assert(/^Updated Sync/.test(first ?? "") && patched.at(-1) === "sync-09", `9 Nov is the 9th, got ${first}`);
  const second = await edit("Remove Fay from the Nov 9th Sync meeting");
  assert(/^Updated Sync/.test(second ?? "") && patched.at(-1) === "sync-09", `Nov 9th is the 9th, got ${second}`);
  assert(noWeekdayOrMonthSearched(from), "the month is not a search word");
}

// 5. A weekday in a title still works: nothing is on a Friday, so "Friday" is part of the name.
{
  const reply = await edit("Remove Bob from the Friday demo meeting");
  assert(/^Updated Friday demo/.test(reply ?? "") && patched.at(-1) === "demo-18", `the Friday demo is found by title, got ${reply}`);
}

// 6. Naming a past meeting by its day.
{
  const reply = await noteCalendarReference({ chatId: ++chat, text: "Which meeting did I have last Thursday?", now: NOW });
  assert(/^That's Planning on 12 Nov 2026/.test(reply ?? ""), `last Thursday's meeting is named, got ${reply}`);
}

// 7. Reusing guests from a meeting on a named day.
{
  const reused = await attendeesForNewMeeting("Book another meeting with the same people from last Monday's Acme meeting", NOW);
  assert(reused.kind === "one", `one Acme meeting on that Monday, got ${JSON.stringify(reused)}`);
  assert(reused.attendees.map((person) => person.email).join(",") === "rita@acme.example", "with that day's guests, not the earlier Acme's");
}

resetOwnerCalendarTestHooks();
console.log = log;
console.log("calendar date checks passed.");
