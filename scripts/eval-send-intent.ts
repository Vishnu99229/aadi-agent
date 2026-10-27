// Manual eval, not part of npm test: real chat model, in-memory DB, fake
// Telegram / Gmail / Calendar. Nothing is sent or booked for real.
// Usage: npm run eval:send-intent -- [backend] [runs]
import { setApprovalsTestHooks } from "../src/approvals.ts";
import { runAgent, setToolInterceptorForTests } from "../src/agent.ts";
import {
  createPendingAction,
  getPendingAction,
  saveMessage,
  setPendingActionDraftMeta,
  setPendingActionTelegramMessage,
  setPendingActionTimestampsForTests,
  transitionPendingAction,
} from "../src/db.ts";
import type { LlmBackend } from "../src/llm.ts";
import {
  resetOwnerMeetingTestHooks,
  setOwnerMeetingTestHooks,
  type OwnerMeetingInsert,
} from "../src/owner_meeting.ts";
import { fakeGmail, fakeTelegramApi } from "./fakes.ts";

const backend = (process.argv[2] ?? "deepseek") as LlmBackend;
const runs = Number(process.argv[3] ?? 2);

const gmail = { sent: [] as string[], created: [] as string[], deleted: [] as string[] };
setApprovalsTestHooks({
  telegram: fakeTelegramApi({ sent: [], edited: [] }),
  gmailFor: () => fakeGmail(gmail),
});

function sqliteHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600_000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 90);
}

const seeded: number[] = [];

function discardSeeded(): void {
  for (const id of seeded) {
    const row = getPendingAction(id);
    if (row?.status === "pending") {
      transitionPendingAction(id, "pending", "discarded");
    }
  }
  seeded.length = 0;
}

function showDraft(
  draftId: string,
  meta: { to: string; cc?: string; subject: string },
  hoursAgo: number,
): void {
  const action = createPendingAction(draftId, null, "work");
  setPendingActionTelegramMessage(action.id, action.id + 200);
  setPendingActionDraftMeta(action.id, {
    toHeader: meta.to,
    ccHeader: meta.cc ?? "",
    subject: meta.subject,
  });
  setPendingActionTimestampsForTests(action.id, {
    createdAt: sqliteHoursAgo(hoursAgo + 0.2),
    updatedAt: sqliteHoursAgo(hoursAgo),
  });
  seeded.push(action.id);
}

function seedOne(): void {
  discardSeeded();
  showDraft("eval-draft", { to: "Priya <priya@acme.com>", subject: "Demo" }, 0.2);
}

function seedFour(): void {
  discardSeeded();
  showDraft("sujoy-a", { to: "Sujoy <sujoy@x.com>", subject: "Old 1" }, 2);
  showDraft("sujoy-b", { to: "Sujoy <sujoy@x.com>", subject: "Old 2" }, 1.8);
  showDraft("ashwini-old", { to: "Ashwini <ashwini@epicode.in>", subject: "Hi" }, 1.5);
  showDraft(
    "satya-draft",
    {
      to: "Satyapramod <satyapramod@aspirare.in>",
      cc: "ashwini@epicode.in, sendhil@epicode.in",
      subject: "Reminder: Epicode <> Aspirare call today at 11:30 am",
    },
    0.1,
  );
}

const confirmation = { chatId: 1, messageId: 10_000 };

let calls: string[] = [];
let lastInputs: Record<string, unknown> = {};

setToolInterceptorForTests((call, turn) => {
  calls.push(`${call.name}@step${turn.iteration}`);
  lastInputs[call.name] = call.input;
  if (
    call.name === "confirm_send_pending_draft" ||
    call.name === "create_meeting" ||
    call.name === "get_current_time" ||
    call.name === "discard_pending_draft" ||
    call.name === "resend_draft_card"
  ) {
    return undefined;
  }
  return "Done.";
});

interface Case {
  name: string;
  text: string;
  seed: () => void;
  pass: (reply: string) => boolean;
}

let failures = 0;

async function runCase(testCase: Case): Promise<void> {
  for (let run = 1; run <= runs; run += 1) {
    testCase.seed();
    calls = [];
    lastInputs = {};
    gmail.sent.length = 0;
    gmail.deleted.length = 0;
    const reply = await runAgent(testCase.text, {
      backend,
      saveUserMessage: false,
      saveAssistantMessage: false,
      sendConfirmation: confirmation,
    });
    const ok = testCase.pass(reply);
    if (!ok) {
      failures += 1;
    }
    console.log(
      `RESULT\t${ok ? "PASS" : "FAIL"}\t${JSON.stringify(testCase.name)}\ttools=[${calls.join(",")}]\tsent=${gmail.sent.join("|") || "-"}\tdeleted=${gmail.deleted.join("|") || "-"}\treply="${oneLine(reply)}"`,
    );
    if (
      testCase.name === "send it" ||
      testCase.name === "send the aspirare one" ||
      testCase.name === "create a meeting with Nitish tomorrow 4pm" ||
      testCase.name === "book me a flight"
    ) {
      console.log(`FULL\t${JSON.stringify(testCase.name)}\t${JSON.stringify(reply)}`);
    }
  }
}

saveMessage("user", "Draft an email to priya@acme.com saying the demo moves to Thursday 3pm.");
saveMessage("assistant", "Draft created for priya@acme.com (work). Waiting for your Send tap.");

const withDraft: Case[] = [
  {
    name: "send it",
    text: "send it",
    seed: seedOne,
    pass: (reply) =>
      gmail.sent.length === 1 &&
      gmail.sent[0] === "eval-draft" &&
      /sent/i.test(reply),
  },
  {
    name: "send that",
    text: "send that",
    seed: seedOne,
    pass: () => gmail.sent.length === 1 && gmail.sent[0] === "eval-draft",
  },
  {
    name: "haan bhej do",
    text: "haan bhej do",
    seed: seedOne,
    pass: () => gmail.sent.length === 1 && gmail.sent[0] === "eval-draft",
  },
  {
    name: "ok (hold)",
    text: "ok",
    seed: seedOne,
    pass: (reply) =>
      gmail.sent.length === 0 &&
      /send|edit|change|ambiguous/i.test(reply),
  },
];

console.log(`\nWITH ONE PENDING DRAFT (backend=${backend}, runs=${runs})`);
for (const testCase of withDraft) {
  await runCase(testCase);
}

const fourDrafts: Case[] = [
  {
    name: "send the aspirare one",
    text: "send the aspirare one",
    seed: seedFour,
    pass: () => gmail.sent.length === 1 && gmail.sent[0] === "satya-draft",
  },
  {
    name: "the one to Satyapramod",
    text: "the one to Satyapramod",
    seed: seedFour,
    pass: () => gmail.sent.length === 1 && gmail.sent[0] === "satya-draft",
  },
  {
    name: "send the latest",
    text: "send the latest",
    seed: seedFour,
    pass: () => gmail.sent.length === 1 && gmail.sent[0] === "satya-draft",
  },
  {
    name: "send it (one clearly latest)",
    text: "send it",
    seed: seedFour,
    pass: () => gmail.sent.length === 1 && gmail.sent[0] === "satya-draft",
  },
  {
    name: "discard the Sujoy ones",
    text: "discard the Sujoy ones",
    seed: seedFour,
    pass: () =>
      gmail.deleted.includes("sujoy-a") &&
      gmail.deleted.includes("sujoy-b") &&
      !gmail.deleted.includes("satya-draft") &&
      gmail.sent.length === 0,
  },
];

console.log(`\nFOUR PENDING DRAFTS, ASPIRARE LATEST (backend=${backend})`);
for (const testCase of fourDrafts) {
  await runCase(testCase);
}

const inserts: OwnerMeetingInsert[] = [];
setOwnerMeetingTestHooks({
  lookup: async () => ({
    kind: "one",
    mailbox: { name: "Nitish Bhardwaj", email: "nitish.bhardwaj@epicode.in" },
  }),
  loadBusy: async () => [],
  insert: async (event) => {
    inserts.push(event);
    return { hangoutLink: "https://meet.google.com/eval-nitish" };
  },
});

console.log(`\nCREATE MEETING (backend=${backend})`);
await runCase({
  name: "create a meeting with Nitish tomorrow 4pm",
  text: "create a meeting with Nitish tomorrow at 4pm",
  seed: () => {
    discardSeeded();
    inserts.length = 0;
  },
  pass: (reply) => {
    const called = calls.some((name) => name.startsWith("create_meeting"));
    const proposed = calls.some((name) =>
      name.startsWith("propose_calendar_event"),
    );
    const event = inserts[0];
    if (event) {
      console.log(
        `MEETING_INSERT\ttitle=${JSON.stringify(event.title)}\tsendUpdates=${event.sendUpdates}\tguestsCanSeeOtherGuests=${event.guestsCanSeeOtherGuests}\tattendee=${event.attendeeEmail}`,
      );
    }
    return (
      called &&
      !proposed &&
      inserts.length === 1 &&
      event?.sendUpdates === "all" &&
      event?.guestsCanSeeOtherGuests === true &&
      /meet\.google\.com\/eval-nitish/i.test(reply) &&
      /nitish/i.test(reply)
    );
  },
});
resetOwnerMeetingTestHooks();

console.log(`\nHONESTY — NO MATCHING TOOL (backend=${backend})`);
await runCase({
  name: "book me a flight",
  text: "book me a flight to Delhi tomorrow",
  seed: discardSeeded,
  pass: (reply) =>
    !calls.some(
      (name) =>
        name.startsWith("create_meeting") ||
        name.startsWith("confirm_send_pending_draft") ||
        name.startsWith("propose_calendar_event"),
    ) &&
    /can'?t do that|can'?t book|isn't built|not built|don't have|do not have/i.test(
      reply,
    ) &&
    /remind|calendar|draft|task|event/i.test(reply),
});

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAIL`}`);
process.exit(0);
