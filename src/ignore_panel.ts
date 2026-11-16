import { InlineKeyboard, type Context } from "grammy";
import {
  formatIgnoreRule,
  labelForRule,
  resumeAllIgnoreRules,
  resumeIgnore,
} from "./ignore.js";
import { listActiveIgnoreRules } from "./db.js";

export function ignoredItemsCaption(): string {
  const rules = listActiveIgnoreRules();
  if (rules.length === 0) {
    return "Ignored Items\n\nNothing is currently ignored.";
  }
  const lines = rules.map((rule, index) => {
    const scope = rule.tag === "both" ? "Both" : rule.tag === "work" ? "Work" : "Personal";
    const duration =
      rule.duration === "temporary" && rule.expires_at
        ? `Until ${rule.expires_at.slice(0, 10)}`
        : "Permanent";
    return `${index + 1}. ${labelForRule(rule)} | ${scope} | ${duration}`;
  });
  return ["Ignored Items", "", ...lines].join("\n");
}

export function ignoredItemsKeyboard(): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const rules = listActiveIgnoreRules();
  for (const rule of rules) {
    keyboard
      .text(`Resume: ${labelForRule(rule).slice(0, 28)}`, `ign:r:${rule.id}`)
      .row();
  }
  if (rules.length > 1) {
    keyboard.text("Resume all", "ign:all").row();
  }
  keyboard.text("Back to settings", "ign:back");
  return keyboard;
}

export async function sendIgnoredItemsPanel(ctx: Context): Promise<void> {
  await ctx.reply(ignoredItemsCaption(), {
    reply_markup: ignoredItemsKeyboard(),
  });
}

async function editIgnoredPanel(ctx: Context, text?: string): Promise<void> {
  try {
    await ctx.editMessageText(text ?? ignoredItemsCaption(), {
      reply_markup: ignoredItemsKeyboard(),
    });
  } catch {
    await ctx.reply(text ?? ignoredItemsCaption(), {
      reply_markup: ignoredItemsKeyboard(),
    });
  }
}

export async function handleIgnorePanelCallback(
  ctx: Context,
  data: string,
): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const authRef = `telegram:callback:${ctx.from?.id ?? 0}:${ctx.callbackQuery?.id ?? ""}`;
  if (data === "ign:back") {
    return;
  }
  if (data === "ign:all") {
    const rules = listActiveIgnoreRules();
    if (rules.length === 0) {
      await editIgnoredPanel(ctx);
      return;
    }
    const preview =
      "Resume all ignored items?\n\n" +
      rules.map((rule) => `• ${formatIgnoreRule(rule)}`).join("\n");
    const keyboard = new InlineKeyboard()
      .text("Confirm resume all", "ign:all:yes")
      .row()
      .text("Cancel", "ign:list");
    try {
      await ctx.editMessageText(preview, { reply_markup: keyboard });
    } catch {
      await ctx.reply(preview, { reply_markup: keyboard });
    }
    return;
  }
  if (data === "ign:all:yes") {
    resumeAllIgnoreRules(authRef, "telegram:resume-all");
    await editIgnoredPanel(ctx, "Resumed all ignored items.\n\n" + ignoredItemsCaption());
    return;
  }
  if (data === "ign:list") {
    await editIgnoredPanel(ctx);
    return;
  }
  const match = /^ign:r:(\d+)$/.exec(data);
  if (!match) {
    return;
  }
  const id = Number(match[1]);
  const rule = resumeIgnore(id, authRef, "telegram:resume");
  const line = rule
    ? `${labelForRule(rule)} resumed.`
    : "That item is no longer ignored.";
  await editIgnoredPanel(ctx, `${line}\n\n${ignoredItemsCaption()}`);
}
