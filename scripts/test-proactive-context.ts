/**
 * Multi-turn action context: meetings keep resolved attendees, ignore
 * understands it/them, contacts collapse duplicate sources.
 */
import "dotenv/config";
import assert from "node:assert/strict";
import type { calendar_v3, gmail_v1 } from "googleapis";
import {
  continuePendingAction,
  getPendingAction,
} from "../src/action_context.ts";
import {
  bookMeetingFromTool,
  bookPendingMeetingAt,
} from "../src/command_email.ts";
import {
  clearContactCacheForTests,
  resolveContact,
  setContactCalendarForTests,
} from "../src/contacts.ts";
import { createBill, createTask, listActiveIgnoreRules } from "../src/db.ts";
import {
  setGoogleAccountForTests,
  type LoadedGoogleAccount,
} from "../src/google/auth.ts";
import { setGmailClientForTests } from "../src/google/mail.ts";
import {
  resetOwnerMeetingTestHooks,
  setOwnerMeetingTestHooks,
} from "../src/owner_meeting.ts";
import { notePresentedFromTool, recordPresentedEntities } from "../src/referents.ts";
import { parseOwnerTime } from "../src/time_parse.ts";
import { handler as ignoreItem } from "../src/tools/ignore_item.ts";
import { handler as listBills } from "../src/tools/list_bills.ts";
import { handler as listTasks } from "../src/tools/list_tasks.ts";

if (process.env.AADI_DB_PATH !== ":memory:") {
  throw new Error("test-proactive-context.ts must run with AADI_DB_PATH=:memory:");
}

const NOW = new Date("2026-11-16T04:00:00.000Z");
const START = "2026-11-16T15:50:00+05:30";
const CHAT = 1;
const ME = "vishnu@epicode.in";
const owner = (text: string, messageId = 200) => ({
  iteration: 1,
  calledTools: [] as string[],
  userText: text,
  confirmation: { chatId: CHAT, messageId },
});

interface Mail {
  id: string;
  from: string;
  to: string;
  cc?: string;
  at: number;
}
const world: Mail[] = [];
let mailId = 0;
function addMail(from: string, to = `Vishnu <${ME}>`): void {
  mailId += 1;
  world.push({ id: `m${mailId}`, from, to, at: 1_700_000_000_000 + mailId * 1000 });
}

function search(q: string): Mail[] {
  const groups = [...q.matchAll(/\(([^)]+)\)/g)];
  if (groups.length === 0) {
    return world;
  }
  return world.filter((item) =>
    groups.every((group) =>
      group[1]!.split(/\s+OR\s+/i).some((term) => {
        const match = /^(from|to|cc):(.+)$/i.exec(term.trim());
        if (!match) {
          return false;
        }
        const field = match[1]!.toLowerCase();
        const value = match[2]!.toLowerCase();
        const header =
          field === "from" ? item.from : field === "to" ? item.to : (item.cc ?? "");
        return header.toLowerCase().includes(value);
      }),
    ),
  );
}

const gmail = {
  users: {
    getProfile: async () => ({ data: { emailAddress: ME } }),
    messages: {
      list: async ({ q, maxResults }: { q: string; maxResults: number }) => ({
        data: { messages: search(q).slice(0, maxResults).map((item) => ({ id: item.id })) },
      }),
      get: async ({ id }: { id: string }) => {
        const item = world.find((row) => row.id === id)!;
        return {
          data: {
            id: item.id,
            internalDate: String(item.at),
            labelIds: ["INBOX"],
            payload: {
              headers: [
                { name: "From", value: item.from },
                { name: "To", value: item.to },
                { name: "Cc", value: item.cc ?? "" },
              ],
            },
          },
        };
      },
    },
  },
} as unknown as gmail_v1.Gmail;

const account = { id: "work", tag: "work", label: "work", client: {} } as unknown as LoadedGoogleAccount;
setGoogleAccountForTests(() => account);
setGmailClientForTests(() => gmail);
setContactCalendarForTests(
  () =>
    ({
      events: {
        list: async () => ({
          data: {
            items: [
              {
                start: { dateTime: "2026-11-01T10:00:00+05:30" },
                attendees: [
                  { email: "tripthi.anchan@epicode.in", displayName: "Tripthi Anchan" },
                  { email: "nithish@epicode.in", displayName: "Nithish Bharadwaj" },
                ],
              },
            ],
          },
        }),
      },
    }) as unknown as calendar_v3.Calendar,
);

addMail("Nithish Bharadwaj <nithish@epicode.in>");
addMail("Tripthi Anchan <tripthi.anchan@epicode.in>");
addMail("Sendhil Kumar <sendhil@epicode.in>");
addMail("Nithish Bharadwaj <nithish@epicode.in>", "Vishnu <personal@gmail.com>");

const booked: Array<{ attendees: Array<{ email: string }>; title?: string; startIso?: string }> = [];
setOwnerMeetingTestHooks({
  loadBusy: async () => [],
  insertCommand: async (event) => {
    booked.push(event);
    return { hangoutLink: "https://meet.example/bts", htmlLink: "https://cal.example/bts" };
  },
});

{
  assert.equal(parseOwnerTime("3:50 pm today", NOW), START);
  assert.equal(parseOwnerTime("today at 3:50 pm", NOW), START);
  assert.equal(parseOwnerTime("tomorrow at 3:50 pm", NOW), "2026-11-17T15:50:00+05:30");
  assert.equal(parseOwnerTime("Friday at 3:50 pm", NOW), "2026-11-20T15:50:00+05:30");
  assert.equal(parseOwnerTime("Show my 3 open tasks", NOW), undefined);
  assert.equal(parseOwnerTime("Don't book it at 3:50 pm", NOW), undefined);
}

{
  const one = await resolveContact("Tripthi");
  assert.equal(one.kind, "one");
  if (one.kind === "one") {
    assert.equal(one.contact.emails[0], "tripthi.anchan@epicode.in");
    assert.ok(
      one.contact.sources.includes("gmail") && one.contact.sources.includes("calendar"),
      `duplicate sources should collapse, got ${one.contact.sources.join(",")}`,
    );
  }
  const hinted = await resolveContact("Tripthi from Epicode");
  assert.equal(hinted.kind, "one");
  const typo = await resolveContact("Triphi");
  assert.equal(typo.kind, "one");
  if (typo.kind === "one") {
    assert.equal(typo.contact.emails[0], "tripthi.anchan@epicode.in");
  }
}

{
  const nithish = await resolveContact("Nithish from Epicode");
  assert.equal(nithish.kind, "one");
  if (nithish.kind === "one") {
    assert.equal(nithish.contact.emails[0], "nithish@epicode.in");
  }
}

{
  const first = await bookMeetingFromTool(
    { attendees: ["Nithish", "Tripthi", "Sendhil"], title: "BTS prep meeting" },
    owner("Book a BTS prep meeting with Nithish, Tripthi and Sendhil."),
    NOW,
  );
  assert.match(first, /I found/i, first);
  assert.match(first, /nithish@epicode\.in/i, first);
  assert.match(first, /tripthi\.anchan@epicode\.in/i, first);
  assert.match(first, /sendhil@epicode\.in/i, first);
  assert.match(first, /have not created|Free slots|No free/i, first);
  assert.equal(booked.length, 0, "no event until he gives a time");
  const pending = getPendingAction(CHAT, NOW);
  assert.equal(pending?.action, "create_meeting");
  assert.equal(pending?.meeting?.waiting, "time");
  assert.equal(pending?.meeting?.attendees.filter((item) => item.resolved).length, 3);
}

{
  const injected = await bookMeetingFromTool(
    { attendees: ["evil@attacker.example"], start_time: START },
    owner("3:50 pm today"),
    NOW,
  );
  assert.match(injected, /own message|Not booked|isn't a name/i, injected);
  assert.equal(booked.length, 0, "an injected address must not book");
}

{
  assert.equal(continuePendingAction(CHAT, "Show my 3 open tasks", NOW).kind, "none");
  assert.equal(continuePendingAction(CHAT, "Don't book it at 3:50 pm", NOW).kind, "none");
  const continuation = continuePendingAction(CHAT, "3:50 pm today", NOW);
  assert.equal(continuation.kind, "meeting_time");
  const second =
    continuation.kind === "meeting_time"
      ? await bookPendingMeetingAt(
          CHAT,
          continuation.startIso,
          { chatId: CHAT, messageId: 201 },
          NOW,
        )
      : "no continuation";
  assert.match(second, /^Booked:/, second);
  assert.equal(booked.length, 1);
  const emails = booked[0]!.attendees.map((item) => item.email).sort();
  assert.deepEqual(emails, [
    "nithish@epicode.in",
    "sendhil@epicode.in",
    "tripthi.anchan@epicode.in",
  ]);
  assert.equal(booked[0]!.title, "BTS prep meeting");
  assert.equal(getPendingAction(CHAT, NOW), undefined);
}

{
  addMail("Kiran Shah <kiran@epicode.in>");
  addMail("Kiran Rao <kiran@otherco.example>");
  addMail("Nithish Other <nithish.other@elsewhere.example>");
  clearContactCacheForTests();
  const many = await resolveContact("Kiran");
  assert.equal(many.kind, "many", "two different Kiran addresses must ask once");
  const hinted = await resolveContact("Nithish from Epicode");
  assert.equal(hinted.kind, "one");
  if (hinted.kind === "one") {
    assert.equal(hinted.contact.emails[0], "nithish@epicode.in");
  }
}

{
  const bills = [
    createBill("Goibibo", 1, "INR", "2026-10-01", "t1")!,
    createBill("Axis Bank Alerts", 1, "INR", "2026-10-02", "t2")!,
    createBill("Google Workspace", 1, "INR", "2026-10-03", "t3")!,
    createBill("Anthropic", 1, "INR", "2026-10-04", "t4")!,
    createBill("AWS", 1, "INR", "2026-10-05", "t5")!,
    createBill("FIRST SWYP", 1, "INR", "2026-10-06", "t6")!,
  ];
  const listed = listBills({ filter: "overdue" });
  notePresentedFromTool("list_bills", listed, CHAT);
  const result = ignoreItem({ query: "all of them" }, owner("Ignore all of them."));
  assert.match(result, /stop tracking|Already ignoring/i, result);
  const rules = listActiveIgnoreRules().filter((rule) =>
    bills.some((bill) => rule.entity_id === String(bill.id)),
  );
  assert.equal(rules.length, bills.length, `expected ${bills.length} bill rules, got ${rules.length}`);
  assert.ok(rules.every((rule) => rule.duration === "permanent"));
}

{
  const tempBills = [
    createBill("TempOne", 1, "INR", "2026-10-07", "tmp1")!,
    createBill("TempTwo", 1, "INR", "2026-10-08", "tmp2")!,
  ];
  recordPresentedEntities(
    CHAT,
    tempBills.map((bill) => ({
      type: "bill" as const,
      id: String(bill.id),
      label: bill.biller,
      matchKey: bill.biller,
      tag: "personal",
    })),
  );
  const result = ignoreItem({ query: "all of them" }, owner("Ignore all of them until tomorrow."));
  assert.match(result, /until 2026-11-17|until tomorrow|stop tracking/i, result);
  const rules = listActiveIgnoreRules().filter((rule) =>
    tempBills.some((bill) => rule.entity_id === String(bill.id)),
  );
  assert.equal(rules.length, 2);
  assert.ok(rules.every((rule) => rule.duration === "temporary" && rule.expires_at));
}

{
  const task = createTask("Pay the electricity bill", "personal", null);
  const listed = listTasks({ status: "open", tag: "personal" });
  notePresentedFromTool("list_tasks", listed, CHAT);
  const result = ignoreItem({ query: "it" }, owner("Ignore it."));
  assert.match(result, /stop tracking|Already ignoring|task/i, result);
  assert.ok(
    listActiveIgnoreRules().some(
      (rule) => rule.entity_type === "task" && rule.entity_id === String(task.id),
    ),
    "the listed task was ignored",
  );
}

{
  const linkedin = [
    createBill("LinkedIn", 1, "INR", "2026-10-24", "li1")!,
    createBill("LinkedIn", 1, "INR", "2026-10-31", "li2")!,
    createBill("Google Play LinkedIn", 1, "INR", "2026-12-23", "li3")!,
  ];
  recordPresentedEntities(
    CHAT,
    linkedin.map((bill) => ({
      type: "bill" as const,
      id: String(bill.id),
      label: bill.biller,
      matchKey: bill.biller,
      tag: "personal",
    })),
    "ignore_which",
  );
  const result = ignoreItem({ query: "all three" }, owner("All three."));
  assert.match(result, /stop tracking|Already ignoring|LinkedIn/i, result);
  const ignored = listActiveIgnoreRules().filter((rule) =>
    linkedin.some((bill) => rule.entity_id === String(bill.id)),
  );
  assert.equal(ignored.length, 3, `three LinkedIn records ignored, got ${ignored.length}`);
}

resetOwnerMeetingTestHooks();
console.log("proactive context checks passed.");
