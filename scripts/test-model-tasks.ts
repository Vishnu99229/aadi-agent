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
const {
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

deleteSetting("llm_task_backends");
deleteSetting("llm_backend");
assert(getTaskBackend("chat") === "claude", "default chat is Claude");
assert(getTaskBackend("drafting") === "claude", "default drafting is Claude");

setSetting("llm_task_backends", "");
deleteSetting("llm_task_backends");
setSetting("llm_backend", "cloud-gemma");
const migrated = getTaskBackends();
assert(migrated.chat === "cloud-gemma", "legacy chat migrates");
assert(migrated.brief === "cloud-gemma", "legacy brief migrates");
assert(migrated.meetings === "cloud-gemma", "legacy meetings migrate");
assert(migrated.documents === "claude", "documents stay Claude after migrate");
assert(migrated.drafting === "claude", "drafting stays Claude after migrate");

const one = applyTaskBackend("chat", "claude");
assert(one.switched && getTaskBackend("chat") === "claude", "single task switch");
assert(getTaskBackend("brief") === "cloud-gemma", "other tasks unchanged");

const shortcut = applyAllTasksExceptDrafting("claude");
assert(shortcut.switched, "shortcut switches");
assert(getTaskBackend("chat") === "claude", "shortcut chat");
assert(getTaskBackend("brief") === "claude", "shortcut brief");
assert(getTaskBackend("documents") === "claude", "shortcut documents");
assert(getTaskBackend("meetings") === "claude", "shortcut meetings");
assert(getTaskBackend("drafting") === "claude", "drafting still Claude");

applyTaskBackend("drafting", "cloud-gemma");
applyAllTasksExceptDrafting("claude");
assert(
  getTaskBackend("drafting") === "cloud-gemma",
  "shortcut does not change drafting",
);

deleteSetting("llm_task_backends");
deleteSetting("llm_backend");
console.log("Per-task model checks passed.");
