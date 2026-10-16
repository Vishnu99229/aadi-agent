import { config } from "./config.js";

const CURSOR_JSON = "application/json";

export class CursorApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly apiMessage: string;

  constructor(status: number, code: string, apiMessage: string) {
    super(`Cursor API returned ${status}.`);
    this.name = "CursorApiError";
    this.status = status;
    this.code = code;
    this.apiMessage = apiMessage;
  }
}

export interface CursorAgent {
  id: string;
  name?: string;
  status?: string;
  url?: string;
  latestRunId?: string;
}

export interface CursorRun {
  id: string;
  agentId: string;
  status: string;
  result?: string;
  git?: {
    branches?: Array<{
      repoUrl?: string;
      branch?: string;
      prUrl?: string;
    }>;
  };
}

function cursorHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${config.cursorApiKey}`,
    "Content-Type": CURSOR_JSON,
    Accept: CURSOR_JSON,
  };
}

function redactSecrets(text: string): string {
  return text
    .replace(/crsr_[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "[redacted]")
    .replace(/ghp_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "[redacted]");
}

function parseCursorError(status: number, text: string): CursorApiError {
  let code = "";
  let message = "";
  try {
    const json = JSON.parse(text) as {
      error?: { code?: unknown; message?: unknown } | string;
      message?: unknown;
    };
    if (typeof json.error === "string") {
      message = json.error;
    } else if (json.error && typeof json.error === "object") {
      code = typeof json.error.code === "string" ? json.error.code : "";
      message =
        typeof json.error.message === "string" ? json.error.message : "";
    }
    if (!message && typeof json.message === "string") {
      message = json.message;
    }
  } catch {
    message = text;
  }
  return new CursorApiError(
    status,
    code,
    redactSecrets(message).replace(/\s+/g, " ").trim().slice(0, 300),
  );
}

export function cursorErrorInfo(error: unknown): {
  status?: number;
  code?: string;
  apiMessage?: string;
  message?: string;
} {
  if (error instanceof CursorApiError) {
    return {
      status: error.status,
      code: error.code,
      apiMessage: error.apiMessage,
    };
  }
  if (error instanceof Error) {
    return { message: redactSecrets(error.message) };
  }
  return {};
}

async function cursorFetch<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${config.cursorApiBase}${path}`, {
    method,
    headers: cursorHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const raw = await response.text();
    const error = parseCursorError(response.status, raw);
    console.error(
      `Cursor API ${method} ${path}: status=${error.status}` +
        (error.code ? ` code=${error.code}` : "") +
        (error.apiMessage ? ` message=${error.apiMessage}` : ""),
    );
    throw error;
  }
  return (await response.json()) as T;
}

export async function createCloudAgent(prompt: string): Promise<{
  agent: CursorAgent;
  run: CursorRun;
}> {
  return cursorFetch<{ agent: CursorAgent; run: CursorRun }>(
    "POST",
    "/v1/agents",
    {
      prompt: { text: prompt },
      repos: [
        {
          url: `https://github.com/${config.githubOwner}/${config.githubRepo}`,
          startingRef: "main",
        },
      ],
      autoCreatePR: true,
      skipReviewerRequest: true,
    },
  );
}

export async function createCloudRun(
  agentId: string,
  prompt: string,
): Promise<CursorRun> {
  const data = await cursorFetch<{ run: CursorRun }>(
    "POST",
    `/v1/agents/${encodeURIComponent(agentId)}/runs`,
    { prompt: { text: prompt } },
  );
  return data.run;
}

export async function getCloudRun(
  agentId: string,
  runId: string,
): Promise<CursorRun> {
  return cursorFetch<CursorRun>(
    "GET",
    `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`,
  );
}

export async function archiveCloudAgent(agentId: string): Promise<void> {
  await cursorFetch<{ id: string }>(
    "POST",
    `/v1/agents/${encodeURIComponent(agentId)}/archive`,
  );
}

export function isTerminalRunStatus(status: string): boolean {
  return (
    status === "FINISHED" ||
    status === "ERROR" ||
    status === "CANCELLED" ||
    status === "EXPIRED"
  );
}
