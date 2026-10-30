import { getTaskBackend } from "./chat_backend.js";
import { config } from "./config.js";
import { complete, type CompleteParams, type CompleteResult } from "./llm.js";

function isCreditError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /credit balance is too low/i.test(text);
}

export async function completeForJob(
  params: Omit<CompleteParams, "backend"> & { backend?: CompleteParams["backend"] },
): Promise<CompleteResult> {
  const preferred = params.backend ?? getTaskBackend("documents");
  try {
    return await complete({ ...params, backend: preferred });
  } catch (error) {
    if (
      config.deepseekApiKey &&
      preferred !== "deepseek" &&
      isCreditError(error)
    ) {
      console.error("Job LLM: Anthropic credit too low; using deepseek.");
      return await complete({
        ...params,
        backend: "deepseek",
        jsonSchema: undefined,
      });
    }
    throw error;
  }
}
