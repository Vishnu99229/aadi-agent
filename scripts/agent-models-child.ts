/**
 * One half of the agent-model restart test. The parent runs it twice against
 * the same SQLite file: once to save a choice, once as a fresh process that
 * reads it back.
 *
 *   tsx scripts/agent-models-child.ts <set|read>
 */
import "dotenv/config";
import { getAgentModelSetting, resolveAgentModel, setAgentModelSetting } from "../src/models/agent_models.ts";

if (!process.env.AADI_DB_PATH || process.env.AADI_DB_PATH === ":memory:") {
  throw new Error("agent-models-child.ts needs a file database in AADI_DB_PATH.");
}
const mode = process.argv[2] ?? "";
if (mode === "set") {
  setAgentModelSetting("sales", { primary: "gemini:flash", fallbacks: ["deepseek:flash"], tier: "deep" });
  console.log("SET");
} else if (mode === "read") {
  const setting = getAgentModelSetting("sales");
  const resolved = resolveAgentModel("sales");
  console.log(`READ ${JSON.stringify({ setting, route: resolved.models.map((spec) => spec.key), effort: resolved.effort })}`);
} else {
  throw new Error(`unknown mode ${mode}`);
}
process.exit(0);
