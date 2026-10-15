import "dotenv/config";

function ensureTestEnv(): void {
  process.env.LLM_PROVIDER ??= "claude";
  process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
  process.env.OWNER_TELEGRAM_ID ??= "1";
  process.env.CLAUDE_MODEL ??= "claude-haiku-4-5";
  process.env.ANTHROPIC_API_KEY ??= "test-key";
  process.env.BRIEF_TIME ??= "08:00";
}

ensureTestEnv();

const { deleteSetting, setSetting } = await import("../src/db.ts");
const { TOOL_ORDER, tools } = await import("../src/tools/index.ts");
const {
  applyAllTasks,
  applyAllTasksExceptDrafting,
  applyTaskBackend,
  getTaskBackend,
  getTaskBackends,
} = await import("../src/chat_backend.ts");

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function resetModelSettings(): void {
  deleteSetting("llm_task_backends");
  deleteSetting("llm_backend");
  deleteSetting("llm_task_defaults_generation");
}

resetModelSettings();
assert(getTaskBackend("chat") === "haiku", "default chat is Fast/Haiku");
assert(getTaskBackend("brief") === "haiku", "default brief is Haiku");
assert(getTaskBackend("documents") === "haiku", "default documents is Haiku");
assert(getTaskBackend("meetings") === "haiku", "default meetings is Haiku");
assert(getTaskBackend("drafting") === "haiku", "default drafting is Haiku");

resetModelSettings();
setSetting("llm_backend", "cloud-gemma");
const migrated = getTaskBackends();
assert(migrated.chat === "cloud-gemma", "legacy chat migrates");
assert(migrated.brief === "cloud-gemma", "legacy brief migrates");
assert(migrated.meetings === "cloud-gemma", "legacy meetings migrate");
assert(migrated.documents === "haiku", "documents use new Haiku default");
assert(migrated.drafting === "haiku", "drafting uses new Haiku default");

const one = applyTaskBackend("chat", "claude");
assert(one.switched && getTaskBackend("chat") === "claude", "manual Sonnet override");
assert(getTaskBackend("brief") === "cloud-gemma", "other tasks unchanged");

const shortcut = applyAllTasks("claude");
assert(shortcut.switched, "claude shortcut switches all");
assert(getTaskBackend("chat") === "claude", "shortcut chat");
assert(getTaskBackend("brief") === "claude", "shortcut brief");
assert(getTaskBackend("documents") === "claude", "shortcut documents");
assert(getTaskBackend("meetings") === "claude", "shortcut meetings");
assert(getTaskBackend("drafting") === "claude", "shortcut drafting");

applyTaskBackend("drafting", "haiku");
applyAllTasksExceptDrafting("cloud-gemma");
assert(
  getTaskBackend("drafting") === "haiku",
  "gemma shortcut does not change drafting",
);
assert(getTaskBackend("chat") === "cloud-gemma", "gemma shortcut chat");

const allFast = applyAllTasks("haiku");
assert(allFast.switched, "fast shortcut");
assert(getTaskBackend("chat") === "haiku", "shortcut chat haiku");
assert(getTaskBackend("drafting") === "haiku", "shortcut drafting haiku");

resetModelSettings();
setSetting(
  "llm_task_backends",
  JSON.stringify({
    chat: "claude",
    brief: "claude",
    documents: "claude",
    meetings: "claude",
    drafting: "claude",
  }),
);
const flipped = getTaskBackends();
assert(flipped.chat === "haiku", "old Claude defaults flip to Haiku");
assert(flipped.drafting === "haiku", "old drafting Claude flips to Haiku");

resetModelSettings();
assert(getTaskBackend("chat") === "haiku", "cleanup restores Haiku default");

assert(TOOL_ORDER.includes("read_sheet"), "read_sheet stays in the cached tool list");
assert(
  Object.keys(tools).join(",") === TOOL_ORDER.join(","),
  "tool registry order matches TOOL_ORDER",
);
console.log("Per-task model checks passed.");
