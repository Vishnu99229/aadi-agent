import { AsyncLocalStorage } from "node:async_hooks";
import { db } from "./db.js";
import { assertTestSeam } from "./test_seam.js";

/**
 * One resource governor for the whole Aadi process, above the per-workflow
 * limits. Every model call, goal loop, tool call, CPU-heavy job and A2A
 * request takes a slot from a shared pool; when a pool is full the work waits
 * in a queue (it does not fail), and the queue serves higher priority first:
 *
 *   1 foreground    Vishnu's active Telegram request (and work it started)
 *   2 continuation  his taps on approvals and cards
 *   3 urgent        reminders and scheduled sends
 *   4 a2a           requests from other agents
 *   5 delegated     delegated work with no live turn behind it (recovery)
 *   6 background    scans, indexing, embeddings
 *
 * While a foreground turn is running, background work gets at most
 * GOV_BACKGROUND_WHILE_ACTIVE model calls (default 1), so a scan can't make a
 * reply slow. Time spent queued is recorded apart from time spent running.
 *
 * The priority travels with the work through AsyncLocalStorage, so a workflow
 * started inside Vishnu's turn keeps his priority all the way down.
 */
export const PRIORITIES = ["foreground", "continuation", "urgent", "a2a", "delegated", "background"] as const;
export type Priority = (typeof PRIORITIES)[number];

const RANK: Record<Priority, number> = { foreground: 1, continuation: 2, urgent: 3, a2a: 4, delegated: 5, background: 6 };

export type PoolName = `model:${string}` | "goal_loops" | "tools" | "cpu" | "a2a";

function envInt(name: string, fallback: number, min = 0): number {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  return Number.isInteger(value) && value >= min ? value : fallback;
}

export interface GovernorLimits {
  /** Concurrent model calls per provider. */
  providerConcurrency: number;
  /** Specialist goal loops across every workflow. */
  goalLoops: number;
  tools: number;
  /** Heavy local CPU work (PDF parsing, OCR, embeddings, a local model). */
  cpu: number;
  a2a: number;
  /** Background model calls allowed while a foreground turn runs. */
  backgroundWhileActive: number;
}

function readLimits(): GovernorLimits {
  return {
    providerConcurrency: envInt("GOV_PROVIDER_CONCURRENCY", 2, 1),
    goalLoops: envInt("GOV_GOAL_LOOPS", 3, 1),
    tools: envInt("GOV_TOOL_CONCURRENCY", 8, 1),
    cpu: envInt("GOV_CPU_HEAVY", 1, 1),
    a2a: envInt("GOV_A2A_CONCURRENCY", 2, 1),
    backgroundWhileActive: envInt("GOV_BACKGROUND_WHILE_ACTIVE", 1, 0),
  };
}

let limits = readLimits();
let overrides: Partial<GovernorLimits> = {};

export function governorLimits(): GovernorLimits {
  return { ...limits, ...overrides };
}

export function setGovernorLimitsForTests(next: Partial<GovernorLimits> | undefined): void {
  assertTestSeam("setGovernorLimitsForTests");
  overrides = next ?? {};
  limits = readLimits();
  for (const pool of pools.values()) {
    pump(pool);
  }
}

function limitFor(name: string): number {
  const current = governorLimits();
  if (name.startsWith("model:")) {
    return current.providerConcurrency;
  }
  switch (name) {
    case "goal_loops":
      return current.goalLoops;
    case "tools":
      return current.tools;
    case "cpu":
      return current.cpu;
    case "a2a":
      return current.a2a;
    default:
      return 1;
  }
}

interface Waiter {
  priority: Priority;
  seq: number;
  enqueuedAt: number;
  grant: () => void;
}

interface Pool {
  name: string;
  active: number;
  activeByPriority: Record<Priority, number>;
  queue: Waiter[];
}

const pools = new Map<string, Pool>();
let seq = 0;
let foregroundActive = 0;

interface WorkContext {
  priority: Priority;
  /** Queue time collected for whoever is measuring this piece of work. */
  queue?: { ms: number };
}

const context = new AsyncLocalStorage<WorkContext>();

export function currentPriority(): Priority {
  return context.getStore()?.priority ?? "delegated";
}

function poolOf(name: string): Pool {
  let pool = pools.get(name);
  if (!pool) {
    pool = {
      name,
      active: 0,
      activeByPriority: { foreground: 0, continuation: 0, urgent: 0, a2a: 0, delegated: 0, background: 0 },
      queue: [],
    };
    pools.set(name, pool);
  }
  return pool;
}

/** Background model work is held back while Vishnu is mid-turn. */
function blocked(pool: Pool, priority: Priority): boolean {
  if (pool.active >= limitFor(pool.name)) {
    return true;
  }
  return (
    priority === "background" &&
    pool.name.startsWith("model:") &&
    foregroundActive > 0 &&
    pool.activeByPriority.background >= governorLimits().backgroundWhileActive
  );
}

function pump(pool: Pool): void {
  pool.queue.sort((left, right) => RANK[left.priority] - RANK[right.priority] || left.seq - right.seq);
  for (let index = 0; index < pool.queue.length; ) {
    const waiter = pool.queue[index]!;
    if (blocked(pool, waiter.priority)) {
      // A blocked background waiter must not hold up others behind it; anything
      // else blocked means the pool is full.
      if (pool.active >= limitFor(pool.name)) {
        return;
      }
      index += 1;
      continue;
    }
    pool.queue.splice(index, 1);
    waiter.grant();
  }
}

function pumpAll(): void {
  for (const pool of pools.values()) {
    pump(pool);
  }
}

let waitRecorder: ((pool: string, priority: Priority, ms: number) => void) | undefined = (pool, priority, ms) => {
  try {
    db.prepare(`INSERT INTO metric_waits (created_at, pool, priority, wait_ms) VALUES (?, ?, ?, ?)`).run(
      new Date().toISOString(),
      pool,
      priority,
      Math.round(ms),
    );
  } catch {
    // Never let measuring block work.
  }
};

db.exec(`
  CREATE TABLE IF NOT EXISTS metric_waits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    pool TEXT NOT NULL,
    priority TEXT NOT NULL,
    wait_ms INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_metric_waits_created ON metric_waits (created_at);
`);

export interface Slot {
  release(): void;
  waitedMs: number;
}

/** Takes a slot from a pool, waiting in priority order if it is full. */
export async function acquire(name: PoolName, priority: Priority = currentPriority()): Promise<Slot> {
  const pool = poolOf(name);
  const enqueuedAt = Date.now();
  if (!blocked(pool, priority) && pool.queue.length === 0) {
    pool.active += 1;
    pool.activeByPriority[priority] += 1;
  } else {
    await new Promise<void>((resolve) => {
      pool.queue.push({
        priority,
        seq: (seq += 1),
        enqueuedAt,
        grant: () => {
          pool.active += 1;
          pool.activeByPriority[priority] += 1;
          resolve();
        },
      });
      pump(pool);
    });
  }
  const waitedMs = Date.now() - enqueuedAt;
  if (waitedMs > 0) {
    const store = context.getStore();
    if (store?.queue) {
      store.queue.ms += waitedMs;
    }
    if (waitedMs >= 5) {
      waitRecorder?.(name, priority, waitedMs);
    }
  }
  let released = false;
  return {
    waitedMs,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      pool.active -= 1;
      pool.activeByPriority[priority] -= 1;
      pump(pool);
    },
  };
}

/** Runs fn holding a slot. The slot is released however fn ends. */
export async function withSlot<T>(name: PoolName, fn: () => Promise<T>, priority: Priority = currentPriority()): Promise<T> {
  const slot = await acquire(name, priority);
  try {
    return await fn();
  } finally {
    slot.release();
  }
}

/** Runs fn (and everything it starts) at a priority. Foreground runs are counted as Vishnu being active. */
export async function runWithPriority<T>(priority: Priority, fn: () => Promise<T>): Promise<T> {
  const parent = context.getStore();
  // Work already running for Vishnu keeps his priority when it calls into something lower.
  const effective = parent && RANK[parent.priority] < RANK[priority] ? parent.priority : priority;
  if (priority === "foreground") {
    foregroundActive += 1;
  }
  try {
    return await context.run({ priority: effective, queue: parent?.queue }, fn);
  } finally {
    if (priority === "foreground") {
      foregroundActive -= 1;
      pumpAll();
    }
  }
}

/** Measures queue time for one piece of work (a turn, a goal loop). */
export async function measuringQueue<T>(fn: () => Promise<T>): Promise<{ value: T; queueMs: number }> {
  const queue = { ms: 0 };
  const parent = context.getStore();
  const value = await context.run({ priority: parent?.priority ?? "delegated", queue }, fn);
  if (parent?.queue) {
    parent.queue.ms += queue.ms;
  }
  return { value, queueMs: queue.ms };
}

/** The provider a model call counts against. */
export function providerPool(provider: string): PoolName {
  return `model:${provider}`;
}

export interface GovernorSnapshot {
  foregroundActive: number;
  pools: Array<{ name: string; active: number; queued: number; limit: number }>;
}

export function governorSnapshot(): GovernorSnapshot {
  return {
    foregroundActive,
    pools: [...pools.values()]
      .map((pool) => ({ name: pool.name, active: pool.active, queued: pool.queue.length, limit: limitFor(pool.name) }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export function formatGovernorLine(): string {
  const snapshot = governorSnapshot();
  const busy = snapshot.pools.filter((pool) => pool.active > 0 || pool.queued > 0);
  const limitsNow = governorLimits();
  return `scheduler: foreground ${snapshot.foregroundActive}, ${busy.length === 0 ? "idle" : busy.map((pool) => `${pool.name} ${pool.active}/${pool.limit}${pool.queued ? ` +${pool.queued} queued` : ""}`).join(", ")} (limits: ${limitsNow.providerConcurrency}/provider, ${limitsNow.goalLoops} goal loops, ${limitsNow.cpu} cpu, background while active ${limitsNow.backgroundWhileActive})`;
}

export function setWaitRecorderForTests(recorder: ((pool: string, priority: Priority, ms: number) => void) | undefined): void {
  assertTestSeam("setWaitRecorderForTests");
  waitRecorder = recorder;
}

export interface QueueStats {
  waits: number;
  avgMs: number;
  p95Ms: number;
  byPriority: Record<string, number>;
}

export function queueStats(fromIso: string, toIso: string): QueueStats {
  const rows = db
    .prepare(`SELECT priority, wait_ms FROM metric_waits WHERE created_at >= ? AND created_at < ?`)
    .all(fromIso, toIso) as Array<{ priority: string; wait_ms: number }>;
  const sorted = rows.map((row) => row.wait_ms).sort((left, right) => left - right);
  const byPriority: Record<string, number> = {};
  for (const row of rows) {
    byPriority[row.priority] = (byPriority[row.priority] ?? 0) + 1;
  }
  return {
    waits: rows.length,
    avgMs: rows.length ? sorted.reduce((sum, value) => sum + value, 0) / rows.length : 0,
    p95Ms: rows.length ? sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)]! : 0,
    byPriority,
  };
}
