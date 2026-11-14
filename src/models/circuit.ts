import { db } from "../db.js";
import { assertTestSeam } from "../test_seam.js";

/**
 * A circuit breaker per provider (and per model). It watches recent calls:
 * timeouts, 429s, 5xx, malformed responses, tool calls the provider formatted
 * badly, and latency.
 *
 *   CLOSED     healthy: calls go through.
 *   OPEN       too many recent failures or very slow: new work goes to the
 *              agent's fallback model instead, for a cooldown.
 *   HALF_OPEN  the cooldown is over: one small test request is sent. Success
 *              closes the circuit; failure opens it again for longer.
 *
 * Credit and auth failures keep their own six-hour pause (llm_fallback.ts).
 * Switching provider never repeats a tool side effect: the dispatcher replays
 * a call that already succeeded in the turn.
 */
export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";
export type CallOutcome = "ok" | "timeout" | "rate_limit" | "server" | "malformed" | "tool_format" | "auth" | "other";

interface Sample {
  at: number;
  outcome: CallOutcome;
  ms: number;
}

interface Breaker {
  key: string;
  state: CircuitState;
  samples: Sample[];
  consecutiveFailures: number;
  openedAt: number;
  cooldownMs: number;
  activations: number;
  lastReason: string;
  probing: boolean;
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]?.trim() || fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export interface CircuitSettings {
  windowMs: number;
  minSamples: number;
  failureRate: number;
  consecutiveFailures: number;
  /** An average this slow over the last few successes counts as severe latency. */
  slowMs: number;
  cooldownMs: number;
  maxCooldownMs: number;
}

let settings: CircuitSettings = readSettings();

function readSettings(): CircuitSettings {
  return {
    windowMs: envNumber("CIRCUIT_WINDOW_SECONDS", 300) * 1000,
    minSamples: envNumber("CIRCUIT_MIN_SAMPLES", 6),
    failureRate: envNumber("CIRCUIT_FAILURE_RATE", 0.5),
    consecutiveFailures: envNumber("CIRCUIT_CONSECUTIVE_FAILURES", 5),
    slowMs: envNumber("CIRCUIT_SLOW_SECONDS", 45) * 1000,
    cooldownMs: envNumber("CIRCUIT_COOLDOWN_SECONDS", 60) * 1000,
    maxCooldownMs: envNumber("CIRCUIT_MAX_COOLDOWN_SECONDS", 600) * 1000,
  };
}

db.exec(`
  CREATE TABLE IF NOT EXISTS metric_circuit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    breaker TEXT NOT NULL,
    from_state TEXT NOT NULL,
    to_state TEXT NOT NULL,
    reason TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_metric_circuit_created ON metric_circuit (created_at);
`);

const breakers = new Map<string, Breaker>();
type Probe = (key: string) => Promise<boolean>;
let probe: Probe | undefined;

/** llm.ts registers how to send the small test request. */
export function setCircuitProbe(fn: Probe | undefined): void {
  probe = fn;
}

function breakerOf(key: string): Breaker {
  let breaker = breakers.get(key);
  if (!breaker) {
    breaker = {
      key,
      state: "CLOSED",
      samples: [],
      consecutiveFailures: 0,
      openedAt: 0,
      cooldownMs: settings.cooldownMs,
      activations: 0,
      lastReason: "",
      probing: false,
    };
    breakers.set(key, breaker);
  }
  return breaker;
}

function transition(breaker: Breaker, to: CircuitState, reason: string): void {
  if (breaker.state === to) {
    return;
  }
  const from = breaker.state;
  breaker.state = to;
  breaker.lastReason = reason;
  if (to === "OPEN") {
    breaker.openedAt = Date.now();
    breaker.activations += 1;
  }
  if (to === "CLOSED") {
    breaker.cooldownMs = settings.cooldownMs;
    breaker.consecutiveFailures = 0;
    // A provider that recovered takes its models with it: their failures were the provider's.
    if (!breaker.key.startsWith("model:")) {
      for (const other of breakers.values()) {
        if (other.key.startsWith(`model:${breaker.key}:`) && other.state !== "CLOSED") {
          other.samples = [];
          transition(other, "CLOSED", `${breaker.key} recovered`);
        }
      }
    }
  }
  console.log(`circuit: ${breaker.key} ${from} -> ${to} (${reason})`);
  try {
    db.prepare(`INSERT INTO metric_circuit (created_at, breaker, from_state, to_state, reason) VALUES (?, ?, ?, ?, ?)`).run(
      new Date().toISOString(),
      breaker.key,
      from,
      to,
      reason.slice(0, 120),
    );
  } catch {
    // Recording is best effort.
  }
}

/** What kind of failure an error is. */
export function classifyFailure(error: unknown): CallOutcome {
  const record = error as { status?: unknown; name?: unknown; code?: unknown; message?: unknown };
  const status = Number(record?.status);
  const text = `${String(record?.name ?? "")} ${String(record?.code ?? "")} ${String(record?.message ?? error ?? "")}`;
  if (status === 429 || /\b429\b|rate.?limit|too many requests|resource.?exhausted/i.test(text)) {
    return "rate_limit";
  }
  if (status === 401 || status === 402 || status === 403 || /credit balance|insufficient.?(credit|balance|quota)|invalid api key|incorrect api key|unauthori[sz]ed/i.test(text)) {
    return "auth";
  }
  if (/timed? ?out|timeout|ETIMEDOUT|AbortError|aborted/i.test(text)) {
    return "timeout";
  }
  if ((Number.isInteger(status) && status >= 500) || /\b5\d\d\b|overloaded|unavailable|bad gateway|internal server error|ECONNRESET|ECONNREFUSED|fetch failed/i.test(text)) {
    return "server";
  }
  if (/thought_signature|no completion choices|unexpected token|invalid json|malformed|could not parse|without a client tool call/i.test(text)) {
    return "malformed";
  }
  return "other";
}

function prune(breaker: Breaker, now: number): void {
  breaker.samples = breaker.samples.filter((sample) => now - sample.at <= settings.windowMs).slice(-50);
}

function shouldOpen(breaker: Breaker): string | undefined {
  if (breaker.consecutiveFailures >= settings.consecutiveFailures) {
    return `${breaker.consecutiveFailures} failures in a row`;
  }
  const counted = breaker.samples.filter((sample) => sample.outcome !== "auth");
  if (counted.length >= settings.minSamples) {
    const failures = counted.filter((sample) => sample.outcome !== "ok").length;
    if (failures / counted.length >= settings.failureRate) {
      return `${failures} of the last ${counted.length} calls failed`;
    }
  }
  const recentOk = breaker.samples.filter((sample) => sample.outcome === "ok").slice(-5);
  if (recentOk.length >= 3) {
    const average = recentOk.reduce((sum, sample) => sum + sample.ms, 0) / recentOk.length;
    if (average >= settings.slowMs) {
      return `average latency ${(average / 1000).toFixed(1)}s`;
    }
  }
  return undefined;
}

/** Records one call's outcome against a breaker key ("gemini" or "model:gemini:flash"). */
export function recordCall(key: string, outcome: CallOutcome, ms: number, now = Date.now()): void {
  const breaker = breakerOf(key);
  breaker.samples.push({ at: now, outcome, ms });
  prune(breaker, now);
  if (outcome === "ok") {
    breaker.consecutiveFailures = 0;
  } else if (outcome !== "auth") {
    breaker.consecutiveFailures += 1;
  }
  if (breaker.state === "CLOSED") {
    const reason = shouldOpen(breaker);
    if (reason) {
      transition(breaker, "OPEN", reason);
    }
  }
}

function startProbe(breaker: Breaker): void {
  if (breaker.probing) {
    return;
  }
  breaker.probing = true;
  const run = probe ? probe(breaker.key) : Promise.resolve(true);
  void run
    .then((ok) => {
      if (ok) {
        breaker.samples = [];
        transition(breaker, "CLOSED", "health probe succeeded");
      } else {
        breaker.cooldownMs = Math.min(settings.maxCooldownMs, breaker.cooldownMs * 2);
        transition(breaker, "OPEN", "health probe failed");
        breaker.openedAt = Date.now();
      }
    })
    .catch(() => {
      breaker.cooldownMs = Math.min(settings.maxCooldownMs, breaker.cooldownMs * 2);
      transition(breaker, "OPEN", "health probe failed");
      breaker.openedAt = Date.now();
    })
    .finally(() => {
      breaker.probing = false;
    });
}

/**
 * May new work go to this key now? An open circuit whose cooldown has passed
 * moves to HALF_OPEN and sends its one health probe; the work in hand goes to
 * the fallback meanwhile.
 */
export function circuitAllows(key: string, now = Date.now()): boolean {
  const breaker = breakers.get(key);
  if (!breaker || breaker.state === "CLOSED") {
    return true;
  }
  if (breaker.state === "OPEN" && now - breaker.openedAt >= breaker.cooldownMs) {
    transition(breaker, "HALF_OPEN", "cooldown over");
    startProbe(breaker);
  }
  return false;
}

/** Read-only: is the circuit open or testing? */
export function circuitState(key: string): CircuitState {
  return breakers.get(key)?.state ?? "CLOSED";
}

export interface CircuitHealth {
  key: string;
  state: CircuitState;
  calls: number;
  successRate: number | undefined;
  avgMs: number | undefined;
  timeouts: number;
  rateLimits: number;
  serverErrors: number;
  malformed: number;
  toolFormat: number;
  consecutiveFailures: number;
  activations: number;
  reopensInMs?: number;
  lastReason: string;
}

export function circuitHealth(now = Date.now()): CircuitHealth[] {
  return [...breakers.values()]
    .filter((breaker) => !breaker.key.startsWith("model:"))
    .map((breaker) => {
      prune(breaker, now);
      const samples = breaker.samples;
      const ok = samples.filter((sample) => sample.outcome === "ok");
      const count = (outcome: CallOutcome) => samples.filter((sample) => sample.outcome === outcome).length;
      return {
        key: breaker.key,
        state: breaker.state,
        calls: samples.length,
        successRate: samples.length ? ok.length / samples.length : undefined,
        avgMs: ok.length ? ok.reduce((sum, sample) => sum + sample.ms, 0) / ok.length : undefined,
        timeouts: count("timeout"),
        rateLimits: count("rate_limit"),
        serverErrors: count("server"),
        malformed: count("malformed"),
        toolFormat: count("tool_format"),
        consecutiveFailures: breaker.consecutiveFailures,
        activations: breaker.activations,
        ...(breaker.state === "OPEN" ? { reopensInMs: Math.max(0, breaker.cooldownMs - (now - breaker.openedAt)) } : {}),
        lastReason: breaker.lastReason,
      };
    })
    .sort((left, right) => left.key.localeCompare(right.key));
}

/** "gemini CLOSED 98% 2.1s · deepseek OPEN 40s (5 failures in a row)" */
export function formatProviderHealth(): string {
  const health = circuitHealth();
  if (health.length === 0) {
    return "providers: no calls yet";
  }
  return `providers: ${health
    .map((item) => {
      const rate = item.successRate === undefined ? "" : ` ${Math.round(item.successRate * 100)}%`;
      const latency = item.avgMs === undefined ? "" : ` ${(item.avgMs / 1000).toFixed(1)}s`;
      const open = item.state === "OPEN" ? ` reopens in ${Math.ceil((item.reopensInMs ?? 0) / 1000)}s (${item.lastReason})` : "";
      return `${item.key} ${item.state}${rate}${latency}${open}`;
    })
    .join(" · ")}`;
}

export function circuitActivations(fromIso: string, toIso: string): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM metric_circuit WHERE to_state = 'OPEN' AND from_state = 'CLOSED' AND created_at >= ? AND created_at < ?`)
      .get(fromIso, toIso) as { n: number }
  ).n;
}

export function resetCircuitsForTests(next?: Partial<CircuitSettings>): void {
  assertTestSeam("resetCircuitsForTests");
  breakers.clear();
  settings = { ...readSettings(), ...next };
}
