import { InlineKeyboard, type Context } from "grammy";
import {
  createMemory,
  createPendingAccountUpdate,
  createPendingMemoryConfirm,
  createReminder,
  deleteAllMemories,
  deleteMemory,
  deletePendingMemoryConfirm,
  getMemory,
  getPendingMemoryConfirm,
  listMemories,
  memoriesWithEventDateBetween,
  searchMemories,
  updateMemory,
  type ItemTag,
  type MemoryRecord,
  type MemorySource,
} from "./db.js";
import { decodedAccounts } from "./accounts.js";
import {
  findAccountsInText,
  suggestedUpdateFromWrapUp,
  type AccountRecord,
} from "./account_logic.js";
import { completeBackground } from "./llm.js";
import {
  addDaysYmd,
  confirmationLine,
  defaultCategoryForExplicit,
  defaultTagForExplicit,
  findMemoryToUpdate,
  formatMemoryContextBlock,
  groupedMemoryText,
  isSensitiveMemoryText,
  kolkataYmd,
  looksLikeDatedEvent,
  parseEventDateFromText,
  parseExtractedFacts,
  parseExplicitRemember,
  reminderAtNine,
  shouldSkipAutoCapture,
  type ExtractedFact,
} from "./memory_logic.js";

const SENSITIVE_REFUSAL =
  "I don't store passwords, OTPs, card or account numbers, or health details.";

export function memoriesForRequest(userText: string): {
  relevant: MemoryRecord[];
  upcoming: MemoryRecord[];
} {
  const today = kolkataYmd();
  const relevant = searchMemories(userText, 15);
  const upcoming = memoriesWithEventDateBetween(today, addDaysYmd(today, 14));
  return { relevant, upcoming };
}

export function memoryContextLine(userText: string): string {
  const { relevant, upcoming } = memoriesForRequest(userText);
  return formatMemoryContextBlock(relevant, upcoming);
}

export function memoriesForBrief(): MemoryRecord[] {
  const today = kolkataYmd();
  return memoriesWithEventDateBetween(today, addDaysYmd(today, 14));
}

export function memoriesMatchingText(haystack: string): MemoryRecord[] {
  if (!haystack.trim()) {
    return [];
  }
  return searchMemories(haystack, 8);
}

function persistFact(
  fact: ExtractedFact,
  source: MemorySource,
  existing: MemoryRecord[],
): { memory: MemoryRecord; updated: boolean } {
  const target = findMemoryToUpdate(existing, fact);
  if (target) {
    const memory = updateMemory(target.id, {
      content: fact.content,
      category: fact.category,
      tag: fact.tag,
      eventDate: fact.event_date,
      source,
    })!;
    return { memory, updated: true };
  }
  const memory = createMemory({
    content: fact.content,
    category: fact.category,
    tag: fact.tag,
    eventDate: fact.event_date,
    source,
  });
  return { memory, updated: false };
}

export function saveExplicitMemory(rawFact: string): {
  ok: true;
  text: string;
  memory: MemoryRecord;
  updated: boolean;
} | { ok: false; text: string } {
  if (isSensitiveMemoryText(rawFact)) {
    return { ok: false, text: SENSITIVE_REFUSAL };
  }
  const fact: ExtractedFact = {
    content: rawFact.replace(/\.*$/, "").trim(),
    category: defaultCategoryForExplicit(rawFact),
    tag: defaultTagForExplicit(rawFact),
    event_date: parseEventDateFromText(rawFact),
    weight: "important",
    update_of_id: null,
  };
  const existing = searchMemories(fact.content, 15);
  const { memory, updated } = persistFact(fact, "explicit", existing);
  return {
    ok: true,
    text: confirmationLine(updated ? "Updated" : "Noted", memory.content, memory.tag),
    memory,
    updated,
  };
}

function offerKeyboard(memory: MemoryRecord): InlineKeyboard | undefined {
  const keyboard = new InlineKeyboard();
  let used = false;
  if (
    looksLikeDatedEvent({
      category: memory.category,
      event_date: memory.event_date,
    }) &&
    memory.event_date &&
    memory.event_date >= kolkataYmd()
  ) {
    keyboard.text("Set a reminder", `mem:remind:${memory.id}`);
    used = true;
  }
  const accounts = findAccountsInText(
    decodedAccounts(),
    memory.content,
  ) as AccountRecord[];
  if (memory.category === "deal" && accounts[0]) {
    if (used) {
      keyboard.row();
    }
    keyboard.text(
      `Update ${accounts[0].name}`.slice(0, 64),
      `mem:acct:${memory.id}`,
    );
    used = true;
  }
  return used ? keyboard : undefined;
}

async function sendConfirmation(
  ctx: Context,
  text: string,
  memory: MemoryRecord,
): Promise<void> {
  const keyboard = offerKeyboard(memory);
  await ctx.reply(text, keyboard ? { reply_markup: keyboard } : undefined);
}

export async function handleExplicitRemember(
  ctx: Context,
  userText: string,
): Promise<boolean> {
  const parsed = parseExplicitRemember(userText);
  if (!parsed.matched) {
    return false;
  }
  if (!parsed.body) {
    await ctx.reply("What should I remember?");
    return true;
  }
  const result = saveExplicitMemory(parsed.body);
  if (!result.ok) {
    await ctx.reply(result.text);
    return true;
  }
  await sendConfirmation(ctx, result.text, result.memory);
  return true;
}

function rememberKeyboard(pendingId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("Yes", `mem:yes:${pendingId}`)
    .text("No", `mem:no:${pendingId}`);
}

async function extractFactsFromMessage(userText: string): Promise<ExtractedFact[]> {
  const candidates = searchMemories(userText, 10).map((item) => ({
    id: item.id,
    category: item.category,
    tag: item.tag,
    event_date: item.event_date,
  }));
  const response = await completeBackground({
    system: {
      cacheable: `You extract long-term facts from Vishnu's Telegram message for Aadi.
Return JSON only: {"facts":[{"content":"one clear fact","category":"deal|plan|event|person|preference|other","tag":"work|personal","event_date":"YYYY-MM-DD or null","weight":"important|unsure|trivial","update_of_id":null or id}]}
Important: deals and status, plans, upcoming demos/meetings, deadlines, decisions, commitments, key people and roles. Save those.
Unsure: might matter but could be casual. Ask.
Trivial: small talk, questions with no new fact, thanks, scheduling a one-off lookup. Ignore. Return [].
Never invent. Never include passwords, OTPs, card/account numbers, or health details (omit those).
event_date only for a specific calendar day, Asia/Kolkata, YYYY-MM-DD.
If the message updates a candidate memory, set update_of_id to that id.
At most 2 facts. Prefer one. Content under 140 characters.`,
    },
    messages: [
      {
        role: "user",
        content: JSON.stringify({
          today: kolkataYmd(),
          message: userText,
          candidates,
        }),
      },
    ],
    tools: [],
    maxTokens: 512,
    task: "memory_extraction",
  });
  console.log(
    `Memory capture: facts_raw_len=${response.textParts.join("").length} input_tokens=${response.usage.inputTokens} output_tokens=${response.usage.outputTokens}`,
  );
  return parseExtractedFacts(response.textParts.join("\n"));
}

export async function captureFromUserMessage(
  ctx: Context,
  userText: string,
): Promise<void> {
  if (shouldSkipAutoCapture(userText)) {
    return;
  }
  let facts: ExtractedFact[];
  try {
    facts = await extractFactsFromMessage(userText);
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(`Memory capture failed (${errorType}).`);
    return;
  }
  const existing = searchMemories(userText, 15);
  const important = facts.filter((item) => item.weight === "important");
  const unsure = facts.find((item) => item.weight === "unsure");
  const saved: Array<{ memory: MemoryRecord; updated: boolean }> = [];
  for (const fact of important.slice(0, 2)) {
    if (isSensitiveMemoryText(fact.content)) {
      continue;
    }
    saved.push(persistFact(fact, "auto", existing));
  }
  if (saved.length === 1) {
    const item = saved[0]!;
    await sendConfirmation(
      ctx,
      confirmationLine(
        item.updated ? "Updated" : "Noted",
        item.memory.content,
        item.memory.tag,
      ),
      item.memory,
    );
  } else if (saved.length > 1) {
    const first = saved[0]!;
    await sendConfirmation(
      ctx,
      `${confirmationLine(first.updated ? "Updated" : "Noted", first.memory.content, first.memory.tag)} (+${saved.length - 1} more)`,
      first.memory,
    );
  }
  if (unsure && saved.length === 0 && !isSensitiveMemoryText(unsure.content)) {
    const pending = createPendingMemoryConfirm({
      content: unsure.content,
      category: unsure.category,
      tag: unsure.tag,
      eventDate: unsure.event_date,
      updateOfId: findMemoryToUpdate(existing, unsure)?.id ?? unsure.update_of_id,
    });
    console.log(`Memory confirm ${pending.id}: asked`);
    await ctx.reply("Should I remember this?", {
      reply_markup: rememberKeyboard(pending.id),
    });
  }
}

export async function handleMemoryConfirmCallback(
  ctx: Context,
  accept: boolean,
  pendingId: number,
): Promise<void> {
  const pending = getPendingMemoryConfirm(pendingId);
  if (!pending) {
    await ctx.answerCallbackQuery("That prompt expired.");
    return;
  }
  deletePendingMemoryConfirm(pendingId);
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(
    () => undefined,
  );
  if (!accept) {
    await ctx.answerCallbackQuery("Skipped");
    return;
  }
  if (isSensitiveMemoryText(pending.content)) {
    await ctx.answerCallbackQuery();
    await ctx.reply(SENSITIVE_REFUSAL);
    return;
  }
  const fact: ExtractedFact = {
    content: pending.content,
    category: pending.category,
    tag: pending.tag,
    event_date: pending.event_date,
    weight: "important",
    update_of_id: pending.update_of_id,
  };
  const existing = fact.update_of_id
    ? ([getMemory(fact.update_of_id)].filter(Boolean) as MemoryRecord[])
    : searchMemories(fact.content, 15);
  const { memory, updated } = persistFact(fact, "confirmed", existing);
  await ctx.answerCallbackQuery(updated ? "Updated" : "Noted");
  await sendConfirmation(
    ctx,
    confirmationLine(updated ? "Updated" : "Noted", memory.content, memory.tag),
    memory,
  );
}

export async function handleMemoryForgetCallback(
  ctx: Context,
  memoryId: number,
): Promise<void> {
  const existed = deleteMemory(memoryId);
  await ctx.answerCallbackQuery(existed ? "Forgotten" : "Already gone");
  if (existed) {
    await ctx.reply(`Forgotten #${memoryId}.`);
  }
}

export async function handleForgetAllCallback(
  ctx: Context,
  confirm: boolean,
): Promise<void> {
  if (!confirm) {
    await ctx.answerCallbackQuery("Kept");
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(
      () => undefined,
    );
    return;
  }
  const count = deleteAllMemories();
  await ctx.answerCallbackQuery("Forgotten");
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(
    () => undefined,
  );
  await ctx.reply(
    count === 0 ? "No memories to forget." : `Forgotten ${count} memories.`,
  );
}

export async function handleMemoryReminderCallback(
  ctx: Context,
  memoryId: number,
): Promise<void> {
  const memory = getMemory(memoryId);
  await ctx.answerCallbackQuery();
  if (!memory?.event_date) {
    await ctx.reply("That memory has no date to remind you of.");
    return;
  }
  const remindAt = reminderAtNine(memory.event_date);
  if (new Date(remindAt).getTime() <= Date.now()) {
    await ctx.reply("That date is already in the past.");
    return;
  }
  const reminder = createReminder(
    memory.content,
    memory.tag,
    remindAt,
    "none",
  );
  console.log(`Reminder ${reminder.id}: status -> pending (from memory ${memory.id})`);
  await ctx.reply(
    `Reminder set for ${memory.event_date} 9:00am (${memory.tag}).`,
  );
}

export async function handleMemoryAccountCallback(
  ctx: Context,
  memoryId: number,
): Promise<void> {
  await ctx.answerCallbackQuery();
  const memory = getMemory(memoryId);
  if (!memory) {
    await ctx.reply("That memory is gone.");
    return;
  }
  const matches = findAccountsInText(
    decodedAccounts(),
    memory.content,
  ) as AccountRecord[];
  const account = matches[0];
  if (!account) {
    await ctx.reply("No tracked account matched that memory.");
    return;
  }
  const suggestion = suggestedUpdateFromWrapUp(account, {
    title: memory.content,
    people: "",
    content: memory.content,
    decisions: [],
    action_items: [],
  });
  if (!suggestion) {
    await ctx.reply(`No account change suggested for ${account.name}.`);
    return;
  }
  const pending = createPendingAccountUpdate({
    accountId: account.id,
    suggestedStage: suggestion.stage,
    suggestedNextStep: suggestion.next_step,
    suggestedWaitingOn: suggestion.waiting_on,
  });
  await ctx.reply(`Update ${account.name}?`, {
    reply_markup: new InlineKeyboard()
      .text(
        `Update ${account.name}`.slice(0, 64),
        `acct:yes:${pending.id}`,
      )
      .row()
      .text("No change", `acct:no:${pending.id}`),
  });
}

export async function sendMemoryList(ctx: Context): Promise<void> {
  const memories = listMemories();
  if (memories.length === 0) {
    await ctx.reply("No memories saved.");
    return;
  }
  await ctx.reply(groupedMemoryText(memories));
  const chunkSize = 8;
  for (let offset = 0; offset < memories.length && offset < 80; offset += chunkSize) {
    const chunk = memories.slice(offset, offset + chunkSize);
    const keyboard = new InlineKeyboard();
    for (const [index, memory] of chunk.entries()) {
      if (index > 0) {
        keyboard.row();
      }
      keyboard.text(`Forget #${memory.id}`, `mem:forget:${memory.id}`);
    }
    await ctx.reply("Forget:", { reply_markup: keyboard });
  }
}

export async function handleForgetQuery(
  ctx: Context,
  query: string,
): Promise<void> {
  const matches = searchMemories(query, 10);
  if (matches.length === 0) {
    await ctx.reply("I couldn't find a memory matching that.");
    return;
  }
  if (matches.length === 1) {
    const memory = matches[0]!;
    deleteMemory(memory.id);
    await ctx.reply(`Forgotten #${memory.id}.`);
    return;
  }
  const keyboard = new InlineKeyboard();
  for (const [index, memory] of matches.entries()) {
    if (index > 0) {
      keyboard.row();
    }
    keyboard.text(`Forget #${memory.id}`, `mem:forget:${memory.id}`);
  }
  await ctx.reply(
    `Several memories matched:\n${matches.map((item) => `#${item.id} ${item.content}`).join("\n")}`,
    { reply_markup: keyboard },
  );
}

export async function askForgetEverything(ctx: Context): Promise<void> {
  await ctx.reply("Delete all memories? This cannot be undone.", {
    reply_markup: new InlineKeyboard()
      .text("Delete all", "mem:wipe:yes")
      .text("Keep them", "mem:wipe:no"),
  });
}

export function saveMemoryFromTool(input: {
  content: string;
  category: MemoryRecord["category"];
  tag: ItemTag;
  eventDate?: string | null;
}): string {
  if (isSensitiveMemoryText(input.content)) {
    throw new Error(SENSITIVE_REFUSAL);
  }
  const fact: ExtractedFact = {
    content: input.content.trim(),
    category: input.category,
    tag: input.tag,
    event_date: input.eventDate ?? null,
    weight: "important",
    update_of_id: null,
  };
  const { memory, updated } = persistFact(
    fact,
    "explicit",
    searchMemories(fact.content, 15),
  );
  return JSON.stringify({
    id: memory.id,
    updated,
    tag: memory.tag,
    category: memory.category,
  });
}
