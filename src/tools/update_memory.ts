import type { LlmTool } from "../llm.js";
import { getMemory, updateMemory } from "../db.js";
import { isMemoryCategory, isSensitiveMemoryText } from "../memory_logic.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "update_memory",
  description:
    "Update an existing long-term memory by id. Use when a saved fact changed (a demo moved, a deal stage changed).",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "Memory id." },
      content: { type: "string" },
      category: {
        type: "string",
        enum: ["deal", "plan", "event", "person", "preference", "other"],
      },
      tag: { type: "string", enum: ["work", "personal"] },
      event_date: {
        type: "string",
        description: "YYYY-MM-DD, or empty to clear.",
      },
    },
    required: ["id"],
  },
};

export function handler(input: unknown): string {
  const values = input as {
    id?: unknown;
    content?: unknown;
    category?: unknown;
    tag?: unknown;
    event_date?: unknown;
  };
  if (
    typeof values.id !== "number" ||
    !Number.isSafeInteger(values.id) ||
    values.id <= 0
  ) {
    throw new Error("id must be a positive integer.");
  }
  if (!getMemory(values.id)) {
    throw new Error(`Memory ${values.id} was not found.`);
  }
  if (typeof values.content === "string" && isSensitiveMemoryText(values.content)) {
    throw new Error(
      "I don't store passwords, OTPs, card or account numbers, or health details.",
    );
  }
  const updated = updateMemory(values.id, {
    content: typeof values.content === "string" ? values.content.trim() : undefined,
    category:
      typeof values.category === "string" && isMemoryCategory(values.category)
        ? values.category
        : undefined,
    tag: values.tag === "work" || values.tag === "personal" ? values.tag : undefined,
    eventDate:
      values.event_date === ""
        ? null
        : typeof values.event_date === "string" &&
            /^\d{4}-\d{2}-\d{2}$/.test(values.event_date)
          ? values.event_date
          : undefined,
  });
  return JSON.stringify({ id: updated?.id, updated: true });
}
