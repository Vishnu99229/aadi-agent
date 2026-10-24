import { InlineKeyboard, type Api, type Context } from "grammy";
import { config } from "./config.js";
import {
  cancelPendingRemindersForBill,
  cancelPendingRemindersForTask,
  createReminder,
  getDueReminders,
  getReminder,
  markTaskDone,
  transitionBillStatus,
  transitionReminderStatus,
  type ReminderRecord,
} from "./db.js";

const TIME_ZONE = "Asia/Kolkata";
const ONE_DAY_MS = 24 * 60 * 60 * 1_000;
const handledButtons = new Set<number>();
const activeButtons = new Set<number>();
const missedAtStartup = new Set<number>();
let processingDueReminders = false;

function reminderKeyboard(id: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("Done", `reminder:done:${id}`)
    .text("Snooze 1h", `reminder:snooze:${id}`)
    .text("Tomorrow 9am", `reminder:tomorrow:${id}`);
}

function formatKolkataDateTime(date: Date): string {
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: TIME_ZONE,
  }).format(date);
}

function kolkataWeekday(date: Date): number {
  const name = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    timeZone: TIME_ZONE,
  }).format(date);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
}

function nextOccurrence(
  reminder: ReminderRecord,
  now: Date,
): string | undefined {
  if (reminder.recurrence === "none") {
    return undefined;
  }

  let candidate = new Date(reminder.remind_at);
  const increment =
    reminder.recurrence === "weekly" ? 7 * ONE_DAY_MS : ONE_DAY_MS;

  do {
    candidate = new Date(candidate.getTime() + increment);
  } while (
    candidate.getTime() <= now.getTime() ||
    (reminder.recurrence === "weekdays" &&
      (kolkataWeekday(candidate) === 0 || kolkataWeekday(candidate) === 6))
  );

  return candidate.toISOString();
}

function tomorrowAtNineInKolkata(now: Date): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    timeZone: TIME_ZONE,
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((value) => value.type === type)?.value);

  // Asia/Kolkata is UTC+05:30, so 09:00 there is 03:30 UTC.
  return new Date(
    Date.UTC(part("year"), part("month") - 1, part("day") + 1, 3, 30),
  );
}

function shortReminderText(text: string): string {
  const characters = Array.from(text);
  return characters.length <= 3_500
    ? text
    : `${characters.slice(0, 3_499).join("")}…`;
}

async function deliverReminder(
  api: Api,
  reminder: ReminderRecord,
  missedWhileOffline: boolean,
): Promise<void> {
  const heading = missedWhileOffline
    ? "⏰ Reminder (missed while offline)"
    : "⏰ Reminder";
  const message = `${heading}\n\n${shortReminderText(reminder.text)}\n\n${formatKolkataDateTime(
    new Date(reminder.remind_at),
  )} (${reminder.tag})`;

  await api.sendMessage(config.ownerTelegramId, message, {
    reply_markup: reminderKeyboard(reminder.id),
  });

  if (!transitionReminderStatus(reminder.id, "pending", "sent")) {
    console.warn(
      `Reminder ${reminder.id}: delivered, but status was no longer pending`,
    );
    return;
  }
  console.log(`Reminder ${reminder.id}: status -> sent`);

  const nextAt = nextOccurrence(reminder, new Date());
  if (nextAt) {
    const next = createReminder(
      reminder.text,
      reminder.tag,
      nextAt,
      reminder.recurrence,
    );
    console.log(`Reminder ${next.id}: recurring occurrence -> pending`);
  }
}

async function processDue(
  api: Api,
): Promise<void> {
  if (processingDueReminders) {
    return;
  }
  processingDueReminders = true;

  try {
    const reminders = getDueReminders(new Date().toISOString());
    for (const reminder of reminders) {
      try {
        await deliverReminder(api, reminder, missedAtStartup.has(reminder.id));
        missedAtStartup.delete(reminder.id);
      } catch (error) {
        const errorType = error instanceof Error ? error.name : "UnknownError";
        console.error(
          `Reminder ${reminder.id}: delivery failed (${errorType}); status remains pending`,
        );
      }
    }
  } finally {
    processingDueReminders = false;
  }
}

export async function registerReminderScheduler(
  api: Api,
): Promise<NodeJS.Timeout> {
  for (const reminder of getDueReminders(new Date().toISOString())) {
    missedAtStartup.add(reminder.id);
  }
  await processDue(api);
  const interval = setInterval(() => {
    void processDue(api);
  }, 60_000);
  console.log(`Reminder scheduler registered (every minute, ${TIME_ZONE}).`);
  return interval;
}

function callbackMessageText(ctx: Context): string {
  const text = ctx.callbackQuery?.message?.text;
  return typeof text === "string" ? text : "⏰ Reminder";
}

async function editHandledMessage(
  ctx: Context,
  statusLine: string,
): Promise<void> {
  await ctx.editMessageText(`${callbackMessageText(ctx)}\n\n${statusLine}`, {
    reply_markup: { inline_keyboard: [] },
  });
}

export async function handleReminderCallback(
  ctx: Context,
  operation: "done" | "snooze" | "tomorrow",
  reminderId: number,
): Promise<void> {
  if (activeButtons.has(reminderId)) {
    await ctx.answerCallbackQuery("Already processing.");
    return;
  }
  if (handledButtons.has(reminderId)) {
    await ctx.answerCallbackQuery("This reminder was already handled.");
    return;
  }

  const reminder = getReminder(reminderId);
  if (!reminder || reminder.status !== "sent") {
    await ctx.answerCallbackQuery("This reminder is no longer available.");
    return;
  }

  activeButtons.add(reminderId);
  try {
    await ctx.answerCallbackQuery();

    if (operation === "done") {
      // If this reminder is tied to a promise/task, close the task and
      // cancel any sibling reminders (e.g. a promise's T-24h and morning-of).
      if (reminder.related_task_id !== null) {
        const taskClosed = markTaskDone(reminder.related_task_id);
        const siblings = cancelPendingRemindersForTask(
          reminder.related_task_id,
        );
        console.log(
          `Reminder ${reminderId}: linked task ${reminder.related_task_id} ` +
            `closed=${taskClosed} siblings_cancelled=${siblings}`,
        );
      }
      // Same for bills: mark the linked bill paid and cancel the T-3d /
      // T-1d / due-day sibling reminders.
      if (reminder.related_bill_id !== null) {
        const billPaid = transitionBillStatus(
          reminder.related_bill_id,
          "upcoming",
          "paid",
        );
        const siblings = cancelPendingRemindersForBill(
          reminder.related_bill_id,
        );
        console.log(
          `Reminder ${reminderId}: linked bill ${reminder.related_bill_id} ` +
            `paid=${billPaid} siblings_cancelled=${siblings}`,
        );
      }
      await editHandledMessage(ctx, "Done");
      handledButtons.add(reminderId);
      console.log(`Reminder ${reminderId}: button -> done`);
      return;
    }

    const remindAt =
      operation === "snooze"
        ? new Date(Date.now() + 60 * 60 * 1_000)
        : tomorrowAtNineInKolkata(new Date());
    const next = createReminder(
      reminder.text,
      reminder.tag,
      remindAt.toISOString(),
      "none",
    );
    const statusLine =
      operation === "snooze"
        ? `Snoozed until ${formatKolkataDateTime(remindAt)}`
        : `Rescheduled for ${formatKolkataDateTime(remindAt)}`;

    await editHandledMessage(ctx, statusLine);
    handledButtons.add(reminderId);
    console.log(
      `Reminder ${reminderId}: button -> ${operation}; reminder ${next.id}: status -> pending`,
    );
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(
      `Reminder ${reminderId}: button ${operation} failed (${errorType})`,
    );
    try {
      await ctx.answerCallbackQuery("Something broke. Please try again.");
    } catch {
      // The first callback acknowledgement may already have succeeded.
    }
  } finally {
    activeButtons.delete(reminderId);
  }
}
