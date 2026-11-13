/**
 * Contracts shared by Aadi (the orchestrator), the six specialist agents and the
 * delegation layer. Nothing here knows how a message travels: a local call and an
 * A2A request both carry the same DelegationRequest and return the same
 * AgentTaskResult.
 */

export const LOCAL_AGENT_IDS = [
  "email",
  "calendar",
  "sales",
  "knowledge",
  "operations",
  "build",
] as const;

export type LocalAgentId = (typeof LOCAL_AGENT_IDS)[number];

/** Tools no one domain owns (the clock, an emoji reaction). */
export const CORE_OWNER = "aadi";

/** The name every specialist's free-form capability goes by. */
export const GOAL_CAPABILITY = "goal";

/** Registry-driven, so a new agent needs no change here. */
export type AgentId = string;

/** The A2A task states (spec 4.1.3), in their JSON spelling. */
export const TASK_STATES = [
  "submitted",
  "working",
  "input-required",
  "auth-required",
  "completed",
  "failed",
  "canceled",
  "rejected",
] as const;

export type TaskState = (typeof TASK_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  "completed",
  "failed",
  "canceled",
  "rejected",
]);

/** Paused until someone outside the task acts. */
export const INTERRUPTED_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  "input-required",
  "auth-required",
]);

export function isTerminal(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}

/** A JSON Schema subset: the same shape the LLM tool definitions already use. */
export interface JsonSchema {
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array" | "null";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  items?: JsonSchema;
  enum?: readonly unknown[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

/** What a capability can change. Authorization is decided on this. */
export type CapabilityEffect =
  /** Only reads. */
  | "read"
  /** Writes something that still needs Vishnu's tap (a draft, a proposal card). */
  | "draft"
  /** Changes Aadi's own records (tasks, reminders, memories, accounts). */
  | "write"
  /** Sends, books, deletes, merges or deploys outside Aadi. */
  | "external";

/**
 * What to do when an attempt's outcome is unknown (crash, timeout, lost reply):
 * - safe: run it again.
 * - reconcile: ask the capability whether the work happened, then decide.
 * - never: never run it again automatically.
 */
export type RetryPolicy = "safe" | "reconcile" | "never";

export type CapabilityKind =
  /** One existing tool, run directly. No model call. */
  | "tool"
  /** Several steps in code. No model call unless the capability says so. */
  | "workflow"
  /** A goal in words, worked out by the agent's own model loop. */
  | "goal";

/** A pointer to context, never the context itself. */
export interface ContextRef {
  kind:
    | "task_result"
    | "document"
    | "email_thread"
    | "email_message"
    | "draft"
    | "calendar_event"
    | "account"
    | "build"
    | "note"
    | "other";
  id: string;
  label?: string;
}

export interface Artifact {
  artifactId: string;
  name: string;
  /** text is prose for a person; data is structured. */
  kind: "text" | "data";
  text?: string;
  data?: Record<string, unknown>;
}

export interface TaskError {
  code:
    | "invalid_input"
    | "invalid_output"
    | "unknown_agent"
    | "unknown_capability"
    | "not_authorized"
    | "tool_not_allowed"
    | "deadline_exceeded"
    | "budget_exceeded"
    | "depth_exceeded"
    | "dependency_failed"
    | "transient"
    | "uncertain_outcome"
    | "interrupted"
    | "remote_error"
    | "canceled"
    | "failed";
  message: string;
  /** Safe to try again as-is. */
  retryable: boolean;
  /** The work may have happened. Check before doing it again. */
  uncertain?: boolean;
}

export interface TaskUsage {
  llmCalls: number;
  costUsd: number;
}

/** What Aadi sends an agent. Holds references and ids, never tokens or secrets. */
export interface DelegationRequest {
  workflowId: string;
  taskId: string;
  parentTaskId?: string;
  agentId: AgentId;
  capability: string;
  input: Record<string, unknown>;
  contextRefs: ContextRef[];
  /** The agent conversation this task belongs to (the A2A contextId). */
  contextId: string;
  correlationId: string;
  idempotencyKey?: string;
  /** ISO 8601. */
  deadline?: string;
  /** Names an authorization Aadi holds. The grant itself never travels. */
  authRef?: string;
  /** How many delegations deep this is. */
  depth: number;
}

export interface InputRequest {
  question: string;
  /** Named pieces of input the agent is missing. */
  fields?: string[];
  /** Who can answer: Vishnu, or another agent by id. */
  from?: "user" | AgentId;
}

/** What an agent sends back. */
export interface AgentTaskResult {
  taskId: string;
  contextId: string;
  state: TaskState;
  /** A short summary a person can read. */
  text?: string;
  /** The structured result. */
  output?: Record<string, unknown>;
  artifacts?: Artifact[];
  /** What should happen next, if anything ("Await Vishnu's Send tap"). */
  nextAction?: string;
  inputRequired?: InputRequest;
  error?: TaskError;
  usage?: TaskUsage;
}

export interface AgentTaskStatus {
  taskId: string;
  contextId: string;
  state: TaskState;
  statusMessage?: string;
  updatedAt: string;
}

export interface ContinueRequest {
  taskId: string;
  contextId: string;
  /** The answer to an input-required question. */
  input: Record<string, unknown>;
  authRef?: string;
}

/** What an agent publishes about one thing it can do. Serializable. */
export interface CapabilityDescriptor {
  name: string;
  description: string;
  kind: CapabilityKind;
  effect: CapabilityEffect;
  usesLlm: boolean;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  examples?: readonly string[];
}

/** An agent's public description. Becomes an A2A Agent Card. */
export interface AgentManifest {
  id: AgentId;
  name: string;
  description: string;
  version: string;
  /** local runs in this process; remote is reached over A2A. */
  location: "local" | "remote";
  capabilities: CapabilityDescriptor[];
  /** The LLM tools this agent may call. Nothing else is ever offered to it. */
  tools: readonly string[];
}

export class AgentTaskError extends Error {
  constructor(readonly detail: TaskError) {
    super(detail.message);
    this.name = "AgentTaskError";
  }
}

/** Thrown by a capability that needs something before it can go on. */
export class InputRequiredSignal extends Error {
  constructor(
    readonly request: InputRequest,
    /** Saved with the task so the same conversation resumes from here. */
    readonly checkpoint?: Record<string, unknown>,
  ) {
    super(request.question);
    this.name = "InputRequiredSignal";
  }
}

/** Thrown by a capability that is waiting on an approval Aadi has asked for. */
export class AuthRequiredSignal extends Error {
  constructor(
    readonly prompt: string,
    readonly checkpoint?: Record<string, unknown>,
  ) {
    super(prompt);
    this.name = "AuthRequiredSignal";
  }
}
