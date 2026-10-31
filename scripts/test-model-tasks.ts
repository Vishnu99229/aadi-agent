import "dotenv/config";

function ensureTestEnv(): void {
  process.env.LLM_PROVIDER ??= "claude";
  process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
  process.env.OWNER_TELEGRAM_ID ??= "1";
  process.env.CLAUDE_MODEL ??= "claude-haiku-4-5";
  process.env.ANTHROPIC_API_KEY ??= "test-key";
  process.env.BRIEF_TIME ??= "08:00";
  process.env.GEMINI_API_KEY ??= "test-key";
}

ensureTestEnv();

const { deleteSetting, setSetting } = await import("../src/db.ts");
const { TOOL_ORDER, tools } = await import("../src/tools/index.ts");
const {
  applyAllChoice,
  applyAllTasks,
  applyTaskBackend,
  applyTaskChoice,
  formatModelSetupText,
  formatTaskSetupLine,
  getTaskBackend,
  getTaskBackends,
  getTaskEffort,
  isChatBackend,
  modelDisplayName,
  supportsEffort,
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
  deleteSetting("llm_task_efforts");
}

resetModelSettings();
assert(getTaskBackend("chat") === "haiku", "default chat is Fast/Haiku");
assert(getTaskBackend("brief") === "haiku", "default brief is Haiku");
assert(getTaskBackend("documents") === "haiku", "default documents is Haiku");
assert(getTaskBackend("meetings") === "haiku", "default meetings is Haiku");
assert(getTaskBackend("drafting") === "haiku", "default drafting is Haiku");

resetModelSettings();
setSetting("llm_backend", "haiku");
const migrated = getTaskBackends();
assert(migrated.chat === "haiku", "generation bump restores Haiku chat");
assert(migrated.brief === "haiku", "generation bump restores Haiku brief");
assert(migrated.meetings === "haiku", "generation bump restores Haiku meetings");
assert(migrated.documents === "haiku", "documents use new Haiku default");
assert(migrated.drafting === "haiku", "drafting uses new Haiku default");

const one = applyTaskBackend("chat", "claude");
assert(one.switched && getTaskBackend("chat") === "claude", "manual Sonnet override");
assert(getTaskBackend("brief") === "haiku", "other tasks unchanged");

const shortcut = applyAllTasks("claude");
assert(shortcut.switched, "claude shortcut switches all");
assert(getTaskBackend("chat") === "claude", "shortcut chat");
assert(getTaskBackend("brief") === "claude", "shortcut brief");
assert(getTaskBackend("documents") === "claude", "shortcut documents");
assert(getTaskBackend("meetings") === "claude", "shortcut meetings");
assert(getTaskBackend("drafting") === "claude", "shortcut drafting");

applyTaskBackend("drafting", "haiku");
applyAllTasks("gemini");
assert(getTaskBackend("chat") === "gemini", "gemini shortcut chat");
assert(getTaskBackend("drafting") === "gemini", "gemini shortcut drafting");

const allFast = applyAllTasks("haiku");
assert(allFast.switched, "fast shortcut");
assert(getTaskBackend("chat") === "haiku", "shortcut chat haiku");
assert(getTaskBackend("drafting") === "haiku", "shortcut drafting haiku");

resetModelSettings();
setSetting(
  "llm_task_backends",
  JSON.stringify({
    chat: "cloud-gemma",
    brief: "cloud-gemma",
    documents: "cloud-gemma",
    meetings: "cloud-gemma",
    drafting: "haiku",
  }),
);
const flipped = getTaskBackends();
assert(flipped.chat === "haiku", "stuck Gemma chat resets to Haiku");
assert(flipped.brief === "haiku", "stuck Gemma brief resets to Haiku");
assert(flipped.documents === "haiku", "stuck Gemma documents reset to Haiku");
assert(flipped.meetings === "haiku", "stuck Gemma meetings reset to Haiku");
assert(flipped.drafting === "haiku", "drafting resets to Haiku");

resetModelSettings();
assert(getTaskEffort("chat") === "low", "default effort is low");
assert(getTaskEffort("drafting") === "low", "drafting effort defaults low");
assert(modelDisplayName("haiku") === "Haiku 5.5", "haiku display name");
assert(modelDisplayName("claude") === "Claude Sonnet 5.5", "sonnet display name");
assert(modelDisplayName("gemini") === "Gemini 3.6 Flash", "gemini display name");
assert(modelDisplayName("deepseek") === "DeepSeek Flash", "deepseek display name");
assert(isChatBackend("deepseek"), "deepseek is a chat backend");
assert(!supportsEffort("deepseek"), "deepseek has no Anthropic effort");

const saved = applyTaskChoice("chat", "haiku", "medium");
assert(saved.switched, "chat choice saves");
assert(getTaskEffort("chat") === "medium", "chat effort is medium");
assert(
  formatTaskSetupLine("chat") === "Chat and questions — Haiku 5.5 · medium",
  "chat setup line matches selection",
);

const allGemini = applyAllChoice("gemini");
assert(allGemini.switched, "set all gemini applies to every task");
assert(getTaskBackend("drafting") === "gemini", "drafting uses gemini too");
assert(
  formatModelSetupText({
    updatedTasks: ["chat"],
  }).includes("Chat and questions — Gemini 3.6 Flash ✅ updated"),
  "updated gemini line",
);

const allHaiku = applyAllChoice("haiku", "medium");
assert(allHaiku.switched, "set all haiku medium");
assert(getTaskBackend("drafting") === "haiku", "drafting is haiku after set all");
assert(getTaskEffort("documents") === "medium", "set all effort applies");
assert(
  formatModelSetupText().includes("Background scans — Haiku 5.5 (automatic)") ||
    formatModelSetupText().includes(
      "Background scans — DeepSeek Flash (automatic)",
    ),
  "background scans line",
);

resetModelSettings();
assert(getTaskBackend("chat") === "haiku", "cleanup restores Haiku default");
assert(getTaskEffort("chat") === "low", "cleanup restores low effort");

assert(TOOL_ORDER.includes("read_sheet"), "read_sheet stays in the cached tool list");
assert(
  Object.keys(tools).join(",") === TOOL_ORDER.join(","),
  "tool registry order matches TOOL_ORDER",
);
console.log("Per-task model checks passed.");
