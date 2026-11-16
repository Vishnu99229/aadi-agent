import type { LlmTool } from "../llm.js";
import { formatIgnoreRule } from "../ignore.js";
import { listActiveIgnoreRules } from "../db.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "list_ignored",
  description:
    "List what Vishnu has asked Aadi to ignore. Does not resume anything. Use when he asks what is ignored, or before resuming an item.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

export function handler(): string {
  const rules = listActiveIgnoreRules();
  if (rules.length === 0) {
    return "Nothing is currently ignored.";
  }
  return rules
    .map(
      (rule, index) =>
        `${index + 1}. ${formatIgnoreRule(rule)} (id ${rule.id}, ${rule.entity_type})`,
    )
    .join("\n");
}
