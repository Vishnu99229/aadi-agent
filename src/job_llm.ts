import { getTaskBackend } from "./chat_backend.js";
import {
  completeWithCreditFallback,
  type CompleteParams,
  type CompleteResult,
} from "./llm.js";

export async function completeForJob(
  params: Omit<CompleteParams, "backend"> & { backend?: CompleteParams["backend"] },
): Promise<CompleteResult> {
  return completeWithCreditFallback({
    ...params,
    backend: params.backend ?? getTaskBackend("documents"),
  });
}
