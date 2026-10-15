import "dotenv/config";

function ensureTestEnv(): void {
  process.env.LLM_PROVIDER ??= "claude";
  process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
  process.env.OWNER_TELEGRAM_ID ??= "1";
  process.env.CLAUDE_MODEL ??= "claude-haiku-4-5";
  process.env.ANTHROPIC_API_KEY ??= "test-key";
  process.env.BRIEF_TIME ??= "08:00";
}

ensureTestEnv();

const {
  confirmationLine,
  findMemoryToUpdate,
  formatMemoryContextBlock,
  formatMemoryLine,
  groupedMemoryText,
  isForgetEverything,
  isPastEventDate,
  isSensitiveMemoryText,
  kolkataYmd,
  parseEventDateFromText,
  parseExplicitRemember,
  parseExtractedFacts,
  parseForgetQuery,
  shouldSkipAutoCapture,
} = await import("../src/memory_logic.ts");
const {
  clearMessages,
  countMemories,
  createMemory,
  deleteAllMemories,
  deleteMemory,
  getMemory,
  getRecentMessages,
  isMemoriesFtsReady,
  saveMessage,
  searchMemories,
  updateMemory,
} = await import("../src/db.ts");
const { saveExplicitMemory } = await import("../src/memory.ts");

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const stamp = Date.now();
const MARKER = `MemTest${stamp}`;

function testParsingAndSensitive(): void {
  assert(parseExplicitRemember("hello").matched === false, "not explicit");
  const parsed = parseExplicitRemember(`remember that ${MARKER} demo is Thu 23 Oct 2026`);
  assert(parsed.matched && parsed.body.includes("demo"), "explicit body");
  assert(parseExplicitRemember("remember that").matched === true, "empty still matched");
  assert(parseExplicitRemember("remember that").matched && parseExplicitRemember("remember that").body === "", "empty body");
  assert(parseEventDateFromText("demo on 23 Oct 2026") === "2026-10-23", "named date");
  assert(parseEventDateFromText("demo on 2026-10-23") === "2026-10-23", "iso date");
  assert(isSensitiveMemoryText("remember that my password is hunter2"), "password blocked");
  assert(isSensitiveMemoryText("the OTP is 123456"), "otp blocked");
  assert(isSensitiveMemoryText("card number 4111111111111111"), "card blocked");
  assert(isSensitiveMemoryText("my diagnosis is hypertension"), "health blocked");
  assert(!isSensitiveMemoryText("Eternal demo moved to Thursday"), "demo allowed");
  assert(isForgetEverything("forget everything"), "forget all");
  assert(parseForgetQuery("forget the Eternal demo") === "the Eternal demo", "forget query");
  assert(parseForgetQuery("forget it") === null, "forget it ignored");
  assert(shouldSkipAutoCapture("ok thanks"), "short skip");
  assert(shouldSkipAutoCapture("remember that the sky is blue"), "explicit skip auto");
}

function testUpdateScoring(): void {
  const existing = [
    {
      id: 1,
      content: "Eternal demo is on 16 Oct 2026",
      category: "event" as const,
      tag: "work" as const,
      event_date: "2026-10-16",
      source: "auto" as const,
      created_at: "",
      updated_at: "",
    },
    {
      id: 2,
      content: "Pinnacle MSA in legal review",
      category: "deal" as const,
      tag: "work" as const,
      event_date: null,
      source: "auto" as const,
      created_at: "",
      updated_at: "",
    },
  ];
  const hit = findMemoryToUpdate(existing, {
    content: "Eternal demo moved to 23 Oct 2026",
    category: "event",
    update_of_id: null,
  });
  assert(hit?.id === 1, "updates the Eternal demo not the MSA");
  const miss = findMemoryToUpdate(existing, {
    content: "Amma visits Bangalore in December",
    category: "plan",
    update_of_id: null,
  });
  assert(!miss, "unrelated does not update");
}

function testStoreSearchAndReset(): void {
  const created = createMemory({
    content: `${MARKER} Eternal demo on 23 Oct 2026`,
    category: "event",
    tag: "work",
    eventDate: "2026-10-23",
    source: "auto",
  });
  assert(created.id > 0, "created");
  const found = searchMemories(`${MARKER} Eternal demo`, 15);
  assert(
    found.some((item) => item.id === created.id),
    `search missed id=${created.id} fts=${isMemoriesFtsReady()} hits=${found.length}`,
  );
  const updated = updateMemory(created.id, {
    content: `${MARKER} Eternal demo moved to 30 Oct 2026`,
    eventDate: "2026-10-30",
  });
  assert(updated?.event_date === "2026-10-30", "date updated");
  const again = searchMemories(`${MARKER} Eternal`, 15);
  assert(again.filter((item) => item.content.includes(MARKER)).length === 1, "no duplicate after update");

  saveMessage("user", `temp ${MARKER}`);
  const before = getRecentMessages(10).length;
  assert(before > 0, "history present");
  clearMessages();
  assert(getRecentMessages(10).length === 0, "reset clears history");
  assert(getMemory(created.id)?.id === created.id, "reset keeps memories");

  const today = kolkataYmd();
  const past = createMemory({
    content: `${MARKER} past demo`,
    category: "event",
    tag: "work",
    eventDate: "2020-01-01",
    source: "auto",
  });
  assert(isPastEventDate(past.event_date, today), "past labelled");
  const line = formatMemoryLine(past, today);
  assert(line.includes("[past]"), line);
  const ctx = formatMemoryContextBlock([updated!], [], today);
  assert(ctx.includes("Long-term memories"), ctx);
  assert(groupedMemoryText([created]).includes("EVENT"), "grouped");
  assert(confirmationLine("Updated", "Eternal demo moved", "work").startsWith("Updated:"), "updated line");

  const refused = saveExplicitMemory("my password is hunter2");
  assert(!refused.ok, "explicit sensitive refused");
  const noted = saveExplicitMemory(`${MARKER} prefers short briefs`);
  assert(noted.ok && noted.text.startsWith("Noted:"), noted.ok ? noted.text : "fail");

  deleteMemory(created.id);
  deleteMemory(past.id);
  if (noted.ok) {
    deleteMemory(noted.memory.id);
  }
}

function testExtractedFacts(): void {
  const facts = parseExtractedFacts(
    `{"facts":[{"content":"${MARKER} demo moved","category":"event","tag":"work","event_date":"2026-10-23","weight":"important","update_of_id":9}]}`,
  );
  assert(facts.length === 1 && facts[0]?.update_of_id === 9, "json facts");
  assert(facts[0]?.weight === "important", "weight");
}

function testForgetAllCount(): void {
  const before = countMemories();
  const row = createMemory({
    content: `${MARKER} disposable`,
    category: "other",
    tag: "personal",
    source: "explicit",
  });
  assert(countMemories() === before + 1, "count up");
  assert(deleteMemory(row.id), "delete one");
  assert(countMemories() === before, "count restored");
}

testParsingAndSensitive();
testUpdateScoring();
testStoreSearchAndReset();
testExtractedFacts();
testForgetAllCount();
console.log(
  `Memory checks passed. fts5=${isMemoriesFtsReady()} remaining=${countMemories()}`,
);
