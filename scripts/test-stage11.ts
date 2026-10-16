import "dotenv/config";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

function ensureTestEnv(): void {
  process.env.LLM_PROVIDER ??= "claude";
  process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
  process.env.OWNER_TELEGRAM_ID ??= "1";
  process.env.CLAUDE_MODEL ??= "claude-haiku-4-5";
  process.env.ANTHROPIC_API_KEY ??= "test-key";
  process.env.BRIEF_TIME ??= "08:00";
}

ensureTestEnv();

const execFileAsync = promisify(execFile);

const {
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
  parsePullNumber,
  protectedAreasTouched,
  shouldAutoMerge,
  summarizeGithubChecks,
  revertCommitMessage,
  rollbackTelegram,
  macFixMainCommand,
  shortSummary,
  wrapBuildPrompt,
} = await import("../src/build_logic.ts");
const { isTerminalRunStatus } = await import("../src/cursor_cloud.ts");
const {
  clearDeployResult,
  readDeployResult,
  writeDeployResult,
  writeHeartbeat,
  heartbeatPath,
} = await import("../src/heartbeat.ts");

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

assert(
  !isBuildConfigured("", "token") && !isBuildConfigured("key", ""),
  "both keys required",
);
assert(isBuildConfigured("key", "token"), "both keys present");

assert(
  parseBuildVoice("build: change the /start greeting") ===
    "change the /start greeting",
  "voice build prefix",
);
assert(parseBuildVoice("Build:\nfix the brief") === "fix the brief", "multiline voice");
assert(parseBuildVoice("please build this") === undefined, "plain text is not build");

const prompt = wrapBuildPrompt("change the /start greeting");
assert(prompt.includes("change the /start greeting"), "task in prompt");
assert(prompt.includes(".cursor/rules/aadi.mdc"), "rules in prompt");
assert(prompt.includes("Never read, create or modify .env"), "secret guard");
assert(prompt.includes("Open a pull request; do not merge"), "no merge");

assert(
  parsePullNumber("https://github.com/Vishnu99229/aadi-agent/pull/42") === 42,
  "pr number",
);
assert(parsePullNumber("https://example.com") === undefined, "not a pr");

assert(isTerminalRunStatus("FINISHED") && isTerminalRunStatus("ERROR"), "terminal");
assert(isTerminalRunStatus("finished") && isTerminalRunStatus("expired"), "terminal case");
assert(!isTerminalRunStatus("RUNNING") && !isTerminalRunStatus("CREATING"), "active");
assert(!isTerminalRunStatus("IDLE") && !isTerminalRunStatus("ACTIVE"), "agent status is not a run");

assert(
  confirmBuildText("fix greeting").includes("Build this?"),
  "confirm text",
);
assert(
  confirmBuildText("fix greeting").includes("Tap Start or Cancel."),
  "confirm asks for Start",
);
assert(oneLineError("  boom \n line  ") === "boom line", "one line error");
assert(
  formatCouldNotStart({
    status: 403,
    code: "feature_unavailable",
    apiMessage:
      "Storage mode is disabled. Please enable storage in your Cursor settings to use agents via API.",
  }) === "Could not start: storage is disabled in Cursor settings",
  "storage mode error",
);
assert(
  formatCouldNotStart({ status: 401, apiMessage: "Unauthorized" }) ===
    "Could not start: invalid API key",
  "invalid key",
);
assert(
  formatCouldNotStart({
    status: 403,
    apiMessage: "repository not accessible",
  }) === "Could not start: repository not accessible",
  "repo inaccessible",
);
assert(
  formatCouldNotStart({
    status: 403,
    code: "feature_unavailable",
    apiMessage: "Cloud Agents are not available on your plan.",
  }) === "Could not start: cloud agents not enabled on this plan",
  "plan gate",
);
assert(
  !failedStartText("fix greeting", { status: 403 }).includes("crsr_"),
  "no secrets in start failure",
);
assert(
  failedStartText("fix greeting", {
    status: 403,
    code: "feature_unavailable",
    apiMessage: "Storage mode is disabled.",
  }).includes("Tap Start or Cancel."),
  "failed start keeps confirm buttons copy",
);
assert(shortSummary("").includes("finished"), "empty summary");

const list = formatBuildsList([
  {
    id: 3,
    task: "change greeting",
    status: "review",
    cursor_agent_id: null,
    cursor_run_id: null,
    cursor_url: null,
    pr_url: null,
    pr_number: null,
    summary: null,
    files_json: null,
    error: null,
    merge_sha: null,
    created_at: "",
    updated_at: "",
  },
]);
assert(list.includes("#3 waiting for approval"), "builds list");
assert(
  !shouldAutoMerge({
    autoDeploy: true,
    protectedAreas: ["owner lock"],
    filesVerified: true,
  }),
  "protected blocks auto-merge",
);
assert(
  !shouldAutoMerge({
    autoDeploy: true,
    protectedAreas: [],
    filesVerified: false,
  }),
  "unverified files block auto-merge",
);
assert(
  shouldAutoMerge({
    autoDeploy: true,
    protectedAreas: [],
    filesVerified: true,
  }),
  "safe auto-merge",
);
assert(
  protectedAreasTouched(["src/bot.ts", "src/start_greeting.ts"]).includes(
    "owner lock",
  ),
  "bot.ts is owner lock",
);
assert(
  protectedAreasTouched(["src/start_greeting.ts", "package.json"]).length === 0,
  "greeting helper is not protected",
);
assert(
  protectedAreasTouched([".github/workflows/ci.yml"]).includes(
    ".github/workflows",
  ),
  "workflow files are protected",
);
assert(
  summarizeGithubChecks([]).state === "passed",
  "no checks means passed",
);
assert(
  summarizeGithubChecks([
    { name: "CI", status: "in_progress", conclusion: null },
  ]).state === "pending",
  "in-progress checks",
);
assert(
  summarizeGithubChecks([
    { name: "CI", status: "completed", conclusion: "failure" },
  ]).reason === "CI",
  "failed check name",
);
assert(
  failedChecksText("CI").startsWith("Build failed checks:"),
  "failed checks copy",
);
assert(
  needsApprovalText(["owner lock"]) ===
    "Needs your approval: touches owner lock",
  "approval copy",
);
assert(
  formatDeployedText({
    summary: "Changed the greeting.",
    files: ["src/bot.ts"],
    prUrl: "https://github.com/Vishnu99229/aadi-agent/pull/1",
  }).includes("Deployed:"),
  "deployed copy",
);
assert(
  formatChangedFiles(["src/bot.ts", "prompts/system.md"]).includes("src/bot.ts"),
  "file names only",
);

assert(
  revertCommitMessage("Change /start greeting") ===
    "Revert Change /start greeting — failed health check",
  "revert message",
);
assert(
  macFixMainCommand("abc123def") ===
    "git pull && git revert --no-edit abc123def && git push origin main",
  "mac fix uses merge sha",
);
assert(
  rollbackTelegram({
    reason: "Aadi did not become healthy in time.",
    phoneNote: "Rolled back the phone to the previous version.",
    revert: {
      ok: true,
      message: "Revert Change greeting — failed health check",
    },
  }).includes("Reverted GitHub main"),
  "telegram reports revert",
);
assert(
  rollbackTelegram({
    reason: "Aadi did not become healthy in time.",
    phoneNote: "Rolled back the phone to the previous version.",
    revert: { ok: false, mergeSha: "deadbeef" },
  }).includes("GitHub main is still broken"),
  "telegram reports broken main",
);
assert(
  rollbackTelegram({
    reason: "boom",
    phoneNote: "Rolled back.",
    revert: { ok: false, mergeSha: "deadbeef" },
  }).includes("git revert --no-edit deadbeef"),
  "telegram includes mac fix command",
);

const dir = await mkdtemp(join(tmpdir(), "aadi-stage11-"));
try {
  writeHeartbeat(dir);
  const beat = await readFile(heartbeatPath(dir), "utf8");
  assert(beat.includes("T"), "heartbeat written");
  await writeDeployResult(
    { buildId: 9, status: "rolled_back", error: "npm install failed." },
    dir,
  );
  const result = await readDeployResult(dir);
  assert(result?.buildId === 9 && result.status === "rolled_back", "deploy result");
  await clearDeployResult(dir);

  const pkgPath = join(dir, "package.json");
  await writeFile(
    pkgPath,
    JSON.stringify({
      dependencies: { "better-sqlite3": "^12.11.1" },
      allowScripts: {},
    }),
  );
  await execFileAsync("node", [
    join(process.cwd(), "scripts/ensure-allow-scripts.cjs"),
  ], { cwd: dir });
  const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as {
    allowScripts: Record<string, boolean>;
  };
  assert(pkg.allowScripts["better-sqlite3@12.11.1"] === true, "sqlite allowScripts");
  assert(pkg.allowScripts["esbuild@0.28.2"] === true, "esbuild allowScripts");
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log("Stage 11 checks passed.");
