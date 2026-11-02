import {
  clearMessages,
  getRecentMessages,
  insertMessageEmbedding,
  saveMessage,
} from "../src/db.ts";
import {
  EMBED_DIMS,
  EMBED_MODEL,
  EMBED_SCHEME,
  HISTORY_KEEP_MAX,
  SEARCH_HISTORY_NO_MATCH,
  documentEmbedText,
  floatsToBlob,
  runMessageEmbed,
  searchHistory,
  setBatchEmbedForTests,
} from "../src/embeddings.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function axis(index: number): number[] {
  const values = new Array<number>(EMBED_DIMS).fill(0);
  values[index] = 1;
  return values;
}

function latestId(): number {
  const row = getRecentMessages(1).at(-1);
  if (!row) {
    throw new Error("expected a message");
  }
  return row.id;
}

function padLiveWindow(): void {
  for (let i = 0; i < HISTORY_KEEP_MAX; i += 1) {
    saveMessage("user", `later turn ${i} stays inside the live window`);
  }
}

async function testRedactedEmbedAndSkippedTools(): Promise<void> {
  clearMessages();
  const seen: string[] = [];
  setBatchEmbedForTests(async (texts) => {
    seen.push(...texts);
    return {
      vectors: texts.map(() => axis(0)),
      tokens: texts.length,
    };
  });
  const body =
    "password hunter2 and the meeting stays on Tuesday for the pricing review";
  saveMessage("user", body);
  saveMessage("tool", `secret tool body ${"z".repeat(80)}`, "read_email");
  const result = await runMessageEmbed();
  assert(result.embedded === 1, `embedded ${result.embedded}`);
  assert(seen.length === 1, `embed calls ${seen.length}`);
  assert(!seen[0]!.includes("hunter2"), "raw password reached the embedder");
  assert(!seen[0]!.includes("secret tool body"), "tool row was embedded");
  assert(
    seen[0] === documentEmbedText(body.replace("hunter2", "[redacted]")),
    `embed text was ${seen[0]}`,
  );
}

async function testSearchRedactsAndIgnoresOtherModels(): Promise<void> {
  clearMessages();
  saveMessage(
    "assistant",
    "password hunter2 was the example in that old pricing thread about Tuesday",
  );
  const keptId = latestId();
  saveMessage(
    "assistant",
    "other-model-marker should not appear in search results at all",
  );
  const otherId = latestId();
  padLiveWindow();
  insertMessageEmbedding({
    messageId: keptId,
    createdAt: "2026-10-01 12:00:00",
    model: EMBED_MODEL,
    scheme: EMBED_SCHEME,
    dims: EMBED_DIMS,
    vector: floatsToBlob(axis(0)),
    skipReason: null,
  });
  insertMessageEmbedding({
    messageId: otherId,
    createdAt: "2026-10-01 12:00:00",
    model: "gemini-embedding-001",
    scheme: "gemini-embedding-001/768/other",
    dims: EMBED_DIMS,
    vector: floatsToBlob(axis(0)),
    skipReason: null,
  });
  setBatchEmbedForTests(async () => ({ vectors: [axis(0)], tokens: 1 }));
  const output = await searchHistory("what did we decide about Tuesday pricing", 5);
  assert(!output.includes("hunter2"), "search snippet still contains the password");
  assert(output.includes("[redacted]"), "search snippet was not redacted");
  assert(!output.includes("other-model-marker"), "other model row was returned");
}

async function testNoMatch(): Promise<void> {
  clearMessages();
  saveMessage("user", "This old note is about a completely different topic entirely");
  const keptId = latestId();
  padLiveWindow();
  insertMessageEmbedding({
    messageId: keptId,
    createdAt: "2026-09-01 00:00:00",
    model: EMBED_MODEL,
    scheme: EMBED_SCHEME,
    dims: EMBED_DIMS,
    vector: floatsToBlob(axis(0)),
    skipReason: null,
  });
  setBatchEmbedForTests(async () => ({ vectors: [axis(1)], tokens: 1 }));
  const output = await searchHistory("biryani recipe from last month please", 5);
  assert(output === SEARCH_HISTORY_NO_MATCH, `no-match text was ${output}`);
}

async function main(): Promise<void> {
  try {
    await testRedactedEmbedAndSkippedTools();
    await testSearchRedactsAndIgnoresOtherModels();
    await testNoMatch();
    console.log("test-message-embeddings: ok");
  } finally {
    setBatchEmbedForTests(undefined);
  }
}

await main();
