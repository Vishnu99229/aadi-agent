import { InlineKeyboard, type Api, type Context } from "grammy";
import { getTaskBackend } from "./chat_backend.js";
import { everyClock, type IntervalJob } from "./scheduler.js";
import { config } from "./config.js";
import { complete } from "./llm.js";
import {
  getImportantDate,
  getImportantDates,
  type ImportantDateRecord,
} from "./db.js";

const TIME_ZONE = "Asia/Kolkata";
const REMINDER_HOUR = 9;

function todayParts(now: Date): { ymd: string; monthDay: string } {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const monthDay = ymd.slice(5);
  return { ymd, monthDay };
}

function addDaysMonthDay(monthDay: string, days: number, year: number): string {
  const [month, day] = monthDay.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${values.month}-${values.day}`;
}

function matchesReminderDay(
  record: ImportantDateRecord,
  targetMonthDay: string,
): boolean {
  return record.month_day === targetMonthDay;
}

function labelFor(record: ImportantDateRecord): string {
  const typeLabel =
    record.type === "birthday"
      ? "Birthday"
      : record.type === "anniversary"
        ? "Anniversary"
        : "Date";
  return `${typeLabel}: ${record.person}${record.relation ? ` (${record.relation})` : ""}`;
}

function addDaysYmd(ymd: string, days: number): string {
  const date = new Date(`${ymd}T12:00:00+05:30`);
  date.setDate(date.getDate() + days);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function importantDatesForBrief(
  todayYmd: string,
  days = 7,
): ImportantDateRecord[] {
  const window = Math.max(1, Math.min(366, Math.floor(days)));
  const targetDays = new Set<string>();
  for (let offset = 0; offset < window; offset += 1) {
    targetDays.add(addDaysYmd(todayYmd, offset).slice(5));
  }
  return getImportantDates().filter((record) =>
    targetDays.has(record.month_day),
  );
}

async function sendDateReminder(
  api: Api,
  record: ImportantDateRecord,
  daysUntil: number,
): Promise<void> {
  const when =
    daysUntil === 0
      ? "Today"
      : daysUntil === 3
        ? "In 3 days"
        : `In ${daysUntil} days`;
  const keyboard =
    daysUntil === 0 &&
    (record.type === "birthday" || record.type === "anniversary")
      ? new InlineKeyboard().text("Draft a wish", `date:wish:${record.id}`)
      : undefined;
  await api.sendMessage(
    config.ownerTelegramId,
    `${when}\n${labelFor(record)}${record.note ? `\n${record.note}` : ""}`,
    keyboard ? { reply_markup: keyboard } : undefined,
  );
  console.log(`Important date ${record.id}: reminder sent`);
}

export async function runImportantDateReminders(api: Api): Promise<void> {
  const now = new Date();
  const { ymd, monthDay } = todayParts(now);
  const year = Number(ymd.slice(0, 4));
  const threeDays = addDaysMonthDay(monthDay, 3, year);

  for (const record of getImportantDates()) {
    if (
      (record.type === "birthday" || record.type === "anniversary") &&
      matchesReminderDay(record, threeDays)
    ) {
      await sendDateReminder(api, record, 3);
    }
    if (matchesReminderDay(record, monthDay)) {
      await sendDateReminder(api, record, 0);
    }
  }
}

export async function draftWishMessage(
  record: ImportantDateRecord,
): Promise<string> {
  const response = await complete({
    backend: getTaskBackend("meetings"),
    effort: "low",
    cacheTtl: "5m",
    task: "other",
    maxTokens: 300,
    tools: [],
    system: {
      cacheable:
        "Write a short, warm wish Vishnu can copy into WhatsApp. Plain text, 2-3 sentences. Do not claim to send it.",
    },
    messages: [
      {
        role: "user",
        content: `${record.type === "anniversary" ? "Anniversary" : "Birthday"} wish for ${record.person}.`,
      },
    ],
  });
  const text = response.textParts.join("\n").trim();
  console.log(
    `Important date ${record.id}: wish draft tokens input=${response.usage.inputTokens} output=${response.usage.outputTokens}`,
  );
  return text || "Happy birthday!";
}

export async function handleDateWishCallback(
  ctx: Context,
  dateId: number,
): Promise<void> {
  await ctx.answerCallbackQuery();
  const record = getImportantDate(dateId);
  if (!record) {
    await ctx.reply("That date was not found.");
    return;
  }
  const wish = await draftWishMessage(record);
  await ctx.reply(`Copy this wish:\n\n${wish}`);
}

export function registerImportantDateReminders(api: Api): IntervalJob {
  const task = everyClock(
    "important-dates",
    REMINDER_HOUR,
    0,
    () => runImportantDateReminders(api),
    { kind: "daily" },
  );
  console.log(
    `Important date reminders scheduled daily at ${REMINDER_HOUR}:00 ${TIME_ZONE}.`,
  );
  return task;
}
