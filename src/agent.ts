import type {
  LlmMessage,
  LlmTool,
  ToolCall,
} from "./llm.js";
import { readFile } from "node:fs/promises";
import { getRecentMessages, saveMessage } from "./db.js";
import { complete } from "./llm.js";
import { recentUploadLine } from "./recent_upload.js";
import { tools as customTools } from "./tools/index.js";

const TIME_ZONE = "Asia/Kolkata";
const MAX_ITERATIONS = 8;

const webSearchTool: LlmTool = {
  type: "web_search",
  maxUses: 5,
};

const toolDefinitions: LlmTool[] = [
  ...Object.values(customTools).map((tool) => tool.definition),
  webSearchTool,
];

function formatCurrentTime(): string {
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "full",
    timeStyle: "long",
    timeZone: TIME_ZONE,
  }).format(new Date());
}

async function runTool(
  call: ToolCall,
): Promise<Extract<LlmMessage, { role: "tool" }>> {
  const tool = customTools[call.name];

  if (!tool) {
    return {
      role: "tool",
      toolCallId: call.id,
      content: `Unknown tool: ${call.name}`,
      isError: true,
    };
  }

  try {
    const result = await tool.handler(call.input);
    return {
      role: "tool",
      toolCallId: call.id,
      content: result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      role: "tool",
      toolCallId: call.id,
      content: `Tool failed: ${message}`,
      isError: true,
    };
  }
}

function saveConversation(
  userText: string,
  reply: string,
  saveUserMessage: boolean,
  saveAssistantMessage: boolean,
): string {
  if (saveUserMessage) {
    saveMessage("user", userText);
  }
  if (saveAssistantMessage) {
    saveMessage("assistant", reply);
  }
  return reply;
}

export interface RunAgentOptions {
  saveUserMessage?: boolean;
  saveAssistantMessage?: boolean;
}

export async function runAgent(
  userText: string,
  options: RunAgentOptions = {},
): Promise<string> {
  const saveUserMessage = options.saveUserMessage ?? true;
  const saveAssistantMessage = options.saveAssistantMessage ?? true;
  const promptUrl = new URL("../prompts/system.md", import.meta.url);
  const basePrompt = await readFile(promptUrl, "utf8");
  const recentUpload = recentUploadLine();
  const system = {
    cacheable: basePrompt.trim(),
    dynamic: `Current date and time in ${TIME_ZONE}: ${formatCurrentTime()}${recentUpload ? `\n${recentUpload}` : ""}`,
  };

  const messages: LlmMessage[] = getRecentMessages().map((message) =>
    message.role === "user"
      ? { role: "user", content: message.content }
      : {
          role: "assistant",
          textParts: [message.content],
          toolCalls: [],
        },
  );
  messages.push({ role: "user", content: userText });

  const collectedText: string[] = [];

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration += 1) {
    const response = await complete({
      system,
      tools: toolDefinitions,
      messages,
    });

    const responseText = response.textParts.join("\n").trim();
    if (responseText) {
      collectedText.push(responseText);
    }

    const calledTools = response.toolCalls.map((call) => call.name);
    const cacheCreationTokens = response.usage.cacheCreationInputTokens ?? 0;
    const cacheReadTokens = response.usage.cacheReadInputTokens ?? 0;

    console.log(
      `Agent iteration ${iteration}: tools=[${calledTools.join(", ")}], input_tokens=${response.usage.inputTokens}, output_tokens=${response.usage.outputTokens}, cache_creation_input_tokens=${cacheCreationTokens}, cache_read_input_tokens=${cacheReadTokens}, estimated_cost_usd=${response.usage.estimatedCostUsd.toFixed(6)}`,
    );

    if (response.stopReason === "tool_use") {
      const clientToolCalls = response.toolCalls.filter(
        (call) => call.execution === "client",
      );
      if (clientToolCalls.length === 0) {
        throw new Error("LLM requested tool use without a client tool call.");
      }

      // Independent calls can arrive together and are all executed. Consecutive
      // tool messages are serialized by the Claude adapter as one user message
      // containing every matching tool_result block. Calls that depend on an
      // earlier result are left for the model to request on a later iteration.
      const toolResults = await Promise.all(clientToolCalls.map(runTool));
      messages.push({
        role: "assistant",
        textParts: response.textParts,
        toolCalls: response.toolCalls,
      });
      messages.push(...toolResults);
      continue;
    }

    if (response.stopReason === "pause_turn") {
      const partialReply =
        collectedText.join("\n\n") || "I couldn't finish the request.";
      return saveConversation(
        userText,
        `${partialReply}\n\nNote: the server-side tool continuation limit was reached.`,
        saveUserMessage,
        saveAssistantMessage,
      );
    }

    const finalReply =
      responseText ||
      collectedText.at(-1) ||
      "I couldn't produce a text response.";
    return saveConversation(
      userText,
      finalReply,
      saveUserMessage,
      saveAssistantMessage,
    );
  }

  const partialReply =
    collectedText.join("\n\n") || "I couldn't finish the request.";
  return saveConversation(
    userText,
    `${partialReply}\n\nNote: I hit the 8-iteration safety limit.`,
    saveUserMessage,
    saveAssistantMessage,
  );
}
