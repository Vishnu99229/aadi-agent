import { parsePullNumber } from "./build_logic.js";
import { config } from "./config.js";
import { redactSecrets } from "./security/env_guard.js";

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
    const message = readGithubError(data);
    const hint = message.slice(0, 80);
    console.error(
      `GitHub API ${method} ${path}: status=${response.status}` +
        (hint ? ` message=${hint}` : ""),
    );
    throw new Error(message || `GitHub API returned ${response.status}.`);
  }
  return { status: response.status, data };
}

function readGithubError(data: unknown): string {
  if (!data || typeof data !== "object") {
    return "";
  }
  const record = data as {
    message?: unknown;
    errors?: Array<{ message?: unknown }>;
  };
  if (typeof record.message === "string" && record.message.trim()) {
    return redactSecrets(record.message.replace(/\s+/g, " ").trim());
  }
  const nested = record.errors?.find(
    (item) => typeof item?.message === "string" && item.message.trim(),
  );
  if (nested && typeof nested.message === "string") {
    return redactSecrets(nested.message.replace(/\s+/g, " ").trim());
  }
  return "";
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

export interface GithubPull {
  number: number;
  node_id: string;
  title: string;
  html_url: string;
  draft: boolean;
  merged: boolean;
  mergeable: boolean | null;
  mergeable_state?: string | null;
  head: { sha: string };
  merge_commit_sha: string | null;
}

export interface GithubCheckItem {
  name: string;
  status: string;
  conclusion: string | null;
}

export async function getPull(pullNumber: number): Promise<GithubPull> {
  const { data } = await githubFetch<GithubPull>(
    "GET",
    `${repoPath()}/pulls/${pullNumber}`,
  );
  return data;
}

async function listCommitCheckRuns(sha: string): Promise<GithubCheckItem[]> {
  const items: GithubCheckItem[] = [];
  let page = 1;
  for (;;) {
    const { data } = await githubFetch<{
      check_runs?: Array<{
        name?: string;
        status?: string;
        conclusion?: string | null;
      }>;
    }>(
      "GET",
      `${repoPath()}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100&page=${page}`,
    );
    const runs = data.check_runs ?? [];
    if (runs.length === 0) {
      break;
    }
    for (const run of runs) {
      items.push({
        name: run.name?.trim() || "check",
        status: run.status ?? "",
        conclusion: run.conclusion ?? null,
      });
    }
    if (runs.length < 100) {
      break;
    }
    page += 1;
    if (page > 5) {
      break;
    }
  }
  return items;
}

async function listWorkflowRunsForSha(sha: string): Promise<GithubCheckItem[]> {
  const { data } = await githubFetch<{
    workflow_runs?: Array<{
      name?: string;
      status?: string;
      conclusion?: string | null;
    }>;
  }>(
    "GET",
    `${repoPath()}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=20`,
  );
  return (data.workflow_runs ?? []).map((run) => ({
    name: run.name?.trim() || "CI",
    status: run.status ?? "",
    conclusion: run.conclusion ?? null,
  }));
}

export async function listPullCheckRuns(
  sha: string,
): Promise<GithubCheckItem[]> {
  try {
    const items = await listCommitCheckRuns(sha);
    if (items.length > 0) {
      return items;
    }
  } catch {
    console.error("GitHub check-runs unavailable; falling back to Actions runs");
  }
  return listWorkflowRunsForSha(sha);
}

const MERGE_STATE_ATTEMPTS = 3;
const MERGE_STATE_DELAY_MS = 2000;

export class PullMergeError extends Error {
  readonly kind: "conflict" | "blocked";

  constructor(kind: "conflict" | "blocked") {
    super(
      kind === "conflict"
        ? "mergeable_state is dirty (merge conflict)"
        : "mergeable_state is blocked",
    );
    this.name = "PullMergeError";
    this.kind = kind;
  }
}

export function isPullConflict(error: unknown): boolean {
  if (error instanceof PullMergeError) {
    return error.kind === "conflict";
  }
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("merge conflict") ||
    message.includes("mergeable_state is dirty")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function mergeableState(pull: GithubPull): string {
  const raw = pull.mergeable_state;
  if (typeof raw !== "string") {
    return "unknown";
  }
  const state = raw.trim().toLowerCase();
  return state || "unknown";
}

async function markPullReadyForReview(pull: GithubPull): Promise<void> {
  if (!pull.draft) {
    return;
  }
  if (!pull.node_id) {
    throw new Error("Could not mark the pull request ready for review.");
  }
  const { data } = await githubFetch<{
    data?: {
      markPullRequestReadyForReview?: { pullRequest?: { isDraft?: boolean } };
    };
    errors?: Array<{ message?: string }>;
  }>("POST", "/graphql", {
    query:
      "mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { isDraft } } }",
    variables: { id: pull.node_id },
  });
  const message = readGithubError(data);
  if (data.errors && data.errors.length > 0) {
    console.error(
      `GitHub GraphQL markReady: ${(message || "request failed").slice(0, 80)}`,
    );
    throw new Error(
      message || "Could not mark the pull request ready for review.",
    );
  }
  if (data.data?.markPullRequestReadyForReview?.pullRequest?.isDraft === true) {
    throw new Error("Pull request is still a draft.");
  }
}

export async function mergePullSquash(
  pullNumber: number,
  options?: { pollDelayMs?: number },
): Promise<string | undefined> {
  const delayMs = options?.pollDelayMs ?? MERGE_STATE_DELAY_MS;
  let pull = await getPull(pullNumber);
  if (pull.merged) {
    return pull.merge_commit_sha ?? undefined;
  }
  await markPullReadyForReview(pull);
  const refreshFirst = pull.draft === true;

  // GitHub reports mergeable_state as unknown until it finishes calculating.
  for (let attempt = 1; attempt <= MERGE_STATE_ATTEMPTS; attempt += 1) {
    if (attempt > 1 || refreshFirst) {
      pull = await getPull(pullNumber);
      if (pull.merged) {
        return pull.merge_commit_sha ?? undefined;
      }
    }
    const state = mergeableState(pull);
    if (state === "dirty") {
      throw new PullMergeError("conflict");
    }
    if (state === "blocked") {
      throw new PullMergeError("blocked");
    }
    if (state === "unknown" || state === "draft") {
      if (attempt < MERGE_STATE_ATTEMPTS) {
        await sleep(delayMs);
        continue;
      }
      if (state === "draft") {
        throw new Error("Pull request is still a draft.");
      }
      break;
    }
    break;
  }

  try {
    const { data } = await githubFetch<{ sha?: string }>(
      "PUT",
      `${repoPath()}/pulls/${pullNumber}/merge`,
      { merge_method: "squash" },
    );
    return data.sha;
  } catch (error) {
    try {
      const latest = await getPull(pullNumber);
      if (latest.merged === true) {
        return latest.merge_commit_sha ?? undefined;
      }
    } catch {
      // Keep the original merge error for the Telegram card.
    }
    throw error;
  }
}

export async function closePull(pullNumber: number): Promise<void> {
  await githubFetch("PATCH", `${repoPath()}/pulls/${pullNumber}`, {
    state: "closed",
  });
}

export async function revertMergedPull(
  pullNumber: number,
): Promise<{ ok: true; message: string; mergeSha: string } | { ok: false; mergeSha?: string }> {
  const pull = await getPull(pullNumber);
  const title = pull.title || "merged pull request";
  const mergeSha = pull.merge_commit_sha ?? "";
  if (!mergeSha) {
    return { ok: false };
  }
  try {
    const { data: ref } = await githubFetch<{ object?: { sha?: string } }>(
      "GET",
      `${repoPath()}/git/ref/heads/main`,
    );
    const mainSha = ref.object?.sha ?? "";
    if (!mainSha) {
      return { ok: false, mergeSha };
    }
    if (mainSha !== mergeSha) {
      return { ok: false, mergeSha };
    }
    const { data: mergeCommit } = await githubFetch<{
      parents?: Array<{ sha?: string }>;
    }>("GET", `${repoPath()}/git/commits/${mergeSha}`);
    const parentSha = mergeCommit.parents?.[0]?.sha;
    if (!parentSha) {
      return { ok: false, mergeSha };
    }
    const { data: parentCommit } = await githubFetch<{
      tree?: { sha?: string };
    }>("GET", `${repoPath()}/git/commits/${parentSha}`);
    const treeSha = parentCommit.tree?.sha;
    if (!treeSha) {
      return { ok: false, mergeSha };
    }
    const message = `Revert ${title.replace(/\s+/g, " ").trim()} — undo deploy`;
    const { data: created } = await githubFetch<{ sha?: string }>(
      "POST",
      `${repoPath()}/git/commits`,
      { message, tree: treeSha, parents: [mergeSha] },
    );
    const newSha = created.sha;
    if (!newSha) {
      return { ok: false, mergeSha };
    }
    await githubFetch("PATCH", `${repoPath()}/git/refs/heads/main`, {
      sha: newSha,
      force: false,
    });
    return { ok: true, message, mergeSha };
  } catch {
    return { ok: false, mergeSha };
  }
}
