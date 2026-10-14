import { bot } from "./bot.js";
import { startApprovalExpirySweep } from "./approvals.js";
import { registerBillScan } from "./bills.js";
import { registerMorningBrief } from "./brief.js";
import { registerFollowupScan } from "./followups.js";
import { registerImportantDateReminders } from "./important_dates.js";
import { registerWeeklyReview } from "./weekly.js";
import { startDocumentExpirySweep } from "./documents.js";
import { registerReminderScheduler } from "./reminders.js";
import { logGoogleAccounts } from "./google/auth.js";
import { registerMeetingScan } from "./meetings.js";
import { registerWeeklyBackup } from "./backup.js";

const morningBriefTask = registerMorningBrief(bot.api);
const billScanTask = registerBillScan(bot.api);
const importantDateTask = registerImportantDateReminders(bot.api);
const weeklyReviewTask = registerWeeklyReview(bot.api);
const followupScanTask = registerFollowupScan();
const approvalExpirySweep = startApprovalExpirySweep();
const reminderScheduler = await registerReminderScheduler(bot.api);
const documentExpirySweep = startDocumentExpirySweep();
const meetingScanTask = registerMeetingScan(bot.api);
const weeklyBackupTask = registerWeeklyBackup(bot.api);
const MENU_COMMANDS = [
  { command: "followups", description: "Scan and list emails waiting on a reply" },
  { command: "reset", description: "Clear conversation history" },
] as const;

const COMMAND_SCOPES = [
  { type: "default" },
  { type: "all_private_chats" },
  { type: "all_group_chats" },
  { type: "all_chat_administrators" },
] as const;

async function replaceBotCommandMenu(): Promise<void> {
  for (const scope of COMMAND_SCOPES) {
    await bot.api.deleteMyCommands({ scope });
  }
  await bot.api.setMyCommands(MENU_COMMANDS);
}

await logGoogleAccounts();
bot.start({
  onStart: async () => {
    await replaceBotCommandMenu();
    console.log(
      `Telegram / menu: ${MENU_COMMANDS.map((item) => `/${item.command}`).join(", ")}`,
    );
    console.log("Aadi is running with Telegram long polling.");
  },
});

process.once("SIGINT", () => {
  morningBriefTask.stop();
  billScanTask.stop();
  importantDateTask.stop();
  weeklyReviewTask.stop();
  followupScanTask.stop();
  meetingScanTask.stop();
  weeklyBackupTask.stop();
  clearInterval(approvalExpirySweep);
  clearInterval(reminderScheduler);
  clearInterval(documentExpirySweep);
  bot.stop();
});
process.once("SIGTERM", () => {
  morningBriefTask.stop();
  billScanTask.stop();
  importantDateTask.stop();
  weeklyReviewTask.stop();
  followupScanTask.stop();
  meetingScanTask.stop();
  weeklyBackupTask.stop();
  clearInterval(approvalExpirySweep);
  clearInterval(reminderScheduler);
  clearInterval(documentExpirySweep);
  bot.stop();
});
