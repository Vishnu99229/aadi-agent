import { config } from "./config.js";
import { parsePullNumber } from "./build_logic.js";

const GITHUB_API = "https://api.github.com";
const API_VERSION = "2022-11-28";

function githubHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${config.githubToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION,
  };
}

function repoPath(): string {
  return `/repos/${config.githubOwner}/${config.githubRepo}`;
}

async function githubFetch<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      ...githubHeaders(),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = {} as T;
  if (text) {
    try {
      data = JSON.parse(text) as T;
    } catch {
      data = {} as T;
    }
  }
  if (!response.ok) {
    console.error(`GitHub API ${method} ${path}: status=${response.status}`);
    throw new Error(`GitHub API returned ${response.status}.`);
  }
  return { status: response.status, data };
}

export function pullNumberFromUrl(prUrl: string | null | undefined): number | undefined {
  if (!prUrl) {
    return undefined;
  }
  return parsePullNumber(prUrl);
}

export async function listPullFilenames(pullNumber: number): Promise<string[]> {
  const names: string[] = [];
  let page = 1;
  for (;;) {
    const { data } = await githubFetch<Array<{ filename?: string }>>(
      "GET",
      `${repoPath()}/pulls/${pullNumber}/files?per_page=100&page=${page}`,
    );
    if (!Array.isArray(data) || data.length === 0) {
      break;
    }
    for (const item of data) {
      if (typeof item.filename === "string" && item.filename) {
        names.push(item.filename);
      }
    }
    if (data.length < 100) {
      break;
    }
    page += 1;
    if (page > 10) {
      break;
    }
  }
  return names;
}

export async function mergePullSquash(pullNumber: number): Promise<void> {
  try {
    await githubFetch(
      "PUT",
      `${repoPath()}/pulls/${pullNumber}/merge`,
      { merge_method: "squash" },
    );
  } catch (error) {
    const { data } = await githubFetch<{ merged?: boolean }>(
      "GET",
      `${repoPath()}/pulls/${pullNumber}`,
    );
    if (data.merged === true) {
      return;
    }
    throw error;
  }
}

export async function closePull(pullNumber: number): Promise<void> {
  await githubFetch("PATCH", `${repoPath()}/pulls/${pullNumber}`, {
    state: "closed",
  });
}
