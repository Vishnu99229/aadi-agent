import { randomUUID } from "node:crypto";
import type { DependencyResult } from "./handle.js";
import { extractRefs, fromContextRef, parseRef, type ResourceRef } from "./refs.js";
import type { AgentId, AgentTaskResult, DelegationRequest } from "./types.js";

/**
 * The compact typed protocol agents use with each other. Inside this process a
 * message is a plain TypeScript object handed from the engine to the agent: it
 * is never serialized to HTTP or JSON to travel. (Its JSON size is computed
 * only to measure it.) Over A2A the same fields become the structured task
 * envelope in a2a/remote.ts.
 *
 * Agents exchange conclusions, evidence references, constraints, tool outputs
 * and suggested next actions. Never reasoning transcripts.
 */
export type MessagePriority = "urgent" | "high" | "normal" | "background";

export interface AgentResultRef {
  /** The step's key in the workflow. */
  key: string;
  agentId: AgentId;
  capability: string;
  status: AgentResult["status"];
  summary?: string;
  data?: Record<string, unknown>;
  confidence?: number;
  refs?: ResourceRef[];
  suggestedNextSteps?: AgentAction[];
}

export interface AgentMessage {
  type: "task" | "result" | "question" | "error" | "progress";
  messageId: string;
  workflowId: string;
  taskId: string;
  from: AgentId;
  to: AgentId;
  capability?: string;
  goal?: string;
  refs?: ResourceRef[];
  constraints?: Record<string, unknown>;
  dependencyResults?: AgentResultRef[];
  expectedOutput?: string;
  priority?: MessagePriority;
  deadlineAt?: string;
  /** Names an authorization Aadi holds. Never the authorization itself. */
  authRef?: string;
}

/** "calendar.find_slots": an agent and one of its capabilities, for Aadi to decide on. */
export type AgentAction = string;

export interface AgentResult {
  status: "completed" | "input-required" | "auth-required" | "failed";
  summary?: string;
  data?: Record<string, unknown>;
  confidence?: number;
  artifacts?: ResourceRef[];
  suggestedNextSteps?: AgentAction[];
  cacheRefs?: string[];
}

const SUMMARY_CHARS = 700;
const DATA_CHARS = 900;
/** Keys that are bookkeeping, not findings: never forwarded to another agent. */
const INTERNAL_KEYS = new Set(["tools", "run", "buttons", "asked"]);

function clip(text: string | undefined, max: number): string | undefined {
  if (!text) {
    return undefined;
  }
  const flat = text.replace(/\s+\n/g, "\n").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** The findings in an output, small: internal keys dropped, long values clipped. */
export function compactData(output: Record<string, unknown> | undefined, max = DATA_CHARS): Record<string, unknown> | undefined {
  if (!output) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  let used = 0;
  for (const [key, value] of Object.entries(output)) {
    if (INTERNAL_KEYS.has(key) || value === undefined || value === null || key === "summary") {
      continue;
    }
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (used + text.length > max) {
      out[key] = typeof value === "string" ? clip(value, Math.max(40, max - used)) : "(omitted: too large)";
      break;
    }
    out[key] = value;
    used += text.length;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function stringList(value: unknown, max: number): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, max) : [];
}

/** A task result in the protocol's shape. */
export function toAgentResult(result: Pick<AgentTaskResult, "state" | "text" | "output" | "artifacts" | "error">): AgentResult {
  const output = result.output ?? {};
  const status: AgentResult["status"] =
    result.state === "completed"
      ? "completed"
      : result.state === "input-required"
        ? "input-required"
        : result.state === "auth-required"
          ? "auth-required"
          : "failed";
  const refs = new Set<ResourceRef>([
    ...stringList(output.refs, 12).filter((ref) => parseRef(ref) !== undefined),
    ...extractRefs(result.text ?? ""),
  ]);
  const confidence = typeof output.confidence === "number" && output.confidence >= 0 && output.confidence <= 1 ? output.confidence : undefined;
  return {
    status,
    summary: clip(typeof output.summary === "string" ? output.summary : result.text ?? result.error?.message, SUMMARY_CHARS),
    data: compactData(typeof output.data === "object" && output.data ? (output.data as Record<string, unknown>) : output),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(refs.size > 0 ? { artifacts: [...refs] } : {}),
    ...(stringList(output.suggested_next_steps, 5).length > 0 ? { suggestedNextSteps: stringList(output.suggested_next_steps, 5) } : {}),
    ...(stringList(output.cache_refs, 10).length > 0 ? { cacheRefs: stringList(output.cache_refs, 10) } : {}),
  };
}

/** A finished dependency, as the next agent receives it. */
export function toResultRef(dep: DependencyResult): AgentResultRef {
  const result = toAgentResult({ state: dep.state, text: dep.text, output: dep.output });
  return {
    key: dep.key,
    agentId: dep.agentId,
    capability: dep.capability,
    status: result.status,
    ...(result.summary ? { summary: result.summary } : {}),
    ...(result.data ? { data: result.data } : {}),
    ...(result.confidence !== undefined ? { confidence: result.confidence } : {}),
    ...(result.artifacts ? { refs: result.artifacts } : {}),
    ...(result.suggestedNextSteps ? { suggestedNextSteps: result.suggestedNextSteps } : {}),
  };
}

export function toMessagePriority(rank: string | undefined): MessagePriority {
  switch (rank) {
    case "foreground":
    case "continuation":
      return "high";
    case "urgent":
      return "urgent";
    case "background":
      return "background";
    default:
      return "normal";
  }
}

/** The task message the engine hands an agent. */
export function taskMessage(
  request: DelegationRequest,
  dependencies: Record<string, DependencyResult>,
  options: { from?: AgentId; priority?: MessagePriority } = {},
): AgentMessage {
  const input = request.input;
  const refs = new Set<ResourceRef>([
    ...stringList(input.refs, 12).filter((ref) => parseRef(ref) !== undefined),
    ...request.contextRefs.map(fromContextRef).filter((ref): ref is ResourceRef => ref !== undefined),
  ]);
  const constraints =
    input.constraints && typeof input.constraints === "object" && !Array.isArray(input.constraints)
      ? (input.constraints as Record<string, unknown>)
      : undefined;
  const deps = Object.values(dependencies).map(toResultRef);
  return {
    type: "task",
    messageId: randomUUID(),
    workflowId: request.workflowId,
    taskId: request.taskId,
    from: options.from ?? "aadi",
    to: request.agentId,
    capability: request.capability,
    ...(typeof input.goal === "string" ? { goal: input.goal } : {}),
    ...(refs.size > 0 ? { refs: [...refs] } : {}),
    ...(constraints ? { constraints } : {}),
    ...(deps.length > 0 ? { dependencyResults: deps } : {}),
    ...(typeof input.expected_output === "string" ? { expectedOutput: input.expected_output } : {}),
    priority: options.priority ?? "normal",
    ...(request.deadline ? { deadlineAt: request.deadline } : {}),
    ...(request.authRef ? { authRef: request.authRef } : {}),
  };
}

/** The reply message for a finished, paused or failed task. */
export function resultMessage(task: AgentMessage, result: AgentResult): AgentMessage & { result: AgentResult } {
  return {
    type: result.status === "completed" ? "result" : result.status === "failed" ? "error" : "question",
    messageId: randomUUID(),
    workflowId: task.workflowId,
    taskId: task.taskId,
    from: task.to,
    to: task.from,
    capability: task.capability,
    result,
  };
}

/** Bytes the message would take as JSON. For measurement only. */
export function messageBytes(message: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(message));
  } catch {
    return 0;
  }
}
