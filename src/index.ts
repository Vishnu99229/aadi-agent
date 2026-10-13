import { bot } from "./bot.js";
import { startApprovalExpirySweep } from "./approvals.js";
import { registerBillScan } from "./bills.js";
import { registerMorningBrief } from "./brief.js";
import { registerFollowupScan } from "./followups.js";
import { registerImportantDateReminders } from "./important_dates.js";
import { registerWeeklyReview } from "./weekly.js";
import { startDocumentExpirySweep } from "./documents.js";
import { registerReminderScheduler } from "./reminders.js";

const morningBriefTask = registerMorningBrief(bot.api);
const billScanTask = registerBillScan(bot.api);
const importantDateTask = registerImportantDateReminders(bot.api);
const weeklyReviewTask = registerWeeklyReview(bot.api);
const followupScanTask = registerFollowupScan();
const approvalExpirySweep = startApprovalExpirySweep();
const reminderScheduler = await registerReminderScheduler(bot.api);
const documentExpirySweep = startDocumentExpirySweep();
bot.start({
  onStart: () => {
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
