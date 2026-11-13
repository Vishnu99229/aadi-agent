import type { AgentHandle } from "./handle.js";
import {
  CORE_OWNER,
  type AgentId,
  type CapabilityDescriptor,
  type CapabilityEffect,
  type RetryPolicy,
} from "./types.js";

/**
 * The one place that knows which agents exist, what each can do and which agent
 * owns each tool. Aadi routes by looking things up here, so adding an agent is a
 * registration, not a change to the orchestrator.
 */
export interface ToolOwnership {
  owner: AgentId;
  effect: CapabilityEffect;
  retry: RetryPolicy;
  /** A read with nothing private in it, which another agent may ask for. */
  remoteExposed?: boolean;
}

/** How Aadi recognises a message as belonging to one agent, without a model call. */
export interface RoutingHints {
  /** Words and phrases that put a message in this agent's domain. */
  patterns: readonly RegExp[];
  /** Command families (command_intent.ts) this agent carries out. */
  commandKinds: readonly string[];
}

interface Registration {
  handle: AgentHandle;
  routing?: RoutingHints;
}

const agents = new Map<AgentId, Registration>();
const toolOwners = new Map<string, ToolOwnership>();

/** Tools that belong to no single domain. Any agent may be given them. */
const CORE_TOOLS: Record<string, { effect: CapabilityEffect; retry: RetryPolicy }> = {
  get_current_time: { effect: "read", retry: "safe" },
  react_to_message: { effect: "write", retry: "never" },
};

for (const [name, detail] of Object.entries(CORE_TOOLS)) {
  toolOwners.set(name, { owner: CORE_OWNER, ...detail });
}

export function isCoreTool(name: string): boolean {
  return toolOwners.get(name)?.owner === CORE_OWNER;
}

export function registerAgent(
  handle: AgentHandle,
  options: {
    routing?: RoutingHints;
    /** The tools this agent owns. Each tool has exactly one owner. */
    ownedTools?: ReadonlyArray<{ name: string; effect: CapabilityEffect; retry: RetryPolicy; remoteExposed?: boolean }>;
  } = {},
): void {
  const id = handle.manifest.id;
  if (id === CORE_OWNER) {
    throw new Error(`"${CORE_OWNER}" is the orchestrator and can't be registered as an agent.`);
  }
  if (agents.has(id)) {
    throw new Error(`Agent ${id} is already registered.`);
  }
  for (const tool of options.ownedTools ?? []) {
    const existing = toolOwners.get(tool.name);
    if (existing) {
      throw new Error(`Tool ${tool.name} is owned by ${existing.owner}; ${id} can't also own it.`);
    }
    toolOwners.set(tool.name, {
      owner: id,
      effect: tool.effect,
      retry: tool.retry,
      remoteExposed: tool.remoteExposed === true && tool.effect === "read",
    });
  }
  agents.set(id, { handle, routing: options.routing });
}

export function unregisterAgent(id: AgentId): void {
  agents.delete(id);
  for (const [name, ownership] of toolOwners) {
    if (ownership.owner === id) {
      toolOwners.delete(name);
    }
  }
}

export function getAgent(id: AgentId): AgentHandle | undefined {
  return agents.get(id)?.handle;
}

export function listAgents(): AgentHandle[] {
  return [...agents.values()].map((entry) => entry.handle);
}

export function listAgentIds(): AgentId[] {
  return [...agents.keys()];
}

export function routingHints(id: AgentId): RoutingHints | undefined {
  return agents.get(id)?.routing;
}

export function toolOwnership(tool: string): ToolOwnership | undefined {
  return toolOwners.get(tool);
}

export function ownedTools(id: AgentId): string[] {
  return [...toolOwners.entries()]
    .filter(([, ownership]) => ownership.owner === id)
    .map(([name]) => name);
}

export function allToolOwnership(): Array<{ tool: string } & ToolOwnership> {
  return [...toolOwners.entries()].map(([tool, ownership]) => ({ tool, ...ownership }));
}

export function findCapability(
  agentId: AgentId,
  capability: string,
): CapabilityDescriptor | undefined {
  return agents
    .get(agentId)
    ?.handle.getCapabilities()
    .find((item) => item.name === capability);
}

/** Every agent that offers a capability by this name. */
export function agentsWithCapability(capability: string): AgentId[] {
  return [...agents.entries()]
    .filter(([, entry]) => entry.handle.getCapabilities().some((item) => item.name === capability))
    .map(([id]) => id);
}
