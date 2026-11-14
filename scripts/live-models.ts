/**
 * Asks each provider that has a key in .env for its model list and says whether
 * every model id in Aadi's registry is on it. Read-only: no completion is made,
 * nothing is spent, and no key is printed.
 *
 *   npm run live:models
 */
import { listModels, PROVIDER_LABELS, PROVIDERS, providerApiKey, type ProviderId } from "../src/models/registry.ts";
import { agentModelSummary } from "../src/models/agent_models.ts";

const BASES: Record<ProviderId, () => string> = {
  openai: () => process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1",
  anthropic: () => `${process.env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com"}/v1`,
  gemini: () => (process.env.GEMINI_BASE_URL?.trim() || "https://generativelanguage.googleapis.com/v1beta/openai/").replace(/\/+$/, ""),
  deepseek: () => process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com",
  kimi: () => process.env.KIMI_BASE_URL?.trim() || "https://api.moonshot.ai/v1",
};

async function modelIds(provider: ProviderId, key: string): Promise<string[]> {
  const headers: Record<string, string> =
    provider === "anthropic" ? { "x-api-key": key, "anthropic-version": "2023-06-01" } : { Authorization: `Bearer ${key}` };
  const query = provider === "anthropic" ? "?limit=1000" : "";
  const response = await fetch(`${BASES[provider]()}/models${query}`, { headers });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const body = (await response.json()) as { data?: Array<{ id?: string }> };
  return (body.data ?? []).map((item) => String(item.id ?? "").replace(/^models\//, ""));
}

let problems = 0;
for (const provider of PROVIDERS) {
  const key = providerApiKey(provider);
  const mine = listModels().filter((spec) => spec.provider === provider);
  if (!key) {
    console.log(`${PROVIDER_LABELS[provider]}: no key (${mine.map((spec) => spec.key).join(", ")} unavailable)`);
    continue;
  }
  try {
    const ids = new Set(await modelIds(provider, key));
    for (const spec of mine) {
      const found = ids.has(spec.modelId);
      problems += found ? 0 : 1;
      console.log(`${PROVIDER_LABELS[provider]}: ${spec.key} -> ${spec.modelId} ${found ? "listed" : "NOT LISTED (set its env var to a listed id)"}`);
    }
  } catch (error) {
    problems += 1;
    console.log(`${PROVIDER_LABELS[provider]}: could not list models (${error instanceof Error ? error.message : String(error)})`);
  }
}
console.log(`\nAgent models: ${agentModelSummary().join(" ")}`);
process.exit(problems > 0 ? 1 : 0);
