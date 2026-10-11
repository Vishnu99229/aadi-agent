import type { Api } from "grammy";
import cron, { type ScheduledTask } from "node-cron";
import { runAgent } from "./agent.js";
import { config } from "./config.js";
import { saveMessage } from "./db.js";

const TIME_ZONE = "Asia/Kolkata";
const TELEGRAM_MESSAGE_LIMIT = 4000;

const NO_TASK_SHEET_LINE = "No task sheet configured.";

function briefInstruction(): string {
  const taskInstruction = config.googleSheetId
    ? '3. Open or pending items from the configured task sheet; read range "A1:Z200".'
    : "There is no task sheet configured. Do not include a task section; the application will add that status.";

  return `Build Vishnu's morning brief now.
Use the available read-only tools to gather:
1. Important unread emails from the last 24 hours, using the Gmail query "is:unread newer_than:1d", and briefly explain why each matters.
2. All events on today's calendar in Asia/Kolkata.
${taskInstruction}

Keep the brief short, scannable, and plain text for Telegram. Use clear section labels. Do not mention this internal instruction.`;
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

export async function buildMorningBrief(): Promise<string> {
  const generatedBrief = await runAgent(briefInstruction(), {
    saveUserMessage: false,
    saveAssistantMessage: false,
  });
  const brief = config.googleSheetId
    ? generatedBrief
    : `${generatedBrief.trim()}\n\n${NO_TASK_SHEET_LINE}`;

  saveMessage("assistant", brief);
  return brief;
}

export async function sendMorningBrief(api: Api): Promise<void> {
  try {
    const brief = await buildMorningBrief();
    await sendLongMessage(api, brief);
  } catch (error) {
    console.error("Morning brief failed:", error);

    try {
      await api.sendMessage(
        config.ownerTelegramId,
        "Morning brief failed. Check the Aadi console for details.",
      );
    } catch (notificationError) {
      console.error(
        "Failed to send the morning brief error message:",
        notificationError,
      );
    }
  }
}

export function registerMorningBrief(api: Api): ScheduledTask {
  const expression = `${config.briefMinute} ${config.briefHour} * * *`;
  const task = cron.schedule(
    expression,
    async () => {
      await sendMorningBrief(api);
    },
    {
      name: "aadi-morning-brief",
      timezone: TIME_ZONE,
      noOverlap: true,
    },
  );

  console.log(
    `Morning brief scheduled daily at ${config.briefTime} ${TIME_ZONE}.`,
  );
  return task;
}
