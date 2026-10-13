/**
 * Prevents a local LLM from loading while Aadi is running, or on a machine
 * without enough RAM. gemma4:e4b needs ~7GB; this phone has ~7.4GB total.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { freemem, totalmem } from "node:os";
import { promisify } from "node:util";
import { config } from "./config.js";

const execFileAsync = promisify(execFile);

/** Available RAM required before any local model may load. Blocks E4B on the phone. */
export const LOCAL_LLM_MIN_AVAILABLE_MB = 7000;

const PHONE_SSH = [
  "-p",
  "8022",
  "-o",
  "ConnectTimeout=8",
  "-o",
  "BatchMode=yes",
  "u0_a289@192.168.1.7",
];

export class LocalLlmBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalLlmBlockedError";
  }
}

interface MachineState {
  label: string;
  aadiTmux: boolean;
  aadiProcess: boolean;
  availableMb: number | null;
  totalMb: number | null;
}

function isTermux(): boolean {
  return existsSync("/data/data/com.termux");
}

function bytesToMb(bytes: number): number {
  return Math.floor(bytes / (1024 * 1024));
}

function parseFreeM(text: string): { totalMb: number | null; availableMb: number | null } {
  const line = text.split("\n").find((row) => /^\s*Mem:/i.test(row));
  if (!line) {
    return { totalMb: null, availableMb: null };
  }
  const parts = line.trim().split(/\s+/);
  const totalMb = Number(parts[1]);
  const availableMb = Number(parts[6] ?? parts[3]);
  return {
    totalMb: Number.isFinite(totalMb) ? totalMb : null,
    availableMb: Number.isFinite(availableMb) ? availableMb : null,
  };
}

async function run(
  command: string,
  args: string[],
  timeoutMs = 8000,
): Promise<{ ok: boolean; stdout: string }> {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: timeoutMs });
    return { ok: true, stdout: stdout ?? "" };
  } catch (error) {
    const err = error as { stdout?: string; status?: number | null };
    return { ok: false, stdout: err.stdout ?? "" };
  }
}

async function portListeners(port: number): Promise<string> {
  const result = await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], 5000);
  return result.stdout.toLowerCase();
}

async function resolveTarget(): Promise<"local" | "phone"> {
  if (isTermux()) {
    return "phone";
  }
  let url: URL;
  try {
    url = new URL(config.localLlmBaseUrl);
  } catch {
    return "local";
  }
  if (url.hostname === "192.168.1.7") {
    return "phone";
  }
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
    const port = Number(url.port || "80");
    const listeners = await portListeners(port);
    if (listeners.includes("ssh")) {
      return "phone";
    }
  }
  return "local";
}

async function inspectLocal(label: string): Promise<MachineState> {
  const tmux = await run("tmux", ["has-session", "-t", "aadi"], 4000);
  const proc = await run("pgrep", ["-f", "[t]sx src/index.ts"], 4000);
  const free = await run("free", ["-m"], 4000);
  const parsed = parseFreeM(free.stdout);
  return {
    label,
    aadiTmux: tmux.ok,
    aadiProcess: proc.ok && proc.stdout.trim().length > 0,
    availableMb: parsed.availableMb ?? bytesToMb(freemem()),
    totalMb: parsed.totalMb ?? bytesToMb(totalmem()),
  };
}

async function inspectPhone(): Promise<MachineState> {
  const remote = await run(
    "ssh",
    [
      ...PHONE_SSH,
      'tmux has-session -t aadi 2>/dev/null && echo AADI_TMUX=1 || echo AADI_TMUX=0; pgrep -f "[t]sx src/index.ts" >/dev/null && echo AADI_PROC=1 || echo AADI_PROC=0; free -m',
    ],
    15000,
  );
  if (!remote.ok && !remote.stdout.trim()) {
    throw new LocalLlmBlockedError(
      "Refusing to load a local model: cannot reach the phone to check whether Aadi is running. Stop Aadi first (`npm run phone:pause`) if the model would load there.",
    );
  }
  const parsed = parseFreeM(remote.stdout);
  return {
    label: "phone",
    aadiTmux: /AADI_TMUX=1/.test(remote.stdout),
    aadiProcess: /AADI_PROC=1/.test(remote.stdout),
    availableMb: parsed.availableMb,
    totalMb: parsed.totalMb,
  };
}

function refuse(state: MachineState): never {
  if (state.aadiTmux || state.aadiProcess) {
    throw new LocalLlmBlockedError(
      `Refusing to load a local model: Aadi is running on the ${state.label} (tmux session "aadi" or tsx src/index.ts). Stop Aadi first (\`npm run phone:pause\` on the phone, or stop the Mac copy). Never run Ollama alongside Aadi — they exceed the phone's RAM and crash it.`,
    );
  }
  const available = state.availableMb ?? 0;
  if (available < LOCAL_LLM_MIN_AVAILABLE_MB) {
    throw new LocalLlmBlockedError(
      `Refusing to load a local model: ${available}MB available on the ${state.label} (need at least ${LOCAL_LLM_MIN_AVAILABLE_MB}MB). gemma4:e4b needs ~7GB and cannot start on the ~7.4GB phone. Local models are Mac-only, or require pausing Aadi first on a machine with enough RAM.`,
    );
  }
  throw new LocalLlmBlockedError("Refusing to load a local model.");
}

/**
 * Call before any request that would load a local Ollama model.
 * Throws LocalLlmBlockedError with a message telling Vishnu what to stop.
 */
export async function assertLocalModelAllowed(): Promise<void> {
  const target = await resolveTarget();
  const state =
    target === "phone" && !isTermux()
      ? await inspectPhone()
      : await inspectLocal(target === "phone" ? "phone" : "this machine");

  if (
    state.aadiTmux ||
    state.aadiProcess ||
    (state.availableMb !== null && state.availableMb < LOCAL_LLM_MIN_AVAILABLE_MB)
  ) {
    refuse(state);
  }
}
