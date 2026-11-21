import { config } from "../config.js";
import { getSetting, setSetting } from "../db.js";
import { assertTestSeam } from "../test_seam.js";

/**
 * A model on the laptop (Ollama) that an agent may think with instead of its
 * cloud models. Only an agent that can't send, book or change anything may use
 * it, and this file is where that rule lives: the lock in the picker is only how
 * it looks. A locked agent with a stored choice still runs on its cloud models.
 *
 * The choice is saved in SQLite under its own key, so it survives a restart and
 * never touches agent_models_v1 (the cloud primary, fallbacks and tier).
 */
export const LOCAL_AGENT_SETTING = "agent_local_models_v1";

/** Knowledge runs on its read tools when local. Every other agent acts on its own. */
export const LOCAL_ALLOWED_AGENTS: ReadonlySet<string> = new Set(["knowledge"]);

export const LOCAL_LOCKED_TEXT = "Locked: this agent sends, books or changes things.";
export const LOCAL_SECTION_TITLE = "Local models (laptop)";
export const LOCAL_MODEL_LABEL = "slow, laptop";
/** Shown, never selectable. */
export const LOCAL_SEARCH_MODEL = "bge-m3";
export const LOCAL_SEARCH_MODEL_TEXT = "search model, not in use";

export const LOCAL_AGENT_CONNECT_TIMEOUT_MS = 3_000;
export const LOCAL_AGENT_TOTAL_TIMEOUT_MS = 120_000;

export interface LocalAgentModel {
  model: string;
  url: string;
  connectTimeoutMs: number;
  /** For the whole local run, every model call in it included. */
  totalTimeoutMs: number;
}

let overrides: Partial<LocalAgentModel> | undefined;

export function setLocalAgentModelConfigForTests(next: Partial<LocalAgentModel> | undefined): void {
  assertTestSeam("setLocalAgentModelConfigForTests");
  overrides = next;
}

/** The one local model the picker offers: LOCAL_MODEL_NAME (gemma4:e2b). */
export function selectableLocalModel(): string {
  return overrides?.model ?? config.localModelName;
}

export function localModelAllowed(agentId: string): boolean {
  return LOCAL_ALLOWED_AGENTS.has(agentId);
}

function readStored(): Record<string, string> {
  const raw = getSetting(LOCAL_AGENT_SETTING);
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

/** True when this agent has the laptop model switched on and may use it. */
export function localModelOn(agentId: string): boolean {
  return localModelAllowed(agentId) && readStored()[agentId] === selectableLocalModel();
}

/**
 * Switches the laptop model on for this agent, or back off to its cloud models.
 * Refused for a locked agent, and for any model but the selectable one.
 */
export function toggleLocalModel(agentId: string, model = selectableLocalModel()): { on: boolean } | { refused: string } {
  if (!localModelAllowed(agentId)) {
    return { refused: LOCAL_LOCKED_TEXT };
  }
  if (model !== selectableLocalModel()) {
    return { refused: model === LOCAL_SEARCH_MODEL ? `${LOCAL_SEARCH_MODEL} is a search model and can't answer.` : `${model} can't be picked.` };
  }
  const stored = readStored();
  const on = stored[agentId] !== model;
  if (on) {
    stored[agentId] = model;
  } else {
    delete stored[agentId];
  }
  setSetting(LOCAL_AGENT_SETTING, JSON.stringify(stored));
  return { on };
}

/**
 * The laptop model a run of this agent uses, or undefined for its cloud models.
 * Only an allowed agent that picked the selectable model gets one.
 */
export function localModelForAgent(agentId: string): LocalAgentModel | undefined {
  if (!localModelOn(agentId)) {
    return undefined;
  }
  const url = (overrides?.url ?? config.localModelUrl).trim().replace(/\/$/, "");
  if (!url) {
    return undefined;
  }
  return {
    model: selectableLocalModel(),
    url,
    connectTimeoutMs: overrides?.connectTimeoutMs ?? LOCAL_AGENT_CONNECT_TIMEOUT_MS,
    totalTimeoutMs: overrides?.totalTimeoutMs ?? LOCAL_AGENT_TOTAL_TIMEOUT_MS,
  };
}
