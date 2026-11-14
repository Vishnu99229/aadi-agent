import { db } from "../db.js";
import "../metrics.js";
import "../feedback.js";
import {
  AGENT_MODEL_LABELS,
  AUTO,
  getAgentModelSetting,
  isModelAgentId,
  MODEL_AGENT_IDS,
  setAgentModelSetting,
  settingLabel,
  type ModelAgentId,
} from "./agent_models.js";
import { getModel } from "./registry.js";

/**
 * Continuous evaluation from real use: every agent and model pair, measured
 * from the turns and goal runs it actually served, plus Vishnu's corrections,
 * retries and dissatisfaction.
 *
 * It never changes an agent's model. It writes recommendations, and a model
 * changes only when Vishnu taps Accept on one in Telegram.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS model_recommendations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    current_model TEXT NOT NULL,
    suggested_model TEXT NOT NULL,
    reason TEXT NOT NULL,
    stats_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected', 'superseded')),
    decided_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_model_recommendations_status ON model_recommendations (status, agent_id);
`);

const DAY_MS = 24 * 60 * 60 * 1000;

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]?.trim() || fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export interface PairStats {
  agentId: string;
  model: string;
  requests: number;
  goalRuns: number;
  runs: number;
  successRate: number;
  corrections: number;
  retries: number;
  dissatisfaction: number;
  correctionRate: number;
  toolErrors: number;
  toolCalls: number;
  providerErrors: number;
  fallbackRate: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  inputTokens: number;
  outputTokens: number;
  avgCostUsd: number;
  totalCostUsd: number;
  avgModelCalls: number;
  workflowCompletionRate: number | undefined;
  authRequired: number;
  uncertain: number;
}

function percentile(sorted: number[], fraction: number): number {
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]!;
}

/** Every agent and model pair with at least one model run in the window. */
export function pairStats(fromIso: string, toIso: string): PairStats[] {
  const runs = db
    .prepare(
      `SELECT r.agent_id, r.served_model, r.kind, r.outcome, r.error_code, r.latency_ms, r.cost_usd, r.model_calls,
              r.input_tokens, r.output_tokens, r.tool_calls, r.tool_errors, r.fallback,
              COALESCE(t.auth_required, 0) AS auth_required, COALESCE(t.uncertain, 0) AS uncertain
       FROM metric_agent_runs r LEFT JOIN metric_turns t ON t.id = r.turn_id AND r.kind = 'turn'
       WHERE r.created_at >= ? AND r.created_at < ? AND r.kind IN ('turn', 'goal') AND r.served_model IS NOT NULL`,
    )
    .all(fromIso, toIso) as Array<{
    agent_id: string;
    served_model: string;
    kind: string;
    outcome: string;
    error_code: string | null;
    latency_ms: number;
    cost_usd: number;
    model_calls: number;
    input_tokens: number;
    output_tokens: number;
    tool_calls: number;
    tool_errors: number;
    fallback: number;
    auth_required: number;
    uncertain: number;
  }>;
  const feedback = db
    .prepare(`SELECT agent_id, model, kind FROM metric_feedback WHERE created_at >= ? AND created_at < ?`)
    .all(fromIso, toIso) as Array<{ agent_id: string | null; model: string | null; kind: string }>;
  const groups = new Map<string, typeof runs>();
  for (const run of runs) {
    const key = `${run.agent_id}|${run.served_model}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  return [...groups.entries()].map(([key, rows]) => {
    const [agentId, model] = key.split("|") as [string, string];
    const latencies = rows.map((row) => row.latency_ms).sort((left, right) => left - right);
    const ok = rows.filter((row) => row.outcome === "completed").length;
    const goals = rows.filter((row) => row.kind === "goal");
    const mine = feedback.filter((item) => item.agent_id === agentId && item.model === model);
    const corrections = mine.filter((item) => item.kind === "correction").length;
    return {
      agentId,
      model,
      requests: rows.filter((row) => row.kind === "turn").length,
      goalRuns: goals.length,
      runs: rows.length,
      successRate: ok / rows.length,
      corrections,
      retries: mine.filter((item) => item.kind === "retry").length,
      dissatisfaction: mine.filter((item) => item.kind === "dissatisfaction").length,
      correctionRate: mine.length / rows.length,
      toolErrors: rows.reduce((sum, row) => sum + row.tool_errors, 0),
      toolCalls: rows.reduce((sum, row) => sum + row.tool_calls, 0),
      providerErrors: rows.filter((row) => row.outcome !== "completed" && (row.error_code === "failed" || row.error_code === "transient")).length,
      fallbackRate: rows.filter((row) => row.fallback > 0).length / rows.length,
      avgLatencyMs: latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
      p50LatencyMs: percentile(latencies, 0.5),
      p95LatencyMs: percentile(latencies, 0.95),
      inputTokens: rows.reduce((sum, row) => sum + row.input_tokens, 0),
      outputTokens: rows.reduce((sum, row) => sum + row.output_tokens, 0),
      avgCostUsd: rows.reduce((sum, row) => sum + row.cost_usd, 0) / rows.length,
      totalCostUsd: rows.reduce((sum, row) => sum + row.cost_usd, 0),
      avgModelCalls: rows.reduce((sum, row) => sum + row.model_calls, 0) / rows.length,
      workflowCompletionRate: goals.length ? goals.filter((row) => row.outcome === "completed").length / goals.length : undefined,
      authRequired: rows.reduce((sum, row) => sum + row.auth_required, 0),
      uncertain: rows.reduce((sum, row) => sum + row.uncertain, 0),
    };
  });
}

export interface Recommendation {
  id: number;
  agentId: string;
  currentModel: string;
  suggestedModel: string;
  reason: string;
  current: PairStats;
  candidate: PairStats;
  status: string;
}

/** Success, with corrections counted against it: an answer he had to correct didn't really succeed. */
function quality(stats: PairStats): number {
  return stats.successRate - stats.correctionRate;
}

function judge(current: PairStats, candidate: PairStats): string | undefined {
  const qualityGap = quality(candidate) - quality(current);
  const faster = current.avgLatencyMs > 0 ? 1 - candidate.avgLatencyMs / current.avgLatencyMs : 0;
  const cheaper = current.avgCostUsd > 0 ? 1 - candidate.avgCostUsd / current.avgCostUsd : 0;
  if (qualityGap >= 0.05) {
    return "it succeeded more often with fewer corrections";
  }
  if (qualityGap >= -0.02 && (faster >= 0.3 || cheaper >= 0.3)) {
    const gains = [faster >= 0.3 ? "faster" : "", cheaper >= 0.3 ? "cheaper" : ""].filter(Boolean).join(" and ");
    return `it was ${gains} with about the same success; consider it if speed or cost matters more than a small quality difference`;
  }
  if (current.fallbackRate >= 0.3 && quality(candidate) >= quality(current) - 0.02) {
    return "the current primary often needed its fallback";
  }
  return undefined;
}

/**
 * Compares each agent's current model with the other models that served that
 * same agent in the window (as a fallback, or under an earlier setting), each
 * with enough runs to mean something. Writes new open recommendations; never
 * changes a setting.
 */
export function computeRecommendations(now = Date.now()): Recommendation[] {
  const minRuns = envNumber("RECOMMEND_MIN_RUNS", 5);
  const days = envNumber("RECOMMEND_WINDOW_DAYS", 7);
  const fromIso = new Date(now - days * DAY_MS).toISOString();
  const toIso = new Date(now + 1).toISOString();
  const stats = pairStats(fromIso, toIso);
  for (const agentId of MODEL_AGENT_IDS) {
    const setting = getAgentModelSetting(agentId);
    if (setting.primary === AUTO) {
      continue;
    }
    const current = stats.find((item) => item.agentId === agentId && item.model === setting.primary);
    if (!current || current.runs < minRuns) {
      continue;
    }
    const candidates = stats
      .filter((item) => item.agentId === agentId && item.model !== setting.primary && item.runs >= minRuns && getModel(item.model))
      .map((candidate) => ({ candidate, reason: judge(current, candidate) }))
      .filter((item): item is { candidate: PairStats; reason: string } => item.reason !== undefined)
      .sort((left, right) => quality(right.candidate) - quality(left.candidate) || left.candidate.avgCostUsd - right.candidate.avgCostUsd);
    const best = candidates[0];
    if (!best) {
      continue;
    }
    const recentRejection = db
      .prepare(
        `SELECT 1 FROM model_recommendations WHERE agent_id = ? AND suggested_model = ? AND status = 'rejected' AND decided_at >= ?`,
      )
      .get(agentId, best.candidate.model, fromIso);
    const open = db
      .prepare(`SELECT id FROM model_recommendations WHERE agent_id = ? AND status = 'open'`)
      .get(agentId) as { id: number } | undefined;
    if (recentRejection) {
      continue;
    }
    const statsJson = JSON.stringify({ current, candidate: best.candidate });
    if (open) {
      db.prepare(
        `UPDATE model_recommendations SET current_model = ?, suggested_model = ?, reason = ?, stats_json = ?, created_at = ? WHERE id = ?`,
      ).run(setting.primary, best.candidate.model, best.reason, statsJson, new Date(now).toISOString(), open.id);
    } else {
      db.prepare(
        `INSERT INTO model_recommendations (created_at, agent_id, current_model, suggested_model, reason, stats_json) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(new Date(now).toISOString(), agentId, setting.primary, best.candidate.model, best.reason, statsJson);
    }
  }
  return listRecommendations("open");
}

export function listRecommendations(status?: string): Recommendation[] {
  const rows = db
    .prepare(`SELECT * FROM model_recommendations ${status ? "WHERE status = ?" : ""} ORDER BY id`)
    .all(...(status ? [status] : [])) as Array<{
    id: number;
    agent_id: string;
    current_model: string;
    suggested_model: string;
    reason: string;
    stats_json: string;
    status: string;
  }>;
  return rows.map((row) => {
    const parsed = JSON.parse(row.stats_json) as { current: PairStats; candidate: PairStats };
    return {
      id: row.id,
      agentId: row.agent_id,
      currentModel: row.current_model,
      suggestedModel: row.suggested_model,
      reason: row.reason,
      current: parsed.current,
      candidate: parsed.candidate,
      status: row.status,
    };
  });
}

/**
 * Vishnu's tap. Accept makes the suggested model the agent's primary and keeps
 * the old one as its first fallback. Reject keeps the setting and doesn't
 * suggest the same thing again for the window.
 */
export function decideRecommendation(id: number, accept: boolean, now = Date.now()): { ok: boolean; message: string } {
  const row = listRecommendations().find((item) => item.id === id);
  if (!row || row.status !== "open") {
    return { ok: false, message: "That recommendation is no longer open." };
  }
  if (!isModelAgentId(row.agentId)) {
    return { ok: false, message: "Unknown agent." };
  }
  db.prepare(`UPDATE model_recommendations SET status = ?, decided_at = ? WHERE id = ?`).run(
    accept ? "accepted" : "rejected",
    new Date(now).toISOString(),
    id,
  );
  const label = AGENT_MODEL_LABELS[row.agentId as ModelAgentId];
  if (!accept) {
    return { ok: true, message: `Kept ${label} on ${settingLabel(row.currentModel)}.` };
  }
  const setting = getAgentModelSetting(row.agentId);
  const fallbacks = setting.fallbacks === AUTO ? AUTO : [row.currentModel, ...setting.fallbacks.filter((key) => key !== row.suggestedModel)].slice(0, 2);
  setAgentModelSetting(row.agentId as ModelAgentId, { primary: row.suggestedModel, fallbacks });
  return { ok: true, message: `${label} now uses ${settingLabel(row.suggestedModel)}, with ${settingLabel(row.currentModel)} as its fallback.` };
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function money(value: number): string {
  return `$${value.toFixed(value >= 0.01 ? 3 : 4)}`;
}

function block(title: string, stats: PairStats): string[] {
  return [
    title,
    `Success: ${Math.round(stats.successRate * 100)}% over ${stats.runs} run(s) · corrections ${stats.corrections}, retries ${stats.retries}`,
    `Average latency: ${seconds(stats.avgLatencyMs)} (p95 ${seconds(stats.p95LatencyMs)}) · average cost: ${money(stats.avgCostUsd)}`,
  ];
}

/** The text for /agents recommendations. Buttons are added by the bot, one pair per recommendation. */
export function formatRecommendations(recommendations: Recommendation[]): string {
  if (recommendations.length === 0) {
    return `Model recommendations\n\nNone right now. A recommendation needs at least ${envNumber("RECOMMEND_MIN_RUNS", 5)} runs of the current model and of an alternative on the same agent in the last ${envNumber("RECOMMEND_WINDOW_DAYS", 7)} days. Nothing is ever changed without your tap.`;
  }
  const lines = ["Model recommendations (nothing changes unless you tap Accept)"];
  for (const item of recommendations) {
    const label = isModelAgentId(item.agentId) ? AGENT_MODEL_LABELS[item.agentId] : item.agentId;
    lines.push(
      "",
      label,
      ...block(`Current: ${settingLabel(item.currentModel)}`, item.current),
      ...block(`${settingLabel(item.suggestedModel)} on the same agent:`, item.candidate),
      `Recommendation: consider ${settingLabel(item.suggestedModel)} for the ${label}: ${item.reason}.`,
    );
  }
  return lines.join("\n");
}
