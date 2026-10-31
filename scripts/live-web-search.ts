process.env.AADI_DB_PATH ??= ":memory:";
process.env.FALLBACK_CHAIN ??= "deepseek,gemini";

function scrub(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/AIza[0-9A-Za-z_-]+/g, "[redacted]")
    .replace(/sk-[a-f0-9]{32}/gi, "[redacted]")
    .replace(/key=[^&\s"'\\]+/gi, "key=[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}

if (!process.env.DEEPSEEK_API_KEY?.trim()) {
  console.error("live-web-search: DEEPSEEK_API_KEY is missing");
  process.exit(1);
}
if (!process.env.GEMINI_API_KEY?.trim()) {
  console.error("live-web-search: GEMINI_API_KEY is missing");
  process.exit(1);
}

const { runAgent } = await import("../src/agent.ts");
const { searchWeb } = await import("../src/web_search.ts");

const QUERY = "top India news headline today 31 October 2026";

function showHits(
  label: string,
  provider: string,
  hits: Array<{ title: string; url: string }>,
  answer?: string,
): void {
  console.log(`${label}: provider=${provider} hits=${hits.length}`);
  if (answer) {
    console.log(`${label}: answer_chars=${answer.length}`);
  }
  for (const hit of hits.slice(0, 5)) {
    console.log(`- ${hit.title} — ${hit.url}`);
  }
}

try {
  const primary = await searchWeb(QUERY);
  if (!primary.ok) {
    console.error(
      `live-web-search: primary failed reason=${primary.reason} attempts=${primary.attempts
        .map((row) => `${row.provider}:${row.status}`)
        .join(",")}`,
    );
    process.exit(1);
  }
  if (primary.provider !== "deepseek") {
    console.error(`live-web-search: expected deepseek, got ${primary.provider}`);
    process.exit(1);
  }
  if (primary.hits.length === 0) {
    console.error("live-web-search: deepseek returned no URLs");
    process.exit(1);
  }
  showHits("deepseek-search", primary.provider, primary.hits, primary.answer);

  const chat = await runAgent(
    "What is the top India news headline today? Cite the source titles and URLs.",
    {
      backend: "deepseek",
      saveUserMessage: false,
      saveAssistantMessage: false,
      skipHistory: true,
    },
  );
  const chatText = scrub(chat).trim();
  if (!chatText) {
    console.error("live-web-search: empty DeepSeek chat reply");
    process.exit(1);
  }
  if (/^Not searched:/i.test(chatText) || /couldn't search/i.test(chatText)) {
    console.error(`live-web-search: chat could not search: ${chatText.slice(0, 200)}`);
    process.exit(1);
  }
  const hasUrl = /https?:\/\//i.test(chatText);
  if (!hasUrl) {
    console.error("live-web-search: DeepSeek chat reply had no source URL");
    process.exit(1);
  }
  console.log(`deepseek-chat: chars=${chatText.length} cited=${hasUrl ? "yes" : "no"}`);
  console.log(chatText);

  const fallback = await searchWeb(QUERY, { skipProviders: ["deepseek"] });
  console.log(
    `fallback-attempts: ${fallback.attempts
      .map((row) => `${row.provider}:${row.status}${row.reason ? `:${row.reason}` : ""}`)
      .join(",")}`,
  );
  const geminiAttempt = fallback.attempts.find((row) => row.provider === "gemini");
  if (!geminiAttempt || geminiAttempt.status === "skipped") {
    console.error("live-web-search: gemini was not attempted after deepseek skip");
    process.exit(1);
  }
  if (fallback.ok && fallback.provider === "gemini") {
    showHits("gemini-fallback", fallback.provider, fallback.hits, fallback.answer);
    console.log("live-web-search: ok");
    process.exit(0);
  }
  if (/429|503/.test(geminiAttempt.reason ?? "")) {
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    const geminiOnly = await searchWeb(QUERY, {
      skipProviders: ["deepseek", "claude"],
    });
    if (geminiOnly.ok && geminiOnly.provider === "gemini") {
      showHits("gemini-fallback-retry", geminiOnly.provider, geminiOnly.hits, geminiOnly.answer);
      console.log("live-web-search: ok");
      process.exit(0);
    }
    if (!fallback.ok) {
      console.error("live-web-search: gemini 429/503 and no later provider succeeded");
      process.exit(1);
    }
    showHits("later-fallback", fallback.provider, fallback.hits, fallback.answer);
    console.log(
      `live-web-search: ok gemini=${geminiAttempt.status}:${geminiAttempt.reason} next=${fallback.provider}`,
    );
    process.exit(0);
  }
  console.error(
    `live-web-search: expected gemini fallback, got ${fallback.ok ? fallback.provider : fallback.reason}`,
  );
  process.exit(1);
} catch (error) {
  const raw = error instanceof Error ? error.message : String(error);
  console.error(`live-web-search: ${scrub(raw)}`);
  process.exit(1);
}
