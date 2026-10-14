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

const morningBriefTask = registerMorningBrief(bot.api);
const billScanTask = registerBillScan(bot.api);
const importantDateTask = registerImportantDateReminders(bot.api);
const weeklyReviewTask = registerWeeklyReview(bot.api);
const followupScanTask = registerFollowupScan();
const approvalExpirySweep = startApprovalExpirySweep();
const reminderScheduler = await registerReminderScheduler(bot.api);
const documentExpirySweep = startDocumentExpirySweep();
await logGoogleAccounts();
bot.start({
  onStart: async () => {
    await bot.api.setMyCommands([
      { command: "menu", description: "Buttons for model, brief, waiting, bills, tasks" },
      { command: "brief", description: "Send today's morning brief" },
      { command: "weekly", description: "Send the weekly review" },
      { command: "followups", description: "Scan and list emails waiting on a reply" },
      { command: "model", description: "Switch between Claude and cloud Gemma" },
      { command: "wrapup", description: "Save call or meeting notes" },
      { command: "reset", description: "Clear conversation history" },
      { command: "start", description: "Say hello" },
    ]);
    console.log("Aadi is running with Telegram long polling.");
  },
});

process.once("SIGINT", () => {
  morningBriefTask.stop();
  billScanTask.stop();
  importantDateTask.stop();
  weeklyReviewTask.stop();
  followupScanTask.stop();
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
  clearInterval(approvalExpirySweep);
  clearInterval(reminderScheduler);
  clearInterval(documentExpirySweep);
  bot.stop();
});
