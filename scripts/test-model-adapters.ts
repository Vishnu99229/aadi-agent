/**
 * The five provider adapters against a local stand-in for each provider's HTTP
 * API: OpenAI's Responses API, Anthropic's Messages API, and the
 * OpenAI-compatible chat APIs of Gemini, DeepSeek and Kimi. Checks what each
 * adapter sends (model id, tools, reasoning, provider state carried between
 * steps) and how it reads the answer back. Then the route: a provider that
 * fails with an auth error is paused and the next model answers.
 *
 * Nothing leaves the machine: every base URL points at 127.0.0.1.
 */
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

if (process.env.AADI_DB_PATH !== ":memory:") {
  throw new Error("test-model-adapters.ts must run with AADI_DB_PATH=:memory:");
}

const log = console.log;
console.log = () => undefined;
console.error = () => undefined;

type Body = Record<string, unknown>;
const requests: Array<{ path: string; body: Body; auth: string }> = [];
let openaiFails = false;

function readBody(request: IncomingMessage): Promise<Body> {
  return new Promise((resolve) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => {
      raw += chunk.toString();
    });
    request.on("end", () => resolve(raw ? (JSON.parse(raw) as Body) : {}));
  });
}

function chatCompletion(body: Body, provider: string): Body {
  const messages = body.messages as Array<Record<string, unknown>>;
  const last = messages.at(-1)!;
  if (last.role === "tool") {
    return {
      id: "c2",
      object: "chat.completion",
      model: body.model,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: `${provider} read: ${String(last.content)}` } }],
      usage: { prompt_tokens: 50, completion_tokens: 10 },
    };
  }
  return {
    id: "c1",
    object: "chat.completion",
    model: body.model,
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          ...(provider === "kimi" ? { reasoning_content: "Kimi thought about it." } : {}),
          tool_calls: [
            {
              id: `${provider}-call-1`,
              type: "function",
              function: { name: "get_current_time", arguments: "{}" },
              ...(provider === "gemini" ? { extra_content: { google: { thought_signature: "sig-from-gemini" } } } : {}),
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 40, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 0 } },
  };
}

const server = createServer(async (request, response) => {
  const body = await readBody(request);
  const path = request.url ?? "";
  requests.push({ path, body, auth: String(request.headers.authorization ?? request.headers["x-api-key"] ?? "") });
  response.setHeader("Content-Type", "application/json");
  if (path === "/openai/v1/responses") {
    if (openaiFails) {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: { message: "Incorrect API key provided", type: "invalid_request_error" } }));
      return;
    }
    const input = body.input as Array<Record<string, unknown>>;
    const output = input.some((item) => item.type === "function_call_output")
      ? [{ type: "message", id: "msg_2", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OpenAI read the time.", annotations: [] }] }]
      : [
          { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "ENCRYPTED-REASONING" },
          { type: "function_call", id: "fc_1", call_id: "call_openai_1", name: "get_current_time", arguments: "{}", status: "completed" },
        ];
    response.end(
      JSON.stringify({
        id: "resp_1",
        object: "response",
        status: "completed",
        model: body.model,
        output,
        usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 30 }, output_tokens_details: { reasoning_tokens: 12 } },
      }),
    );
    return;
  }
  if (path === "/anthropic/v1/messages") {
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    const toolResult = JSON.stringify(messages.at(-1)?.content ?? "").includes("tool_result");
    response.end(
      JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: body.model,
        content: toolResult
          ? [{ type: "text", text: "Claude read the time." }]
          : [{ type: "tool_use", id: "toolu_1", name: "get_current_time", input: {} }],
        stop_reason: toolResult ? "end_turn" : "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 60, output_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      }),
    );
    return;
  }
  for (const provider of ["gemini", "deepseek", "kimi"]) {
    if (path === `/${provider}/chat/completions`) {
      response.end(JSON.stringify(chatCompletion(body, provider)));
      return;
    }
  }
  response.statusCode = 404;
  response.end("{}");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

Object.assign(process.env, {
  OPENAI_API_KEY: "test-openai-key",
  OPENAI_BASE_URL: `${base}/openai/v1`,
  OPENAI_MODEL_STRONG: "gpt-test-strong",
  ANTHROPIC_BASE_URL: `${base}/anthropic`,
  GEMINI_API_KEY: "test-gemini-key",
  GEMINI_BASE_URL: `${base}/gemini/`,
  DEEPSEEK_API_KEY: "test-deepseek-key",
  DEEPSEEK_BASE_URL: `${base}/deepseek`,
  KIMI_API_KEY: "test-kimi-key",
  KIMI_BASE_URL: `${base}/kimi`,
  KIMI_MODEL: "kimi-test",
});

// Imported after the environment is set: provider keys are read at startup.
const { complete, completeWithModel, resetProviderClientsForTests } = await import("../src/llm.ts");
const { getModel } = await import("../src/models/registry.ts");
const { clearLlmBackendFlagsForTests, isProviderFlagged } = await import("../src/llm_fallback.ts");
type LlmMessage = import("../src/llm.ts").LlmMessage;
type CompleteParams = import("../src/llm.ts").CompleteParams;
resetProviderClientsForTests();

const TOOL = {
  type: "function" as const,
  name: "get_current_time",
  description: "The time.",
  inputSchema: { type: "object" as const, properties: {} },
};

function params(messages: LlmMessage[], extra: Partial<CompleteParams> = {}): CompleteParams {
  return {
    system: { cacheable: "You are a test agent.", dynamic: "Today is a test." },
    messages,
    tools: [TOOL],
    skipUsageLog: false,
    ...extra,
  };
}

/** Two steps: the model calls the tool, then answers from its result. */
async function twoSteps(key: string, extra: Partial<CompleteParams> = {}): Promise<{ first: Body; second: Body; text: string; firstResult: Awaited<ReturnType<typeof completeWithModel>> }> {
  const spec = getModel(key)!;
  const from = requests.length;
  const opening: LlmMessage[] = [{ role: "user", content: "What time is it?" }];
  const firstResult = await completeWithModel(spec, params(opening, extra));
  assert(firstResult.stopReason === "tool_use" && firstResult.toolCalls[0]?.name === "get_current_time", `${key}: the tool call is read back (${firstResult.stopReason})`);
  const followUp: LlmMessage[] = [
    ...opening,
    { role: "assistant", textParts: firstResult.textParts, toolCalls: firstResult.toolCalls, ...(firstResult.providerItems ? { providerItems: firstResult.providerItems } : {}) },
    { role: "tool", toolCallId: firstResult.toolCalls[0]!.id, content: "12:00 IST" },
  ];
  const secondResult = await completeWithModel(spec, params(followUp));
  assert(secondResult.stopReason === "end_turn", `${key}: the answer ends the turn (${secondResult.stopReason})`);
  return { first: requests[from]!.body, second: requests[from + 1]!.body, text: secondResult.textParts.join(" "), firstResult };
}

const passed: string[] = [];

// ---- OpenAI: Responses API ----
const openai = await twoSteps("openai:strong", { toolChoice: { name: "get_current_time" }, effort: "medium" });
assert(requests.some((item) => item.path === "/openai/v1/responses"), "OpenAI goes to the Responses API, not Chat Completions");
assert(openai.first.model === "gpt-test-strong" && openai.first.store === false, "the configured model id, stateless");
assert(String(openai.first.instructions).includes("You are a test agent.") && String(openai.first.instructions).includes("Today is a test."), "system prompt as instructions");
const openaiTools = openai.first.tools as Array<Record<string, unknown>>;
assert(openaiTools[0]?.type === "function" && openaiTools[0]?.name === "get_current_time" && openaiTools[0]?.strict === false, "function tools, not strict");
assert(JSON.stringify(openai.first.tool_choice) === JSON.stringify({ type: "function", name: "get_current_time" }), "a forced tool is sent as tool_choice");
assert(JSON.stringify(openai.first.reasoning) === JSON.stringify({ effort: "medium" }) && JSON.stringify(openai.first.include) === '["reasoning.encrypted_content"]', "reasoning effort and encrypted reasoning");
const secondInput = openai.second.input as Array<Record<string, unknown>>;
assert(secondInput.some((item) => item.type === "reasoning" && item.encrypted_content === "ENCRYPTED-REASONING"), "the reasoning item goes back on the next step");
const call = secondInput.find((item) => item.type === "function_call")!;
assert(call.call_id === "call_openai_1" && call.id === undefined, "the function call goes back by call_id, without OpenAI's item id");
assert(secondInput.some((item) => item.type === "function_call_output" && item.call_id === "call_openai_1" && item.output === "12:00 IST"), "with its output");
assert(openai.text === "OpenAI read the time.", "and the answer is read back");
assert(openai.firstResult.usage.inputTokens === 100 && openai.firstResult.usage.cacheReadInputTokens === 30 && openai.firstResult.usage.estimatedCostUsd > 0, "usage and cost are recorded");
passed.push("OpenAI adapter: Responses API, function tools, forced tool, reasoning items carried, usage and cost");

// ---- Anthropic: Messages API ----
const claude = await twoSteps("anthropic:sonnet", { toolChoice: { name: "get_current_time" } });
assert(requests.some((item) => item.path === "/anthropic/v1/messages"), "Claude goes to the Messages API");
assert(claude.first.model === getModel("anthropic:sonnet")!.modelId && claude.first.tool_choice === undefined, "its model id, and no forced tool (Claude rejects it)");
assert(JSON.stringify(claude.second.messages).includes("tool_result") && claude.text === "Claude read the time.", "the tool result goes back and the answer is read");
passed.push("Claude adapter: Messages API, tool use, no forced tool_choice");

// ---- Gemini: OpenAI-compatible ----
const gemini = await twoSteps("gemini:flash", { toolChoice: { name: "get_current_time" }, effort: "high" });
assert(gemini.first.model === getModel("gemini:flash")!.modelId && gemini.first.reasoning_effort === "high", "its model id and the agent's effort");
assert(JSON.stringify(gemini.first.tool_choice) === JSON.stringify({ type: "function", function: { name: "get_current_time" } }), "a forced tool");
assert(JSON.stringify(gemini.second.messages).includes("sig-from-gemini"), "Gemini's thought signature goes back on the next step");
assert(gemini.text === "gemini read: 12:00 IST", "and the answer is read");
passed.push("Gemini adapter: OpenAI-compatible, effort, forced tool, thought signature carried");

// ---- DeepSeek: OpenAI-compatible ----
const deepseek = await twoSteps("deepseek:flash");
assert(deepseek.first.model === getModel("deepseek:flash")!.modelId && JSON.stringify(deepseek.first.thinking) === '{"type":"disabled"}', "its model id, thinking off");
assert(deepseek.text === "deepseek read: 12:00 IST", "the answer is read");
const reasoner = await completeWithModel(getModel("deepseek:reasoner")!, params([{ role: "user", content: "think" }], { toolChoice: "required" }));
const reasonerBody = requests.at(-1)!.body;
assert(JSON.stringify(reasonerBody.thinking) === '{"type":"enabled"}' && reasonerBody.tool_choice === undefined && reasoner.toolCalls.length === 1, "the thinking slot turns thinking on and drops forced tools");
passed.push("DeepSeek adapter: OpenAI-compatible, thinking off by default and on for the thinking slot");

// ---- Kimi: OpenAI-compatible ----
const kimi = await twoSteps("kimi:main", { toolChoice: { name: "get_current_time" } });
assert(requests.some((item) => item.path === "/kimi/chat/completions"), "Kimi goes to its OpenAI-compatible endpoint");
assert(kimi.first.model === "kimi-test" && kimi.first.tool_choice === undefined, "its model id, and no forced tool_choice");
const kimiAssistant = (kimi.second.messages as Array<Record<string, unknown>>).find((message) => message.role === "assistant")!;
assert(kimiAssistant.reasoning_content === "Kimi thought about it.", "Kimi's reasoning goes back to Kimi on the next step");
assert(kimi.text === "kimi read: 12:00 IST", "and the answer is read");
assert(requests.filter((item) => item.path.startsWith("/kimi")).every((item) => item.auth === "Bearer test-kimi-key"), "with Kimi's own key");
passed.push("Kimi adapter: OpenAI-compatible through the shared loop, reasoning carried, no forced tool");

// ---- provider state never crosses providers ----
const crossed = await completeWithModel(getModel("gemini:flash")!, params([
  { role: "user", content: "What time is it?" },
  { role: "assistant", textParts: [], toolCalls: openai.firstResult.toolCalls, providerItems: openai.firstResult.providerItems },
  { role: "tool", toolCallId: openai.firstResult.toolCalls[0]!.id, content: "12:00 IST" },
]));
assert(!JSON.stringify(requests.at(-1)!.body).includes("ENCRYPTED-REASONING") && crossed.stopReason === "end_turn", "OpenAI's reasoning is never sent to another provider");
passed.push("provider state stays with its provider when a turn moves between them");

// ---- the route: an auth failure pauses the provider and the next model answers ----
openaiFails = true;
const routed = await complete(
  params([{ role: "user", content: "What time is it?" }], {
    route: { agentId: "email", models: [getModel("openai:fast")!, getModel("gemini:flash")!] },
  }),
);
assert(routed.servedBy === "gemini:flash" && routed.servedModel === getModel("gemini:flash")!.modelId, `OpenAI's 401 falls through to Gemini (${routed.servedBy})`);
assert(isProviderFlagged("openai"), "and pauses OpenAI");
const skip = requests.length;
const again = await complete(params([{ role: "user", content: "Again?" }], { route: { agentId: "email", models: [getModel("openai:fast")!, getModel("gemini:flash")!] } }));
assert(again.servedBy === "gemini:flash" && !requests.slice(skip).some((item) => item.path.startsWith("/openai")), "a paused provider is not called again");
clearLlmBackendFlagsForTests();
openaiFails = false;
delete process.env.KIMI_API_KEY;
resetProviderClientsForTests();
const noKey = await complete(params([{ role: "user", content: "Hi" }], { route: { agentId: "knowledge", models: [getModel("kimi:main")!, getModel("deepseek:flash")!] } }));
assert(noKey.servedBy === "deepseek:flash", `a provider with no key is skipped without a call (${noKey.servedBy})`);
const image = await complete({
  system: { cacheable: "x" },
  messages: [{ role: "user", content: [{ type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" }, { type: "text", text: "what is this" }] }],
  tools: [],
  route: { agentId: "operations", models: [getModel("deepseek:flash")!, getModel("openai:fast")!] },
});
assert(image.servedBy === "openai:fast", `an image skips a model that can't see (${image.servedBy})`);
passed.push("route: auth failure pauses the provider, no key is skipped, an image skips models without vision");

server.close();
log(passed.map((line) => `  ok  ${line}`).join("\n"));
log("Model adapter checks passed.");
process.exit(0);
