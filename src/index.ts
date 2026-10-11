import { bot } from "./bot.js";
import { startApprovalExpirySweep } from "./approvals.js";
import { registerMorningBrief } from "./brief.js";

const morningBriefTask = registerMorningBrief(bot.api);
const approvalExpirySweep = startApprovalExpirySweep();
bot.start({
  onStart: () => {
    console.log("Aadi is running with Telegram long polling.");
  },
});

process.once("SIGINT", () => {
  morningBriefTask.stop();
  clearInterval(approvalExpirySweep);
  bot.stop();
});
process.once("SIGTERM", () => {
  morningBriefTask.stop();
  clearInterval(approvalExpirySweep);
  bot.stop();
});
