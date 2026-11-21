/**
 * One half of the local-model restart test. The parent runs it twice against
 * the same SQLite file: once to switch Knowledge to the laptop model, once as a
 * fresh process that reads the choice back.
 *
 *   tsx scripts/local-model-picker-child.ts <set|read>
 */
import "dotenv/config";
import { resolveAgentModel } from "../src/models/agent_models.ts";
import { localModelForAgent, toggleLocalModel } from "../src/models/local_agent_models.ts";

if (!process.env.AADI_DB_PATH || process.env.AADI_DB_PATH === ":memory:") {
  throw new Error("local-model-picker-child.ts needs a file database in AADI_DB_PATH.");
}
const mode = process.argv[2] ?? "";
if (mode === "set") {
  console.log(`SET ${JSON.stringify(toggleLocalModel("knowledge"))}`);
} else if (mode === "read") {
  console.log(
    `READ ${JSON.stringify({
      local: localModelForAgent("knowledge")?.model ?? null,
      resolved: resolveAgentModel("knowledge").local?.model ?? null,
      cloud: resolveAgentModel("knowledge").models.map((spec) => spec.key),
    })}`,
  );
} else {
  throw new Error(`unknown mode ${mode}`);
}
process.exit(0);
