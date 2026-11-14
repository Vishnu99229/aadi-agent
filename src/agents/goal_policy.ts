import { config, GOAL_TIERS, type GoalDelegationConfig, type GoalTier } from "../config.js";
import { assertTestSeam } from "../test_seam.js";
import { workflowGoalUsage } from "./store.js";

/**
 * How much independent work a delegated workflow may do: the limits shared by
 * every goal loop of one workflow. Which model a goal loop uses is the agent's
 * own setting (src/models/agent_models.ts), the same as on its other turns.
 */
let overrides: Partial<GoalDelegationConfig> = {};
const meters = new Map<string, { calls: number; costUsd: number; startedAt: number }>();
const workflowCaps = new Map<string, number>();

export function goalLimits(): GoalDelegationConfig {
  return { ...config.goalDelegation, ...overrides };
}

/** Tests change the limits without touching the environment. */
export function setGoalLimitsForTests(next: Partial<GoalDelegationConfig> | undefined): void {
  assertTestSeam("setGoalLimitsForTests");
  overrides = next ?? {};
  meters.clear();
  workflowCaps.clear();
}

/** His own words, not a goal's text. "A thorough research job" is the large cap. */
const LARGE_JOB =
  /\b(?:thorough|full)\s+(?:research|investigation|analysis|review)\b|\b(?:large|big)\s+job\b|\bdeep dive\b|\bspend more\b/i;

export function goalSpend(ownerText: string | undefined): { workflowUsd: number; goalUsd: number; large: boolean } {
  const limits = goalLimits();
  const large = typeof ownerText === "string" && LARGE_JOB.test(ownerText);
  return {
    large,
    workflowUsd: large ? limits.largeWorkflowBudgetUsd : limits.workflowBudgetUsd,
    goalUsd: large ? limits.largeGoalBudgetUsd : limits.goalBudgetUsd,
  };
}

/**
 * The budget recorded on the task wins over a missing grant, so a restart
 * doesn't shrink a large job he already authorized back to the ordinary cap.
 */
export function capsForTask(
  ownerText: string | undefined,
  taskBudgetUsd?: number,
): { goalUsd: number; workflowUsd: number } {
  const limits = goalLimits();
  const spend = goalSpend(ownerText);
  const goalUsd = taskBudgetUsd ?? spend.goalUsd;
  const workflowUsd = goalUsd > limits.goalBudgetUsd + 1e-9 ? limits.largeWorkflowBudgetUsd : spend.workflowUsd;
  return { goalUsd, workflowUsd };
}

export function parseGoalTier(value: unknown): GoalTier {
  return typeof value === "string" && (GOAL_TIERS as readonly string[]).includes(value) ? (value as GoalTier) : "standard";
}

export interface GoalMeter {
  /** Takes one model call from the workflow's allowance, or says why not. */
  reserve(): string | undefined;
  add(costUsd: number): void;
}

const MAX_METERS = 100;

/**
 * One meter per workflow, shared by its goal loops. It starts from what the
 * database already holds for the workflow, so a restart doesn't reset it.
 */
export function goalMeter(workflowId: string, workflowBudgetUsd?: number): GoalMeter {
  if (workflowBudgetUsd !== undefined) {
    const existing = workflowCaps.get(workflowId);
    workflowCaps.set(workflowId, existing === undefined ? workflowBudgetUsd : Math.max(existing, workflowBudgetUsd));
  }
  let state = meters.get(workflowId);
  if (!state) {
    const used = workflowGoalUsage(workflowId);
    const created = used.createdAt ? Date.parse(used.createdAt) : Date.now();
    state = { calls: used.llmCalls, costUsd: used.costUsd, startedAt: Number.isFinite(created) ? created : Date.now() };
    if (meters.size >= MAX_METERS) {
      meters.delete(meters.keys().next().value!);
    }
    meters.set(workflowId, state);
  }
  const meter = state;
  return {
    reserve: () => {
      const limits = goalLimits();
      const cap = workflowCaps.get(workflowId) ?? limits.workflowBudgetUsd;
      if (Date.now() - meter.startedAt >= limits.workflowTimeoutMs) {
        return `Stopped: this job reached its ${Math.round(limits.workflowTimeoutMs / 1000)}-second limit.`;
      }
      if (meter.calls >= limits.maxModelCalls) {
        return `Stopped: this job used its ${limits.maxModelCalls} model calls.`;
      }
      if (meter.costUsd >= cap) {
        return `Stopped: this job used its model budget ($${cap.toFixed(2)}).`;
      }
      meter.calls += 1;
      return undefined;
    },
    add: (costUsd) => {
      meter.costUsd += costUsd;
    },
  };
}

/** Forgets the in-memory meters, as a restart would. Tests only. */
export function forgetGoalMetersForTests(): void {
  assertTestSeam("forgetGoalMetersForTests");
  meters.clear();
  workflowCaps.clear();
}
