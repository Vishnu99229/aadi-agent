// LIVE 12-turn cache eval. Prints token/cost/cache-hit counts only — never
// reply or message content.
import "dotenv/config";

process.env.AADI_DB_PATH = ":memory:";

const { clearMessages, listUsageLogs } = await import("../src/db.ts");
const { runAgent } = await import("../src/agent.ts");
const { setHistoryLimitsForTests } = await import("../src/chat_history.ts");

type Backend = "claude" | "deepseek";

function tally(
  rows: Array<{
    input_tokens: number;
    cache_write_tokens: number;
    cache_read_tokens: number;
    output_tokens: number;
    cost_usd: number;
  }>,
): {
  calls: number;
  input: number;
  write: number;
  read: number;
  output: number;
  cost: number;
  hit: string;
} {
  let input = 0;
  let write = 0;
  let read = 0;
  let output = 0;
  let cost = 0;
  for (const row of rows) {
    input += row.input_tokens;
    write += row.cache_write_tokens;
    read += row.cache_read_tokens;
    output += row.output_tokens;
    cost += row.cost_usd;
  }
  const denom = input + write + read;
  const hit =
    denom > 0 ? `${Math.round((read / denom) * 100)}%` : "n/a";
  return { calls: rows.length, input, write, read, output, cost, hit };
}

function line(
  label: string,
  stats: ReturnType<typeof tally>,
): string {
  return [
    label,
    `calls=${stats.calls}`,
    `input=${stats.input}`,
    `cache_write=${stats.write}`,
    `cache_read=${stats.read}`,
    `output=${stats.output}`,
    `cache_hit=${stats.hit}`,
    `cost_usd=${stats.cost.toFixed(6)}`,
  ].join(" ");
}

async function runPhase(
  name: string,
  backend: Backend,
  limits: { keepMax: number; fold: number } | undefined,
): Promise<ReturnType<typeof tally>> {
  clearMessages();
  setHistoryLimitsForTests(limits);
  const phaseFrom = new Date().toISOString();
  console.log(`phase=${name} backend=${backend} keepMax=${limits?.keepMax ?? 30} fold=${limits?.fold ?? 10}`);
  for (let turn = 1; turn <= 12; turn += 1) {
    const from = new Date().toISOString();
    const started = Date.now();
    let chars = 0;
    let empty = false;
    let errorType = "";
    try {
      const reply = await runAgent(
        `Cache-eval turn ${turn} of 12. Reply with only the word pong and the number ${turn}. Do not call tools.`,
        { backend },
      );
      chars = reply.length;
      empty = reply.trim().length === 0;
    } catch (error) {
      errorType = error instanceof Error ? error.name : "UnknownError";
      const message = error instanceof Error ? error.message : String(error);
      if (/credit balance is too low/i.test(message)) {
        throw new Error(`phase=${name} turn=${turn} anthropic_credit_too_low`);
      }
      throw error;
    }
    const to = new Date(Date.now() + 2_000).toISOString();
    const stats = tally(listUsageLogs(from, to));
    console.log(
      line(
        `turn=${turn} duration_ms=${Date.now() - started} chars=${chars} empty=${empty} err=${errorType || "none"}`,
        stats,
      ),
    );
  }
  const phaseTo = new Date(Date.now() + 2_000).toISOString();
  const total = tally(listUsageLogs(phaseFrom, phaseTo));
  console.log(line(`phase=${name} TOTAL`, total));
  setHistoryLimitsForTests(undefined);
  return total;
}

async function main(): Promise<void> {
  let backend: Backend = "claude";
  try {
    const before = await runPhase("before_slide8", backend, {
      keepMax: 8,
      fold: 1,
    });
    const after = await runPhase("after_block30", backend, undefined);
    console.log(
      `compare before_cost_usd=${before.cost.toFixed(6)} after_cost_usd=${after.cost.toFixed(6)} before_hit=${before.hit} after_hit=${after.hit}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (backend === "claude" && /anthropic_credit_too_low/i.test(message)) {
      console.log("claude unavailable (credit). retrying both phases on deepseek.");
      backend = "deepseek";
      const before = await runPhase("before_slide8", backend, {
        keepMax: 8,
        fold: 1,
      });
      const after = await runPhase("after_block30", backend, undefined);
      console.log(
        `compare before_cost_usd=${before.cost.toFixed(6)} after_cost_usd=${after.cost.toFixed(6)} before_hit=${before.hit} after_hit=${after.hit}`,
      );
      return;
    }
    throw error;
  }
}

await main();
