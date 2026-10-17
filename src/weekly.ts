import type { Api } from "grammy";
import cron, { type ScheduledTask } from "node-cron";
import { wrapClockJob } from "./scheduler.js";
import { config } from "./config.js";
import { getTasks } from "./db.js";
import { billsForBrief } from "./bills.js";
import { importantDatesForBrief } from "./important_dates.js";

const TIME_ZONE = "Asia/Kolkata";
const TELEGRAM_MESSAGE_LIMIT = 4000;

function dateInKolkata(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function weekStartIso(now: Date): string {
  const date = new Date(now);
  const day = date.getDay();
  const diff = day === 0 ? 6 : day - 1;
  date.setDate(date.getDate() - diff);
  date.setHours(0, 0, 0, 0);
  return date.toISOString();
}

export function buildWeeklyReview(now = new Date()): string {
  const today = dateInKolkata(now);
  const weekStart = weekStartIso(now);
  const completed = getTasks().filter(
    (task) =>
      task.status === "done" &&
      task.tag === "personal" &&
      task.created_at >= weekStart,
  );
  const openPersonal = getTasks().filter(
    (task) => task.status === "open" && task.tag === "personal",
  );
  const { upcoming, overdue } = billsForBrief(today);
  const dates = importantDatesForBrief(today);

  const lines = [
    "Weekly personal review",
    "",
    `Tasks completed this week: ${completed.length}`,
    ...completed.slice(0, 10).map((task) => `• ${task.text}`),
    "",
    `Personal tasks still open: ${openPersonal.length}`,
    ...openPersonal.slice(0, 10).map((task) => `• ${task.text}`),
    "",
    "Bills due in the next 7 days:",
    ...(upcoming.length
      ? upcoming.map(
          (bill) =>
            `• ${bill.biller} — ${bill.currency} ${bill.amount ?? "?"} — ${bill.due_date}`,
        )
      : ["• None"]),
    ...(overdue.length
      ? ["", "Overdue bills:", ...overdue.map((bill) => `• ${bill.biller}`)]
      : []),
    "",
    "Important dates in the next 7 days:",
    ...(dates.length
      ? dates.map(
          (record) =>
            `• ${record.month_day} — ${record.person} (${record.type})`,
        )
      : ["• None"]),
  ];
  return lines.join("\n");
}

async function sendLongMessage(api: Api, text: string): Promise<void> {
  const characters = Array.from(text);
  for (
    let offset = 0;
    offset < characters.length;
    offset += TELEGRAM_MESSAGE_LIMIT
  ) {
    await api.sendMessage(
      config.ownerTelegramId,
      characters.slice(offset, offset + TELEGRAM_MESSAGE_LIMIT).join(""),
    );
  }
}

export async function sendWeeklyReview(api: Api): Promise<void> {
  const review = buildWeeklyReview();
  await sendLongMessage(api, review);
}

export function registerWeeklyReview(api: Api): ScheduledTask {
  const expression = `${config.weeklyReviewMinute} ${config.weeklyReviewHour} * * 0`;
  const task = cron.schedule(
    expression,
    wrapClockJob(
      "weekly-review",
      config.weeklyReviewHour,
      config.weeklyReviewMinute,
      () => sendWeeklyReview(api),
      [0],
    ),
    { name: "aadi-weekly-review", timezone: TIME_ZONE, noOverlap: true },
  );
  console.log(
    `Weekly review scheduled Sundays at ${config.weeklyReviewTime} ${TIME_ZONE}.`,
  );
  return task;
}
