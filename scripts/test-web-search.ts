process.env.AADI_DB_PATH = ":memory:";
process.env.LLM_PROVIDER = "claude";
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.OWNER_TELEGRAM_ID = "1";
process.env.CLAUDE_MODEL = "claude-sonnet-test";
process.env.BACKGROUND_MODEL = "claude-haiku-test";
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.DEEPSEEK_API_KEY = "test-deepseek";
process.env.GEMINI_API_KEY = "test-gemini";
process.env.BRIEF_TIME = "08:00";
process.env.WEB_SEARCH_ORDER = "deepseek,gemini,claude";
process.env.WEB_SEARCH_DAILY_CAP = "100";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const { runAgent, setToolInterceptorForTests } = await import("../src/agent.ts");
const { setCompleteForTests } = await import("../src/llm.ts");
const {
  clearLlmBackendFlagsForTests,
  flagLlmBackend,
} = await import("../src/llm_fallback.ts");
const { setReplyCheckerForTests, UNCONFIRMED_TEXT } = await import("../src/reply_checker.ts");
const {
  formatSearchToolResult,
  getSearchOrder,
  parseSearchSources,
  searchWeb,
  setSearchProvidersForTests,
  withSearchCitations,
} = await import("../src/web_search.ts");
const { modelReply } = await import("./fakes.ts");

const bbc = {
  title: "Spain win Euro 2024",
  url: "https://bbc.example/euro-2024",
  snippet: "Spain defeated England 2-1.",
};
const hindu = {
  title: "Nifty closes higher",
  url: "https://thehindu.example/markets",
  snippet: "Nifty ended at 24,100.",
};

function callsLog(): { calls: string[]; reset: () => void } {
  const calls: string[] = [];
  return { calls, reset: () => { calls.length = 0; } };
}

async function testOrderAndPrimary(): Promise<void> {
  assert(
    getSearchOrder().join(",") === "deepseek,gemini,claude",
    `default order: ${getSearchOrder().join(",")}`,
  );
  process.env.WEB_SEARCH_PROVIDER = "gemini";
  assert(
    getSearchOrder().join(",") === "gemini,deepseek,claude",
    `pin gemini first: ${getSearchOrder().join(",")}`,
  );
  delete process.env.WEB_SEARCH_PROVIDER;

  const log = callsLog();
  setSearchProvidersForTests({
    deepseek: async () => {
      log.calls.push("deepseek");
      return { hits: [bbc] };
    },
    gemini: async () => {
      log.calls.push("gemini");
      throw new Error("should not run");
    },
    claude: async () => {
      log.calls.push("claude");
      throw new Error("should not run");
    },
  });
  const outcome = await searchWeb("Euro 2024 winner");
  assert(outcome.ok && outcome.provider === "deepseek", "primary is deepseek");
  assert(log.calls.join(",") === "deepseek", `only deepseek ran: ${log.calls.join(",")}`);
  assert(outcome.ok && outcome.hits[0]?.url === bbc.url, "returns cited hits");
}

async function testPrimaryFailsThenGemini(): Promise<void> {
  const log = callsLog();
  setSearchProvidersForTests({
    deepseek: async () => {
      log.calls.push("deepseek");
      throw new Error("502");
    },
    gemini: async () => {
      log.calls.push("gemini");
      return { hits: [hindu], answer: "Nifty closed higher." };
    },
    claude: async () => {
      log.calls.push("claude");
      throw new Error("should not run");
    },
  });
  const outcome = await searchWeb("Nifty close");
  assert(outcome.ok && outcome.provider === "gemini", "falls to gemini");
  assert(log.calls.join(",") === "deepseek,gemini", `cascade: ${log.calls.join(",")}`);
}

async function testGeminiFailsThenClaude(): Promise<void> {
  const log = callsLog();
  setSearchProvidersForTests({
    deepseek: async () => {
      log.calls.push("deepseek");
      return { hits: [] };
    },
    gemini: async () => {
      log.calls.push("gemini");
      throw new Error("503");
    },
    claude: async () => {
      log.calls.push("claude");
      return { hits: [bbc], answer: "Spain won Euro 2024." };
    },
  });
  const outcome = await searchWeb("Euro 2024");
  assert(outcome.ok && outcome.provider === "claude", "falls to claude");
  assert(
    log.calls.join(",") === "deepseek,gemini,claude",
    `full cascade: ${log.calls.join(",")}`,
  );
}

async function testClaudeSkippedWhenCreditFlagged(): Promise<void> {
  clearLlmBackendFlagsForTests();
  flagLlmBackend("claude", "credit too low");
  const log = callsLog();
  setSearchProvidersForTests({
    deepseek: async () => {
      log.calls.push("deepseek");
      throw new Error("402");
    },
    gemini: async () => {
      log.calls.push("gemini");
      throw new Error("401");
    },
    claude: async () => {
      log.calls.push("claude");
      return { hits: [bbc] };
    },
  });
  const outcome = await searchWeb("headline");
  assert(!outcome.ok && outcome.reason === "no_results", "all fail when claude skipped");
  assert(!log.calls.includes("claude"), `claude not called: ${log.calls.join(",")}`);
  assert(
    outcome.attempts.some((row) => row.provider === "claude" && row.status === "skipped"),
    "claude marked skipped",
  );
  clearLlmBackendFlagsForTests();
}

async function testAllFailClearMessage(): Promise<void> {
  setSearchProvidersForTests({
    deepseek: async () => ({ hits: [] }),
    gemini: async () => {
      throw new Error("503");
    },
    claude: async () => {
      throw new Error("skipped:credit");
    },
  });
  const outcome = await searchWeb("invented news");
  assert(!outcome.ok, "all fail");
  const text = formatSearchToolResult(outcome);
  assert(text.startsWith("Not searched:"), `clear failure: ${text}`);
  assert(!/Spain|Nifty|won/i.test(text), "no hallucinated results on failure");
}

async function testDailyCap(): Promise<void> {
  setSearchProvidersForTests({
    deepseek: async () => ({ hits: [bbc] }),
  });
  const day = new Date("2026-01-02T06:00:00+05:30");
  const first = await searchWeb("one", { dailyCap: 1, now: day });
  assert(first.ok, "first search under cap");
  const second = await searchWeb("two", { dailyCap: 1, now: day });
  assert(!second.ok && second.reason === "daily_cap", "second hits cap");
  const text = formatSearchToolResult(second);
  assert(/today's search limit/i.test(text), `cap message: ${text}`);
}

async function testCitationsAppended(): Promise<void> {
  const hits = [bbc, hindu];
  // Code always renders the search tool's sources; the reply's own words are not read.
  const appended = withSearchCitations("Spain won Euro 2024.", hits);
  assert(
    appended === `Spain won Euro 2024.\n\nSources:\n- ${bbc.title} — ${bbc.url}\n- ${hindu.title} — ${hindu.url}`,
    `appends the Sources block from the results: ${appended}`,
  );
  const mentioned = withSearchCitations(`Spain won (${bbc.url}).`, hits);
  assert(mentioned.endsWith(`Sources:\n- ${bbc.title} — ${bbc.url}\n- ${hindu.title} — ${hindu.url}`), "rendered even when the reply names a URL");
  assert(withSearchCitations("No results.", []) === "No results.", "nothing to cite, nothing added");
  const parsed = parseSearchSources(
    formatSearchToolResult({
      ok: true,
      provider: "deepseek",
      hits,
      attempts: [{ provider: "deepseek", status: "ok" }],
    }),
  );
  assert(parsed.length === 2 && parsed[0]?.url === bbc.url, "parses source marker");
}

async function testAgentBlocksInventedSearch(): Promise<void> {
  setSearchProvidersForTests({
    deepseek: async () => ({ hits: [] }),
    gemini: async () => ({ hits: [] }),
    claude: async () => ({ hits: [] }),
  });
  setCompleteForTests(async (params) => {
    if (params.tools.length === 0) {
      return modelReply({ text: '{"facts":[]}' });
    }
    return modelReply({
      text: "As of today Nifty closed at 99,999.",
    });
  });
  // No web_search ran, so the checker finds the live figure unsupported, twice.
  let checks = 0;
  setReplyCheckerForTests((input) => {
    checks += 1;
    const searched = input.tools.some((tool) => tool.name === "web_search" && tool.status === "ok");
    return searched
      ? { status: "checked", verdict: "ok", issues: [], model: "test", ms: 0 }
      : { status: "checked", verdict: "unsupported_claim", issues: ["No search ran this turn."], model: "test", ms: 0 };
  });
  setToolInterceptorForTests(undefined);
  const reply = await runAgent("What's Nifty at as of today?", {
    saveUserMessage: false,
    saveAssistantMessage: false,
    skipHistory: true,
  });
  assert(checks === 2, `checked, retried, checked again (${checks})`);
  assert(
    reply.endsWith(UNCONFIRMED_TEXT) && !reply.includes("99,999"),
    `invented live claim is withheld, got: ${reply}`,
  );
  setReplyCheckerForTests(undefined);
  setCompleteForTests(undefined);
}

async function testAgentUsesPrimaryAndCites(): Promise<void> {
  const log = callsLog();
  setSearchProvidersForTests({
    deepseek: async () => {
      log.calls.push("deepseek");
      return { hits: [bbc] };
    },
    gemini: async () => {
      log.calls.push("gemini");
      throw new Error("should not run");
    },
    claude: async () => {
      log.calls.push("claude");
      throw new Error("should not run");
    },
  });
  setCompleteForTests(async (params) => {
    if (params.tools.length === 0) {
      return modelReply({ text: '{"facts":[]}' });
    }
    const last = params.messages.at(-1);
    if (last?.role === "tool") {
      return modelReply({ text: "Spain won Euro 2024." });
    }
    return modelReply({
      text: "",
      tools: [{ name: "web_search", input: { query: "Euro 2024 winner" } }],
    });
  });
  const reply = await runAgent("Who won Euro 2024?", {
    saveUserMessage: false,
    saveAssistantMessage: false,
    skipHistory: true,
  });
  assert(log.calls.join(",") === "deepseek", `agent used primary: ${log.calls.join(",")}`);
  assert(reply.includes("Spain won Euro 2024."), `answer present: ${reply}`);
  assert(reply.includes(bbc.url), `cited URL: ${reply}`);
  assert(reply.includes(bbc.title), `cited title: ${reply}`);
  setCompleteForTests(undefined);
}

async function main(): Promise<void> {
  await testOrderAndPrimary();
  await testPrimaryFailsThenGemini();
  await testGeminiFailsThenClaude();
  await testClaudeSkippedWhenCreditFlagged();
  await testAllFailClearMessage();
  await testDailyCap();
  await testCitationsAppended();
  await testAgentBlocksInventedSearch();
  await testAgentUsesPrimaryAndCites();
  setSearchProvidersForTests(undefined);
  setCompleteForTests(undefined);
  console.log("test-web-search: ok");
}

await main();
