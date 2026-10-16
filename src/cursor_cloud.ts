import { config } from "./config.js";

const CURSOR_JSON = "application/json";

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
    console.error(`Cursor API ${method} ${path}: status=${response.status}`);
    throw new Error(`Cursor API returned ${response.status}.`);
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
