import { config, type LlmProvider } from "./config.js";
import { getSetting, setSetting } from "./db.js";

const TASK_SETTING = "llm_task_backends";
const LEGACY_SETTING = "llm_backend";

export type ChatBackend = LlmProvider;
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
  return value === "claude" || value === "cloud-gemma";
}

export function isModelTask(value: string): value is ModelTask {
  return (MODEL_TASKS as string[]).includes(value);
}

function defaultChoices(): TaskBackendMap {
  return {
    chat: "claude",
    brief: "claude",
    documents: "claude",
    meetings: "claude",
    drafting: "claude",
  };
}

function persist(choices: TaskBackendMap): void {
  setSetting(TASK_SETTING, JSON.stringify(choices));
}

function migrateIfNeeded(): TaskBackendMap {
  const raw = getSetting(TASK_SETTING);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const choices = defaultChoices();
      for (const task of MODEL_TASKS) {
        const value = parsed[task];
        if (typeof value === "string" && isChatBackend(value)) {
          choices[task] = value;
        }
      }
      return choices;
    } catch {
      // fall through to legacy
    }
  }
  const choices = defaultChoices();
  const legacy = getSetting(LEGACY_SETTING);
  if (legacy && isChatBackend(legacy)) {
    // Old global switch drove chat and anything that used getChatBackend()
    // (morning brief). Documents and drafting were pinned to Claude.
    choices.chat = legacy;
    choices.brief = legacy;
    choices.meetings = legacy;
  }
  persist(choices);
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
  return backend === "claude" ? "Claude" : "cloud Gemma";
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

/** /model claude and /model gemma: every task except email drafting. */
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
      backend === "claude"
        ? "Chat, briefs, documents and meetings now use Claude. Email drafting is unchanged."
        : "Chat, briefs, documents and meetings now use cloud Gemma. Email drafting is unchanged.",
  };
}
