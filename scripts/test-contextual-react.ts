import { runAgent, setToolInterceptorForTests } from "../src/agent.ts";
import {
  createReactionSession,
  isPickerWhitelistEmoji,
  parsePickerOutput,
  PICKER_EMOJIS,
  pickerEmojiOrNull,
  resetReactionFrequencyForTests,
  runContextualReaction,
  setPickContextualEmojiForTests,
  shouldAllowPickerReaction,
  startContextualReaction,
} from "../src/contextual_react.ts";
import { setCompleteForTests } from "../src/llm.ts";
import { isAllowedTelegramReaction } from "../src/telegram_react.ts";
import { modelReply, scriptedModel } from "./fakes.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function sessionSpy(): {
  seen: string[];
  session: ReturnType<typeof createReactionSession>;
} {
  const seen: string[] = [];
  const session = createReactionSession({
    react: async (emoji) => {
      seen.push(emoji);
    },
    messageId: 42,
  });
  return { seen, session };
}

async function testParseAndWhitelist(): Promise<void> {
  const win = parsePickerOutput('{"emoji":"🎉","confidence":0.92}');
  assert(win.emoji === "🎉" && win.confidence === 0.92, "parses a win emoji");
  const none = parsePickerOutput('{"emoji":null,"confidence":0.2}');
  assert(none.emoji === null, "null emoji is allowed");
  const heart = parsePickerOutput('{"emoji":"❤️","confidence":0.88}');
  assert(heart.emoji === "❤", "strips variation selector to Telegram ❤");
  const dropped = parsePickerOutput('{"emoji":"💩","confidence":0.99}');
  assert(dropped.emoji === null, "non-whitelisted model emoji is dropped");
  const clown = parsePickerOutput('{"emoji":"🤡","confidence":1}');
  assert(clown.emoji === null, "clown is dropped");
  assert(pickerEmojiOrNull("🤮") === undefined, "vomit is not on the picker list");
  assert(pickerEmojiOrNull("🖕") === undefined, "middle finger is not on the picker list");
  for (const emoji of PICKER_EMOJIS) {
    assert(
      isAllowedTelegramReaction(emoji),
      `picker emoji ${emoji} must be on Telegram ReactionTypeEmoji`,
    );
    assert(isPickerWhitelistEmoji(emoji), `picker list includes ${emoji}`);
  }
}

function testFrequencyGuard(): void {
  assert(
    shouldAllowPickerReaction([true, true], 0.8) === false,
    "third of three is skipped under 0.9",
  );
  assert(
    shouldAllowPickerReaction([true, true], 0.9) === true,
    "strong emotion still reacts on the third",
  );
  assert(
    shouldAllowPickerReaction([true, false], 0.75) === true,
    "two of three is allowed",
  );
  assert(shouldAllowPickerReaction([], 0.7) === true, "first message can react");
}

async function testPickerAppliesAndNullSkips(): Promise<void> {
  resetReactionFrequencyForTests();
  setPickContextualEmojiForTests(async () => ({ emoji: "🎉", confidence: 0.91 }));
  const hit = sessionSpy();
  await runContextualReaction("I just closed Eternal!", hit.session);
  await hit.session.flush();
  assert(hit.seen.join(",") === "🎉", "picker output calls setMessageReaction");

  resetReactionFrequencyForTests();
  setPickContextualEmojiForTests(async () => ({ emoji: null, confidence: 0.4 }));
  const skipped = sessionSpy();
  await runContextualReaction("ok", skipped.session);
  await skipped.session.flush();
  assert(skipped.seen.length === 0, "null picker does not react");

  resetReactionFrequencyForTests();
  setPickContextualEmojiForTests(async () => ({ emoji: "💩", confidence: 0.99 }));
  const bad = sessionSpy();
  await runContextualReaction("gross", bad.session);
  await bad.session.flush();
  assert(bad.seen.length === 0, "non-whitelisted emoji is not sent");

  resetReactionFrequencyForTests();
  setPickContextualEmojiForTests(async () => ({ emoji: "🤔", confidence: 0.6 }));
  const low = sessionSpy();
  await runContextualReaction("hmm", low.session);
  await low.session.flush();
  assert(low.seen.length === 0, "confidence below 0.7 does not react");
}

async function testFrequencyInSession(): Promise<void> {
  resetReactionFrequencyForTests();
  setPickContextualEmojiForTests(async () => ({ emoji: "🔥", confidence: 0.8 }));
  const first = sessionSpy();
  const second = sessionSpy();
  const third = sessionSpy();
  await runContextualReaction("win one", first.session);
  await runContextualReaction("win two", second.session);
  await runContextualReaction("win three", third.session);
  await first.session.flush();
  await second.session.flush();
  await third.session.flush();
  assert(first.seen.join(",") === "🔥", "first of three reacts");
  assert(second.seen.join(",") === "🔥", "second of three reacts");
  assert(third.seen.length === 0, "third of three is held unless strong");

  resetReactionFrequencyForTests();
  const a = sessionSpy();
  const b = sessionSpy();
  const strong = sessionSpy();
  await runContextualReaction("win a", a.session);
  await runContextualReaction("win b", b.session);
  setPickContextualEmojiForTests(async () => ({ emoji: "🏆", confidence: 0.95 }));
  await runContextualReaction("huge win", strong.session);
  await a.session.flush();
  await b.session.flush();
  await strong.session.flush();
  assert(strong.seen.join(",") === "🏆", "confidence 0.9 still reacts on the third");
}

async function testDoesNotDelayReply(): Promise<void> {
  resetReactionFrequencyForTests();
  let pickStarted = false;
  setPickContextualEmojiForTests(
    () =>
      new Promise(() => {
        pickStarted = true;
      }),
  );
  const { session } = sessionSpy();
  let replyReady = false;
  startContextualReaction("hello there", session);
  replyReady = true;
  assert(replyReady, "text reply path is not awaited on the picker");
  assert(pickStarted, "picker started in the background");
}

async function testToolAckSwap(): Promise<void> {
  resetReactionFrequencyForTests();
  const model = scriptedModel((text) => {
    if (text.includes("Nitish")) {
      return { tools: [{ name: "list_events", input: {} }] };
    }
    return { text: "Booked." };
  });
  setCompleteForTests(model.fake);
  setToolInterceptorForTests(() => "events: none");
  const { seen, session } = sessionSpy();
  const reply = await runAgent("create a meeting with Nitish tomorrow 4pm", {
    skipHistory: true,
    saveUserMessage: false,
    saveAssistantMessage: false,
    reactions: session,
  });
  await session.flush();
  assert(reply.includes("events: none") || reply.includes("Booked."), "tool turn still replies");
  assert(seen[0] === "👀", "tool turn reacts 👀 first");
  assert(seen[1] === "👍", "successful tool turn replaces with 👍");
  assert(seen.join(",") === "👀,👍", "👀 then 👍 and nothing else");
  setToolInterceptorForTests(undefined);
  setCompleteForTests(undefined);
}

async function testToolAckFailureLeavesEyes(): Promise<void> {
  resetReactionFrequencyForTests();
  const model = scriptedModel(() => ({
    tools: [{ name: "search_emails", input: { query: "x" } }],
  }));
  setCompleteForTests(model.fake);
  setToolInterceptorForTests(() => {
    throw new Error("boom");
  });
  const { seen, session } = sessionSpy();
  let threw = false;
  try {
    await runAgent("search my mail", {
      skipHistory: true,
      saveUserMessage: false,
      saveAssistantMessage: false,
      reactions: session,
    });
  } catch {
    threw = true;
  }
  await session.flush();
  assert(threw, "failed tool bubbles");
  assert(seen.join(",") === "👀", "failed tool turn leaves 👀");
  setToolInterceptorForTests(undefined);
  setCompleteForTests(undefined);
}

async function testNoToolsNoAck(): Promise<void> {
  resetReactionFrequencyForTests();
  setCompleteForTests(async () => modelReply({ text: "Sounds good." }));
  const { seen, session } = sessionSpy();
  const reply = await runAgent("ok", {
    skipHistory: true,
    saveUserMessage: false,
    saveAssistantMessage: false,
    reactions: session,
  });
  await session.flush();
  assert(reply.includes("Sounds good."), "plain reply still sent");
  assert(seen.length === 0, "no tool means no 👀");
  setCompleteForTests(undefined);
}

async function testOwnMessageSkipped(): Promise<void> {
  resetReactionFrequencyForTests();
  setPickContextualEmojiForTests(async () => ({ emoji: "🎉", confidence: 0.99 }));
  const seen: string[] = [];
  const session = createReactionSession({
    react: async (emoji) => {
      seen.push(emoji);
    },
    fromIsBot: true,
    messageId: 99,
  });
  await runContextualReaction("I just closed Eternal!", session);
  await session.flush();
  assert(seen.length === 0, "never react to Aadi's own messages");
}

async function main(): Promise<void> {
  await testParseAndWhitelist();
  testFrequencyGuard();
  await testPickerAppliesAndNullSkips();
  await testFrequencyInSession();
  await testDoesNotDelayReply();
  await testToolAckSwap();
  await testToolAckFailureLeavesEyes();
  await testNoToolsNoAck();
  await testOwnMessageSkipped();
  setPickContextualEmojiForTests(undefined);
  resetReactionFrequencyForTests();
  console.log("test-contextual-react: ok");
}

await main();
