import { spawn } from "node:child_process";
import { join } from "node:path";
import { Api, InlineKeyboard, type Context } from "grammy";
import { everyMs, type IntervalJob } from "./scheduler.js";
import {
  confirmBuildText,
  failedChecksText,
  failedStartText,
  formatBuildsList,
  formatChangedFiles,
  formatCouldNotStart,
  formatDeployedText,
  isBuildConfigured,
  needsApprovalText,
  oneLineError,
  parseBuildVoice,
  protectedAreasTouched,
  shouldAutoMerge,
  shortSummary,
  summarizeGithubChecks,
  wrapBuildPrompt,
} from "./build_logic.js";
import { config } from "./config.js";
import {
  archiveCloudAgent,
  createCloudAgent,
  createCloudRun,
  cursorErrorInfo,
  getLatestCloudRun,
  isTerminalRunStatus,
  normalizeRunStatus,
} from "./cursor_cloud.js";
import {
  createBuild,
  getBuild,
  listBuilds,
  listBuildsByStatuses,
  updateBuild,
  type BuildRecord,
} from "./db.js";
import {
  closePull,
  getPull,
  isPullConflict,
  listPullCheckRuns,
  listPullFilenames,
  mergePullSquash,
  pullNumberFromUrl,
  revertMergedPull,
} from "./github_api.js";
import {
  clearDeployResult,
  readDeployResult,
} from "./heartbeat.js";

const TIME_ZONE = "Asia/Kolkata";
const awaitingFollowup = new Map<number, number>();
const ACTIVE_POLL_STATUSES = [
  "running",
  "waiting_checks",
  "review",
  "merged",
  "deploying",
] as const;

function buildsReady(): boolean {
  return isBuildConfigured(config.cursorApiKey, config.githubToken);
}

export function notSetupMessage(): string {
  return "Build isn't set up. Add CURSOR_API_KEY and GITHUB_TOKEN to .env.";
}

function emptyKeyboard(): InlineKeyboard {
  return new InlineKeyboard();
}

function confirmKeyboard(id: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("Start", `build:go:${id}`)
    .text("Cancel", `build:no:${id}`);
}

function reviewKeyboard(id: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("Deploy", `build:deploy:${id}`)
    .row()
    .text("Ask for changes", `build:ask:${id}`)
    .row()
    .text("Discard", `build:discard:${id}`);
}

function failedCheckKeyboard(id: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("Ask for changes", `build:ask:${id}`)
    .row()
    .text("Discard", `build:discard:${id}`);
}

function undoKeyboard(id: number): InlineKeyboard {
  return new InlineKeyboard().text("Undo", `build:undo:${id}`);
}

function buildsListKeyboard(rows: BuildRecord[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const row of rows) {
    if (row.status === "running" || row.status === "waiting_checks") {
      keyboard.text(`Check now #${row.id}`, `build:check:${row.id}`).row();
    }
  }
  return keyboard;
}

function ownerApi(): Api {
  return new Api(config.telegramBotToken);
}

async function editOrReply(
  ctx: Context,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  try {
    await ctx.editMessageText(text, {
      reply_markup: keyboard ?? emptyKeyboard(),
    });
  } catch {
    await ctx
      .editMessageReplyMarkup({
        reply_markup: keyboard ?? emptyKeyboard(),
      })
      .catch(() => undefined);
  }
}

function parseFiles(build: BuildRecord): string[] {
  if (!build.files_json) {
    return [];
  }
  try {
    const parsed = JSON.parse(build.files_json) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function reviewBody(build: BuildRecord, prefix?: string): string {
  const files = parseFiles(build);
  const lines = [
    prefix,
    shortSummary(build.summary ?? undefined),
    formatChangedFiles(files),
    build.pr_url ? `PR: ${build.pr_url}` : "PR: not opened yet",
  ].filter((line): line is string => Boolean(line && line.trim()));
  return lines.join("\n");
}

export async function promptBuild(ctx: Context, task: string): Promise<void> {
  if (!buildsReady()) {
    await ctx.reply(notSetupMessage());
    return;
  }
  const trimmed = task.trim();
  if (!trimmed) {
    await ctx.reply("Send /build plus what you want changed.");
    return;
  }
  const build = createBuild(trimmed);
  console.log(`Build ${build.id}: status -> pending_confirm`);
  await ctx.reply(confirmBuildText(trimmed), {
    reply_markup: confirmKeyboard(build.id),
  });
}

export async function handleBuildVoice(
  ctx: Context,
  transcript: string,
): Promise<boolean> {
  const task = parseBuildVoice(transcript);
  if (!task) {
    return false;
  }
  await promptBuild(ctx, task);
  return true;
}

export function consumeBuildFollowup(userId: number): number | undefined {
  const id = awaitingFollowup.get(userId);
  if (id === undefined) {
    return undefined;
  }
  awaitingFollowup.delete(userId);
  return id;
}

export async function submitBuildFollowup(
  ctx: Context,
  buildId: number,
  text: string,
): Promise<void> {
  const build = getBuild(buildId);
  if (
    !build ||
    !build.cursor_agent_id ||
    (build.status !== "awaiting_followup" &&
      build.status !== "review" &&
      build.status !== "waiting_approval" &&
      build.status !== "failed")
  ) {
    await ctx.reply("That build is no longer waiting for changes.");
    return;
  }
  try {
    const run = await createCloudRun(
      build.cursor_agent_id,
      wrapBuildPrompt(text),
    );
    updateBuild(build.id, {
      status: "running",
      cursor_run_id: run.id,
      error: null,
    });
    console.log(`Build ${build.id}: status -> running run=${run.id}`);
    await ctx.reply("Started a follow-up on that build.");
  } catch (error) {
    const info = cursorErrorInfo(error);
    const message = formatCouldNotStart(info);
    updateBuild(build.id, { error: message });
    console.error(
      `Build ${build.id}: follow-up failed status=${info.status ?? "?"}` +
        (info.code ? ` code=${info.code}` : "") +
        ` ${message}`,
    );
    await ctx.reply(message);
  }
}

export function formatRecentBuilds(): string {
  return formatBuildsList(listBuilds(15));
}

export async function sendBuildsPanel(ctx: Context): Promise<void> {
  const rows = listBuilds(15);
  await ctx.reply(formatBuildsList(rows), {
    reply_markup: buildsListKeyboard(rows),
  });
}

function spawnDetachedBash(
  script: string,
  buildId: number,
  prNumber: number,
): void {
  const child = spawn("bash", [script, String(buildId), String(prNumber)], {
    detached: true,
    stdio: "ignore",
    cwd: process.cwd(),
  });
  child.unref();
}

function spawnPhoneDeploy(buildId: number, prNumber: number): void {
  const script = join(process.cwd(), "scripts/phone-self-deploy.sh");
  const tmux = spawn(
    "tmux",
    [
      "new-window",
      "-t",
      "aadi",
      "-n",
      `deploy-${buildId}`,
      `bash ${script} ${buildId} ${prNumber}`,
    ],
    { stdio: "ignore" },
  );
  tmux.unref();
  tmux.on("error", () => {
    spawnDetachedBash(script, buildId, prNumber);
  });
  tmux.on("exit", (code) => {
    if (code !== 0) {
      spawnDetachedBash(script, buildId, prNumber);
    }
  });
  console.log(`Build ${buildId}: detached deploy pr=${prNumber}`);
}

async function startPhoneDeploy(build: BuildRecord): Promise<void> {
  const prNumber = build.pr_number;
  if (!prNumber) {
    return;
  }
  updateBuild(build.id, { status: "deploying", error: null });
  console.log(`Build ${build.id}: status -> deploying pr=${prNumber}`);
  spawnPhoneDeploy(build.id, prNumber);
}

async function collectPrFiles(build: BuildRecord): Promise<{
  files: string[];
  prUrl: string | null;
  prNumber: number | null;
  filesVerified: boolean;
}> {
  const prUrl = build.pr_url;
  const prNumber = build.pr_number ?? pullNumberFromUrl(prUrl);
  let files = parseFiles(build);
  let filesVerified = files.length > 0;
  if (prNumber) {
    try {
      files = await listPullFilenames(prNumber);
      filesVerified = true;
    } catch {
      console.error(`Build ${build.id}: PR file list failed`);
    }
  }
  return { files, prUrl, prNumber: prNumber ?? null, filesVerified };
}

async function finishCursorRun(build: BuildRecord): Promise<void> {
  if (!build.cursor_agent_id) {
    return;
  }
  const run = await getLatestCloudRun(build.cursor_agent_id);
  if (run.id && run.id !== build.cursor_run_id) {
    updateBuild(build.id, { cursor_run_id: run.id });
  }
  const status = normalizeRunStatus(run.status);
  if (!isTerminalRunStatus(status)) {
    return;
  }
  if (status !== "FINISHED") {
    const error = oneLineError(run.result);
    updateBuild(build.id, { status: "failed", error });
    console.log(`Build ${build.id}: status -> failed`);
    await ownerApi().sendMessage(
      config.ownerTelegramId,
      `Build #${build.id} failed: ${error}`,
    );
    return;
  }

  const prUrl = run.git?.branches?.find((item) => item.prUrl)?.prUrl ?? null;
  const prNumber = pullNumberFromUrl(prUrl) ?? null;
  let files: string[] = [];
  if (prNumber) {
    try {
      files = await listPullFilenames(prNumber);
    } catch {
      console.error(`Build ${build.id}: PR file list failed`);
    }
  }
  updateBuild(build.id, {
    status: "waiting_checks",
    cursor_run_id: run.id,
    pr_url: prUrl,
    pr_number: prNumber,
    summary: shortSummary(run.result),
    files_json: JSON.stringify(files),
    error: null,
  });
  console.log(
    `Build ${build.id}: status -> waiting_checks pr=${prNumber ?? "none"}`,
  );
  const latest = getBuild(build.id);
  if (latest) {
    await processChecks(latest);
  }
}

async function askForApproval(
  build: BuildRecord,
  files: string[],
  prUrl: string | null,
  prNumber: number | null,
  prefix?: string,
): Promise<void> {
  const body = reviewBody(
    {
      ...build,
      files_json: JSON.stringify(files),
      pr_url: prUrl,
      pr_number: prNumber,
    },
    prefix,
  );
  await ownerApi().sendMessage(config.ownerTelegramId, body, {
    reply_markup: reviewKeyboard(build.id),
  });
  updateBuild(build.id, {
    status: "waiting_approval",
    files_json: JSON.stringify(files),
    pr_url: prUrl,
    pr_number: prNumber,
    error: prefix ?? null,
  });
  console.log(
    `Build ${build.id}: status -> waiting_approval ${prefix ?? ""}`.trim(),
  );
}

async function processChecks(build: BuildRecord): Promise<void> {
  const { files, prUrl, prNumber, filesVerified } = await collectPrFiles(build);
  if (!prNumber) {
    updateBuild(build.id, {
      status: "failed",
      error: "The agent finished without a pull request.",
    });
    await ownerApi().sendMessage(
      config.ownerTelegramId,
      `Build #${build.id} failed: The agent finished without a pull request.`,
    );
    return;
  }

  if (build.status === "review" || build.status === "deploying") {
    updateBuild(build.id, {
      status: "waiting_checks",
      files_json: JSON.stringify(files),
      pr_url: prUrl,
      pr_number: prNumber,
    });
  }

  let pull;
  try {
    pull = await getPull(prNumber);
  } catch {
    await askForApproval(
      build,
      files,
      prUrl,
      prNumber,
      "Needs your approval: GitHub token cannot access this repository",
    );
    return;
  }
  if (pull.merged) {
    updateBuild(build.id, {
      status: "merged",
      merge_sha: pull.merge_commit_sha,
      files_json: JSON.stringify(files),
    });
    console.log(`Build ${build.id}: status -> merged (already on GitHub)`);
    await startPhoneDeploy(getBuild(build.id) ?? build);
    return;
  }

  const checks = summarizeGithubChecks(await listPullCheckRuns(pull.head.sha));
  if (checks.state === "pending") {
    if (build.status !== "waiting_checks") {
      updateBuild(build.id, { status: "waiting_checks" });
      console.log(`Build ${build.id}: status -> waiting_checks`);
    }
    return;
  }
  if (checks.state === "failed") {
    const text = failedChecksText(checks.reason ?? "CI failed");
    await ownerApi().sendMessage(config.ownerTelegramId, text, {
      reply_markup: failedCheckKeyboard(build.id),
    });
    updateBuild(build.id, { status: "failed", error: text });
    console.log(`Build ${build.id}: status -> failed (checks)`);
    return;
  }

  const areas = protectedAreasTouched(files);
  if (
    !shouldAutoMerge({
      autoDeploy: config.autoDeploy,
      protectedAreas: areas,
      filesVerified,
    })
  ) {
    const prefix = !filesVerified
      ? "Needs your approval: could not verify changed files on GitHub"
      : areas.length > 0
        ? needsApprovalText(areas)
        : undefined;
    await askForApproval(build, files, prUrl, prNumber, prefix);
    return;
  }

  await autoMergeAndDeploy({
    ...build,
    files_json: JSON.stringify(files),
    pr_url: prUrl,
    pr_number: prNumber,
  });
}

function mergeErrorDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : "";
  const detail = raw.replace(/\s+/g, " ").trim().slice(0, 500);
  return detail || "GitHub merge failed.";
}

function squashMergeFailureText(error: unknown): string {
  return `Could not squash-merge the pull request. ${mergeErrorDetail(error)}`;
}

async function notifyMergeNeedsApproval(
  build: BuildRecord,
  error: unknown,
): Promise<void> {
  const errorType = error instanceof Error ? error.name : "UnknownError";
  console.error(`Build ${build.id}: merge failed (${errorType})`);
  const prefix = squashMergeFailureText(error);
  try {
    await askForApproval(
      build,
      parseFiles(build),
      build.pr_url,
      build.pr_number,
      prefix,
    );
  } catch (sendError) {
    const sendType =
      sendError instanceof Error ? sendError.name : "UnknownError";
    console.error(`Build ${build.id}: approval card failed (${sendType})`);
    await ownerApi().sendMessage(config.ownerTelegramId, prefix, {
      reply_markup: reviewKeyboard(build.id),
    });
    updateBuild(build.id, {
      status: "waiting_approval",
      error: prefix,
    });
  }
}

async function mergePullSquashRetry(
  buildId: number,
  pullNumber: number,
): Promise<string | undefined> {
  try {
    return await mergePullSquash(pullNumber);
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(
      `Build ${buildId}: merge failed (${errorType}); retrying once`,
    );
    return mergePullSquash(pullNumber);
  }
}

async function autoMergeAndDeploy(build: BuildRecord): Promise<void> {
  if (!build.pr_number) {
    return;
  }
  try {
    const sha = await mergePullSquash(build.pr_number);
    updateBuild(build.id, {
      status: "merged",
      merge_sha: sha ?? null,
      error: null,
    });
    console.log(`Build ${build.id}: status -> merged sha=${sha ?? "none"}`);
    await startPhoneDeploy(getBuild(build.id) ?? build);
  } catch (error) {
    await notifyMergeNeedsApproval(build, error);
  }
}

async function processOneBuild(build: BuildRecord): Promise<void> {
  if (build.status === "running") {
    await finishCursorRun(build);
    return;
  }
  if (
    build.status === "waiting_checks" ||
    build.status === "review"
  ) {
    await processChecks(build);
    return;
  }
  if (build.status === "merged") {
    await startPhoneDeploy(build);
    return;
  }
  if (build.status === "deploying") {
    if (!build.pr_number) {
      return;
    }
    try {
      const pull = await getPull(build.pr_number);
      if (pull.merged) {
        return;
      }
    } catch {
      // Resume the PR flow; GitHub access is checked in processChecks.
    }
    console.log(`Build ${build.id}: deploy did not merge; resume checks`);
    await processChecks(build);
  }
}

export async function pollRunningBuilds(): Promise<void> {
  if (!buildsReady()) {
    return;
  }
  await applyPendingDeployResult();
  const active = listBuildsByStatuses([...ACTIVE_POLL_STATUSES]);
  for (const build of active) {
    try {
      await processOneBuild(build);
    } catch (error) {
      const errorType = error instanceof Error ? error.name : "UnknownError";
      console.error(`Build ${build.id}: poll failed (${errorType})`);
    }
  }
}

export function registerBuildPoll(): IntervalJob {
  const task = everyMs(
    "build-poll",
    60 * 1000,
    () => pollRunningBuilds(),
    { runImmediately: true },
  );
  console.log(`Build poll scheduled every minute (${TIME_ZONE}).`);
  return task;
}

export async function handleBuildCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const match = /^build:(go|no|deploy|ask|discard|check|undo):(\d+)$/.exec(
    data,
  );
  if (!match) {
    await ctx.answerCallbackQuery();
    return;
  }
  const action = match[1];
  const id = Number(match[2]);
  const build = getBuild(id);
  if (!build) {
    await ctx.answerCallbackQuery({ text: "That build is gone.", show_alert: true });
    return;
  }

  if (action === "check") {
    await ctx.answerCallbackQuery("Checking");
    try {
      await processOneBuild(getBuild(id) ?? build);
    } catch (error) {
      const errorType = error instanceof Error ? error.name : "UnknownError";
      console.error(`Build ${id}: check now failed (${errorType})`);
    }
    return;
  }

  if (action === "no") {
    updateBuild(id, { status: "discarded" });
    console.log(`Build ${id}: status -> discarded`);
    await ctx.answerCallbackQuery("Cancelled");
    await editOrReply(ctx, "Cancelled.");
    return;
  }

  if (action === "go") {
    if (build.status !== "pending_confirm") {
      await ctx.answerCallbackQuery("Already started.");
      return;
    }
    if (!buildsReady()) {
      await ctx.answerCallbackQuery({ text: notSetupMessage(), show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery("Starting");
    try {
      const created = await createCloudAgent(wrapBuildPrompt(build.task));
      const url = created.agent.url ?? "";
      const runId = created.run.id || created.agent.latestRunId || "";
      updateBuild(id, {
        status: "running",
        cursor_agent_id: created.agent.id,
        cursor_run_id: runId || null,
        cursor_url: url || null,
        error: null,
      });
      console.log(
        `Build ${id}: status -> running agent=${created.agent.id} run=${runId}`,
      );
      await editOrReply(ctx, url ? `Started ${url}` : "Started");
    } catch (error) {
      const info = cursorErrorInfo(error);
      const text = failedStartText(build.task, info);
      updateBuild(id, {
        status: "pending_confirm",
        error: formatCouldNotStart(info),
      });
      console.error(
        `Build ${id}: start failed status=${info.status ?? "?"}` +
          (info.code ? ` code=${info.code}` : "") +
          ` ${formatCouldNotStart(info)}`,
      );
      await editOrReply(ctx, text, confirmKeyboard(id));
    }
    return;
  }

  if (action === "ask") {
    awaitingFollowup.set(config.ownerTelegramId, id);
    updateBuild(id, { status: "awaiting_followup" });
    console.log(`Build ${id}: status -> awaiting_followup`);
    await ctx.answerCallbackQuery("Send your changes.");
    await editOrReply(ctx, "What should the agent change?");
    return;
  }

  if (action === "discard") {
    await ctx.answerCallbackQuery("Discarding");
    try {
      if (build.pr_number) {
        await closePull(build.pr_number);
      }
      if (build.cursor_agent_id) {
        await archiveCloudAgent(build.cursor_agent_id);
      }
    } catch (error) {
      const errorType = error instanceof Error ? error.name : "UnknownError";
      console.error(`Build ${id}: discard failed (${errorType})`);
    }
    updateBuild(id, { status: "discarded" });
    console.log(`Build ${id}: status -> discarded`);
    awaitingFollowup.delete(config.ownerTelegramId);
    await editOrReply(ctx, "Discarded. The PR is closed.");
    return;
  }

  if (action === "undo") {
    if (build.status !== "deployed" && build.status !== "rolled_back") {
      await ctx.answerCallbackQuery({
        text: "Nothing to undo yet.",
        show_alert: true,
      });
      return;
    }
    if (!build.pr_number) {
      await ctx.answerCallbackQuery({
        text: "No pull request to revert.",
        show_alert: true,
      });
      return;
    }
    await ctx.answerCallbackQuery("Undoing");
    const reverted = await revertMergedPull(build.pr_number);
    if (!reverted.ok) {
      await editOrReply(
        ctx,
        "Could not revert GitHub main. On the Mac: git pull first, then revert the merge commit.",
      );
      return;
    }
    updateBuild(id, { status: "deploying", error: "undo" });
    spawnPhoneDeploy(id, 0);
    await editOrReply(ctx, "Reverted on GitHub. Deploying main on the phone.");
    return;
  }

  if (action === "deploy") {
    if (!build.pr_number) {
      await ctx.answerCallbackQuery({
        text: "No pull request to deploy.",
        show_alert: true,
      });
      return;
    }
    await ctx.answerCallbackQuery("Deploying");
    try {
      const sha = await mergePullSquashRetry(id, build.pr_number);
      updateBuild(id, {
        status: "merged",
        merge_sha: sha ?? null,
        error: null,
      });
    } catch (error) {
      const errorType = error instanceof Error ? error.name : "UnknownError";
      const detail = mergeErrorDetail(error);
      console.error(
        `Build ${id}: merge failed (${errorType}) ${detail.slice(0, 180)}`,
      );
      const text = isPullConflict(error)
        ? `${squashMergeFailureText(error)} Resolve the conflict on GitHub.`
        : squashMergeFailureText(error);
      updateBuild(id, { error: text });
      await editOrReply(ctx, text, reviewKeyboard(id));
      return;
    }
    await editOrReply(
      ctx,
      "Deploying on the phone. I'll message you when it's done.",
    );
    const latest = getBuild(id);
    if (latest) {
      await startPhoneDeploy(latest);
    }
  }
}

export async function applyPendingDeployResult(): Promise<void> {
  const result = await readDeployResult();
  if (!result) {
    return;
  }
  const status =
    result.status === "deployed"
      ? "deployed"
      : result.status === "rolled_back"
        ? "rolled_back"
        : "failed";
  const updated = updateBuild(result.buildId, {
    status,
    error: result.error ?? null,
  });
  console.log(`Build ${result.buildId}: status -> ${status} (from deploy result)`);
  await clearDeployResult();
  if (status === "deployed" && updated) {
    const text = formatDeployedText({
      summary: updated.summary ?? "The agent finished.",
      files: parseFiles(updated),
      prUrl: updated.pr_url ?? "",
    });
    await ownerApi().sendMessage(config.ownerTelegramId, text, {
      reply_markup: undoKeyboard(updated.id),
    });
  }
}
