import { InlineKeyboard, type Context } from "grammy";
import {
  applyAllChoice,
  applyTaskChoice,
  formatModelSetupText,
  getTaskBackend,
  getTaskEffort,
  MODEL_TASKS,
  modelDisplayName,
  supportsEffort,
  TASK_BUTTON_LABELS,
  TASK_LABELS,
  type ChatBackend,
  type ModelTask,
} from "./chat_backend.js";
import type { EffortLevel } from "./usage.js";

const TASK_CODE: Record<ModelTask, string> = {
  chat: "chat",
  brief: "brief",
  documents: "docs",
  meetings: "meet",
  drafting: "draft",
};

const TASK_FROM_CODE: Record<string, ModelTask> = {
  chat: "chat",
  brief: "brief",
  docs: "documents",
  meet: "meetings",
  draft: "drafting",
};

const BACKEND_CODE: Record<ChatBackend, string> = {
  haiku: "h",
  claude: "c",
  deepseek: "d",
  "cloud-gemma": "g",
};

const BACKEND_FROM_CODE: Record<string, ChatBackend> = {
  h: "haiku",
  c: "claude",
  d: "deepseek",
  g: "cloud-gemma",
};

const EFFORT_CODE: Record<EffortLevel, string> = {
  low: "l",
  medium: "m",
  high: "h",
};

const EFFORT_FROM_CODE: Record<string, EffortLevel> = {
  l: "low",
  m: "medium",
  h: "high",
};

const MODEL_ORDER: ChatBackend[] = ["haiku", "claude", "deepseek", "cloud-gemma"];
const EFFORT_ORDER: EffortLevel[] = ["low", "medium", "high"];

function emptyKeyboard(): InlineKeyboard {
  return new InlineKeyboard();
}

function homeKeyboard(): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const row = MODEL_TASKS.slice(0, 3);
  const rest = MODEL_TASKS.slice(3);
  for (const task of row) {
    keyboard.text(TASK_BUTTON_LABELS[task], `md:t:${TASK_CODE[task]}`);
  }
  keyboard.row();
  for (const task of rest) {
    keyboard.text(TASK_BUTTON_LABELS[task], `md:t:${TASK_CODE[task]}`);
  }
  keyboard
    .row()
    .text("Set all to…", "md:a")
    .row()
    .text("Close", "md:x");
  return keyboard;
}

function modelButtonLabel(backend: ChatBackend, current: ChatBackend): string {
  const mark = backend === current ? "✅ " : "";
  return `${mark}${modelDisplayName(backend)}`;
}

function modelsKeyboard(
  current: ChatBackend,
  prefix: "t" | "a",
  taskCode?: string,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const backend of MODEL_ORDER) {
    const data =
      prefix === "a"
        ? `md:ab:${BACKEND_CODE[backend]}`
        : `md:b:${taskCode}:${BACKEND_CODE[backend]}`;
    keyboard.text(modelButtonLabel(backend, current), data).row();
  }
  keyboard.text("‹ Back", "md:h");
  return keyboard;
}

function effortKeyboard(
  current: EffortLevel,
  prefix: "t" | "a",
  backendCode: string,
  taskCode?: string,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const effort of EFFORT_ORDER) {
    const mark = effort === current ? "✅ " : "";
    const label = `${mark}${effort[0]!.toUpperCase()}${effort.slice(1)}`;
    const data =
      prefix === "a"
        ? `md:ae:${backendCode}:${EFFORT_CODE[effort]}`
        : `md:e:${taskCode}:${backendCode}:${EFFORT_CODE[effort]}`;
    keyboard.text(label, data).row();
  }
  const back =
    prefix === "a" ? "md:a" : `md:t:${taskCode}`;
  keyboard.text("‹ Back", back);
  return keyboard;
}

async function editPanel(
  ctx: Context,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  const markup = keyboard ?? emptyKeyboard();
  try {
    await ctx.editMessageText(text, { reply_markup: markup });
  } catch {
    await ctx
      .editMessageReplyMarkup({ reply_markup: markup })
      .catch(() => undefined);
  }
}

function taskPickerText(task: ModelTask): string {
  return `${TASK_LABELS[task]}\nCurrent: ${formatTaskCurrent(task)}\n\nChoose a model.`;
}

function formatTaskCurrent(task: ModelTask): string {
  const backend = getTaskBackend(task);
  if (!supportsEffort(backend)) {
    return backend === "cloud-gemma"
      ? "Gemma 4 31B (no effort setting)"
      : modelDisplayName(backend);
  }
  return `${modelDisplayName(backend)} · ${getTaskEffort(task)}`;
}

function effortPickerText(task: ModelTask, backend: ChatBackend): string {
  return `${TASK_LABELS[task]}\n${modelDisplayName(backend)}\n\nChoose effort.`;
}

export async function sendModelPanel(ctx: Context): Promise<void> {
  await ctx.reply(formatModelSetupText(), { reply_markup: homeKeyboard() });
}

export async function handleModelCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  if (!data.startsWith("md:")) {
    return;
  }

  if (data === "md:x") {
    await ctx.answerCallbackQuery();
    await editPanel(ctx, formatModelSetupText());
    return;
  }

  if (data === "md:h") {
    await ctx.answerCallbackQuery();
    await editPanel(ctx, formatModelSetupText(), homeKeyboard());
    return;
  }

  if (data === "md:a") {
    await ctx.answerCallbackQuery();
    await editPanel(
      ctx,
      "Set all use cases\nGemma never applies to email drafting.\n\nChoose a model.",
      modelsKeyboard(getTaskBackend("chat"), "a"),
    );
    return;
  }

  const taskMatch = /^md:t:(\w+)$/.exec(data);
  if (taskMatch) {
    const task = TASK_FROM_CODE[taskMatch[1] ?? ""];
    if (!task) {
      await ctx.answerCallbackQuery();
      return;
    }
    await ctx.answerCallbackQuery();
    await editPanel(
      ctx,
      taskPickerText(task),
      modelsKeyboard(getTaskBackend(task), "t", TASK_CODE[task]),
    );
    return;
  }

  const backendMatch = /^md:b:(\w+):([chgd])$/.exec(data);
  if (backendMatch) {
    const task = TASK_FROM_CODE[backendMatch[1] ?? ""];
    const backend = BACKEND_FROM_CODE[backendMatch[2] ?? ""];
    if (!task || !backend) {
      await ctx.answerCallbackQuery();
      return;
    }
    if (!supportsEffort(backend)) {
      const result = applyTaskChoice(task, backend);
      await ctx.answerCallbackQuery(
        result.switched ? "Saved" : result.message.slice(0, 200),
      );
      if (!result.switched) {
        return;
      }
      await editPanel(ctx, formatModelSetupText({ updatedTasks: [task] }));
      return;
    }
    await ctx.answerCallbackQuery();
    await editPanel(
      ctx,
      effortPickerText(task, backend),
      effortKeyboard(
        getTaskEffort(task),
        "t",
        BACKEND_CODE[backend],
        TASK_CODE[task],
      ),
    );
    return;
  }

  const effortMatch = /^md:e:(\w+):([ch]):([lmh])$/.exec(data);
  if (effortMatch) {
    const task = TASK_FROM_CODE[effortMatch[1] ?? ""];
    const backend = BACKEND_FROM_CODE[effortMatch[2] ?? ""];
    const effort = EFFORT_FROM_CODE[effortMatch[3] ?? ""];
    if (!task || !backend || !effort) {
      await ctx.answerCallbackQuery();
      return;
    }
    const result = applyTaskChoice(task, backend, effort);
    await ctx.answerCallbackQuery(
      result.switched ? "Saved" : result.message.slice(0, 200),
    );
    if (!result.switched) {
      return;
    }
    await editPanel(ctx, formatModelSetupText({ updatedTasks: [task] }));
    return;
  }

  const allBackendMatch = /^md:ab:([chgd])$/.exec(data);
  if (allBackendMatch) {
    const backend = BACKEND_FROM_CODE[allBackendMatch[1] ?? ""];
    if (!backend) {
      await ctx.answerCallbackQuery();
      return;
    }
    if (!supportsEffort(backend)) {
      const result = applyAllChoice(backend);
      await ctx.answerCallbackQuery(
        result.switched ? "Saved" : result.message.slice(0, 200),
      );
      if (!result.switched) {
        return;
      }
      await editPanel(
        ctx,
        formatModelSetupText({
          updatedTasks: result.updatedTasks,
          gemmaSkippedDrafting: result.gemmaSkippedDrafting,
        }),
      );
      return;
    }
    await ctx.answerCallbackQuery();
    await editPanel(
      ctx,
      `Set all use cases\n${modelDisplayName(backend)}\n\nChoose effort.`,
      effortKeyboard(getTaskEffort("chat"), "a", BACKEND_CODE[backend]),
    );
    return;
  }

  const allEffortMatch = /^md:ae:([ch]):([lmh])$/.exec(data);
  if (allEffortMatch) {
    const backend = BACKEND_FROM_CODE[allEffortMatch[1] ?? ""];
    const effort = EFFORT_FROM_CODE[allEffortMatch[2] ?? ""];
    if (!backend || !effort) {
      await ctx.answerCallbackQuery();
      return;
    }
    const result = applyAllChoice(backend, effort);
    await ctx.answerCallbackQuery(
      result.switched ? "Saved" : result.message.slice(0, 200),
    );
    if (!result.switched) {
      return;
    }
    await editPanel(
      ctx,
      formatModelSetupText({ updatedTasks: result.updatedTasks }),
    );
    return;
  }

  await ctx.answerCallbackQuery();
}
