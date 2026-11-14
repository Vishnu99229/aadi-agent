import { db } from "./db.js";
// metric_turns lives there; it must exist before the queries below.
import "./metrics.js";

/**
 * Corrections, retries and dissatisfaction as a quality signal for the agent
 * and model that answered the previous turn.
 *
 * Only clear cases count. "No, I meant Hardik from Pinnacle", "that's the wrong
 * meeting", "rewrite it, too formal", "that research is outdated", the Retry
 * button, or the same message sent again within minutes. An ordinary follow-up
 * ("and also remind me", "thanks", "no, that's all") is not a correction.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS metric_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    turn_id INTEGER,
    chat_id INTEGER,
    kind TEXT NOT NULL CHECK (kind IN ('correction', 'retry', 'dissatisfaction')),
    category TEXT NOT NULL,
    agent_id TEXT,
    model TEXT,
    route TEXT,
    tools_json TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX IF NOT EXISTS idx_metric_feedback_created ON metric_feedback (created_at);
`);

export type FeedbackKind = "correction" | "retry" | "dissatisfaction";
export type CorrectionCategory =
  | "wrong_person"
  | "wrong_item"
  | "tone"
  | "outdated"
  | "misunderstood"
  | "incorrect"
  | "retry"
  | "dissatisfied";

export interface FeedbackSignal {
  kind: FeedbackKind;
  category: CorrectionCategory;
}

/** Replies that start with "no" but are answers, not corrections. */
const NOT_A_CORRECTION =
  /^(?:no|nope|nah)[,.!]?\s*(?:thanks|thank you|problem|worries|need|that'?s (?:all|it|fine|ok|okay)|i'?m good|it'?s fine|all good|later|not now)\b/i;

const RULES: Array<{ pattern: RegExp; signal: FeedbackSignal }> = [
  { pattern: /\b(?:i meant|i mean|i was talking about)\b/i, signal: { kind: "correction", category: "wrong_person" } },
  {
    pattern: /\b(?:wrong|not the right|not that|different) (?:person|contact|guy|one|hardik|name)\b/i,
    signal: { kind: "correction", category: "wrong_person" },
  },
  {
    pattern: /\b(?:wrong|not the right|not that) (?:meeting|email|mail|event|document|doc|file|thread|draft|account|build|reminder|task|date|time|day)\b/i,
    signal: { kind: "correction", category: "wrong_item" },
  },
  { pattern: /\btoo (?:formal|casual|informal|long|short|wordy|stiff|blunt|salesy|pushy)\b/i, signal: { kind: "correction", category: "tone" } },
  { pattern: /\b(?:rewrite|redo|rephrase) (?:it|this|that|the (?:email|reply|draft|message))\b/i, signal: { kind: "correction", category: "tone" } },
  {
    pattern: /\b(?:outdated|out of date|old (?:info|information|news|data|version)|stale|that'?s old|not the latest)\b/i,
    signal: { kind: "correction", category: "outdated" },
  },
  {
    pattern: /\b(?:not what i (?:asked|meant|said|wanted)|you misunderstood|misunderstood me|that'?s not what i)\b/i,
    signal: { kind: "correction", category: "misunderstood" },
  },
  {
    pattern: /\b(?:that'?s|this is|it'?s|that is|you'?re) (?:wrong|incorrect|not right|not correct|inaccurate)\b|^(?:no|nope|wrong)[,.!]+\s*(?:it'?s|that'?s|the|i)\b/i,
    signal: { kind: "correction", category: "incorrect" },
  },
  { pattern: /\b(?:useless|not helpful|unhelpful|that'?s (?:bad|terrible|awful)|come on|ugh)\b/i, signal: { kind: "dissatisfaction", category: "dissatisfied" } },
  { pattern: /^(?:try again|retry|one more time|do it again|again please)\b/i, signal: { kind: "retry", category: "retry" } },
];

/** What a message says about the previous answer, if anything clear. */
export function classifyFeedback(text: string): FeedbackSignal | undefined {
  const trimmed = text.trim();
  if (!trimmed || NOT_A_CORRECTION.test(trimmed)) {
    return undefined;
  }
  return RULES.find((rule) => rule.pattern.test(trimmed))?.signal;
}

function normalized(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** The same request again soon after is a retry, even without the word. */
export function isRepeat(previous: string, current: string): boolean {
  const left = normalized(previous);
  const right = normalized(current);
  if (!left || left.length < 8) {
    return false;
  }
  if (left === right) {
    return true;
  }
  const a = new Set(left.split(" "));
  const b = new Set(right.split(" "));
  const shared = [...a].filter((word) => b.has(word)).length;
  return shared / Math.max(a.size, b.size) >= 0.9;
}

const WINDOW_MS = 15 * 60 * 1000;
const REPEAT_WINDOW_MS = 3 * 60 * 1000;
const lastText = new Map<number, { text: string; at: number }>();

interface LastTurn {
  id: number;
  created_at: string;
  route: string;
  agents_json: string;
  models_json: string;
  tools_json: string;
}

function lastTurn(chatId: number, now: number): LastTurn | undefined {
  const row = db
    .prepare(
      `SELECT id, created_at, route, agents_json, models_json, tools_json FROM metric_turns WHERE chat_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(chatId) as LastTurn | undefined;
  return row && now - Date.parse(row.created_at) <= WINDOW_MS ? row : undefined;
}

function first(json: string): string | null {
  try {
    const list = JSON.parse(json) as unknown[];
    return typeof list[0] === "string" ? list[0] : null;
  } catch {
    return null;
  }
}

/** Ties a signal to the previous turn's agent, model, route and tools. */
export function recordFeedback(chatId: number, signal: FeedbackSignal, now = Date.now()): boolean {
  const turn = lastTurn(chatId, now);
  if (!turn) {
    return false;
  }
  try {
    db.prepare(
      `INSERT INTO metric_feedback (created_at, turn_id, chat_id, kind, category, agent_id, model, route, tools_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      new Date(now).toISOString(),
      turn.id,
      chatId,
      signal.kind,
      signal.category,
      first(turn.agents_json),
      first(turn.models_json),
      turn.route,
      turn.tools_json ?? "[]",
    );
    console.log(`feedback: ${signal.kind} (${signal.category}) on turn ${turn.id} agent=${first(turn.agents_json)} model=${first(turn.models_json)}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Called with each of Vishnu's own messages before it is handled. Records a
 * correction, a dissatisfaction or a repeat against the previous turn. It
 * never changes how the message is handled.
 */
export function noteOwnerMessage(chatId: number, text: string, now = Date.now()): FeedbackSignal | undefined {
  const previous = lastText.get(chatId);
  lastText.set(chatId, { text, at: now });
  let signal = classifyFeedback(text);
  if (!signal && previous && now - previous.at <= REPEAT_WINDOW_MS && isRepeat(previous.text, text)) {
    signal = { kind: "retry", category: "retry" };
  }
  if (signal && recordFeedback(chatId, signal, now)) {
    return signal;
  }
  return undefined;
}

/** The Retry button on a failed answer. */
export function noteRetryTap(chatId: number, now = Date.now()): void {
  recordFeedback(chatId, { kind: "retry", category: "retry" }, now);
}
