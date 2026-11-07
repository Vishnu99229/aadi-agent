import { bot } from "./bot.js";
import { installOutboundHistory } from "./outbound.js";
import {
  setAfterDraftSend,
  setDraftRefresher,
  startApprovalExpirySweep,
} from "./approvals.js";
import { registerBillScan } from "./bills.js";
import { registerMorningBrief } from "./brief.js";
import { sendOverdueFollowupNudge } from "./followup_panel.js";
import { registerFollowupScan } from "./followups.js";
import { registerImportantDateReminders } from "./important_dates.js";
import { registerPromiseScan } from "./promises.js";
import { registerWeeklyReview } from "./weekly.js";
import { startDocumentExpirySweep } from "./documents.js";
import { registerReminderScheduler } from "./reminders.js";
import { logGoogleAccounts } from "./google/auth.js";
import { registerMeetingScan } from "./meetings.js";
import { registerWeeklyBackup } from "./backup.js";
import { registerAttachmentAlertScan } from "./attachment_alerts.js";
import {
  applyPendingDeployResult,
  registerBuildPoll,
} from "./builds.js";
import { writeHeartbeat } from "./heartbeat.js";
import {
  onMeetingDraftSent,
  registerMeetingBookingJobs,
} from "./meeting_book.js";
import { registerShadowJobs } from "./shadow_inbox.js";
import { registerSequenceDetection } from "./sequences.js";
import { registerScheduledSends } from "./scheduled_sends.js";
import { refreshSequenceDraftSlots, registerSequenceSend } from "./sequence_runner.js";
import { registerMessageEmbed } from "./embeddings.js";
import { registerJobWorker } from "./job_worker.js";

installOutboundHistory(bot.api);
const morningBriefTask = registerMorningBrief(bot.api);
const billScanTask = registerBillScan(bot.api);
const importantDateTask = registerImportantDateReminders(bot.api);
const weeklyReviewTask = registerWeeklyReview(bot.api);
const followupScanTask = registerFollowupScan(
  sendOverdueFollowupNudge,
  bot.api,
);
const promiseScanTask = registerPromiseScan(bot.api);
const approvalExpirySweep = startApprovalExpirySweep();
const reminderScheduler = await registerReminderScheduler(bot.api);
const documentExpirySweep = startDocumentExpirySweep();
const meetingScanTask = registerMeetingScan(bot.api);
const weeklyBackupTask = registerWeeklyBackup(bot.api);
const attachmentAlertTask = registerAttachmentAlertScan(bot.api);
const meetingBookingJobs = registerMeetingBookingJobs(bot.api);
const shadowJobs = registerShadowJobs(bot.api);
const sequenceDetectTask = registerSequenceDetection(bot.api);
const sequenceSendTask = registerSequenceSend(bot.api);
const scheduledSendTask = registerScheduledSends();
setDraftRefresher(refreshSequenceDraftSlots);
setAfterDraftSend(onMeetingDraftSent);
const buildPollTask = registerBuildPoll();
const jobQueueTask = registerJobWorker(bot.api);
const messageEmbedTask = registerMessageEmbed();
await applyPendingDeployResult();
const MENU_COMMANDS = [
  { command: "followups", description: "Scan and list emails waiting on a reply" },
  { command: "model", description: "Choose which model handles each task" },
  { command: "build", description: "Ask a Cursor agent to change Aadi's code" },
  { command: "builds", description: "List recent code builds" },
  { command: "health", description: "Show scheduled job last-run times" },
  { command: "memory", description: "List saved memories and forget any" },
  { command: "meetings", description: "List auto-handled meeting threads" },
  { command: "sequence", description: "Offer a follow-up sequence for a prospect" },
  { command: "sequences", description: "List active follow-up sequences, with Stop buttons" },
  { command: "reset", description: "Clear conversation history" },
  { command: "jobs", description: "List running and recent big jobs" },
  { command: "voice", description: "Turn spoken replies to voice notes on or off" },
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
    writeHeartbeat();
  },
});

process.once("SIGINT", () => {
  morningBriefTask.stop();
  billScanTask.stop();
  importantDateTask.stop();
  weeklyReviewTask.stop();
  followupScanTask.stop();
  promiseScanTask.stop();
  meetingScanTask.stop();
  weeklyBackupTask.stop();
  attachmentAlertTask.stop();
  meetingBookingJobs.inbox.stop();
  meetingBookingJobs.poll.stop();
  meetingBookingJobs.pending.stop();
  shadowJobs.evening.stop();
  sequenceDetectTask?.stop();
  sequenceSendTask?.stop();
  scheduledSendTask?.stop();
  clearInterval(shadowJobs.expiry);
  buildPollTask.stop();
  jobQueueTask.stop();
  messageEmbedTask.stop();
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
  promiseScanTask.stop();
  meetingScanTask.stop();
  weeklyBackupTask.stop();
  attachmentAlertTask.stop();
  meetingBookingJobs.inbox.stop();
  meetingBookingJobs.poll.stop();
  meetingBookingJobs.pending.stop();
  shadowJobs.evening.stop();
  sequenceDetectTask?.stop();
  sequenceSendTask?.stop();
  scheduledSendTask?.stop();
  clearInterval(shadowJobs.expiry);
  buildPollTask.stop();
  jobQueueTask.stop();
  messageEmbedTask.stop();
  clearInterval(approvalExpirySweep);
  clearInterval(reminderScheduler);
  clearInterval(documentExpirySweep);
  bot.stop();
});
