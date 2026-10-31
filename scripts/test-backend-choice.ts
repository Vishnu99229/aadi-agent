import "dotenv/config";

process.env.AADI_DB_PATH = ":memory:";
process.env.LLM_PROVIDER = "claude";
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.OWNER_TELEGRAM_ID = "1";
process.env.CLAUDE_MODEL = "claude-sonnet-test";
process.env.BACKGROUND_MODEL = "claude-haiku-test";
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.BRIEF_TIME = "08:00";
process.env.DEEPSEEK_API_KEY = "";
process.env.GEMINI_API_KEY = "";

const CREDIT = "Your credit balance is too low to access the Anthropic API.";
const HAIKU_REJECT = "Haiku rate limited";

type Mode = "ok" | "fail" | "credit";

const state: {
  mode: Mode;
  calls: Array<{ url: string; model: string; body: string }>;
} = {
  mode: "ok",
  calls: [],
};

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function readBody(body: BodyInit | null | undefined): Promise<string> {
  if (body == null) {
    return "";
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  if (body instanceof Blob) {
    return body.text();
  }
  if (body instanceof ArrayBuffer) {
    return new TextDecoder().decode(body);
  }
  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(body);
  }
  if (typeof body === "object" && Symbol.asyncIterator in body) {
    const chunks: string[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      chunks.push(
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
      );
    }
    return chunks.join("");
  }
  return String(body);
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function anthropicResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function okMessage(text: string): Response {
  return anthropicResponse(200, {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-test",
    stop_reason: "end_turn",
    stop_sequence: null,
    content: [{ type: "text", text }],
    usage: {
      input_tokens: 12,
      output_tokens: 4,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  });
}

function errorMessage(message: string): Response {
  return anthropicResponse(400, {
    type: "error",
    error: { type: "invalid_request_error", message },
    message,
  });
}

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = requestUrl(input);
  const body = await readBody(init?.body);
  if (!url.includes("api.anthropic.com")) {
    throw new Error(`Refusing unexpected request to ${new URL(url).host}`);
  }
  let model = "";
  try {
    model = String((JSON.parse(body) as { model?: string }).model ?? "");
  } catch {
    model = "";
  }
  state.calls.push({ url, model, body });
  if (state.mode === "credit") {
    return errorMessage(CREDIT);
  }
  if (state.mode === "fail") {
    const message = model.includes("haiku") ? HAIKU_REJECT : CREDIT;
    return errorMessage(message);
  }
  if (body.includes("Summarise this Telegram chat")) {
    return okMessage("Summary of older chat.");
  }
  if (body.includes("Classify this background fixture")) {
    return okMessage("Background ok.");
  }
  return okMessage("Main reply.");
};

const { CONVERSATION_SUMMARY_KEY, clearMessages, deleteSetting, getSetting, saveMessage } =
  await import("../src/db.ts");
const { getTaskBackend, setTaskBackend } = await import("../src/chat_backend.ts");
const { complete, completeBackground } = await import("../src/llm.ts");
const { completeForJob } = await import("../src/job_llm.ts");
const { clearLlmBackendFlagsForTests } = await import("../src/llm_fallback.ts");
const { runAgent } = await import("../src/agent.ts");

function resetModelSettings(): void {
  deleteSetting("llm_task_backends");
  deleteSetting("llm_backend");
  deleteSetting("llm_task_defaults_generation");
  deleteSetting("llm_task_efforts");
}

function resetCalls(): void {
  state.calls.length = 0;
}

const minimal = {
  system: { cacheable: "Reply with one short line." },
  messages: [{ role: "user" as const, content: "hello" }],
  tools: [] as [],
  skipUsageLog: true,
};

resetModelSettings();
clearLlmBackendFlagsForTests();
setTaskBackend("chat", "haiku");
state.mode = "ok";
resetCalls();
const direct = await complete({ ...minimal, backend: "haiku" });
assert(direct.textParts.join("\n") === "Main reply.", "haiku direct reply");
assert(state.calls.length === 1, "haiku does not fall back when it succeeds");
assert(
  state.calls[0]?.model === "claude-haiku-test",
  `haiku model was ${state.calls[0]?.model}`,
);

resetCalls();
const fromChatChoice = await complete(minimal);
assert(
  fromChatChoice.textParts.join("\n") === "Main reply.",
  "default chat backend reply",
);
assert(
  state.calls[0]?.model === "claude-haiku-test",
  `chat-task model was ${state.calls[0]?.model}`,
);

state.mode = "fail";
resetCalls();
clearLlmBackendFlagsForTests();
let haikuAndClaude = "";
try {
  await complete({ ...minimal, backend: "haiku" });
  throw new Error("expected haiku then claude to both fail");
} catch (error) {
  haikuAndClaude = error instanceof Error ? error.message : String(error);
}
assert(
  haikuAndClaude.startsWith("All LLM backends failed:"),
  haikuAndClaude,
);
assert(haikuAndClaude.includes("haiku:"), haikuAndClaude);
assert(
  haikuAndClaude.indexOf("haiku:") < haikuAndClaude.indexOf("claude:"),
  `claude must be last: ${haikuAndClaude}`,
);
assert(state.calls.length === 2, "haiku then claude, no jump");
assert(
  !haikuAndClaude.includes("Fallback (Claude)"),
  haikuAndClaude,
);

clearLlmBackendFlagsForTests();
state.mode = "credit";
resetCalls();
const creditLogs: string[] = [];
const originalCreditError = console.error;
console.error = (...args: unknown[]) => {
  creditLogs.push(args.map((part) => String(part)).join(" "));
};
let haikuCredit = "";
try {
  await complete({ ...minimal, backend: "haiku" });
  throw new Error("expected haiku credit error to throw");
} catch (error) {
  haikuCredit = error instanceof Error ? error.message : String(error);
} finally {
  console.error = originalCreditError;
}
assert(/credit too low/i.test(haikuCredit), haikuCredit);
assert(
  !haikuCredit.includes("Fallback (Claude)"),
  `credit error retried Claude: ${haikuCredit}`,
);
assert(state.calls.length === 1, `credit error made ${state.calls.length} calls`);
assert(
  !creditLogs.some((line) => line.includes("retrying on Claude")),
  `credit error logged Claude retry: ${creditLogs.join(" | ")}`,
);
clearLlmBackendFlagsForTests();

resetCalls();
clearLlmBackendFlagsForTests();
let jobCredit = "";
try {
  await completeForJob({ ...minimal, backend: "haiku" });
  throw new Error("expected job credit error to throw");
} catch (error) {
  jobCredit = error instanceof Error ? error.message : String(error);
}
assert(/credit too low|credit balance is too low/i.test(jobCredit), jobCredit);
assert(
  !jobCredit.includes("Fallback (Claude)"),
  `job credit error retried Claude: ${jobCredit}`,
);
assert(
  state.calls.length === 1,
  `job credit error made ${state.calls.length} calls`,
);
clearLlmBackendFlagsForTests();

resetCalls();
let deepseekSkipped = "";
try {
  await complete({ ...minimal, backend: "deepseek" });
  throw new Error("expected usable anthropic backends to fail");
} catch (error) {
  deepseekSkipped = error instanceof Error ? error.message : String(error);
}
assert(
  !state.calls.some((call) => call.url.includes("deepseek")),
  "deepseek with no key is never attempted",
);
assert(deepseekSkipped.startsWith("All LLM backends failed:"), deepseekSkipped);
assert(!deepseekSkipped.includes("DEEPSEEK_API_KEY"), deepseekSkipped);

clearLlmBackendFlagsForTests();
resetCalls();
let claudeOnly = "";
try {
  await complete({ ...minimal, backend: "claude" });
  throw new Error("expected claude to fail");
} catch (error) {
  claudeOnly = error instanceof Error ? error.message : String(error);
}
assert(/credit too low|credit balance is too low/i.test(claudeOnly), claudeOnly);
assert(!claudeOnly.includes("Primary ("), claudeOnly);
assert(!claudeOnly.includes("Fallback ("), claudeOnly);

clearLlmBackendFlagsForTests();
state.mode = "ok";
resetCalls();
setTaskBackend("brief", "gemini");
assert(getTaskBackend("brief") === "gemini", "brief task is gemini");
const logged: string[] = [];
const originalError = console.error;
console.error = (...args: unknown[]) => {
  logged.push(args.map((part) => String(part)).join(" "));
};
let backgroundText = "";
try {
  const background = await completeBackground({
    system: { cacheable: "Classify this background fixture" },
    messages: [{ role: "user", content: "one invoice" }],
    tools: [],
    skipUsageLog: true,
  });
  backgroundText = background.textParts.join("\n");
} finally {
  console.error = originalError;
}
assert(backgroundText === "Background ok.", backgroundText);
assert(
  state.calls.length === 1,
  `background made ${state.calls.length} calls`,
);
assert(
  state.calls[0]?.model === "claude-haiku-test",
  `background used ${state.calls[0]?.model}, not Claude jump`,
);
assert(
  state.calls[0]?.body.includes("Classify this background fixture") === true,
  "background prompt was sent",
);
assert(
  !logged.some((line) => line.includes("retrying on Claude")),
  `jumped to Claude: ${logged.join(" | ")}`,
);

clearMessages();
for (let index = 0; index < 31; index += 1) {
  saveMessage(index % 2 === 0 ? "user" : "assistant", `turn ${index}`);
}
setTaskBackend("chat", "gemini");
assert(getTaskBackend("chat") === "gemini", "chat task is gemini");
resetCalls();
logged.length = 0;
console.error = (...args: unknown[]) => {
  logged.push(args.map((part) => String(part)).join(" "));
};
let reply = "";
try {
  reply = await runAgent("Noted.", {
    saveUserMessage: false,
    saveAssistantMessage: false,
  });
} finally {
  console.error = originalError;
}
assert(reply === "Main reply.", reply);
const summaryCall = state.calls.find((call) =>
  call.body.includes("Summarise this Telegram chat"),
);
assert(summaryCall !== undefined, "conversation summary called the model");
assert(
  summaryCall?.model === "claude-haiku-test",
  `summary used ${summaryCall?.model}, expected haiku before claude`,
);
assert(
  getSetting(CONVERSATION_SUMMARY_KEY) === "Summary of older chat.",
  "summary was stored",
);
assert(
  !logged.some((line) => line.includes("retrying on Claude")),
  "summary must not jump to Claude",
);

console.log("backend choice tests passed");
