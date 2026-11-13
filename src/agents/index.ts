import { tools as toolRegistry } from "../tools/index.js";
import { allToolOwnership, getAgent, listAgents, registerAgent } from "./registry.js";
import { LocalSpecialist, type SpecialistDefinition } from "./specialist.js";
import { buildAgent } from "./specialists/build.js";
import { calendarAgent } from "./specialists/calendar.js";
import { emailAgent } from "./specialists/email.js";
import { knowledgeAgent } from "./specialists/knowledge.js";
import { operationsAgent } from "./specialists/operations.js";
import { salesAgent } from "./specialists/sales.js";

/**
 * The agents that run in this process. Adding one is a new definition file and
 * one line here: the orchestrator finds it through the registry.
 */
export const SPECIALISTS: readonly SpecialistDefinition[] = [
  emailAgent,
  calendarAgent,
  salesAgent,
  knowledgeAgent,
  operationsAgent,
  buildAgent,
];

/** Registers one specialist that runs in this process. */
export function registerSpecialist(definition: SpecialistDefinition): LocalSpecialist {
  const specialist = new LocalSpecialist(definition);
  registerAgent(specialist, { routing: definition.routing, ownedTools: definition.tools });
  return specialist;
}

for (const definition of SPECIALISTS) {
  registerSpecialist(definition);
}

// Fail at startup, not mid-conversation, if a tool has no owner.
const owned = new Set(allToolOwnership().map((entry) => entry.tool));
const orphans = Object.keys(toolRegistry).filter((name) => !owned.has(name));
if (orphans.length > 0) {
  throw new Error(`Tools with no owning agent: ${orphans.join(", ")}`);
}

/** The specialist with this id, if it runs in this process. */
export function specialistFor(id: string): LocalSpecialist | undefined {
  const agent = getAgent(id);
  return agent instanceof LocalSpecialist ? agent : undefined;
}

export function localSpecialists(): LocalSpecialist[] {
  return listAgents().filter((agent): agent is LocalSpecialist => agent instanceof LocalSpecialist);
}
