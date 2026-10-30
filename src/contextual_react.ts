import { completeBackground } from "./llm.js";
import { assertTestSeam } from "./test_seam.js";
import {
  applyTelegramReaction,
  isAllowedTelegramReaction,
  stripVariationSelectors,
} from "./telegram_react.js";

/** Subset of Telegram ReactionTypeEmoji. Offensive/odd ones are omitted. */
export const PICKER_EMOJIS = [
  "👍",
  "❤",
  "🔥",
  "👏",
  "🎉",
  "🤩",
  "🤔",
  "🤯",
  "😱",
  "🙏",
  "👌",
  "🤝",
  "💯",
  "😁",
  "🤣",
  "😢",
  "👀",
  "🫡",
  "✍",
  "🏆",
  "😎",
] as const;

export type PickerEmoji = (typeof PICKER_EMOJIS)[number];

const PICKER_WHITELIST = new Set<string>(
  PICKER_EMOJIS.filter((emoji) => isAllowedTelegramReaction(emoji)),
);

export const TASK_ACK_WORKING = "👀";
export const TASK_ACK_DONE = "👍";
const MIN_CONFIDENCE = 0.7;
const STRONG_CONFIDENCE = 0.9;

export const PICKER_SYSTEM = `You pick one Telegram reaction emoji for Vishnu's message to Aadi, his personal assistant, or null.

Return only JSON: {"emoji": <emoji or null>, "confidence": <0 to 1>}

emoji must be one of: ${PICKER_EMOJIS.join(" ")}
or null. null is a normal, frequent answer. Prefer null when unsure or the message is a plain instruction, "ok", or small talk with no emotion.

Guidance:
- good news / a win → 🎉 🔥 👏 🏆
- surprising or amazing → 🤯 🤩 😱
- a hard question or a decision to think about → 🤔
- sad, stressful, apology → 🙏 😢
- agreement / plan confirmed → 👍 👌 🤝
- a joke → 😁 🤣
- plain instruction, "ok", small talk with no emotion → null
- a task request (create a meeting, draft, search, remind, send) → null

Never use offensive or odd emoji (vomit, poop, clown, middle finger, angry-swear). Never react to every message.`;

export const REACTION_PICK_SCHEMA = {
  type: "object",
  properties: {
    emoji: {
      anyOf: [
        { type: "null" },
        { type: "string", enum: [...PICKER_EMOJIS] },
      ],
    },
    confidence: { type: "number" },
  },
  required: ["emoji", "confidence"],
  additionalProperties: false,
} as const;

export interface PickerResult {
  emoji: string | null;
  confidence: number;
}

export interface ReactionTarget {
  react: (emoji: string) => Promise<unknown>;
  messageId?: number;
  fromIsBot?: boolean;
}

const recentPickerReacted: boolean[] = [];
let pickImpl: (text: string) => Promise<PickerResult> = defaultPickContextualEmoji;

export function isPickerWhitelistEmoji(emoji: string): boolean {
  return PICKER_WHITELIST.has(stripVariationSelectors(emoji));
}

export function pickerEmojiOrNull(raw: string | null | undefined): string | undefined {
  if (raw == null) {
    return undefined;
  }
  const stripped = stripVariationSelectors(String(raw));
  if (!stripped || stripped === "null" || stripped === "none") {
    return undefined;
  }
  if (PICKER_WHITELIST.has(stripped)) {
    return stripped;
  }
  return undefined;
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

export function parsePickerOutput(text: string): PickerResult {
  const parsed = parseJsonObject(text);
  if (!parsed || typeof parsed !== "object") {
    return { emoji: null, confidence: 0 };
  }
  const row = parsed as { emoji?: unknown; confidence?: unknown };
  const confidenceRaw = Number(row.confidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.min(1, Math.max(0, confidenceRaw))
    : 0;
  if (row.emoji == null || row.emoji === "" || row.emoji === "null") {
    return { emoji: null, confidence };
  }
  if (typeof row.emoji !== "string") {
    return { emoji: null, confidence };
  }
  return {
    emoji: pickerEmojiOrNull(row.emoji) ?? null,
    confidence,
  };
}

export function shouldAllowPickerReaction(
  recentFlags: readonly boolean[],
  confidence: number,
): boolean {
  const lastTwo = recentFlags.slice(-2);
  if (lastTwo.length === 2 && lastTwo.every(Boolean) && confidence < STRONG_CONFIDENCE) {
    return false;
  }
  return true;
}

export function resetReactionFrequencyForTests(): void {
  assertTestSeam("resetReactionFrequencyForTests");
  recentPickerReacted.length = 0;
}

export function setPickContextualEmojiForTests(
  impl: ((text: string) => Promise<PickerResult>) | undefined,
): void {
  assertTestSeam("setPickContextualEmojiForTests");
  pickImpl = impl ?? defaultPickContextualEmoji;
}

async function defaultPickContextualEmoji(text: string): Promise<PickerResult> {
  const result = await completeBackground({
    system: { cacheable: PICKER_SYSTEM },
    messages: [{ role: "user", content: text.slice(0, 2000) }],
    tools: [],
    jsonSchema: REACTION_PICK_SCHEMA,
    maxTokens: 80,
    cacheTtl: "5m",
    task: "classification",
  });
  return parsePickerOutput(result.textParts.join(""));
}

export async function pickContextualEmoji(text: string): Promise<PickerResult> {
  try {
    return await pickImpl(text);
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.log(`reaction picker: failed error_type=${errorType}`);
    return { emoji: null, confidence: 0 };
  }
}

function messageMeta(messageId: number | undefined): string {
  return messageId != null ? `message_id=${messageId}` : "message_id=none";
}

function recordPickerOutcome(reacted: boolean): void {
  recentPickerReacted.push(reacted);
  if (recentPickerReacted.length > 12) {
    recentPickerReacted.splice(0, recentPickerReacted.length - 12);
  }
}

export class ReactionSession {
  private readonly reactFn: ((emoji: string) => Promise<unknown>) | undefined;
  private readonly messageId: number | undefined;
  private readonly fromIsBot: boolean;
  private working = false;
  private closed = false;
  private pickerApplied = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(target: ReactionTarget) {
    this.reactFn = target.react;
    this.messageId = target.messageId;
    this.fromIsBot = target.fromIsBot === true;
  }

  canReact(): boolean {
    return Boolean(this.reactFn) && !this.fromIsBot;
  }

  noteWorking(): void {
    if (!this.canReact() || this.working) {
      return;
    }
    this.working = true;
    console.log(`reaction ack: ${messageMeta(this.messageId)} status=working`);
    this.enqueue(TASK_ACK_WORKING);
  }

  finish(ok: boolean): void {
    if (!this.canReact()) {
      return;
    }
    this.closed = true;
    if (!this.working) {
      return;
    }
    if (ok) {
      console.log(`reaction ack: ${messageMeta(this.messageId)} status=done`);
      this.enqueue(TASK_ACK_DONE);
      return;
    }
    console.log(`reaction ack: ${messageMeta(this.messageId)} status=failed`);
  }

  flush(): Promise<void> {
    return this.chain;
  }

  applyPicker(emoji: string): void {
    if (!this.canReact() || this.working || this.closed || this.pickerApplied) {
      console.log(
        `reaction picker: ${messageMeta(this.messageId)} skipped reason=${this.working || this.closed ? "task_ack" : "already_reacted"}`,
      );
      return;
    }
    this.pickerApplied = true;
    console.log(
      `reaction picker: ${messageMeta(this.messageId)} emoji=${emoji} applied=1`,
    );
    this.enqueue(emoji);
  }

  private enqueue(emoji: string): void {
    const react = this.reactFn;
    if (!react) {
      return;
    }
    this.chain = this.chain
      .then(async () => {
        await applyTelegramReaction(react, emoji);
      })
      .catch(() => undefined);
  }
}

export function createReactionSession(target: ReactionTarget): ReactionSession {
  return new ReactionSession(target);
}

export async function runContextualReaction(
  text: string,
  session: ReactionSession,
): Promise<void> {
  if (!session.canReact() || !text.trim()) {
    if (session.canReact() === false) {
      console.log("reaction picker: skipped reason=own_message_or_unavailable");
    }
    return;
  }
  const picked = await pickContextualEmoji(text);
  if (picked.emoji == null) {
    console.log(
      `reaction picker: skipped reason=null confidence=${picked.confidence.toFixed(2)}`,
    );
    recordPickerOutcome(false);
    return;
  }
  if (picked.confidence < MIN_CONFIDENCE) {
    console.log(
      `reaction picker: skipped reason=low_confidence confidence=${picked.confidence.toFixed(2)}`,
    );
    recordPickerOutcome(false);
    return;
  }
  if (!isPickerWhitelistEmoji(picked.emoji)) {
    console.log("reaction picker: skipped reason=not_whitelisted");
    recordPickerOutcome(false);
    return;
  }
  if (!shouldAllowPickerReaction(recentPickerReacted, picked.confidence)) {
    console.log(
      `reaction picker: skipped reason=frequency confidence=${picked.confidence.toFixed(2)}`,
    );
    recordPickerOutcome(false);
    return;
  }
  session.applyPicker(picked.emoji);
  recordPickerOutcome(true);
}

/** Fire-and-forget. Must not be awaited by the reply path. */
export function startContextualReaction(
  text: string,
  session: ReactionSession,
): void {
  void runContextualReaction(text, session).catch((error: unknown) => {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.log(`reaction picker: failed error_type=${errorType}`);
  });
}
