/**
 * One half of a real restart test. The parent test runs this twice against the
 * same SQLite file: once to start work and be killed mid-task (kill -9), and
 * once as the "restarted" process that recovers what the first one left.
 *
 *   tsx scripts/agent-crash-child.ts <engine-start|engine-recover|a2a-start|a2a-recover>
 */
import "dotenv/config";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { issueGrant } from "../src/agents/auth.ts";
import { registerRemoteAgents } from "../src/agents/a2a/remote.ts";
import { recoverTasks, startWorkflow, delegate } from "../src/agents/engine.ts";
import { registerSpecialist } from "../src/agents/index.ts";
import { db } from "../src/db.ts";

const mode = process.argv[2] ?? "";
const effectsFile = process.env.CRASH_EFFECTS_FILE ?? "";
if (!process.env.AADI_DB_PATH || process.env.AADI_DB_PATH === ":memory:") {
  throw new Error("agent-crash-child.ts needs a file database in AADI_DB_PATH.");
}

function effects(name: string): number {
  if (!existsSync(effectsFile)) {
    return 0;
  }
  return readFileSync(effectsFile, "utf8").split("\n").filter((line) => line === name).length;
}

const hang = (): Promise<never> => new Promise(() => undefined);
const starting = mode === "engine-start";

/** Each capability records that it ran, then (in the first process) never returns. */
function crashy(name: string, effect: "read" | "external", retry: "safe" | "never" | "reconcile") {
  return {
    name,
    description: name,
    kind: "workflow" as const,
    effect,
    retry,
    usesLlm: false,
    inputSchema: { type: "object" as const, properties: {} },
    handler: async () => {
      appendFileSync(effectsFile, `${name}\n`);
      if (starting) {
        await hang();
      }
      return { text: `${name} ran` };
    },
    ...(retry === "reconcile"
      ? { reconcile: async () => (effects(name) > 0 ? ("done" as const) : ("not_done" as const)) }
      : {}),
  };
}

function states(): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT task_key, state, attempts, error_json, result_json, remote_task_id FROM agent_tasks
       WHERE durable = 1 ORDER BY created_at ASC, task_key ASC`,
    )
    .all() as Array<Record<string, unknown>>;
}

if (mode === "engine-start" || mode === "engine-recover") {
  registerSpecialist({
    id: "crashlab",
    name: "Crash Lab",
    description: "Test agent.",
    version: "1",
    promptFile: "email.md",
    tools: [],
    noGoal: true,
    routing: { patterns: [], commandKinds: [] },
    capabilities: [
      crashy("lookup", "read", "safe"),
      crashy("send_like", "external", "never"),
      crashy("book_like", "external", "reconcile"),
      crashy("after_lookup", "read", "safe"),
    ],
  });
}

if (mode === "engine-start") {
  const grant = issueGrant({ source: "owner_chat", ownerText: "do the three things" });
  void startWorkflow({
    title: "crash test",
    origin: "chat",
    grant,
    durable: true,
    tasks: [
      { key: "lookup", agentId: "crashlab", capability: "lookup", input: {} },
      { key: "send", agentId: "crashlab", capability: "send_like", input: {} },
      { key: "book", agentId: "crashlab", capability: "book_like", input: {} },
      { key: "after", agentId: "crashlab", capability: "after_lookup", input: {}, dependsOn: ["lookup"] },
    ],
  });
  const timer = setInterval(() => {
    if (effects("lookup") === 1 && effects("send_like") === 1 && effects("book_like") === 1) {
      clearInterval(timer);
      console.log("STARTED");
    }
  }, 50);
} else if (mode === "engine-recover") {
  const report = await recoverTasks({ wait: true });
  console.log(`RESULT ${JSON.stringify({ report, tasks: states() })}`);
  process.exit(0);
} else if (mode === "a2a-start" || mode === "a2a-recover") {
  const count = await registerRemoteAgents([
    { id: "example", url: process.env.CRASH_A2A_URL ?? "", token: process.env.CRASH_A2A_TOKEN ?? "" },
  ]);
  if (count !== 1) {
    throw new Error("could not register the example agent");
  }
  if (mode === "a2a-start") {
    const grant = issueGrant({ source: "owner_chat", ownerText: "ask the example agent to run the slow job" });
    void delegate({
      agentId: "example",
      capability: "slow",
      input: { text: "run the slow job" },
      grant,
      durable: true,
      origin: "chat",
    });
    const timer = setInterval(() => {
      const row = states()[0];
      if (row?.remote_task_id) {
        clearInterval(timer);
        console.log(`STARTED ${String(row.remote_task_id)}`);
      }
    }, 50);
  } else {
    const report = await recoverTasks({ wait: true });
    console.log(`RESULT ${JSON.stringify({ report, tasks: states() })}`);
    process.exit(0);
  }
} else if (mode === "build-start") {
  // A build is asked for, then the process dies before Vishnu taps anything.
  const { updateBuild } = await import("../src/db.ts");
  const grant = issueGrant({ source: "owner_chat", ownerText: "build: tidy the brief" });
  const asked = await delegate({ agentId: "build", capability: "request_build", input: { task: "tidy the brief" }, grant, origin: "chat" });
  const buildId = Number(asked.output?.build_id);
  // What the existing build poll records once Cursor has opened a pull request.
  updateBuild(buildId, {
    status: "waiting_approval",
    pr_url: "https://github.com/example/aadi/pull/7",
    pr_number: 7,
    files_json: JSON.stringify(["src/brief.ts", "src/security/approvals.ts"]),
  });
  console.log(`STARTED ${buildId}`);
  await hang();
} else if (mode === "build-status") {
  const status = await delegate({ agentId: "build", capability: "build_status", input: {}, origin: "background" });
  console.log(`RESULT ${JSON.stringify({ state: status.state, text: status.text, output: status.output })}`);
  process.exit(0);
} else {
  throw new Error(`unknown mode ${mode}`);
}
