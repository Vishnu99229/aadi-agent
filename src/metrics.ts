import type { RunReport } from "./agent.js";
import { db, getSetting, listUsageLogs, setSetting } from "./db.js";
import { cacheStats } from "./agents/cache.js";
import { queueStats } from "./governor.js";
import { circuitActivations, formatProviderHealth } from "./models/circuit.js";
import {
  AGENT_MODEL_LABELS,
  fallbackLabel,
  getAgentModelSetting,
  MODEL_AGENT_IDS,
  settingLabel,
} from "./models/agent_models.js";

/**
 * Measurements for the 7-day agent experiment. One row per user turn and one
 * per agent run (a turn on an agent's loop, a delegated goal, or a fast-path
 * answer that needed no model). Counts, timings and model keys only: no
 * message text is stored.
 *
 * Nothing here judges whether the architecture helped. The report shows the
 * numbers side by side and leaves the conclusion to whoever reads them.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS metric_turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    chat_id INTEGER,
    route TEXT NOT NULL,
    path TEXT NOT NULL CHECK (path IN ('fast', 'specialist', 'aadi', 'delegated')),
    agents_json TEXT NOT NULL,
    models_json TEXT NOT NULL,
    fallbacks INTEGER NOT NULL,
    model_calls INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cost_usd REAL NOT NULL,
    tool_calls INTEGER NOT NULL,
    duplicate_skipped INTEGER NOT NULL,
    first_model_ms INTEGER,
    total_ms INTEGER NOT NULL,
    workflow_ms INTEGER,
    workflows INTEGER NOT NULL DEFAULT 0,
    workflows_failed INTEGER NOT NULL DEFAULT 0,
    success INTEGER NOT NULL,
    auth_required INTEGER NOT NULL,
    uncertain INTEGER NOT NULL,
    error TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_metric_turns_created ON metric_turns (created_at);

  CREATE TABLE IF NOT EXISTS metric_agent_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    turn_id INTEGER,
    workflow_id TEXT,
    task_id TEXT,
    agent_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('turn', 'goal', 'fast')),
    primary_model TEXT,
    served_model TEXT,
    fallback INTEGER NOT NULL,
    model_calls INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cost_usd REAL NOT NULL,
    latency_ms INTEGER NOT NULL,
    first_model_ms INTEGER,
    tool_calls INTEGER NOT NULL,
    tool_errors INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    error_code TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_metric_agent_runs_created ON metric_agent_runs (created_at, agent_id);
  CREATE INDEX IF NOT EXISTS idx_metric_agent_runs_workflow ON metric_agent_runs (workflow_id);
`);

/** Columns added after the tables first shipped; added in place when missing. */
function addColumn(table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
for (const table of ["metric_turns", "metric_agent_runs"]) {
  addColumn(table, "queue_ms", "INTEGER NOT NULL DEFAULT 0");
  addColumn(table, "ctx_original_tokens", "INTEGER NOT NULL DEFAULT 0");
  addColumn(table, "ctx_compressed_tokens", "INTEGER NOT NULL DEFAULT 0");
  addColumn(table, "compress_ms", "INTEGER NOT NULL DEFAULT 0");
  addColumn(table, "cache_hits", "INTEGER NOT NULL DEFAULT 0");
  addColumn(table, "tools_json", "TEXT NOT NULL DEFAULT '[]'");
}

db.exec(`
  CREATE TABLE IF NOT EXISTS metric_workflows (
    workflow_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    origin TEXT,
    tasks INTEGER NOT NULL DEFAULT 0,
    agents_json TEXT NOT NULL DEFAULT '[]',
    max_parallel INTEGER NOT NULL DEFAULT 0,
    ms INTEGER NOT NULL DEFAULT 0,
    messages INTEGER NOT NULL DEFAULT 0,
    message_bytes INTEGER NOT NULL DEFAULT 0,
    direct_handoffs INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_metric_workflows_created ON metric_workflows (created_at);
`);

// Also created by feedback.ts, which writes it; the report reads it.
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
`);

function ensureWorkflowRow(workflowId: string, origin?: string): void {
  db.prepare(`INSERT OR IGNORE INTO metric_workflows (workflow_id, created_at, origin) VALUES (?, ?, ?)`).run(
    workflowId,
    new Date().toISOString(),
    origin ?? null,
  );
}

/** One typed message between agents (task, result, question, error). */
export function recordAgentMessage(workflowId: string, bytes: number): void {
  swallow("agent message", () => {
    ensureWorkflowRow(workflowId);
    db.prepare(`UPDATE metric_workflows SET messages = messages + 1, message_bytes = message_bytes + ? WHERE workflow_id = ?`).run(
      Math.max(0, Math.round(bytes)),
      workflowId,
    );
  });
}

/** How a workflow ran: tasks, agents, how many at once, and results passed straight on. */
export function recordWorkflowRun(input: {
  workflowId: string;
  origin?: string;
  tasks: number;
  agents: string[];
  maxParallel: number;
  ms: number;
  directHandoffs: number;
  completed: boolean;
}): void {
  swallow("workflow", () => {
    ensureWorkflowRow(input.workflowId, input.origin);
    db.prepare(
      `UPDATE metric_workflows SET origin = COALESCE(?, origin), tasks = ?, agents_json = ?, max_parallel = MAX(max_parallel, ?),
         ms = ms + ?, direct_handoffs = ?, completed = ? WHERE workflow_id = ?`,
    ).run(
      input.origin ?? null,
      input.tasks,
      JSON.stringify([...new Set(input.agents)]),
      input.maxParallel,
      Math.round(input.ms),
      input.directHandoffs,
      input.completed ? 1 : 0,
      input.workflowId,
    );
  });
}

const STARTED_KEY = "metrics_started_at";

/** The first time this version ran: the start of the experiment's counters. */
export function initMetrics(now = new Date()): string {
  const existing = getSetting(STARTED_KEY);
  if (existing) {
    return existing;
  }
  const started = now.toISOString();
  setSetting(STARTED_KEY, started);
  return started;
}

export function metricsStartedAt(): string | undefined {
  return getSetting(STARTED_KEY);
}

function swallow(what: string, action: () => void): void {
  try {
    action();
  } catch (error) {
    // Measuring must never cost Vishnu his answer.
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(`metrics: ${what} failed (${errorType}).`);
  }
}

export interface AgentRunInput {
  agentId: string;
  kind: "turn" | "goal" | "fast";
  turnId?: number;
  workflowId?: string;
  taskId?: string;
  report?: RunReport;
  latencyMs: number;
  outcome: string;
  errorCode?: string | null;
}

export function recordAgentRun(input: AgentRunInput): void {
  swallow("agent run", () => {
    const report = input.report;
    const tools = report?.tools ?? [];
    db.prepare(
      `INSERT INTO metric_agent_runs (
         created_at, turn_id, workflow_id, task_id, agent_id, kind, primary_model, served_model,
         fallback, model_calls, input_tokens, output_tokens, cost_usd, latency_ms, first_model_ms,
         tool_calls, tool_errors, outcome, error_code,
         queue_ms, ctx_original_tokens, ctx_compressed_tokens, compress_ms, cache_hits, tools_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      new Date().toISOString(),
      input.turnId ?? null,
      input.workflowId ?? null,
      input.taskId ?? null,
      input.agentId,
      input.kind,
      report?.primaryModel ?? null,
      report?.backend ?? null,
      report && report.fallbacks > 0 ? 1 : 0,
      report?.llmCalls ?? 0,
      report?.totalInputTokens ?? 0,
      report?.outputTokens ?? 0,
      report?.costUsd ?? 0,
      Math.max(0, Math.round(input.latencyMs)),
      report?.firstModelMs ?? null,
      tools.filter((entry) => !entry.reused).length,
      tools.filter((entry) => !entry.ok).length,
      input.outcome,
      input.errorCode ?? null,
      Math.round(report?.queueMs ?? 0),
      report?.context?.originalTokens ?? 0,
      report?.context?.compressedTokens ?? 0,
      Math.round(report?.context?.ms ?? 0),
      report?.cacheHits ?? 0,
      JSON.stringify(tools.map((entry) => entry.tool).slice(0, 30)),
    );
  });
}

/** Ties goal runs written so far to the turn whose plan started them. */
export function attachWorkflowRuns(turnId: number, workflowIds: readonly string[]): void {
  if (workflowIds.length === 0) {
    return;
  }
  swallow("attach runs", () => {
    const placeholders = workflowIds.map(() => "?").join(", ");
    db.prepare(`UPDATE metric_agent_runs SET turn_id = ? WHERE turn_id IS NULL AND workflow_id IN (${placeholders})`).run(
      turnId,
      ...workflowIds,
    );
  });
}

export interface TurnWorkflow {
  workflowId: string;
  ms: number;
  failed: boolean;
  authRequired: number;
  uncertain: number;
  late?: boolean;
}

/** What a turn did, collected while it runs. */
export interface TurnMeter {
  startedAt: number;
  workflows: TurnWorkflow[];
  /** Workflows still running when the turn answered. They are added when they end. */
  pending: number;
}

export function newTurnMeter(): TurnMeter {
  return { startedAt: Date.now(), workflows: [], pending: 0 };
}

interface GoalTotals {
  agents: string[];
  models: string[];
  calls: number;
  input: number;
  output: number;
  cost: number;
  fallbacks: number;
  tools: number;
  queueMs: number;
  ctxOriginal: number;
  ctxCompressed: number;
  compressMs: number;
  cacheHits: number;
  toolNames: string[];
}

function goalTotals(workflowIds: readonly string[]): GoalTotals {
  const empty: GoalTotals = {
    agents: [],
    models: [],
    calls: 0,
    input: 0,
    output: 0,
    cost: 0,
    fallbacks: 0,
    tools: 0,
    queueMs: 0,
    ctxOriginal: 0,
    ctxCompressed: 0,
    compressMs: 0,
    cacheHits: 0,
    toolNames: [],
  };
  if (workflowIds.length === 0) {
    return empty;
  }
  const placeholders = workflowIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT agent_id, served_model, model_calls, input_tokens, output_tokens, cost_usd, fallback, tool_calls,
              queue_ms, ctx_original_tokens, ctx_compressed_tokens, compress_ms, cache_hits, tools_json
       FROM metric_agent_runs WHERE kind = 'goal' AND workflow_id IN (${placeholders})`,
    )
    .all(...workflowIds) as Array<{
    agent_id: string;
    served_model: string | null;
    model_calls: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    fallback: number;
    tool_calls: number;
    queue_ms: number;
    ctx_original_tokens: number;
    ctx_compressed_tokens: number;
    compress_ms: number;
    cache_hits: number;
    tools_json: string;
  }>;
  return rows.reduce((totals, row) => {
    totals.queueMs += row.queue_ms;
    totals.ctxOriginal += row.ctx_original_tokens;
    totals.ctxCompressed += row.ctx_compressed_tokens;
    totals.compressMs += row.compress_ms;
    totals.cacheHits += row.cache_hits;
    try {
      totals.toolNames.push(...(JSON.parse(row.tools_json) as string[]));
    } catch {
      // A malformed list only loses names.
    }
    totals.agents.push(row.agent_id);
    if (row.served_model) {
      totals.models.push(row.served_model);
    }
    totals.calls += row.model_calls;
    totals.input += row.input_tokens;
    totals.output += row.output_tokens;
    totals.cost += row.cost_usd;
    totals.fallbacks += row.fallback;
    totals.tools += row.tool_calls;
    return totals;
  }, empty);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export interface TurnRecordInput {
  chatId?: number;
  route: string;
  path: "fast" | "specialist" | "aadi" | "delegated";
  agentId: string;
  report?: RunReport;
  meter: TurnMeter;
  success: boolean;
  error?: string;
}

/** Writes the turn and its agent run. Returns the turn's id. */
export function recordTurn(input: TurnRecordInput): number | undefined {
  let turnId: number | undefined;
  swallow("turn", () => {
    const report = input.report;
    const totalMs = Date.now() - input.meter.startedAt;
    const workflowIds = input.meter.workflows.map((item) => item.workflowId);
    const goals = goalTotals(workflowIds);
    const tools = report?.tools ?? [];
    const result = db
      .prepare(
        `INSERT INTO metric_turns (
           created_at, chat_id, route, path, agents_json, models_json, fallbacks, model_calls,
           input_tokens, output_tokens, cost_usd, tool_calls, duplicate_skipped, first_model_ms,
           total_ms, workflow_ms, workflows, workflows_failed, success, auth_required, uncertain, error,
           queue_ms, ctx_original_tokens, ctx_compressed_tokens, compress_ms, cache_hits, tools_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        new Date().toISOString(),
        input.chatId ?? null,
        input.route,
        input.path,
        JSON.stringify(unique([input.agentId, ...(report?.widened ? ["aadi"] : []), ...goals.agents])),
        JSON.stringify(unique([...(report?.servedModels ?? []), ...goals.models])),
        (report?.fallbacks ?? 0) + goals.fallbacks,
        (report?.llmCalls ?? 0) + goals.calls,
        (report?.totalInputTokens ?? 0) + goals.input,
        (report?.outputTokens ?? 0) + goals.output,
        (report?.costUsd ?? 0) + goals.cost,
        tools.filter((entry) => !entry.reused).length + goals.tools,
        tools.filter((entry) => entry.reused).length,
        report?.firstModelMs ?? null,
        totalMs,
        input.meter.workflows.length > 0 ? Math.max(...input.meter.workflows.map((item) => item.ms)) : null,
        input.meter.workflows.length + input.meter.pending,
        input.meter.workflows.filter((item) => item.failed).length,
        input.success ? 1 : 0,
        (report?.authRefused ?? 0) + input.meter.workflows.reduce((sum, item) => sum + item.authRequired, 0),
        input.meter.workflows.reduce((sum, item) => sum + item.uncertain, 0),
        input.error ? input.error.slice(0, 200) : null,
        Math.round(report?.queueMs ?? 0) + goals.queueMs,
        (report?.context?.originalTokens ?? 0) + goals.ctxOriginal,
        (report?.context?.compressedTokens ?? 0) + goals.ctxCompressed,
        Math.round(report?.context?.ms ?? 0) + goals.compressMs,
        (report?.cacheHits ?? 0) + goals.cacheHits,
        JSON.stringify([...tools.map((entry) => entry.tool), ...goals.toolNames].slice(0, 40)),
      );
    turnId = Number(result.lastInsertRowid);
    if (input.path !== "fast" || input.report) {
      recordAgentRun({
        agentId: input.agentId,
        kind: input.path === "fast" ? "fast" : "turn",
        turnId,
        report,
        latencyMs: totalMs,
        outcome: input.success ? "completed" : "failed",
        errorCode: input.error ? "failed" : null,
      });
    } else {
      recordAgentRun({
        agentId: input.agentId,
        kind: "fast",
        turnId,
        latencyMs: totalMs,
        outcome: input.success ? "completed" : "failed",
      });
    }
    attachWorkflowRuns(turnId, workflowIds);
  });
  return turnId;
}

/** A workflow that outlived its turn adds its goal runs to that turn when it ends. */
export function recordLateWorkflow(turnId: number | undefined, workflow: TurnWorkflow): void {
  if (turnId === undefined) {
    return;
  }
  swallow("late workflow", () => {
    attachWorkflowRuns(turnId, [workflow.workflowId]);
    const goals = goalTotals([workflow.workflowId]);
    db.prepare(
      `UPDATE metric_turns SET
         model_calls = model_calls + ?, input_tokens = input_tokens + ?, output_tokens = output_tokens + ?,
         cost_usd = cost_usd + ?, fallbacks = fallbacks + ?, tool_calls = tool_calls + ?,
         workflow_ms = MAX(COALESCE(workflow_ms, 0), ?), workflows_failed = workflows_failed + ?,
         auth_required = auth_required + ?, uncertain = uncertain + ?
       WHERE id = ?`,
    ).run(
      goals.calls,
      goals.input,
      goals.output,
      goals.cost,
      goals.fallbacks,
      goals.tools,
      workflow.ms,
      workflow.failed ? 1 : 0,
      workflow.authRequired,
      workflow.uncertain,
      turnId,
    );
  });
}

// ---------------------------------------------------------------- report

interface AgentRow {
  agent_id: string;
  kind: string;
  fallback: number;
  model_calls: number;
  cost_usd: number;
  latency_ms: number;
  tool_calls: number;
  tool_errors: number;
  outcome: string;
}

interface TurnRow {
  path: string;
  total_ms: number;
  workflows: number;
  workflows_failed: number;
  fallbacks: number;
  cost_usd: number;
  success: number;
  auth_required: number;
  uncertain: number;
  duplicate_skipped: number;
}

export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function money(value: number): string {
  return value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(value >= 0.01 ? 3 : 4)}`;
}

function percent(part: number, whole: number): string {
  return whole === 0 ? "n/a" : `${Math.round((part / whole) * 100)}%`;
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export interface AgentStats {
  agentId: string;
  turns: number;
  goals: number;
  fast: number;
  successRate: number | undefined;
  failureRate: number | undefined;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  avgCostUsd: number;
  totalCostUsd: number;
  avgModelCalls: number;
  fallbackRate: number | undefined;
  toolErrorRate: number | undefined;
}

export function agentStats(fromIso: string, toIso: string): AgentStats[] {
  const rows = db
    .prepare(
      `SELECT agent_id, kind, fallback, model_calls, cost_usd, latency_ms, tool_calls, tool_errors, outcome
       FROM metric_agent_runs WHERE created_at >= ? AND created_at < ?`,
    )
    .all(fromIso, toIso) as AgentRow[];
  const ids = unique([...MODEL_AGENT_IDS, ...rows.map((row) => row.agent_id)]);
  return ids.map((agentId) => {
    const mine = rows.filter((row) => row.agent_id === agentId);
    // Rates and latency are about model runs; fast answers are counted on their own.
    const reasoning = mine.filter((row) => row.kind !== "fast");
    const ok = reasoning.filter((row) => row.outcome === "completed").length;
    const latencies = reasoning.map((row) => row.latency_ms);
    const toolCalls = reasoning.reduce((sum, row) => sum + row.tool_calls, 0);
    return {
      agentId,
      turns: mine.filter((row) => row.kind === "turn").length,
      goals: mine.filter((row) => row.kind === "goal").length,
      fast: mine.filter((row) => row.kind === "fast").length,
      successRate: reasoning.length ? ok / reasoning.length : undefined,
      failureRate: reasoning.length ? (reasoning.length - ok) / reasoning.length : undefined,
      avgLatencyMs: average(latencies),
      p50LatencyMs: percentile(latencies, 0.5),
      p95LatencyMs: percentile(latencies, 0.95),
      avgCostUsd: average(reasoning.map((row) => row.cost_usd)),
      totalCostUsd: reasoning.reduce((sum, row) => sum + row.cost_usd, 0),
      avgModelCalls: average(reasoning.map((row) => row.model_calls)),
      fallbackRate: reasoning.length ? reasoning.filter((row) => row.fallback > 0).length / reasoning.length : undefined,
      toolErrorRate: toolCalls ? reasoning.reduce((sum, row) => sum + row.tool_errors, 0) / toolCalls : undefined,
    };
  });
}

export interface TurnTotals {
  turns: number;
  fastPath: number;
  specialist: number;
  aadi: number;
  delegatedTurns: number;
  workflows: number;
  failedWorkflows: number;
  avgDelegatedMs: number;
  avgNonDelegatedMs: number;
  agentCostUsd: number;
  fallbacks: number;
  failedTurns: number;
  authRequired: number;
  uncertain: number;
  duplicatesSkipped: number;
}

export function turnTotals(fromIso: string, toIso: string): TurnTotals {
  const rows = db
    .prepare(
      `SELECT path, total_ms, workflows, workflows_failed, fallbacks, cost_usd, success, auth_required, uncertain, duplicate_skipped
       FROM metric_turns WHERE created_at >= ? AND created_at < ?`,
    )
    .all(fromIso, toIso) as TurnRow[];
  const delegated = rows.filter((row) => row.path === "delegated");
  const other = rows.filter((row) => row.path !== "delegated");
  return {
    turns: rows.length,
    fastPath: rows.filter((row) => row.path === "fast").length,
    specialist: rows.filter((row) => row.path === "specialist").length,
    aadi: rows.filter((row) => row.path === "aadi").length,
    delegatedTurns: delegated.length,
    workflows: rows.reduce((sum, row) => sum + row.workflows, 0),
    failedWorkflows: rows.reduce((sum, row) => sum + row.workflows_failed, 0),
    avgDelegatedMs: average(delegated.map((row) => row.total_ms)),
    avgNonDelegatedMs: average(other.map((row) => row.total_ms)),
    agentCostUsd: rows.reduce((sum, row) => sum + row.cost_usd, 0),
    fallbacks: rows.reduce((sum, row) => sum + row.fallbacks, 0),
    failedTurns: rows.filter((row) => row.success === 0).length,
    authRequired: rows.reduce((sum, row) => sum + row.auth_required, 0),
    uncertain: rows.reduce((sum, row) => sum + row.uncertain, 0),
    duplicatesSkipped: rows.reduce((sum, row) => sum + row.duplicate_skipped, 0),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** /agents (last 24 hours) and /agents week (last 7 days). */
export function formatAgentsReport(window: "day" | "week", now = new Date()): string {
  const toIso = new Date(now.getTime() + 1).toISOString();
  const fromIso = new Date(now.getTime() - (window === "week" ? 7 : 1) * DAY_MS).toISOString();
  const stats = agentStats(fromIso, toIso);
  const totals = turnTotals(fromIso, toIso);
  const allCost = listUsageLogs(fromIso, toIso).reduce((sum, row) => sum + row.cost_usd, 0);
  const lines: string[] = [window === "week" ? "Agents, last 7 days" : "Agents, last 24 hours"];
  const started = metricsStartedAt();
  if (started && Date.parse(started) > Date.parse(fromIso)) {
    lines.push(`Counting since ${started.slice(0, 16).replace("T", " ")} UTC.`);
  }
  for (const stat of stats) {
    const known = (MODEL_AGENT_IDS as readonly string[]).includes(stat.agentId);
    const setting = known ? getAgentModelSetting(stat.agentId) : undefined;
    const label = known ? AGENT_MODEL_LABELS[stat.agentId as keyof typeof AGENT_MODEL_LABELS] : stat.agentId;
    lines.push("");
    lines.push(label);
    if (setting) {
      lines.push(`${settingLabel(setting.primary)} · fallback ${fallbackLabel(setting)} · ${setting.tier}`);
    }
    const runs = stat.turns + stat.goals;
    const counts = [
      stat.agentId === "aadi" ? `Turns: ${stat.turns}` : `Turns: ${stat.turns} · Goal runs: ${stat.goals}`,
      stat.fast > 0 ? `Fast answers: ${stat.fast}` : "",
    ].filter(Boolean);
    lines.push(counts.join(" · "));
    if (runs === 0) {
      continue;
    }
    lines.push(
      `Success: ${percent(Math.round((stat.successRate ?? 0) * runs), runs)} · Failed: ${percent(Math.round((stat.failureRate ?? 0) * runs), runs)}`,
    );
    lines.push(`Latency: avg ${seconds(stat.avgLatencyMs)}, p50 ${seconds(stat.p50LatencyMs)}, p95 ${seconds(stat.p95LatencyMs)}`);
    lines.push(`Cost: ${money(stat.totalCostUsd)} total, ${money(stat.avgCostUsd)} avg · ${stat.avgModelCalls.toFixed(1)} model calls avg`);
    lines.push(
      `Fallbacks: ${stat.fallbackRate === undefined ? "n/a" : `${Math.round(stat.fallbackRate * 100)}%`} · Tool errors: ${stat.toolErrorRate === undefined ? "n/a" : `${Math.round(stat.toolErrorRate * 100)}%`}`,
    );
  }
  lines.push("");
  lines.push("Totals");
  lines.push(
    `Requests: ${totals.turns} (fast path ${totals.fastPath}, specialist ${totals.specialist}, Aadi ${totals.aadi}, delegated ${totals.delegatedTurns})`,
  );
  lines.push(`Delegated workflows: ${totals.workflows} · Failed workflows: ${totals.failedWorkflows}`);
  lines.push(`Fast-path requests: ${totals.fastPath}`);
  lines.push(
    `Avg delegated latency: ${totals.delegatedTurns ? seconds(totals.avgDelegatedMs) : "n/a"} · Avg non-delegated latency: ${totals.turns - totals.delegatedTurns ? seconds(totals.avgNonDelegatedMs) : "n/a"}`,
  );
  lines.push(`LLM cost on turns: ${money(totals.agentCostUsd)} · All LLM cost incl. background: ${money(allCost)}`);
  lines.push(`Fallback model calls: ${totals.fallbacks} · Duplicate tool calls skipped: ${totals.duplicatesSkipped}`);
  lines.push(`Failed turns: ${totals.failedTurns} · Auth-required: ${totals.authRequired} · Uncertain outcomes: ${totals.uncertain}`);
  lines.push("");
  lines.push(...formatOptimizations(fromIso, toIso, totals));
  lines.push("");
  lines.push("Costs are estimates from the configured rates. These are measurements, not a verdict.");
  return lines.join("\n");
}

export interface OptimizationStats {
  contextOriginalTokens: number;
  contextCompressedTokens: number;
  contextTokensAvoided: number;
  compressionRatio: number | undefined;
  avgCompressMs: number;
  cacheHitRate: number | undefined;
  cacheHits: number;
  cacheMisses: number;
  cacheTokensSaved: number;
  cacheLlmCallsSaved: number;
  queueWaits: number;
  avgQueueMs: number;
  p95QueueMs: number;
  circuitActivations: number;
  delegatedWorkflows: number;
  parallelWorkflows: number;
  avgAgentsPerDelegated: number;
  agentMessages: number;
  avgMessageBytes: number;
  directHandoffs: number;
  fastPath: number;
  llmCallsAvoided: number;
  corrections: number;
  retries: number;
  dissatisfaction: number;
}

export function optimizationStats(fromIso: string, toIso: string, totals = turnTotals(fromIso, toIso)): OptimizationStats {
  const context = db
    .prepare(
      `SELECT COALESCE(SUM(ctx_original_tokens), 0) AS original, COALESCE(SUM(ctx_compressed_tokens), 0) AS compressed,
              COALESCE(AVG(CASE WHEN ctx_original_tokens > 0 THEN compress_ms END), 0) AS ms
       FROM metric_agent_runs WHERE created_at >= ? AND created_at < ?`,
    )
    .get(fromIso, toIso) as { original: number; compressed: number; ms: number };
  const workflows = db
    .prepare(
      `SELECT agents_json, max_parallel, messages, message_bytes, direct_handoffs, origin, tasks
       FROM metric_workflows WHERE created_at >= ? AND created_at < ?`,
    )
    .all(fromIso, toIso) as Array<{
    agents_json: string;
    max_parallel: number;
    messages: number;
    message_bytes: number;
    direct_handoffs: number;
    origin: string | null;
    tasks: number;
  }>;
  const delegated = workflows.filter((row) => row.origin === "delegate");
  const messages = workflows.reduce((sum, row) => sum + row.messages, 0);
  const bytes = workflows.reduce((sum, row) => sum + row.message_bytes, 0);
  const directHandoffs = workflows.reduce((sum, row) => sum + row.direct_handoffs, 0);
  const cache = cacheStats(fromIso, toIso);
  const queue = queueStats(fromIso, toIso);
  const feedback = db
    .prepare(`SELECT kind, COUNT(*) AS n FROM metric_feedback WHERE created_at >= ? AND created_at < ? GROUP BY kind`)
    .all(fromIso, toIso) as Array<{ kind: string; n: number }>;
  const count = (kind: string) => feedback.find((row) => row.kind === kind)?.n ?? 0;
  return {
    contextOriginalTokens: context.original,
    contextCompressedTokens: context.compressed,
    contextTokensAvoided: Math.max(0, context.original - context.compressed),
    compressionRatio: context.original > 0 ? context.compressed / context.original : undefined,
    avgCompressMs: context.ms,
    cacheHitRate: cache.hitRate,
    cacheHits: cache.hits,
    cacheMisses: cache.misses,
    cacheTokensSaved: cache.tokensSaved,
    cacheLlmCallsSaved: cache.llmCallsSaved,
    queueWaits: queue.waits,
    avgQueueMs: queue.avgMs,
    p95QueueMs: queue.p95Ms,
    circuitActivations: circuitActivations(fromIso, toIso),
    delegatedWorkflows: delegated.length,
    parallelWorkflows: delegated.filter((row) => row.max_parallel >= 2).length,
    avgAgentsPerDelegated: delegated.length
      ? delegated.reduce((sum, row) => sum + new Set(JSON.parse(row.agents_json) as string[]).size, 0) / delegated.length
      : 0,
    agentMessages: messages,
    avgMessageBytes: messages ? bytes / messages : 0,
    directHandoffs,
    fastPath: totals.fastPath,
    // Conservative: a fast-path answer would have taken at least one model call,
    // a cached web search is one, and a result handed straight to the next agent
    // saves Aadi one planning call.
    llmCallsAvoided: totals.fastPath + cache.llmCallsSaved + directHandoffs,
    corrections: count("correction"),
    retries: count("retry"),
    dissatisfaction: count("dissatisfaction"),
  };
}

function formatOptimizations(fromIso: string, toIso: string, totals: TurnTotals): string[] {
  const stats = optimizationStats(fromIso, toIso, totals);
  const pct = (value: number | undefined) => (value === undefined ? "n/a" : `${Math.round(value * 100)}%`);
  return [
    "Optimizations",
    `Context tokens avoided: ${stats.contextTokensAvoided} (${stats.contextOriginalTokens} -> ${stats.contextCompressedTokens}, ratio ${pct(stats.compressionRatio)}, ${stats.avgCompressMs.toFixed(1)}ms to compress)`,
    `Cache: hit rate ${pct(stats.cacheHitRate)} (${stats.cacheHits} hits, ${stats.cacheMisses} misses) · calls saved ${stats.cacheHits} · tokens not regenerated ${stats.cacheTokensSaved} · model calls saved ${stats.cacheLlmCallsSaved}`,
    `Scheduler queue: ${stats.queueWaits} wait(s), avg ${Math.round(stats.avgQueueMs)}ms, p95 ${Math.round(stats.p95QueueMs)}ms`,
    `Circuit breaker activations: ${stats.circuitActivations} · Fallback model calls: ${totals.fallbacks}`,
    `Parallel workflows: ${stats.parallelWorkflows} of ${stats.delegatedWorkflows} delegated · avg agents per delegated request: ${stats.avgAgentsPerDelegated.toFixed(1)}`,
    `Agent-to-agent messages: ${stats.agentMessages} · avg size ${Math.round(stats.avgMessageBytes)} bytes · results handed on directly: ${stats.directHandoffs}`,
    `Estimated model calls avoided: ${stats.llmCallsAvoided} (fast path ${stats.fastPath}, cache ${stats.cacheLlmCallsSaved}, direct handoffs ${stats.directHandoffs})`,
    `User corrections: ${stats.corrections} · retries: ${stats.retries} · dissatisfaction: ${stats.dissatisfaction}`,
    formatProviderHealth(),
  ];
}
