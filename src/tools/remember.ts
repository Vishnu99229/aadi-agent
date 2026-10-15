import type { LlmTool } from "../llm.js";
import { isMemoryCategory } from "../memory_logic.js";
import { saveMemoryFromTool } from "../memory.js";
import type { ItemTag } from "../db.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "remember",
  description:
    "Save one long-term fact. Use when Vishnu asks to remember something, or when a durable fact should persist across chats. Do not store passwords, OTPs, card/account numbers, or health details. If this updates an existing fact, still call remember with the new wording; duplicates are merged.",
  inputSchema: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "One clear fact in a short sentence.",
      },
      category: {
        type: "string",
        enum: ["deal", "plan", "event", "person", "preference", "other"],
      },
      tag: {
        type: "string",
        enum: ["work", "personal"],
      },
      event_date: {
        type: "string",
        description: "Optional YYYY-MM-DD in Asia/Kolkata when the fact is dated.",
      },
    },
    required: ["content", "category", "tag"],
  },
};

export function handler(input: unknown): string {
  const values = input as {
    content?: unknown;
    category?: unknown;
    tag?: unknown;
    event_date?: unknown;
  };
  if (typeof values.content !== "string" || !values.content.trim()) {
    throw new Error("content must be a non-empty fact.");
  }
  if (typeof values.category !== "string" || !isMemoryCategory(values.category)) {
    throw new Error("category must be deal, plan, event, person, preference, or other.");
  }
  if (values.tag !== "work" && values.tag !== "personal") {
    throw new Error('tag must be "work" or "personal".');
  }
  let eventDate: string | null = null;
  if (values.event_date !== undefined && values.event_date !== null && values.event_date !== "") {
    if (
      typeof values.event_date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(values.event_date)
    ) {
      throw new Error("event_date must be YYYY-MM-DD.");
    }
    eventDate = values.event_date;
  }
  return saveMemoryFromTool({
    content: values.content,
    category: values.category,
    tag: values.tag as ItemTag,
    eventDate,
  });
}
