import { config, type LlmProvider } from "./config.js";
import { getSetting, setSetting } from "./db.js";
import type { EffortLevel } from "./usage.js";

const TASK_SETTING = "llm_task_backends";
const EFFORT_SETTING = "llm_task_efforts";
const LEGACY_SETTING = "llm_backend";

export type ChatBackend = LlmProvider | "haiku" | "deepseek" | "gemini";
export type ModelTask =
  | "chat"
  | "brief"
  | "documents"
  | "meetings"
  | "drafting";

export const MODEL_TASKS: ModelTask[] = [
  "chat",
  "brief",
  "documents",
  "meetings",
  "drafting",
];

export const TASK_LABELS: Record<ModelTask, string> = {
  chat: "Chat and questions",
  brief: "Morning brief and weekly review",
  documents: "Documents (PDFs, contracts, RFPs)",
  meetings: "Meeting briefs and account status",
  drafting: "Email drafting",
};

export const TASK_BUTTON_LABELS: Record<ModelTask, string> = {
  chat: "Chat",
  brief: "Brief",
  documents: "Documents",
  meetings: "Meetings",
  drafting: "Drafting",
};

export const EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high"];

export type TaskBackendMap = Record<ModelTask, ChatBackend>;
export type TaskEffortMap = Record<ModelTask, EffortLevel>;

export function isChatBackend(value: string): value is ChatBackend {
  return (
    value === "claude" ||
    value === "haiku" ||
    value === "gemini" ||
    value === "deepseek"
  );
}

export function isModelTask(value: string): value is ModelTask {
  return (MODEL_TASKS as string[]).includes(value);
}

export function isEffortLevel(value: string): value is EffortLevel {
  return value === "low" || value === "medium" || value === "high";
}

export function supportsEffort(backend: ChatBackend): boolean {
  return backend === "claude" || backend === "haiku";
}

export function modelDisplayName(backend: ChatBackend): string {
  if (backend === "haiku") {
    return "Haiku 5.5";
  }
  if (backend === "claude") {
    return "Claude Sonnet 5.5";
  }
  if (backend === "deepseek") {
    return "DeepSeek Flash";
  }
  return "Gemini 3.6 Flash";
}

const DEFAULTS_GENERATION = "v3-gemini-migration";
const GENERATION_SETTING = "llm_task_defaults_generation";

function defaultChoices(): TaskBackendMap {
  return {
    chat: "haiku",
    brief: "haiku",
    documents: "haiku",
    meetings: "haiku",
    drafting: "haiku",
  };
}

function persist(choices: TaskBackendMap): void {
  setSetting(TASK_SETTING, JSON.stringify(choices));
}

function migrateIfNeeded(): TaskBackendMap {
  const raw = getSetting(TASK_SETTING);
  let choices = defaultChoices();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const task of MODEL_TASKS) {
        const value = parsed[task];
        if (typeof value === "string" && isChatBackend(value)) {
          choices[task] = value;
        }
      }
    } catch {
      choices = defaultChoices();
    }
  } else {
    const legacy = getSetting(LEGACY_SETTING);
    if (legacy && isChatBackend(legacy)) {
      choices.chat = legacy;
      choices.brief = legacy;
      choices.meetings = legacy;
    }
  }
  const generation = getSetting(GENERATION_SETTING);
  if (generation !== DEFAULTS_GENERATION) {
    // One-time: wipe stuck cloud-gemma (and any other saved backends) and
    // restore Haiku defaults so Gemini can be chosen fresh.
    choices = defaultChoices();
    persist(choices);
    setSetting(GENERATION_SETTING, DEFAULTS_GENERATION);
    return choices;
  }
  if (!raw) {
    persist(choices);
  }
  return choices;
}

export function getTaskBackends(): TaskBackendMap {
  return migrateIfNeeded();
}

export function getTaskBackend(task: ModelTask): ChatBackend {
  return getTaskBackends()[task];
}

/** Chat-task backend. Prefer getTaskBackend for a specific task. */
export function getChatBackend(): ChatBackend {
  return getTaskBackend("chat");
}

export function chatBackendLabel(backend: ChatBackend): string {
  return modelDisplayName(backend);
}

function defaultEfforts(): TaskEffortMap {
  return {
    chat: "low",
    brief: "low",
    documents: "low",
    meetings: "low",
    drafting: "low",
  };
}

function persistEfforts(efforts: TaskEffortMap): void {
  setSetting(EFFORT_SETTING, JSON.stringify(efforts));
}

function loadEfforts(): TaskEffortMap {
  const efforts = defaultEfforts();
  const raw = getSetting(EFFORT_SETTING);
  if (!raw) {
    persistEfforts(efforts);
    return efforts;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const task of MODEL_TASKS) {
      const value = parsed[task];
      if (typeof value === "string" && isEffortLevel(value)) {
        efforts[task] = value;
      }
    }
  } catch {
    persistEfforts(efforts);
    return efforts;
  }
  return efforts;
}

export function getTaskEfforts(): TaskEffortMap {
  return loadEfforts();
}

export function getTaskEffort(task: ModelTask): EffortLevel {
  return getTaskEfforts()[task];
}

export function setTaskEffort(task: ModelTask, effort: EffortLevel): void {
  const efforts = getTaskEfforts();
  efforts[task] = effort;
  persistEfforts(efforts);
}

export function applyAllEfforts(effort: EffortLevel): void {
  const efforts = defaultEfforts();
  for (const task of MODEL_TASKS) {
    efforts[task] = effort;
  }
  persistEfforts(efforts);
}

/** Effort to send to Anthropic for this task. Gemma has none. */
export function apiEffortForTask(task: ModelTask): EffortLevel | undefined {
  if (!supportsEffort(getTaskBackend(task))) {
    return undefined;
  }
  return getTaskEffort(task);
}

export function formatTaskSetupLine(task: ModelTask): string {
  const backend = getTaskBackend(task);
  if (!supportsEffort(backend)) {
    return `${TASK_LABELS[task]} — ${modelDisplayName(backend)}`;
  }
  return `${TASK_LABELS[task]} — ${modelDisplayName(backend)} · ${getTaskEffort(task)}`;
}

export function formatModelSetupText(options?: {
  updatedTasks?: ModelTask[];
}): string {
  const updated = new Set(options?.updatedTasks ?? []);
  const lines = ["Model setup"];
  for (const task of MODEL_TASKS) {
    const suffix = updated.has(task) ? " ✅ updated" : "";
    lines.push(`${formatTaskSetupLine(task)}${suffix}`);
  }
  lines.push(
    config.deepseekApiKey
      ? "Background scans — DeepSeek Flash (automatic)"
      : "Background scans — Haiku 5.5 (automatic)",
  );
  return lines.join("\n");
}

function backendNeedsKey(backend: ChatBackend): string | undefined {
  if (backend === "gemini" && !config.geminiApiKey) {
    return "Gemini 3.6 Flash needs GEMINI_API_KEY in .env.";
  }
  if (backend === "deepseek" && !config.deepseekApiKey) {
    return "DeepSeek Flash needs DEEPSEEK_API_KEY in .env.";
  }
  return undefined;
}

export function setTaskBackend(task: ModelTask, backend: ChatBackend): void {
  const choices = getTaskBackends();
  choices[task] = backend;
  persist(choices);
}

export function applyTaskBackend(
  task: ModelTask,
  backend: ChatBackend,
): { switched: boolean; message: string } {
  const blocked = backendNeedsKey(backend);
  if (blocked) {
    return { switched: false, message: blocked };
  }
  setTaskBackend(task, backend);
  const name = TASK_LABELS[task];
  return {
    switched: true,
    message: `${name}: ${chatBackendLabel(backend)}`,
  };
}

export function applyTaskChoice(
  task: ModelTask,
  backend: ChatBackend,
  effort?: EffortLevel,
): { switched: boolean; message: string } {
  const result = applyTaskBackend(task, backend);
  if (!result.switched) {
    return result;
  }
  if (supportsEffort(backend) && effort) {
    setTaskEffort(task, effort);
  }
  return {
    switched: true,
    message: formatTaskSetupLine(task),
  };
}

export function applyAllChoice(
  backend: ChatBackend,
  effort?: EffortLevel,
): {
  switched: boolean;
  message: string;
  updatedTasks: ModelTask[];
} {
  const blocked = backendNeedsKey(backend);
  if (blocked) {
    return {
      switched: false,
      message: blocked,
      updatedTasks: [],
    };
  }
  applyAllTasks(backend);
  if (effort) {
    applyAllEfforts(effort);
  }
  return {
    switched: true,
    message: formatModelSetupText({ updatedTasks: [...MODEL_TASKS] }),
    updatedTasks: [...MODEL_TASKS],
  };
}

/** /model claude|fast|gemini: every task, including drafting. */
export function applyAllTasks(backend: ChatBackend): {
  switched: boolean;
  message: string;
} {
  const blocked = backendNeedsKey(backend);
  if (blocked) {
    return { switched: false, message: blocked };
  }
  const choices = getTaskBackends();
  for (const task of MODEL_TASKS) {
    choices[task] = backend;
  }
  persist(choices);
  return {
    switched: true,
    message:
      backend === "claude"
        ? "All tasks now use Claude (Sonnet 5.5)."
        : backend === "haiku"
          ? "All tasks now use Fast (Haiku 5.5)."
          : backend === "deepseek"
            ? "All tasks now use DeepSeek Flash."
            : "All tasks now use Gemini 3.6 Flash.",
  };
}
