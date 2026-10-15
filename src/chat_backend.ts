import { config, type LlmProvider } from "./config.js";
import { getSetting, setSetting } from "./db.js";

const TASK_SETTING = "llm_task_backends";
const LEGACY_SETTING = "llm_backend";

export type ChatBackend = LlmProvider | "haiku";
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
  documents: "Documents (PDFs and photos)",
  meetings: "Meeting briefs and account status",
  drafting: "Email drafting",
};

export type TaskBackendMap = Record<ModelTask, ChatBackend>;

export function isChatBackend(value: string): value is ChatBackend {
  return value === "claude" || value === "haiku" || value === "cloud-gemma";
}

export function isModelTask(value: string): value is ModelTask {
  return (MODEL_TASKS as string[]).includes(value);
}

const DEFAULTS_GENERATION = "haiku-low-all";
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
    // One-time: old implicit default was Claude. Flip remaining Claude
    // tasks to Haiku. Keep explicit Gemma (or already-Haiku) choices.
    for (const task of MODEL_TASKS) {
      if (choices[task] === "claude") {
        choices[task] = "haiku";
      }
    }
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
  if (backend === "haiku") {
    return "Fast (Haiku 5.5)";
  }
  return backend === "claude" ? "Claude (Sonnet 5.5)" : "cloud Gemma";
}

function gemmaNeedsKey(backend: ChatBackend): string | undefined {
  if (backend === "cloud-gemma" && !config.openRouterApiKey) {
    return "cloud Gemma needs OPENROUTER_API_KEY in .env.";
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
  const blocked = gemmaNeedsKey(backend);
  if (blocked) {
    return { switched: false, message: blocked };
  }
  setTaskBackend(task, backend);
  const name = TASK_LABELS[task];
  if (task === "drafting" && backend === "cloud-gemma") {
    return {
      switched: true,
      message: `${name}: cloud Gemma (not recommended). Drafts still need your Send tap.`,
    };
  }
  return {
    switched: true,
    message: `${name}: ${chatBackendLabel(backend)}`,
  };
}

/** /model claude|fast: every task, including drafting. */
export function applyAllTasks(backend: ChatBackend): {
  switched: boolean;
  message: string;
} {
  const blocked = gemmaNeedsKey(backend);
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
          : "All tasks now use cloud Gemma. Drafts still need your Send tap.",
  };
}

/** /model gemma: every task except email drafting. */
export function applyAllTasksExceptDrafting(backend: ChatBackend): {
  switched: boolean;
  message: string;
} {
  const blocked = gemmaNeedsKey(backend);
  if (blocked) {
    return { switched: false, message: blocked };
  }
  const choices = getTaskBackends();
  for (const task of MODEL_TASKS) {
    if (task !== "drafting") {
      choices[task] = backend;
    }
  }
  persist(choices);
  return {
    switched: true,
    message:
      "Chat, briefs, documents and meetings now use cloud Gemma. Email drafting is unchanged.",
  };
}
