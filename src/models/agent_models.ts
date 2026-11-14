import { getTaskBackend } from "../chat_backend.js";
import { getSetting, setSetting } from "../db.js";
import { modelUnavailableReason } from "../llm_fallback.js";
import type { EffortLevel } from "../usage.js";
import {
  availableModels,
  getModel,
  listModels,
  modelForLegacyBackend,
  modelLabel,
  PROVIDERS,
  type ModelSpec,
} from "./registry.js";

/**
 * Which model each agent thinks with. This is the one place that answers the
 * question, and every path where an agent reasons asks it: Aadi's own turns, a
 * specialist's one-domain turn, a delegated goal, a resumed goal, and a goal
 * running after its dependencies came back. Code that needs no model (a direct
 * answer, a coded workflow) never asks.
 *
 * A model is a setting of the agent, not its identity: changing it changes
 * nothing about the agent's prompt, tools or permissions, which live in its
 * definition (src/agents/specialists) and the registry.
 */
export const MODEL_AGENT_IDS = ["aadi", "email", "calendar", "sales", "knowledge", "operations", "build"] as const;
export type ModelAgentId = (typeof MODEL_AGENT_IDS)[number];

export const AGENT_MODEL_LABELS: Record<ModelAgentId, string> = {
  aadi: "Aadi Orchestrator",
  email: "Email Agent",
  calendar: "Calendar Agent",
  sales: "Sales Agent",
  knowledge: "Knowledge Agent",
  operations: "Operations Agent",
  build: "Build Agent",
};

export const REASONING_TIERS = ["light", "standard", "deep"] as const;
export type ReasoningTier = (typeof REASONING_TIERS)[number];

export const AUTO = "auto";

export interface AgentModelSetting {
  /** A model key, or "auto". */
  primary: string;
  /** Model keys tried in order after the primary, or "auto". */
  fallbacks: string[] | typeof AUTO;
  tier: ReasoningTier;
}

const SETTING_KEY = "agent_models_v1";

/**
 * The first 7-day experiment spreads the agents across providers on purpose,
 * so their behaviour can be compared. AGENT_MODELS overrides any of it, and a
 * choice made in Telegram overrides both.
 */
const EXPERIMENT_DEFAULTS: Record<ModelAgentId, AgentModelSetting> = {
  aadi: { primary: "openai:strong", fallbacks: ["gemini:flash"], tier: "light" },
  email: { primary: "openai:fast", fallbacks: ["gemini:flash"], tier: "light" },
  calendar: { primary: "gemini:flash", fallbacks: ["openai:fast"], tier: "light" },
  sales: { primary: "anthropic:sonnet", fallbacks: ["openai:strong"], tier: "standard" },
  knowledge: { primary: "kimi:main", fallbacks: ["gemini:flash"], tier: "standard" },
  operations: { primary: "deepseek:flash", fallbacks: ["openai:fast"], tier: "light" },
  build: { primary: "openai:strong", fallbacks: ["anthropic:sonnet"], tier: "standard" },
};

export function isModelAgentId(value: string): value is ModelAgentId {
  return (MODEL_AGENT_IDS as readonly string[]).includes(value);
}

export function isReasoningTier(value: unknown): value is ReasoningTier {
  return typeof value === "string" && (REASONING_TIERS as readonly string[]).includes(value);
}

function validKey(key: string): boolean {
  return key === AUTO || getModel(key) !== undefined;
}

/**
 * AGENT_MODELS=aadi=openai:strong>gemini:flash@light,knowledge=auto
 * One entry per agent: primary, then ">" and each fallback, then "@" and a tier.
 * "auto" works for the primary or for the fallbacks.
 */
function parseEnvDefaults(): Partial<Record<ModelAgentId, AgentModelSetting>> {
  const out: Partial<Record<ModelAgentId, AgentModelSetting>> = {};
  // Older per-agent goal backends keep working, now for every path the agent reasons on.
  for (const entry of (process.env.AGENT_GOAL_AGENT_BACKENDS ?? "").split(",")) {
    const [rawId, rawBackend] = entry.split("=").map((part) => part?.trim().toLowerCase() ?? "");
    const spec = rawBackend ? modelForLegacyBackend(rawBackend) : undefined;
    if (rawId && isModelAgentId(rawId) && spec) {
      out[rawId] = { ...EXPERIMENT_DEFAULTS[rawId], primary: spec.key };
    }
  }
  for (const entry of (process.env.AGENT_MODELS ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const match = /^([a-z]+)=([^@]+?)(?:@(light|standard|deep))?$/.exec(trimmed);
    const id = match?.[1] ?? "";
    if (!match || !isModelAgentId(id)) {
      throw new Error(`AGENT_MODELS: "${trimmed}" must be agent=model[>fallback...][@tier], agent one of ${MODEL_AGENT_IDS.join(", ")}.`);
    }
    const [primary, ...rest] = match[2]!.split(">").map((part) => part.trim());
    const fallbacks: string[] | typeof AUTO = rest.length === 1 && rest[0] === AUTO ? AUTO : rest.filter(Boolean);
    for (const key of [primary!, ...(fallbacks === AUTO ? [] : fallbacks)]) {
      if (!validKey(key)) {
        throw new Error(`AGENT_MODELS: "${key}" is not a known model (${listModels().map((spec) => spec.key).join(", ")}, auto).`);
      }
    }
    out[id] = {
      primary: primary!,
      fallbacks,
      tier: (match[3] as ReasoningTier | undefined) ?? EXPERIMENT_DEFAULTS[id].tier,
    };
  }
  return out;
}

function readStored(): Partial<Record<ModelAgentId, AgentModelSetting>> {
  const raw = getSetting(SETTING_KEY);
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, Partial<AgentModelSetting>>;
    const out: Partial<Record<ModelAgentId, AgentModelSetting>> = {};
    for (const id of MODEL_AGENT_IDS) {
      const entry = parsed[id];
      if (!entry || typeof entry.primary !== "string") {
        continue;
      }
      out[id] = {
        primary: entry.primary,
        fallbacks:
          entry.fallbacks === AUTO
            ? AUTO
            : Array.isArray(entry.fallbacks)
              ? entry.fallbacks.filter((key): key is string => typeof key === "string")
              : [],
        tier: isReasoningTier(entry.tier) ? entry.tier : EXPERIMENT_DEFAULTS[id].tier,
      };
    }
    return out;
  } catch {
    return {};
  }
}

/** What the agent is set to: Telegram's choice, else AGENT_MODELS, else the defaults. */
export function getAgentModelSetting(agentId: string): AgentModelSetting {
  const id: ModelAgentId = isModelAgentId(agentId) ? agentId : "aadi";
  return readStored()[id] ?? parseEnvDefaults()[id] ?? EXPERIMENT_DEFAULTS[id];
}

export function getAllAgentModelSettings(): Record<ModelAgentId, AgentModelSetting> {
  return Object.fromEntries(MODEL_AGENT_IDS.map((id) => [id, getAgentModelSetting(id)])) as Record<
    ModelAgentId,
    AgentModelSetting
  >;
}

/** Saved in SQLite, so it survives a restart. Only model keys are stored, never keys to an API. */
export function setAgentModelSetting(agentId: ModelAgentId, change: Partial<AgentModelSetting>): AgentModelSetting {
  const current = getAgentModelSetting(agentId);
  const next: AgentModelSetting = {
    primary: change.primary ?? current.primary,
    fallbacks: change.fallbacks ?? current.fallbacks,
    tier: change.tier ?? current.tier,
  };
  for (const key of [next.primary, ...(next.fallbacks === AUTO ? [] : next.fallbacks)]) {
    if (!validKey(key)) {
      throw new Error(`Unknown model ${key}.`);
    }
  }
  if (next.fallbacks !== AUTO) {
    next.fallbacks = next.fallbacks.filter((key, index, all) => key !== next.primary && all.indexOf(key) === index);
  }
  const stored = readStored();
  stored[agentId] = next;
  setSetting(SETTING_KEY, JSON.stringify(stored));
  return next;
}

/** Forgets Telegram's choices, back to AGENT_MODELS or the defaults. */
export function resetAgentModelSettings(): void {
  setSetting(SETTING_KEY, "{}");
}

export function effortForTier(tier: ReasoningTier): EffortLevel {
  return tier === "deep" ? "high" : tier === "standard" ? "medium" : "low";
}

const WANTED_QUALITY: Record<ReasoningTier, 1 | 2 | 3> = { light: 1, standard: 2, deep: 3 };

export interface ModelNeeds {
  vision?: boolean;
  pdf?: boolean;
  tools?: boolean;
  structuredOutput?: boolean;
}

function fits(spec: ModelSpec, needs: ModelNeeds): boolean {
  return (
    (!needs.tools || spec.supportsTools) &&
    (!needs.vision || spec.supportsVision) &&
    (!needs.pdf || spec.supportsPdf) &&
    (!needs.structuredOutput || spec.supportsStructuredOutput)
  );
}

function blendedCost(spec: ModelSpec): number {
  return spec.cost.inputCostPerMillion * 3 + spec.cost.outputCostPerMillion;
}

/**
 * Auto: the usable models that can do the job, best fit for the tier first.
 * A closer quality class wins; then the cheaper one, which is also the faster
 * one at the same class.
 */
export function autoRank(tier: ReasoningTier, needs: ModelNeeds, exclude: ReadonlySet<string> = new Set()): ModelSpec[] {
  const wanted = WANTED_QUALITY[tier];
  return availableModels()
    .filter((spec) => !exclude.has(spec.key) && fits(spec, needs) && modelUnavailableReason(spec) === undefined)
    .sort(
      (left, right) =>
        Math.abs(left.quality - wanted) - Math.abs(right.quality - wanted) ||
        // At the same distance, deep prefers the stronger model and light the lighter one.
        (wanted >= 2 ? right.quality - left.quality : left.quality - right.quality) ||
        blendedCost(left) - blendedCost(right) ||
        PROVIDERS.indexOf(left.provider) - PROVIDERS.indexOf(right.provider),
    );
}

export interface ResolvedAgentModel {
  agentId: string;
  mode: "fixed" | "auto";
  tier: ReasoningTier;
  effort: EffortLevel;
  /** What the setting asked for, in order (auto expanded). */
  requested: string[];
  /** The models to try, in order. Usable when resolved; the call checks again. */
  models: ModelSpec[];
  /** Asked for but not tried, and why. */
  skipped: Array<{ key: string; reason: string }>;
  /** True when nothing the agent asked for is usable and the system model stands in. */
  safetyNet: boolean;
}

/**
 * The canonical answer to "which model does this agent reason with right now".
 * A tier passed in (a goal's complexity) replaces the agent's own tier for this
 * one run: it picks the model in Auto and the reasoning effort otherwise.
 */
export function resolveAgentModel(
  agentId: string,
  options: { tier?: ReasoningTier; needs?: ModelNeeds } = {},
): ResolvedAgentModel {
  const setting = getAgentModelSetting(agentId);
  const tier = options.tier ?? setting.tier;
  const needs: ModelNeeds = { tools: true, ...options.needs };
  const requested: string[] = [];
  const models: ModelSpec[] = [];
  const skipped: Array<{ key: string; reason: string }> = [];
  const seen = new Set<string>();
  const add = (spec: ModelSpec | undefined, key: string): void => {
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    requested.push(key);
    if (!spec) {
      skipped.push({ key, reason: "not in the model registry" });
      return;
    }
    const unavailable = modelUnavailableReason(spec);
    if (unavailable) {
      skipped.push({ key, reason: unavailable });
      return;
    }
    if (!fits(spec, needs)) {
      skipped.push({ key, reason: "can't do what this run needs" });
      return;
    }
    models.push(spec);
  };

  const auto = setting.primary === AUTO;
  if (auto) {
    const ranked = autoRank(tier, needs);
    const first = ranked[0];
    if (first) {
      add(first, first.key);
    }
  } else {
    add(getModel(setting.primary), setting.primary);
  }
  if (setting.fallbacks === AUTO) {
    // Prefer a different provider for the fallback, so one outage can't take out both.
    const used = new Set(models.map((spec) => spec.provider));
    const ranked = autoRank(tier, needs, seen);
    const ordered = [...ranked.filter((spec) => !used.has(spec.provider)), ...ranked.filter((spec) => used.has(spec.provider))];
    for (const spec of ordered.slice(0, 2)) {
      add(spec, spec.key);
    }
  } else {
    for (const key of setting.fallbacks) {
      add(getModel(key), key);
    }
  }

  let safetyNet = false;
  if (models.length === 0) {
    // Nothing the agent asked for can run: the system chat model, then anything that can.
    safetyNet = true;
    const system = modelForLegacyBackend(getTaskBackend("chat"));
    if (system && !seen.has(system.key) && modelUnavailableReason(system) === undefined && fits(system, needs)) {
      models.push(system);
      seen.add(system.key);
    }
    for (const spec of autoRank(tier, needs, seen).slice(0, 2 - Math.min(models.length, 2))) {
      models.push(spec);
    }
  }
  return {
    agentId,
    mode: auto ? "auto" : "fixed",
    tier,
    effort: effortForTier(tier),
    requested,
    models,
    skipped,
    safetyNet,
  };
}

/** "OpenAI / gpt-5.5" or "Auto". */
export function settingLabel(key: string): string {
  return key === AUTO ? "Auto" : modelLabel(getModel(key)) + (getModel(key) ? "" : ` (${key})`);
}

export function fallbackLabel(setting: AgentModelSetting): string {
  if (setting.fallbacks === AUTO) {
    return "Auto";
  }
  return setting.fallbacks.length === 0 ? "none" : setting.fallbacks.map(settingLabel).join(", then ");
}

/** One line per agent for logs and /health: what it is set to and what it will use now. */
export function agentModelSummary(): string[] {
  return MODEL_AGENT_IDS.map((id) => {
    const setting = getAgentModelSetting(id);
    const resolved = resolveAgentModel(id);
    const now = resolved.models[0];
    const using = now && now.key !== setting.primary ? ` (using ${now.key}${resolved.safetyNet ? ", safety net" : ""})` : "";
    const fallbacks = setting.fallbacks === AUTO ? AUTO : setting.fallbacks.join(">") || "none";
    return `${id}=${setting.primary}>${fallbacks}@${setting.tier}${using}`;
  });
}
