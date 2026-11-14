import { config, type ModelCostRates } from "../config.js";
import type { LlmBackend } from "../llm_fallback.js";

/**
 * Every model Aadi can call, in one table. Business logic never names a model:
 * it asks for an agent's model (agent_models.ts) or a system task's model
 * (chat_backend.ts), and this table says what that model is, what it can do,
 * what it costs and whether its API key is present.
 *
 * Each entry is a stable slot ("openai:strong") whose exact model id comes from
 * the environment, so a provider renaming its models is an .env change, not a
 * code change, and a choice saved in Telegram survives it.
 */
export const PROVIDERS = ["openai", "anthropic", "gemini", "deepseek", "kimi"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  openai: "OpenAI",
  anthropic: "Claude",
  gemini: "Gemini",
  deepseek: "DeepSeek",
  kimi: "Kimi",
};

/** Where each provider's key lives. Keys stay in the environment, never in SQLite. */
export const PROVIDER_KEY_ENV: Record<ProviderId, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  kimi: "KIMI_API_KEY",
};

export interface ModelSpec {
  /** Stable id saved in settings: provider:slot. */
  key: string;
  provider: ProviderId;
  /** The exact id sent to the provider's API. */
  modelId: string;
  displayName: string;
  supportsTools: boolean;
  supportsStructuredOutput: boolean;
  supportsVision: boolean;
  supportsPdf: boolean;
  supportsReasoning: boolean;
  /** Takes a forced tool call (tool_choice). */
  forcesTools: boolean;
  contextTokens?: number;
  cost: ModelCostRates;
  /** Auto only: 1 fast and cheap, 2 balanced, 3 strongest. */
  quality: 1 | 2 | 3;
  /** DeepSeek's thinking mode is a request option, not a separate model id. */
  thinking?: boolean;
  /** The older backend name this slot answers for, so credit flags are shared. */
  legacyBackend?: LlmBackend;
}

function env(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function rate(name: string, fallback: number): number {
  const raw = env(name);
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }
  return value;
}

/** <PREFIX>_INPUT_COST_PER_MILLION and friends, each optional. */
function rates(prefix: string, input: number, output: number, cacheRead = 0, cacheWrite = 0): ModelCostRates {
  return {
    inputCostPerMillion: rate(`${prefix}_INPUT_COST_PER_MILLION`, input),
    outputCostPerMillion: rate(`${prefix}_OUTPUT_COST_PER_MILLION`, output),
    cacheCreationCostPerMillion: rate(`${prefix}_CACHE_CREATION_COST_PER_MILLION`, cacheWrite),
    cacheCreation1hCostPerMillion: rate(`${prefix}_CACHE_CREATION_1H_COST_PER_MILLION`, cacheWrite * 1.6),
    cacheReadCostPerMillion: rate(`${prefix}_CACHE_READ_COST_PER_MILLION`, cacheRead),
  };
}

type SlotInput = Omit<ModelSpec, "displayName"> & { displayName?: string };

function slot(input: SlotInput): ModelSpec {
  return { ...input, displayName: input.displayName || input.modelId };
}

/**
 * Rates are estimates for the /agents report and the goal budgets. Every one can
 * be overridden in .env (see .env.example); the provider's bill is the truth.
 */
function builtInSlots(): ModelSpec[] {
  const slots: ModelSpec[] = [
    slot({
      key: "openai:strong",
      provider: "openai",
      modelId: env("OPENAI_MODEL_STRONG") || "gpt-5.5",
      displayName: env("OPENAI_MODEL_STRONG_NAME"),
      supportsTools: true,
      supportsStructuredOutput: true,
      supportsVision: true,
      supportsPdf: true,
      supportsReasoning: true,
      forcesTools: true,
      contextTokens: 400_000,
      cost: rates("OPENAI_STRONG", 1.25, 10, 0.125),
      quality: 3,
    }),
    slot({
      key: "openai:fast",
      provider: "openai",
      modelId: env("OPENAI_MODEL_FAST") || "gpt-5.4-mini",
      displayName: env("OPENAI_MODEL_FAST_NAME"),
      supportsTools: true,
      supportsStructuredOutput: true,
      supportsVision: true,
      supportsPdf: true,
      supportsReasoning: true,
      forcesTools: true,
      contextTokens: 400_000,
      cost: rates("OPENAI_FAST", 0.25, 2, 0.025),
      quality: 1,
    }),
    slot({
      key: "anthropic:opus",
      provider: "anthropic",
      modelId: env("CLAUDE_OPUS_MODEL") || "claude-opus-5-5",
      displayName: env("CLAUDE_OPUS_MODEL_NAME") || "Claude Opus 5.5",
      supportsTools: true,
      supportsStructuredOutput: true,
      supportsVision: true,
      supportsPdf: true,
      supportsReasoning: true,
      // Forced tool use is rejected with a 400 on current Claude models.
      forcesTools: false,
      contextTokens: 200_000,
      cost: rates("CLAUDE_OPUS", 5, 25, 0.5, 6.25),
      quality: 3,
    }),
    slot({
      key: "anthropic:sonnet",
      provider: "anthropic",
      modelId: config.claudeModel || "claude-sonnet-5-5",
      displayName: env("CLAUDE_MODEL_NAME") || "Claude Sonnet 5.5",
      supportsTools: true,
      supportsStructuredOutput: true,
      supportsVision: true,
      supportsPdf: true,
      supportsReasoning: true,
      forcesTools: false,
      contextTokens: 200_000,
      cost: config.chatCostRates,
      quality: 2,
      legacyBackend: "claude",
    }),
    slot({
      key: "anthropic:haiku",
      provider: "anthropic",
      modelId: config.backgroundModel,
      displayName: env("BACKGROUND_MODEL_NAME") || "Claude Haiku 5.5",
      supportsTools: true,
      supportsStructuredOutput: true,
      supportsVision: true,
      supportsPdf: true,
      supportsReasoning: true,
      forcesTools: false,
      contextTokens: 200_000,
      cost: config.backgroundCostRates,
      quality: 1,
      legacyBackend: "haiku",
    }),
    slot({
      key: "gemini:flash",
      provider: "gemini",
      modelId: config.geminiModel,
      displayName: env("GEMINI_MODEL_NAME") || "Gemini Flash",
      supportsTools: true,
      supportsStructuredOutput: false,
      supportsVision: true,
      // PDFs only reach Gemini rendered as images (see toOpenAiUserContent).
      supportsPdf: false,
      supportsReasoning: true,
      forcesTools: true,
      contextTokens: 1_000_000,
      cost: config.geminiCostRates,
      quality: 1,
      legacyBackend: "gemini",
    }),
    slot({
      key: "deepseek:flash",
      provider: "deepseek",
      modelId: config.deepseekModel,
      displayName: env("DEEPSEEK_MODEL_NAME") || "DeepSeek Flash",
      supportsTools: true,
      supportsStructuredOutput: true,
      supportsVision: false,
      supportsPdf: false,
      supportsReasoning: false,
      forcesTools: true,
      contextTokens: 128_000,
      cost: config.deepseekCostRates,
      quality: 1,
      legacyBackend: "deepseek",
    }),
    slot({
      key: "deepseek:reasoner",
      provider: "deepseek",
      modelId: config.deepseekReasonerModel,
      displayName: env("DEEPSEEK_REASONER_MODEL_NAME") || "DeepSeek (thinking)",
      supportsTools: true,
      supportsStructuredOutput: true,
      supportsVision: false,
      supportsPdf: false,
      supportsReasoning: true,
      forcesTools: false,
      contextTokens: 128_000,
      cost: config.deepseekCostRates,
      quality: 2,
      thinking: true,
      legacyBackend: "deepseek-reasoner",
    }),
    slot({
      key: "kimi:main",
      provider: "kimi",
      modelId: env("KIMI_MODEL") || "kimi-k2.6",
      displayName: env("KIMI_MODEL_NAME"),
      supportsTools: true,
      supportsStructuredOutput: false,
      supportsVision: false,
      supportsPdf: false,
      supportsReasoning: false,
      // Kimi's OpenAI-compatible API does not take a forced tool_choice.
      forcesTools: false,
      contextTokens: 256_000,
      cost: rates("KIMI", 0.6, 2.5, 0.15),
      quality: 2,
    }),
  ];
  const geminiPro = env("GEMINI_PRO_MODEL");
  if (geminiPro) {
    slots.push(
      slot({
        key: "gemini:pro",
        provider: "gemini",
        modelId: geminiPro,
        displayName: env("GEMINI_PRO_MODEL_NAME") || "Gemini Pro",
        supportsTools: true,
        supportsStructuredOutput: false,
        supportsVision: true,
        supportsPdf: false,
        supportsReasoning: true,
        forcesTools: true,
        contextTokens: 1_000_000,
        cost: rates("GEMINI_PRO", 1.25, 10, 0.31),
        quality: 3,
      }),
    );
  }
  return slots;
}

/**
 * MODELS_EXTRA adds models without a code change: a comma-separated list of
 * provider/model-id, optionally with "=Display name" and "@1|2|3" for its class.
 * For example: MODELS_EXTRA=openai/gpt-6.1-sol=GPT-6.1 Sol@3,kimi/kimi-k3@3
 */
function extraSlots(): ModelSpec[] {
  const out: ModelSpec[] = [];
  for (const entry of env("MODELS_EXTRA").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const match = /^([a-z]+)\/([A-Za-z0-9._:-]+)(?:=([^@]+))?(?:@([123]))?$/.exec(trimmed);
    const provider = match?.[1] as ProviderId | undefined;
    if (!match || !provider || !(PROVIDERS as readonly string[]).includes(provider)) {
      throw new Error(`MODELS_EXTRA: "${trimmed}" must be provider/model-id[=Name][@1|2|3], provider one of ${PROVIDERS.join(", ")}.`);
    }
    const modelId = match[2]!;
    const slug = modelId.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24);
    const vision = provider === "openai" || provider === "anthropic" || provider === "gemini";
    out.push(
      slot({
        key: `${provider}:x-${slug}`,
        provider,
        modelId,
        displayName: match[3]?.trim() ?? "",
        supportsTools: true,
        supportsStructuredOutput: provider === "openai" || provider === "anthropic" || provider === "deepseek",
        supportsVision: vision,
        supportsPdf: provider === "openai" || provider === "anthropic",
        supportsReasoning: provider === "openai" || provider === "anthropic",
        forcesTools: provider === "openai" || provider === "gemini" || provider === "deepseek",
        cost: rates(`MODEL_${slug.toUpperCase().replace(/-/g, "_")}`, 1, 5),
        quality: Number(match[4] ?? 2) as 1 | 2 | 3,
      }),
    );
  }
  return out;
}

let cached: ModelSpec[] | undefined;

/** Every model this install knows about, available or not. */
export function listModels(): ModelSpec[] {
  cached ??= [...builtInSlots(), ...extraSlots()];
  return cached;
}

/** Tests change the environment and read the table again. */
export function reloadModelRegistryForTests(): void {
  cached = undefined;
}

export function getModel(key: string): ModelSpec | undefined {
  return listModels().find((spec) => spec.key === key);
}

/** The slot that calls this exact model id, if any. */
export function modelByModelId(modelId: string): ModelSpec | undefined {
  return listModels().find((spec) => spec.modelId === modelId);
}

export function providerApiKey(provider: ProviderId): string {
  if (provider === "kimi") {
    return env("KIMI_API_KEY") || env("MOONSHOT_API_KEY");
  }
  if (provider === "anthropic") {
    return config.anthropicApiKey;
  }
  if (provider === "gemini") {
    return config.geminiApiKey;
  }
  if (provider === "deepseek") {
    return config.deepseekApiKey;
  }
  return env(PROVIDER_KEY_ENV[provider]);
}

/** The key is in the environment. Says nothing about credit or outages. */
export function providerConfigured(provider: ProviderId): boolean {
  return providerApiKey(provider) !== "";
}

/** Configured models, optionally for one provider. */
export function availableModels(provider?: ProviderId): ModelSpec[] {
  return listModels().filter(
    (spec) => providerConfigured(spec.provider) && (provider === undefined || spec.provider === provider),
  );
}

/** "OpenAI / gpt-5.5" */
export function modelLabel(spec: ModelSpec | undefined): string {
  if (!spec) {
    return "none";
  }
  return `${PROVIDER_LABELS[spec.provider]} / ${spec.displayName}`;
}

/** The slot an older backend name maps to. */
export function modelForLegacyBackend(backend: string): ModelSpec | undefined {
  return listModels().find((spec) => spec.legacyBackend === backend);
}

/**
 * Cost rates for a model id that this table prices itself. The older models
 * (Sonnet, Haiku, Gemini Flash, DeepSeek) keep their rules in usage.ts, which
 * include peak hours and long-context pricing.
 */
export function registryRatesForModelId(modelId: string): ModelCostRates | undefined {
  const spec = modelByModelId(modelId);
  if (!spec || spec.legacyBackend) {
    return undefined;
  }
  return spec.cost;
}
