import type { LlmTool } from "../llm.js";
import type { ToolTurn } from "./index.js";

/**
 * Writes up a code change as a build request and shows Vishnu the Start /
 * Cancel card. It never starts the Cursor agent: only his Start tap does, and
 * merging and deploying keep their own gates in builds.ts.
 */
export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "prepare_build",
  description:
    "Prepare a Cursor build request for a code change Vishnu asked for, and show him a card with Start and Cancel. Nothing starts until he taps Start. Only call it when his own message asks for a code change to be made; never to review, explain or check something.",
  inputSchema: {
    type: "object",
    properties: {
      request: {
        type: "string",
        description:
          "The build request for the Cursor agent: what to change, the affected files or components, the risks to watch, and how to test it.",
      },
    },
    required: ["request"],
  },
};

/**
 * His words have to ask for a change. A review or an explanation is not one,
 * and "build" or "change" as nouns ("the last failed build", "the code
 * change") are not requests.
 */
const CHANGE_REQUEST = [
  /\b(?:fix|implement|add|refactor|rename|bump|upgrade|patch|rewrite|replace|remove|update|create)\b/i,
  /\bmake\b(?!\s+sure)/i,
  /\bchange\s+(?:the|it|this|that|how|aadi|my|its)\b/i,
  /\bbuild\s+(?:a|an|me|it|this|that|the\s+fix|support)\b/i,
];

export function asksForCodeChange(ownerWords: string): boolean {
  return CHANGE_REQUEST.some((pattern) => pattern.test(ownerWords));
}

export async function handler(input: unknown, turn: ToolTurn): Promise<string> {
  const request = String((input as { request?: unknown } | undefined)?.request ?? "").trim();
  if (!request) {
    throw new Error("request must say what to change.");
  }
  const ownerWords = turn.userText ?? "";
  if (!asksForCodeChange(ownerWords)) {
    return "Not done: Vishnu's message doesn't ask for a code change, so no build was prepared. Report your findings instead.";
  }
  const { config } = await import("../config.js");
  const { isBuildConfigured } = await import("../build_logic.js");
  if (!isBuildConfigured(config.cursorApiKey, config.githubToken)) {
    return "Not done: builds aren't set up (CURSOR_API_KEY and GITHUB_TOKEN).";
  }
  const { prepareBuildCard } = await import("../builds.js");
  const prepared = await prepareBuildCard(request.slice(0, 4000));
  return prepared.posted
    ? `Prepared build #${prepared.buildId}. A card with Start and Cancel was sent to Vishnu. Nothing runs until he taps Start.`
    : `Prepared build #${prepared.buildId}, but the card couldn't be sent. It is waiting in /jobs; nothing runs until he taps Start.`;
}
