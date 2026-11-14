/**
 * Skills that belong to Aadi's A2A endpoint itself rather than to one of the
 * specialists. They touch no private data: no mail, calendar, memory, files or
 * sales records, and no tool. They exist so another agent has something real
 * to call while the connection itself is being tested.
 */
export interface SystemSkillResult {
  text: string;
  data: Record<string, unknown>;
}

export interface SystemSkill {
  id: string;
  description: string;
  examples: string[];
  run(
    input: Record<string, unknown>,
    progress: (message: string) => void,
    signal: AbortSignal,
  ): Promise<SystemSkillResult>;
}

const MAX_STEPS = 10;
const MAX_STEP_MS = 5_000;
const MAX_MESSAGE = 500;
const MAX_NUMBERS = 100;

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("canceled"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("canceled"));
      },
      { once: true },
    );
  });
}

export const a2aTestSkill: SystemSkill = {
  id: "system.a2a_test",
  description:
    "Connection test. Send { message?, numbers?, steps?, delay_ms?, correlation_id? }. Returns the message back, the count and sum of the numbers, and the correlation id. With steps and delay_ms it runs that many timed steps and reports each one, for testing streaming and reconnection. Reads no private data.",
  examples: ['{"skill":"system.a2a_test","input":{"message":"ping","numbers":[1,2,3]}}'],
  async run(input, progress, signal) {
    const message = typeof input.message === "string" ? input.message.slice(0, MAX_MESSAGE) : "";
    const numbers = Array.isArray(input.numbers)
      ? input.numbers.filter((item): item is number => typeof item === "number" && Number.isFinite(item)).slice(0, MAX_NUMBERS)
      : [];
    const steps = Math.min(MAX_STEPS, Math.max(0, Math.floor(Number(input.steps ?? 0)) || 0));
    const delayMs = Math.min(MAX_STEP_MS, Math.max(0, Math.floor(Number(input.delay_ms ?? 0)) || 0));
    for (let step = 1; step <= steps; step += 1) {
      await wait(delayMs, signal);
      progress(`step ${step} of ${steps}`);
    }
    const data = {
      ok: true,
      echo: message,
      length: message.length,
      numbers_count: numbers.length,
      sum: numbers.reduce((total, value) => total + value, 0),
      steps_completed: steps,
      correlation_id: typeof input.correlation_id === "string" ? input.correlation_id.slice(0, 100) : null,
      received_at: new Date().toISOString(),
      served_by: "aadi",
      private_data_used: false,
    };
    return { text: `a2a_test ok: echo "${message}", ${numbers.length} number(s), sum ${data.sum}, ${steps} step(s).`, data };
  },
};

export const SYSTEM_SKILLS: readonly SystemSkill[] = [a2aTestSkill];
