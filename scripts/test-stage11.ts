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
  formatBuildsList,
  formatChangedFiles,
  isBuildConfigured,
  oneLineError,
  parseBuildVoice,
  parsePullNumber,
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
assert(!isTerminalRunStatus("RUNNING") && !isTerminalRunStatus("CREATING"), "active");

assert(
  confirmBuildText("fix greeting").includes("Build this?"),
  "confirm text",
);
assert(oneLineError("  boom \n line  ") === "boom line", "one line error");
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
    created_at: "",
    updated_at: "",
  },
]);
assert(list.includes("#3 ready to review"), "builds list");
assert(
  formatChangedFiles(["src/bot.ts", "prompts/system.md"]).includes("src/bot.ts"),
  "file names only",
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
