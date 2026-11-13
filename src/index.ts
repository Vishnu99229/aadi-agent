import { bot, refreshReplyKeyboardOnce } from "./bot.js";
import { installOutboundHistory } from "./outbound.js";
import { setAfterDraftSend } from "./approvals.js";
import { recoveryTick } from "./agents/engine.js";
import { localSpecialists } from "./agents/index.js";
import { setLateNotifier } from "./agents/orchestrator.js";
import type { Stoppable } from "./agents/specialist.js";
import { logGoogleAccounts } from "./google/auth.js";
import { registerWeeklyBackup } from "./backup.js";
import { applyPendingDeployResult } from "./builds.js";
import { config } from "./config.js";
import { writeHeartbeat } from "./heartbeat.js";
import { onMeetingDraftSent } from "./meeting_book.js";
import { runMwfAudit } from "./mwf_audit.js";
import { everyMs, registerMwfAuditJob } from "./scheduler.js";
import { splitForTelegram } from "./telegram_io.js";

installOutboundHistory(bot.api);
setAfterDraftSend(onMeetingDraftSent);

// Each agent starts the scheduled work it owns. Aadi keeps only what belongs to
// no domain: the backup, the audit and the recovery scan for delegated tasks.
const jobs: Stoppable[] = [];
for (const agent of localSpecialists()) {
  const started = (await agent.definition.jobs?.(bot.api)) ?? [];
  jobs.push(...started);
  console.log(`Agent ${agent.definition.id}: ${started.length} scheduled job(s) started.`);
}
jobs.push(registerWeeklyBackup(bot.api));
jobs.push(registerMwfAuditJob(() => runMwfAudit(bot.api)));
jobs.push(
  everyMs(
    "agent-recovery",
    60_000,
    async () => {
      await recoveryTick();
      // A remote agent that was down at startup gets picked up here. The A2A
      // library is only loaded when an agent is configured.
      if (config.a2aRemoteAgents.length > 0) {
        const { registerRemoteAgents } = await import("./agents/a2a/remote.js");
        await registerRemoteAgents();
      }
    },
    { runImmediately: true, jobTimeoutMs: 5 * 60 * 1000 },
  ),
);
setLateNotifier(async (text) => {
  for (const chunk of splitForTelegram(text)) {
    await bot.api.sendMessage(config.ownerTelegramId, chunk);
  }
});
const a2aServer = config.a2aServerEnabled
  ? await (await import("./agents/a2a/server.js")).startA2aServer()
  : undefined;
await applyPendingDeployResult();

/** The commands shown in Telegram's menu. Older names still work but aren't listed. */
const MENU_COMMANDS = [
  { command: "start", description: "Say hello and see what Aadi can do" },
  { command: "menu", description: "Quick actions" },
  { command: "brief", description: "Send the morning brief now" },
  { command: "weekly", description: "Send the weekly review now" },
  { command: "meetings", description: "Meeting threads, next brief, wrap-up notes" },
  { command: "accounts", description: "List tracked accounts, stale first" },
  { command: "outbox", description: "Scheduled emails and follow-up sequences" },
  { command: "memory", description: "List saved memories and forget any" },
  { command: "settings", description: "Model, voice replies and keyboard" },
  { command: "jobs", description: "Big jobs, code builds and agent workflows" },
  { command: "build", description: "Ask a Cursor agent to change Aadi's code" },
  { command: "cost", description: "Model spend so far" },
  { command: "health", description: "Show scheduled job last-run times" },
  { command: "backup", description: "Send an encrypted database backup" },
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
    try {
      if (await refreshReplyKeyboardOnce(bot.api)) {
        console.log("Reply keyboard refreshed: Sequences replaces Waiting on.");
      }
    } catch (error) {
      const errorType = error instanceof Error ? error.name : "UnknownError";
      console.error(`Reply keyboard refresh failed (${errorType}); it will retry next start.`);
    }
    console.log(
      `Telegram / menu: ${MENU_COMMANDS.map((item) => `/${item.command}`).join(", ")}`,
    );
    console.log("Aadi is running with Telegram long polling.");
    writeHeartbeat();
  },
});

function shutdown(): void {
  for (const job of jobs) {
    job.stop();
  }
  a2aServer?.close();
  bot.stop();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
