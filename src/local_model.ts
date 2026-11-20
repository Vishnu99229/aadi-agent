import net from "node:net";
import { URL } from "node:url";
import { config } from "./config.js";
import { SUMMARISE_SYSTEM, redactAllSecrets } from "./chat_history.js";
import { insertLocalModelRun, latestLocalModelRun } from "./db.js";
import { assertTestSeam } from "./test_seam.js";

export const LOCAL_CONNECT_TIMEOUT_MS = 3_000;
export const LOCAL_TOTAL_TIMEOUT_MS = 180_000;
export const LOCAL_NUM_PREDICT = 500;

type LocalModelOverrides = {
  enabled?: boolean;
  url?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
};

let overridesForTests: LocalModelOverrides | undefined;
let shadowInFlight = false;
let lastShadowStartedAt = 0;

export function setLocalModelConfigForTests(
  next: LocalModelOverrides | undefined,
): void {
  assertTestSeam("setLocalModelConfigForTests");
  overridesForTests = next;
}

export function resetLocalModelShadowForTests(): void {
  assertTestSeam("resetLocalModelShadowForTests");
  shadowInFlight = false;
  lastShadowStartedAt = 0;
}

function enabled(): boolean {
  return overridesForTests?.enabled ?? config.localModelEnabled;
}

function baseUrl(): string {
  return (overridesForTests?.url ?? config.localModelUrl).replace(/\/$/, "");
}

function modelName(): string {
  return overridesForTests?.model ?? config.localModelName;
}

function fetchImpl(): typeof fetch {
  return overridesForTests?.fetchImpl ?? fetch;
}

function nowMs(): number {
  return (overridesForTests?.nowMs ?? Date.now)();
}

export function formatLocalModelHealthLine(now = new Date()): string {
  if (!enabled()) {
    return "local-model: off";
  }
  const latest = latestLocalModelRun();
  const target = `${modelName()} @ ${baseUrl()}`;
  if (!latest) {
    return `local-model: shadow ${target} (no runs yet)`;
  }
  const ageMs = now.getTime() - Date.parse(latest.created_at);
  const age =
    Number.isFinite(ageMs) && ageMs >= 0
      ? ageMs < 60_000
        ? `${Math.round(ageMs / 1000)}s ago`
        : `${Math.round(ageMs / 60_000)}m ago`
      : "unknown";
  const dur =
    latest.duration_ms != null ? ` ${Math.round(latest.duration_ms / 1000)}s` : "";
  return `local-model: shadow ${target}; last ${latest.status}${dur} (${age})`;
}

async function assertConnectable(
  url: string,
  timeoutMs: number,
): Promise<void> {
  const parsed = new URL(url);
  const host = parsed.hostname;
  const port =
    parsed.port !== ""
      ? Number(parsed.port)
      : parsed.protocol === "https:"
        ? 443
        : 80;
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`local model connect timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export type LocalChatResult = {
  text: string;
  durationMs: number;
};

/** One Ollama /api/chat call. No retries. think=false, num_predict capped. */
export async function callLocalChat(params: {
  system: string;
  user: string;
  url?: string;
  model?: string;
}): Promise<LocalChatResult> {
  const url = (params.url ?? baseUrl()).replace(/\/$/, "");
  const model = params.model ?? modelName();
  const endpoint = `${url}/api/chat`;
  const connectMs =
    overridesForTests?.connectTimeoutMs ?? LOCAL_CONNECT_TIMEOUT_MS;
  const totalMs = overridesForTests?.totalTimeoutMs ?? LOCAL_TOTAL_TIMEOUT_MS;
  const started = nowMs();
  await assertConnectable(endpoint, connectMs);
  const response = await fetchImpl()(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      messages: [
        { role: "system", content: params.system },
        { role: "user", content: params.user },
      ],
      options: { num_predict: LOCAL_NUM_PREDICT },
    }),
    signal: AbortSignal.timeout(totalMs),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `local model HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
    );
  }
  const payload = (await response.json()) as {
    message?: { content?: string };
    response?: string;
  };
  const text =
    payload.message?.content?.trim() ||
    (typeof payload.response === "string" ? payload.response.trim() : "") ||
    "";
  return { text, durationMs: nowMs() - started };
}

export type ShadowFoldParams = {
  input: string;
  cloudSummary: string;
  cloudBackend: string;
  cloudModel: string;
  untilId: number;
};

/**
 * Fire-and-forget shadow fold. Caller must only invoke after the cloud fold
 * succeeded and its summary was saved. Never awaited on the reply path.
 */
export function maybeShadowFoldSummary(params: ShadowFoldParams): void {
  if (!enabled()) {
    return;
  }
  if (shadowInFlight) {
    console.log("local-model shadow: skipped (already running)");
    return;
  }
  shadowInFlight = true;
  lastShadowStartedAt = nowMs();
  void runShadowFold(params)
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`local-model shadow failed: ${message}`);
    })
    .finally(() => {
      shadowInFlight = false;
    });
}

async function runShadowFold(params: ShadowFoldParams): Promise<void> {
  const localModel = modelName();
  const started = nowMs();
  try {
    const result = await callLocalChat({
      system: SUMMARISE_SYSTEM,
      user: params.input,
    });
    const localSummary = redactAllSecrets(result.text);
    insertLocalModelRun({
      untilId: params.untilId,
      status: "ok",
      durationMs: result.durationMs,
      localModel,
      cloudBackend: params.cloudBackend,
      cloudModel: params.cloudModel,
      cloudSummary: params.cloudSummary,
      localSummary,
      error: null,
      inputChars: params.input.length,
    });
    console.log(
      `local-model shadow ok: until_id=${params.untilId} ms=${result.durationMs} chars=${localSummary.length}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    insertLocalModelRun({
      untilId: params.untilId,
      status: "error",
      durationMs: nowMs() - started,
      localModel,
      cloudBackend: params.cloudBackend,
      cloudModel: params.cloudModel,
      cloudSummary: params.cloudSummary,
      localSummary: null,
      error: message.slice(0, 500),
      inputChars: params.input.length,
    });
    throw error;
  }
}

/** Test helper: whether a shadow call is currently in flight. */
export function localModelShadowInFlightForTests(): boolean {
  assertTestSeam("localModelShadowInFlightForTests");
  return shadowInFlight;
}

export function lastLocalModelShadowStartedAtForTests(): number {
  assertTestSeam("lastLocalModelShadowStartedAtForTests");
  return lastShadowStartedAt;
}
