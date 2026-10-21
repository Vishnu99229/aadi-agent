import "dotenv/config";

function ensureTestEnv(): void {
  process.env.LLM_PROVIDER ??= "claude";
  process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
  process.env.OWNER_TELEGRAM_ID ??= "1";
  process.env.CLAUDE_MODEL ??= "claude-haiku-4-5";
  process.env.ANTHROPIC_API_KEY ??= "test-key";
  process.env.BRIEF_TIME ??= "08:00";
}

ensureTestEnv();

const { parseBillClassifications } = await import("../src/bills.ts");
const {
  createBill,
  createImportantDate,
  getBill,
  getImportantDate,
} = await import("../src/db.ts");
const { importantDatesForBrief } = await import("../src/important_dates.ts");
const { stripSensitive } = await import("../src/sensitive.ts");
const { handler: addDate } = await import("../src/tools/add_date.ts");
const { handler: listDates } = await import("../src/tools/list_dates.ts");
const { handler: listUpcomingDates } = await import(
  "../src/tools/list_upcoming_dates.ts"
);
const { handler: removeDate } = await import("../src/tools/remove_date.ts");
const { handler: listBills } = await import("../src/tools/list_bills.ts");
const { handler: markBillPaid } = await import("../src/tools/mark_bill_paid.ts");
const { buildWeeklyReview } = await import("../src/weekly.ts");
const { runTrackedJob, SoftJobError } = await import("../src/scheduler.ts");
const { getJobRun } = await import("../src/db.ts");

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function testStripSensitive(): void {
  const raw =
    "Card 4111 1111 1111 1111 due soon. Account No: 123456789012";
  const cleaned = stripSensitive(raw);
  assert(!cleaned.includes("4111"), "card digits redacted");
  assert(cleaned.includes("[REDACTED]"), "redaction marker present");
}

function testBillClassificationParse(): void {
  const sample = `Here is the result:
[
  {"candidate_id": 1, "is_bill": true, "biller": "Airtel", "amount": 599, "currency": "INR", "due_date": "2026-10-20"},
  {"candidate_id": 2, "is_bill": false, "biller": "", "amount": null, "currency": "INR", "due_date": "2026-10-01"}
]`;
  const parsed = parseBillClassifications(sample, 2);
  assert(parsed[0]?.biller === "Airtel", "first bill parsed");
  assert(parsed[1]?.is_bill === false, "non-bill skipped");
}

function testBillClassificationFencedPartial(): void {
  const fenced =
    '```json\n[\n  {"candidate_id":2,"is_bill":false,"biller":"Zerodha","amount":null,"currency":"INR","due_date":"2026-10-31"},\n  {"candidate_id":13,"is_bill":true,"biller":"YouTube Premium","amount":null,"currency":"INR","due_date":"2026-11-20"},\n  {"candidate_id":13,"is_bill":true,"biller":"Dup","amount":null,"currency":"INR","due_date":"2026-11-20"},\n  {"candidate_id":99,"is_bill":true,"biller":"Out of range","amount":null,"currency":"INR","due_date":"2026-11-20"}\n]\n```';
  const parsed = parseBillClassifications(fenced, 23);
  assert(parsed.length === 2, "partial fenced output keeps valid rows only");
  assert(parsed[1]?.biller === "YouTube Premium", "first of duplicate ids kept");
  let threw = false;
  try {
    parseBillClassifications("Sorry, I cannot help with that.", 3);
  } catch (error) {
    threw = error instanceof SoftJobError;
  }
  assert(threw, "no JSON array throws a soft job error");
}

async function testSoftJobFailure(): Promise<void> {
  const name = `test-soft-${Date.now()}`;
  await runTrackedJob(name, async () => {
    throw new SoftJobError("classifier output unusable");
  });
  const row = getJobRun(name);
  assert(row?.last_status === "soft_error", "soft failure recorded as soft_error");
  assert(row?.last_success_at === null, "soft failure is not a success");
}

function testBillDedupeAndTools(): void {
  const uniqueDay = `2099-01-${String(Date.now() % 28 + 1).padStart(2, "0")}`;
  const first = createBill("Test ISP", 999, "INR", uniqueDay, "thread-a");
  const dup = createBill("Test ISP", 999, "INR", uniqueDay, "thread-b");
  assert(first !== undefined, "bill created");
  assert(dup === undefined, "duplicate bill rejected");
  const listed = JSON.parse(listBills({ filter: "upcoming" })) as {
    id: number;
  }[];
  assert(
    listed.some((row) => row.id === first!.id),
    "list_bills upcoming includes bill",
  );
  const paid = JSON.parse(markBillPaid({ id: first!.id })) as {
    status: string;
  };
  assert(paid.status === "paid", "mark_bill_paid works");
  assert(getBill(first!.id)?.status === "paid", "status persisted");
}

function testImportantDates(): void {
  const record = createImportantDate(
    "Test Person",
    "friend",
    "12-25",
    null,
    "birthday",
    "",
  );
  const viaTool = JSON.parse(
    addDate({
      person: "Amma",
      month_day: "03-14",
      type: "birthday",
      relation: "mother",
    }),
  ) as { person: string; id: number };
  assert(viaTool.person === "Amma", "add_date tool");
  const listed = listDates({ query: "Amma" });
  assert(listed.includes("Amma"), "list_dates finds a March birthday");
  assert(listed.includes("03-14"), "list_dates shows 14 March");
  const upcoming = listUpcomingDates({});
  assert(
    !upcoming.includes(`#${viaTool.id} `),
    "list_upcoming_dates does not hide behind being the only way to find March dates",
  );
  const brief = importantDatesForBrief("2026-12-23");
  assert(
    brief.some((row) => row.id === record.id),
    "date within 7 days from Dec 23 includes Dec 25",
  );
  const removed = JSON.parse(
    removeDate({ query: "Amma's birthday" }),
  ) as { removed: boolean; id: number };
  assert(removed.removed === true, "forget Amma's birthday removes it");
  assert(
    getImportantDate(viaTool.id) === undefined,
    "Amma birthday row is gone",
  );
}

function testWeeklyReview(): void {
  const text = buildWeeklyReview(new Date("2026-10-11T12:00:00+05:30"));
  assert(text.includes("Weekly personal review"), "weekly header");
  assert(text.includes("Bills due"), "bills section");
}

testStripSensitive();
testBillClassificationParse();
testBillClassificationFencedPartial();
await testSoftJobFailure();
testBillDedupeAndTools();
testImportantDates();
testWeeklyReview();
console.log("Stage 6 checks passed.");
