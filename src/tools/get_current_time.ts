import type { LlmTool } from "../llm.js";

const TIME_ZONE = "Asia/Kolkata";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "get_current_time",
  description:
    "Get the current date, time, and weekday in Vishnu's timezone, Asia/Kolkata.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

export function handler(): string {
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "full",
    timeStyle: "long",
    timeZone: TIME_ZONE,
  }).format(new Date());
}
