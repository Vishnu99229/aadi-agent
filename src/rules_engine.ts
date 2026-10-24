import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Engine, type RuleProperties } from "json-rules-engine";

const RULES_PATH = fileURLToPath(
  new URL("../rules/autonomy.json", import.meta.url),
);

export interface DraftFacts {
  is_known_client: boolean;
  has_attachment: boolean;
  domain_seen_count: number;
}

export type AutonomyOutcome =
  | {
      kind: "require_manual_approval";
      reason: string;
      rule: string;
    }
  | {
      kind: "auto_send_approved";
      reason: string;
      rule: string;
      cancelWindowMinutes: number;
    };

interface AutonomyFile {
  rules: RuleProperties[];
}

let engineCache: Engine | undefined;

function loadEngine(): Engine {
  if (engineCache) return engineCache;
  const raw = readFileSync(RULES_PATH, "utf8");
  const parsed = JSON.parse(raw) as AutonomyFile;
  const engine = new Engine([], { allowUndefinedFacts: true });
  for (const rule of parsed.rules) {
    engine.addRule(rule);
  }
  engineCache = engine;
  return engine;
}

/** Flush the cached engine. Only used by tests that swap rule files. */
export function resetEngineForTests(): void {
  engineCache = undefined;
}

/** Evaluate the autonomy rules against a draft's facts.
 *
 *  require_manual_approval ALWAYS wins over auto_send_approved - any
 *  rule asking for a manual tap vetoes auto-send, no matter the priority.
 *  Returns the strongest outcome, or `null` when no rule fired (in which
 *  case the caller defaults to manual approval - safe default). */
export async function evaluateDraft(
  facts: DraftFacts,
): Promise<AutonomyOutcome | null> {
  const engine = loadEngine();
  const result = await engine.run(facts as unknown as Record<string, unknown>);
  let manual: AutonomyOutcome | null = null;
  let auto: AutonomyOutcome | null = null;
  for (const event of result.events) {
    const params = (event.params ?? {}) as Record<string, unknown>;
    const reason =
      typeof params.reason === "string" ? params.reason : event.type;
    const rule = typeof params.rule === "string" ? params.rule : "unknown";
    if (event.type === "require_manual_approval") {
      manual = { kind: "require_manual_approval", reason, rule };
    } else if (event.type === "auto_send_approved") {
      const minutes = Number(params.cancelWindowMinutes);
      const safeMinutes =
        Number.isFinite(minutes) && minutes >= 1 ? Math.floor(minutes) : 5;
      auto = {
        kind: "auto_send_approved",
        reason,
        rule,
        cancelWindowMinutes: safeMinutes,
      };
    }
  }
  // Safety: manual beats auto when both fired.
  return manual ?? auto;
}
