import { bot } from "./bot.js";
import { startApprovalExpirySweep } from "./approvals.js";
import { registerMorningBrief } from "./brief.js";
import { registerFollowupScan } from "./followups.js";
import { registerReminderScheduler } from "./reminders.js";

const morningBriefTask = registerMorningBrief(bot.api);
const followupScanTask = registerFollowupScan();
const approvalExpirySweep = startApprovalExpirySweep();
const reminderScheduler = await registerReminderScheduler(bot.api);
bot.start({
  onStart: () => {
    console.log("Aadi is running with Telegram long polling.");
  },
});

process.once("SIGINT", () => {
  morningBriefTask.stop();
  followupScanTask.stop();
  clearInterval(approvalExpirySweep);
  clearInterval(reminderScheduler);
  bot.stop();
});
process.once("SIGTERM", () => {
  morningBriefTask.stop();
  followupScanTask.stop();
  clearInterval(approvalExpirySweep);
  clearInterval(reminderScheduler);
  bot.stop();
});
