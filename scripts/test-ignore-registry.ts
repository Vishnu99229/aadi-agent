import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  backupDatabaseTo,
  createBill,
  createReminder,
  createTask,
  getBill,
  getBills,
  getReminders,
  getTasks,
  listActiveIgnoreRules,
  listIgnoreRuleEvents,
} from "../src/db.ts";
import { authorize, issueGrant } from "../src/agents/auth.ts";
import { billsForBrief, scheduleBillReminders, trackPayableBill } from "../src/bills.ts";
import { commandIntents } from "../src/command_intent.ts";
import {
  applyIgnore,
  billIsIgnored,
  invalidateIgnoreCache,
  isIgnored,
  matchingIgnoreRule,
  parseIgnoreDuration,
  resolveIgnoreTarget,
  resumeIgnore,
  taskIsIgnored,
} from "../src/ignore.ts";
import { ignoredItemsCaption } from "../src/ignore_panel.ts";
import { FORWARDED_TOOLS } from "../src/tools/index.ts";
import { handler as ignoreItem } from "../src/tools/ignore_item.ts";
import { handler as listIgnored } from "../src/tools/list_ignored.ts";
import { handler as listBills } from "../src/tools/list_bills.ts";
import { handler as listTasks } from "../src/tools/list_tasks.ts";
import { handler as resumeItem } from "../src/tools/resume_item.ts";
import { buildWeeklyReview } from "../src/weekly.ts";
import type { ToolTurn } from "../src/tools/index.ts";

if (process.env.AADI_DB_PATH !== ":memory:") {
  console.error(
    "test-ignore-registry.ts must run with AADI_DB_PATH=:memory: to avoid writing to the live db.",
  );
  process.exit(1);
}

function ownerTurn(text: string): ToolTurn {
  return {
    iteration: 1,
    calledTools: [],
    confirmation: { chatId: 1, messageId: 99 },
    userText: text,
  };
}

const linkedin = createBill("LinkedIn", 2400, "INR", "2026-10-01", "thr-li")!;
const goibibo = createBill("Goibibo", 1200, "INR", "2026-10-02", "thr-gb")!;
const axis = createBill("Axis Bank Alerts", 500, "INR", "2026-10-03", "thr-ax")!;
const workspace = createBill("Google Workspace", 800, "INR", "2026-10-04", "thr-gw")!;
const anthropic = createBill("Anthropic", 1600, "INR", "2026-10-05", "thr-an")!;
const aws = createBill("Amazon Web Services", 3200, "INR", "2026-11-01", "thr-aws")!;
assert(linkedin && goibibo && axis && workspace && anthropic && aws);

const electricity = createTask("Pay the electricity bill", "personal", "2026-10-10T09:00:00.000Z");
const otherTask = createTask("Call the landlord", "personal", "2026-10-11T09:00:00.000Z");
const workTask = createTask("Send the SOW", "work", "2026-10-12T09:00:00.000Z");

createReminder(
  `Bill due: LinkedIn for INR 2400. Due on ${linkedin.due_date}. Tap Done when paid.`,
  "personal",
  "2026-09-28T03:30:00.000Z",
  "none",
  { relatedBillId: linkedin.id },
);

// 1. Ignoring an existing bill
{
  const result = ignoreItem({ query: "LinkedIn bills" }, ownerTurn("Ignore my LinkedIn bills."));
  assert.match(result, /stop tracking LinkedIn bills/i, result);
  assert.equal(getBill(linkedin.id)!.status, "upcoming", "not marked paid");
  assert.equal(billIsIgnored(getBill(linkedin.id)!), true);
}

// 2. Suppressing a future bill from the same approved source
{
  const tracked = trackPayableBill({
    biller: "LinkedIn",
    amount: 2400,
    currency: "INR",
    dueDate: "2026-12-01",
    threadId: "thr-li-next",
    snippet: "Your LinkedIn invoice",
  });
  assert.notEqual(tracked.action, "skipped");
  if (tracked.action !== "skipped") {
    assert.equal(billIsIgnored(tracked.bill), true, "new LinkedIn invoice is suppressed");
    assert.equal(
      scheduleBillReminders(tracked.bill),
      0,
      "no active reminder created for ignored source",
    );
  }
}

// 3. Ignoring an existing task
{
  const result = ignoreItem(
    { query: "electricity bill task" },
    ownerTurn("Ignore the electricity bill task."),
  );
  assert.match(result, /stop tracking and reminding/i, result);
  assert.equal(electricity.status, "open", "task not completed");
  assert.equal(getTasks().find((row) => row.id === electricity.id)!.status, "open");
  assert.equal(taskIsIgnored(electricity), true);
}

// 4. Excluding ignored items from weekly and morning reviews
{
  const review = buildWeeklyReview(new Date("2026-11-16T03:30:00.000Z"));
  assert.match(review, /Goibibo/, "unrelated overdue bill remains");
  assert.match(review, /Axis Bank Alerts/, "axis remains");
  assert.match(review, /Google Workspace/, "workspace remains");
  assert.match(review, /Anthropic/, "anthropic remains");
  assert.match(review, /Amazon Web Services/, "aws remains");
  assert.doesNotMatch(review, /LinkedIn/, "ignored LinkedIn bill is out of the weekly review");
  assert.doesNotMatch(
    review,
    /electricity bill/i,
    "ignored electricity task is not under Personal tasks still open",
  );
  assert.match(review, /Call the landlord/, "unrelated personal task remains");
  const briefBills = billsForBrief("2026-11-16");
  assert.equal(
    briefBills.overdue.some((bill) => bill.biller === "LinkedIn"),
    false,
  );
  assert.equal(
    briefBills.overdue.some((bill) => bill.biller === "Goibibo"),
    true,
  );
}

// 5. Excluding ignored items from proactive reminders and open-task lists
{
  const listed = listTasks({ status: "open", tag: "personal" });
  assert.doesNotMatch(listed, /electricity bill/i);
  assert.match(listed, /Call the landlord/);
  const overdue = listBills({ filter: "overdue" });
  assert.doesNotMatch(overdue, /LinkedIn/);
  assert.match(overdue, /Goibibo/);
}

// 6. Persistence after a simulated process restart
{
  invalidateIgnoreCache();
  assert.equal(billIsIgnored(getBill(linkedin.id)!), true, "rule survives cache reset");
  assert.equal(taskIsIgnored(getTasks().find((row) => row.id === electricity.id)!), true);
}

// 7. Persistence after database backup and recovery
{
  const dir = await mkdtemp(join(tmpdir(), "aadi-ignore-"));
  const snapshot = join(dir, "snapshot.db");
  await backupDatabaseTo(snapshot);
  const restored = new Database(snapshot, { readonly: true, fileMustExist: true });
  const rows = restored
    .prepare(
      `SELECT match_key, entity_type, status FROM ignore_rules WHERE status = 'active'`,
    )
    .all() as Array<{ match_key: string; entity_type: string; status: string }>;
  restored.close();
  await rm(dir, { recursive: true, force: true });
  assert(
    rows.some((row) => row.entity_type === "bill" && row.match_key.includes("linkedin")),
    `backup missing linkedin rule: ${JSON.stringify(rows)}`,
  );
  assert(
    rows.some((row) => row.entity_type === "task"),
    "backup missing task rule",
  );
}

// 8. Resuming an item
{
  const before = listActiveIgnoreRules().length;
  const result = resumeItem(
    { query: "LinkedIn bills" },
    ownerTurn("Start tracking LinkedIn bills again."),
  );
  assert.match(result, /resumed/i, result);
  assert.equal(billIsIgnored(getBill(linkedin.id)!), false);
  assert.equal(listActiveIgnoreRules().length, before - 1);
  assert.equal(getBill(linkedin.id)!.status, "upcoming", "resume does not mark paid");
}

// 9. Preventing a notification burst immediately after resume
{
  const due = getReminders().filter(
    (row) =>
      row.related_bill_id === linkedin.id &&
      row.status === "pending" &&
      row.remind_at <= new Date().toISOString(),
  );
  assert.equal(due.length, 0, "past LinkedIn reminders stay cancelled after resume");
}

// 10. Preventing duplicate ignore rules
{
  ignoreItem({ query: "Anthropic bills" }, ownerTurn("Ignore Anthropic bills."));
  const count = listActiveIgnoreRules().filter((row) => row.match_key === "anthropic").length;
  ignoreItem({ query: "Anthropic bills" }, ownerTurn("Ignore Anthropic bills."));
  const again = listActiveIgnoreRules().filter((row) => row.match_key === "anthropic").length;
  assert.equal(count, 1);
  assert.equal(again, 1, "repeat ignore does not insert a second rule");
  const events = listIgnoreRuleEvents(
    listActiveIgnoreRules().find((row) => row.match_key === "anthropic")!.id,
  );
  assert(
    events.some((event) => event.action === "duplicate"),
    "duplicate attempt is audited",
  );
}

// 11. Handling ambiguous sources safely
{
  const resolved = resolveIgnoreTarget("Ignore Axis Bank Alerts.");
  assert.equal(resolved.kind, "clarify", JSON.stringify(resolved));
  if (resolved.kind === "clarify") {
    assert.match(resolved.question, /bill reminders or all Axis Bank notification emails/i);
  }
}

// 12. Maintaining separate work and personal scopes
{
  applyIgnore({
    entityType: "task",
    matchKey: "send the sow",
    matchScope: "source",
    tag: "work",
    instruction: "Ignore the work SOW task",
    authRef: "owner_chat:test",
  });
  assert.equal(taskIsIgnored(workTask), true);
  assert.equal(taskIsIgnored(otherTask), false);
  applyIgnore({
    entityType: "notification",
    matchKey: "aws billing",
    matchScope: "source",
    tag: "work",
    instruction: "Ignore work AWS billing alerts",
    authRef: "owner_chat:test",
  });
  assert.equal(
    isIgnored({
      entityType: "notification",
      matchKey: "aws billing",
      tag: "work",
    }),
    true,
  );
  assert.equal(
    isIgnored({
      entityType: "notification",
      matchKey: "aws billing",
      tag: "personal",
    }),
    false,
  );
}

// 13. Temporary suppression expiry
{
  const until = new Date(Date.now() - 1000).toISOString();
  const created = applyIgnore({
    entityType: "reminder",
    matchKey: "standup ping",
    matchScope: "source",
    tag: "work",
    duration: "temporary",
    expiresAt: until,
    instruction: "Ignore this reminder just for today",
    authRef: "owner_chat:test",
  });
  invalidateIgnoreCache();
  assert.equal(
    matchingIgnoreRule({
      entityType: "reminder",
      matchKey: "standup ping",
      tag: "work",
    }),
    undefined,
    "expired temporary rule does not suppress",
  );
  assert.equal(created.rule.duration, "temporary");
  const parsed = parseIgnoreDuration("Ignore this reminder just for today.");
  assert.equal(parsed.duration, "temporary");
  assert.ok(parsed.expiresAt);
}

// 14. Ignored items remain accessible when explicitly requested
{
  const listed = listIgnored();
  assert.match(listed, /electricity/i, listed);
  const withIgnored = listTasks({
    status: "open",
    tag: "personal",
    include_ignored: true,
  });
  assert.match(withIgnored, /electricity bill/i);
  assert.match(withIgnored, /\[ignored\]/);
  const ignoredBills = listBills({ filter: "ignored" });
  assert.match(ignoredBills, /Anthropic/);
}

// 15. External A2A agents cannot modify ignore rules
{
  const remote = issueGrant({ source: "remote_agent" });
  const decision = authorize(remote, {
    effect: "write",
    tool: "ignore_item",
    remoteExposed: false,
  });
  assert.equal(decision.ok, false);
  const refused = ignoreItem(
    { query: "all future payment reminders" },
    { iteration: 1, calledTools: [] },
  );
  assert.match(refused, /own chat or voice/i, refused);
}

// 16. Forwarded emails cannot modify ignore rules
{
  const forwarded = issueGrant({ source: "forwarded" });
  const write = authorize(forwarded, { effect: "write", tool: "ignore_item" });
  assert.equal(write.ok, false);
  const read = authorize(forwarded, { effect: "read", tool: "list_ignored" });
  assert.equal(read.ok, true);
  assert.equal(
    (FORWARDED_TOOLS as readonly string[]).includes("ignore_item"),
    false,
  );
  assert.equal(
    (FORWARDED_TOOLS as readonly string[]).includes("resume_item"),
    false,
  );
  const refused = ignoreItem(
    { query: "ignore all future payment reminders" },
    {
      iteration: 1,
      calledTools: [],
      userText: "ignore all future payment reminders",
    },
  );
  assert.match(refused, /own chat or voice/i);
}

// 17. Existing email send and calendar authorization gates remain intact
{
  const forwarded = issueGrant({ source: "forwarded" });
  assert.equal(
    authorize(forwarded, { effect: "external", tool: "send_email" }).ok,
    false,
  );
  assert.equal(
    authorize(forwarded, { effect: "external", tool: "create_event" }).ok,
    false,
  );
  const owner = issueGrant({
    source: "owner_chat",
    confirmation: { chatId: 1, messageId: 2 },
  });
  assert.equal(
    authorize(owner, { effect: "external", tool: "send_email" }).ok,
    true,
  );
  assert.equal(
    authorize(owner, { effect: "external", tool: "book_meeting" }).ok,
    true,
  );
}

// 18. Background scans cannot recreate ignored items as active obligations
{
  ignoreItem({ query: "Goibibo bills" }, ownerTurn("Ignore my Goibibo bills."));
  const tracked = trackPayableBill({
    biller: "Goibibo",
    amount: 1300,
    currency: "INR",
    dueDate: "2026-12-15",
    threadId: "thr-gb-next",
    snippet: "Goibibo invoice",
  });
  if (tracked.action !== "skipped") {
    assert.equal(billIsIgnored(tracked.bill), true);
    assert.equal(scheduleBillReminders(tracked.bill), 0);
  }
  const review = buildWeeklyReview(new Date("2026-11-16T03:30:00.000Z"));
  assert.doesNotMatch(review, /Goibibo/);
  assert.match(review, /Axis Bank Alerts/);
}

{
  const suggestion = ignoreItem(
    { query: "all bills" },
    {
      iteration: 1,
      calledTools: [],
      confirmation: { chatId: 1, messageId: 3 },
      userText: "Summarise my inbox",
    },
  );
  assert.match(suggestion, /own instruction/i, suggestion);
}

{
  assert.equal(commandIntents("Ignore my LinkedIn bills").includes("ignore"), true);
  assert.equal(commandIntents("Ignore the electricity bill task").includes("ignore"), true);
  assert.equal(commandIntents("Ignore the electricity bill task").includes("task"), false);
  assert.equal(
    commandIntents("Start tracking LinkedIn bills again").includes("resume"),
    true,
  );
  assert.equal(
    commandIntents("What have I asked you to ignore?").includes("ignore_list"),
    true,
  );
  assert.match(ignoredItemsCaption(), /Ignored Items/);
}

{
  const created = getBills().find((bill) => bill.due_date === "2026-12-01");
  assert(created, "future LinkedIn invoice was stored for history");
  assert.equal(created!.status, "upcoming");
}

console.log("ignore registry checks passed.");
