import { InlineKeyboard, type Context } from "grammy";
import {
  AGENT_MODEL_LABELS,
  AUTO,
  fallbackLabel,
  getAgentModelSetting,
  MODEL_AGENT_IDS,
  REASONING_TIERS,
  resolveAgentModel,
  setAgentModelSetting,
  settingLabel,
  type ModelAgentId,
  type ReasoningTier,
} from "./models/agent_models.js";
import {
  availableModels,
  getModel,
  PROVIDER_KEY_ENV,
  PROVIDER_LABELS,
  PROVIDERS,
  providerConfigured,
  type ProviderId,
} from "./models/registry.js";

/**
 * /settings -> Agent models. One screen per agent: primary model, fallback,
 * Auto, and reasoning tier. Choosing a model changes only which model the agent
 * thinks with; its prompt, tools and permissions stay what they are. Choices
 * are saved in SQLite. API keys stay in .env and are never asked for here.
 */
const PROVIDER_CODE: Record<ProviderId, string> = { openai: "o", anthropic: "c", gemini: "g", deepseek: "d", kimi: "k" };
const PROVIDER_FROM_CODE: Record<string, ProviderId> = { o: "openai", c: "anthropic", g: "gemini", d: "deepseek", k: "kimi" };

type Role = "p" | "f";

function agentAt(index: string | undefined): ModelAgentId | undefined {
  const value = Number(index);
  return Number.isInteger(value) ? MODEL_AGENT_IDS[value] : undefined;
}

function indexOf(agent: ModelAgentId): number {
  return MODEL_AGENT_IDS.indexOf(agent);
}

function inEffectNote(agent: ModelAgentId): string {
  const setting = getAgentModelSetting(agent);
  const resolved = resolveAgentModel(agent);
  const now = resolved.models[0];
  if (!now) {
    return "Now: no model with an API key can run this agent.";
  }
  if (setting.primary === AUTO) {
    return `Now: Auto picks ${settingLabel(now.key)}.`;
  }
  if (now.key !== setting.primary) {
    const why = resolved.skipped.find((item) => item.key === setting.primary)?.reason ?? "unavailable";
    return `Now: ${settingLabel(now.key)} (primary ${why}).`;
  }
  return "";
}

export function agentBlock(agent: ModelAgentId): string {
  const setting = getAgentModelSetting(agent);
  const note = inEffectNote(agent);
  return [
    AGENT_MODEL_LABELS[agent],
    `Primary: ${settingLabel(setting.primary)}`,
    `Fallback: ${fallbackLabel(setting)}`,
    `Reasoning tier: ${setting.tier}`,
    note,
  ]
    .filter(Boolean)
    .join("\n");
}

export function agentModelsText(): string {
  return ["Agent Models", "", ...MODEL_AGENT_IDS.map((agent) => agentBlock(agent)).join("\n\n").split("\n")].join("\n");
}

function homeKeyboard(): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  MODEL_AGENT_IDS.forEach((agent, index) => {
    keyboard.text(AGENT_MODEL_LABELS[agent].replace(" Agent", ""), `am:a:${index}`);
    if (index % 2 === 1) {
      keyboard.row();
    }
  });
  keyboard.row().text("Advanced models", "am:adv").row().text("Close", "am:x");
  return keyboard;
}

function agentKeyboard(agent: ModelAgentId): InlineKeyboard {
  const i = indexOf(agent);
  const setting = getAgentModelSetting(agent);
  return new InlineKeyboard()
    .text("Primary model", `am:p:${i}:p`)
    .text("Fallback model", `am:p:${i}:f`)
    .row()
    .text(setting.primary === AUTO ? "✅ Auto" : "Auto", `am:auto:${i}`)
    .text("Reasoning tier", `am:t:${i}`)
    .row()
    .text("‹ Back", "am:h");
}

function providerKeyboard(agent: ModelAgentId, role: Role): InlineKeyboard {
  const i = indexOf(agent);
  const keyboard = new InlineKeyboard();
  PROVIDERS.forEach((provider, index) => {
    const label = providerConfigured(provider) ? PROVIDER_LABELS[provider] : `${PROVIDER_LABELS[provider]} (no key)`;
    keyboard.text(label, `am:m:${i}:${role}:${PROVIDER_CODE[provider]}`);
    if (index % 2 === 1) {
      keyboard.row();
    }
  });
  keyboard.row();
  if (role === "f") {
    const setting = getAgentModelSetting(agent);
    keyboard
      .text(setting.fallbacks === AUTO ? "✅ Auto" : "Auto", `am:fa:${i}`)
      .text(setting.fallbacks !== AUTO && setting.fallbacks.length === 0 ? "✅ None" : "None", `am:fn:${i}`)
      .row();
  }
  keyboard.text("‹ Back", `am:a:${i}`);
  return keyboard;
}

function modelKeyboard(agent: ModelAgentId, role: Role, provider: ProviderId): InlineKeyboard {
  const i = indexOf(agent);
  const setting = getAgentModelSetting(agent);
  const current = role === "p" ? [setting.primary] : setting.fallbacks === AUTO ? [] : setting.fallbacks;
  const keyboard = new InlineKeyboard();
  for (const spec of availableModels(provider)) {
    const mark = current.includes(spec.key) ? "✅ " : "";
    keyboard.text(`${mark}${spec.displayName}`, `am:s:${i}:${role}:${spec.key}`).row();
  }
  keyboard.text("‹ Back", `am:p:${i}:${role}`);
  return keyboard;
}

function tierKeyboard(agent: ModelAgentId): InlineKeyboard {
  const i = indexOf(agent);
  const current = getAgentModelSetting(agent).tier;
  const keyboard = new InlineKeyboard();
  for (const tier of REASONING_TIERS) {
    keyboard.text(`${tier === current ? "✅ " : ""}${tier[0]!.toUpperCase()}${tier.slice(1)}`, `am:ts:${i}:${tier}`);
  }
  return keyboard.row().text("‹ Back", `am:a:${i}`);
}

async function editPanel(ctx: Context, text: string, keyboard: InlineKeyboard): Promise<void> {
  try {
    await ctx.editMessageText(text, { reply_markup: keyboard });
  } catch {
    await ctx.editMessageReplyMarkup({ reply_markup: keyboard }).catch(() => undefined);
  }
}

export async function sendAgentModelsPanel(ctx: Context): Promise<void> {
  await ctx.reply(agentModelsText(), { reply_markup: homeKeyboard() });
}

const TIER_HELP =
  "Light: quick answers, least reasoning. Standard: the default. Deep: most reasoning, slowest. On Auto it also picks a stronger or lighter model.";

/** Returns false when the callback isn't for this panel. */
export async function handleAgentModelCallback(
  ctx: Context,
  openAdvanced: (ctx: Context) => Promise<void>,
): Promise<boolean> {
  const data = ctx.callbackQuery?.data ?? "";
  if (!data.startsWith("am:")) {
    return false;
  }
  const parts = data.split(":");
  const action = parts[1];
  const agent = agentAt(parts[2]);

  if (action === "x") {
    await ctx.answerCallbackQuery();
    await editPanel(ctx, agentModelsText(), new InlineKeyboard());
    return true;
  }
  if (action === "h") {
    await ctx.answerCallbackQuery();
    await editPanel(ctx, agentModelsText(), homeKeyboard());
    return true;
  }
  if (action === "adv") {
    await ctx.answerCallbackQuery();
    await openAdvanced(ctx);
    return true;
  }
  if (!agent) {
    await ctx.answerCallbackQuery();
    return true;
  }
  if (action === "a") {
    await ctx.answerCallbackQuery();
    await editPanel(ctx, agentBlock(agent), agentKeyboard(agent));
    return true;
  }
  if (action === "p") {
    const role = parts[3] === "f" ? "f" : "p";
    await ctx.answerCallbackQuery();
    await editPanel(
      ctx,
      `${AGENT_MODEL_LABELS[agent]}\n${role === "p" ? "Primary model" : "Fallback model"}\n\nChoose a provider.`,
      providerKeyboard(agent, role),
    );
    return true;
  }
  if (action === "m") {
    const role = parts[3] === "f" ? "f" : "p";
    const provider = PROVIDER_FROM_CODE[parts[4] ?? ""];
    if (!provider) {
      await ctx.answerCallbackQuery();
      return true;
    }
    if (!providerConfigured(provider)) {
      await ctx.answerCallbackQuery(`${PROVIDER_LABELS[provider]} has no API key. Add ${PROVIDER_KEY_ENV[provider]} to .env.`);
      return true;
    }
    await ctx.answerCallbackQuery();
    await editPanel(
      ctx,
      `${AGENT_MODEL_LABELS[agent]}\n${role === "p" ? "Primary" : "Fallback"}: ${PROVIDER_LABELS[provider]}\n\nChoose a model.`,
      modelKeyboard(agent, role, provider),
    );
    return true;
  }
  if (action === "s") {
    const role = parts[3] === "f" ? "f" : "p";
    const key = parts.slice(4).join(":");
    const spec = getModel(key);
    if (!spec || !providerConfigured(spec.provider)) {
      await ctx.answerCallbackQuery("That model isn't available.");
      return true;
    }
    setAgentModelSetting(agent, role === "p" ? { primary: key } : { fallbacks: [key] });
    await ctx.answerCallbackQuery("Saved");
    await editPanel(ctx, `${agentBlock(agent)}\n✅ updated`, agentKeyboard(agent));
    return true;
  }
  if (action === "auto") {
    const setting = getAgentModelSetting(agent);
    const turningOn = setting.primary !== AUTO;
    // Auto is about the model only. Tools, prompt and permissions don't change.
    setAgentModelSetting(agent, turningOn ? { primary: AUTO, fallbacks: AUTO } : { primary: resolveAgentModel(agent).models[0]?.key ?? setting.primary });
    await ctx.answerCallbackQuery(turningOn ? "Auto on" : "Auto off");
    await editPanel(ctx, `${agentBlock(agent)}\n✅ updated`, agentKeyboard(agent));
    return true;
  }
  if (action === "fa" || action === "fn") {
    setAgentModelSetting(agent, { fallbacks: action === "fa" ? AUTO : [] });
    await ctx.answerCallbackQuery("Saved");
    await editPanel(ctx, `${agentBlock(agent)}\n✅ updated`, agentKeyboard(agent));
    return true;
  }
  if (action === "t") {
    await ctx.answerCallbackQuery();
    await editPanel(ctx, `${AGENT_MODEL_LABELS[agent]}\nReasoning tier: ${getAgentModelSetting(agent).tier}\n\n${TIER_HELP}`, tierKeyboard(agent));
    return true;
  }
  if (action === "ts") {
    const tier = parts[3] as ReasoningTier;
    if (!(REASONING_TIERS as readonly string[]).includes(tier)) {
      await ctx.answerCallbackQuery();
      return true;
    }
    setAgentModelSetting(agent, { tier });
    await ctx.answerCallbackQuery("Saved");
    await editPanel(ctx, `${agentBlock(agent)}\n✅ updated`, agentKeyboard(agent));
    return true;
  }
  await ctx.answerCallbackQuery();
  return true;
}
