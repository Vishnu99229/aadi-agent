import type { AuthGrant } from "./auth.js";
import type { AgentMessage } from "./protocol.js";
import type {
  AgentManifest,
  AgentTaskResult,
  AgentTaskStatus,
  CapabilityDescriptor,
  DelegationRequest,
  RetryPolicy,
} from "./types.js";

/** What a dependency produced, handed to the task that waited for it. */
export interface DependencyResult {
  key: string;
  agentId: string;
  capability: string;
  state: AgentTaskResult["state"];
  text?: string;
  output?: Record<string, unknown>;
}

/**
 * Everything the engine gives an agent besides the request itself. A local
 * agent uses all of it. A remote agent's adapter uses the signal, the remote
 * task id and the resume answer; the grant never leaves this process.
 */
export interface ExecutionEnv {
  /** Resolved from the request's authRef. Undefined after a restart. */
  grant?: AuthGrant;
  signal: AbortSignal;
  /** Set when this run continues an input-required task. */
  resume?: { input: Record<string, unknown> };
  /** Results of the tasks this one depends on, by task key. */
  dependencies: Record<string, DependencyResult>;
  checkpoint: {
    get<T = unknown>(name: string): T | undefined;
    set(name: string, value: unknown): void;
  };
  /** The remote agent's own id for this task, if it has one yet. */
  remoteTaskId?: string;
  setRemoteTaskId(remoteTaskId: string): void;
  onStatus(message: string): void;
  onUsage(usage: { llmCalls: number; costUsd: number }): void;
  /** Stop spending on model calls past this. */
  budgetUsd?: number;
  /** Which attempt this is, from 1. */
  attempt: number;
  /** The typed task message for this run (refs, constraints, dependency results). */
  message?: AgentMessage;
}

export type ReconcileVerdict = "done" | "not_done" | "unknown";

/**
 * The one interface Aadi talks to. A specialist in this process and a remote
 * agent behind A2A both implement it, so the engine never knows which it has.
 */
export interface AgentHandle {
  readonly manifest: AgentManifest;
  getCapabilities(): CapabilityDescriptor[];
  executeTask(request: DelegationRequest, env: ExecutionEnv): Promise<AgentTaskResult>;
  /** Same task and conversation, now with the answer in env.resume. */
  continueTask(request: DelegationRequest, env: ExecutionEnv): Promise<AgentTaskResult>;
  getTaskStatus(taskId: string): Promise<AgentTaskStatus | undefined>;
  cancelTask(taskId: string): Promise<boolean>;
  retryPolicy(capability: string): RetryPolicy;
  /** After an attempt of unknown outcome: did the work happen? */
  reconcile?(request: DelegationRequest, env: ExecutionEnv): Promise<ReconcileVerdict>;
}
