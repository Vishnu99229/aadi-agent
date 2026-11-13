/**
 * Looks up a project's official release list on GitHub and reports which
 * release is the latest. The comparing is done in release_logic.ts.
 *
 * Public data only: requests go to api.github.com and raw.githubusercontent.com
 * with no token, for a repository named as owner/name. Nothing is written
 * anywhere. Only metadata is logged.
 */
import {
  changelogTop,
  formatReleaseReport,
  formatRepoCandidates,
  parseRepo,
  pickSdkRepos,
  summariseReleases,
  type ReleaseEntry,
  type ReleaseReport,
  type ReleaseSummary,
  type RepoInfo,
} from "./release_logic.js";
import { assertTestSeam } from "./test_seam.js";

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";
const TIMEOUT_MS = 12_000;
const CACHE_MS = 10 * 60_000;
const LIST_LIMIT = 100;
const CHANGELOG_BYTES = 64 * 1024;
const CHANGELOG_FILES = ["CHANGELOG.md", "CHANGES.md"];

export interface FetchedPage {
  status: number;
  body: string;
  /** GitHub refused because the hourly allowance is used up. */
  rateLimited?: boolean;
}

export type ReleaseFetch = (url: string) => Promise<FetchedPage> | FetchedPage;

let testFetch: ReleaseFetch | undefined;
const cache = new Map<string, { at: number; page: FetchedPage }>();

export function setReleaseFetchForTests(fetcher: ReleaseFetch | undefined): void {
  assertTestSeam("setReleaseFetchForTests");
  testFetch = fetcher;
  cache.clear();
}

async function readUpTo(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  return Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8");
}

async function fetchPage(url: string): Promise<FetchedPage> {
  const isApi = url.startsWith(`${API}/`);
  const response = await fetch(url, {
    headers: {
      "User-Agent": "aadi-agent",
      ...(isApi ? { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } : {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = isApi ? await response.text() : await readUpTo(response, CHANGELOG_BYTES);
  return {
    status: response.status,
    body,
    rateLimited: response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0"),
  };
}

class RateLimited extends Error {}

async function get(url: string): Promise<FetchedPage> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return hit.page;
  }
  const page = await (testFetch ?? fetchPage)(url);
  if (page.rateLimited) {
    throw new RateLimited();
  }
  if (page.status === 200) {
    cache.set(url, { at: Date.now(), page });
  }
  return page;
}

/** Parsed JSON, or undefined when GitHub says there is no such thing. */
async function getJson(path: string): Promise<unknown> {
  const page = await get(`${API}${path}`);
  if (page.status === 404 || page.status === 451) {
    return undefined;
  }
  if (page.status !== 200) {
    throw new Error(`GitHub returned ${page.status}.`);
  }
  try {
    return JSON.parse(page.body) as unknown;
  } catch {
    throw new Error("GitHub returned something unreadable.");
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function repoInfo(value: unknown): RepoInfo | undefined {
  const row = value as Record<string, unknown> | null;
  const fullName = text(row?.full_name);
  const name = text(row?.name);
  const owner = text((row?.owner as Record<string, unknown> | undefined)?.login);
  if (!fullName || !name || !owner || row?.private === true) {
    return undefined;
  }
  return {
    fullName,
    name,
    owner,
    description: text(row?.description),
    homepage: text(row?.homepage),
    stars: typeof row?.stargazers_count === "number" ? row.stargazers_count : 0,
    fork: row?.fork === true,
    archived: row?.archived === true,
    defaultBranch: text(row?.default_branch),
  };
}

function rows(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value.filter((item) => item && typeof item === "object") as Array<Record<string, unknown>>) : [];
}

async function listReleases(fullName: string): Promise<ReleaseEntry[]> {
  const list = rows(await getJson(`/repos/${fullName}/releases?per_page=${LIST_LIMIT}`));
  return list
    .filter((row) => row.draft !== true && text(row.tag_name))
    .map((row) => ({
      tag: text(row.tag_name)!,
      name: text(row.name),
      publishedAt: text(row.published_at) ?? text(row.created_at),
      prerelease: row.prerelease === true,
      url: text(row.html_url),
    }));
}

/** Tags carry no dates, so only the ones the answer names are dated, from their commits. */
async function listTags(fullName: string): Promise<{ entries: ReleaseEntry[]; summary: ReleaseSummary }> {
  const list = rows(await getJson(`/repos/${fullName}/tags?per_page=${LIST_LIMIT}`));
  const shas = new Map<string, string>();
  const entries: ReleaseEntry[] = [];
  for (const row of list) {
    const tag = text(row.name);
    if (!tag) {
      continue;
    }
    const sha = text((row.commit as Record<string, unknown> | undefined)?.sha);
    if (sha) {
      shas.set(tag, sha);
    }
    entries.push({ tag, url: `https://github.com/${fullName}/releases/tag/${encodeURIComponent(tag)}` });
  }
  const first = summariseReleases(entries, fullName.split("/")[1]);
  const named = [first.latestStable, first.lineStart, first.newerPrerelease].filter((item) => item !== undefined);
  await Promise.all(
    [...new Set(named.map((item) => item.tag))].map(async (tag) => {
      const sha = shas.get(tag);
      if (!sha) {
        return;
      }
      try {
        const commit = (await getJson(`/repos/${fullName}/commits/${sha}`)) as
          | { commit?: { committer?: { date?: unknown } } }
          | undefined;
        const date = text(commit?.commit?.committer?.date);
        const entry = entries.find((item) => item.tag === tag);
        if (date && entry) {
          entry.publishedAt = date;
        }
      } catch {
        // The version still stands without its date.
      }
    }),
  );
  return { entries, summary: summariseReleases(entries, fullName.split("/")[1]) };
}

async function readChangelog(repo: RepoInfo): Promise<ReleaseReport["changelog"]> {
  for (const file of CHANGELOG_FILES) {
    try {
      const page = await get(`${RAW}/${repo.fullName}/HEAD/${file}`);
      if (page.status !== 200) {
        continue;
      }
      const top = changelogTop(page.body);
      if (top) {
        return {
          file,
          url: `https://github.com/${repo.fullName}/blob/${repo.defaultBranch ?? "HEAD"}/${file}`,
          label: top.label,
          version: top.version,
          date: top.date,
        };
      }
    } catch {
      // The changelog is a cross-check; the release list stands without it.
    }
  }
  return undefined;
}

async function sdkVersions(main: RepoInfo): Promise<ReleaseReport["sdks"]> {
  let siblings: RepoInfo[];
  try {
    siblings = rows(await getJson(`/users/${main.owner}/repos?per_page=${LIST_LIMIT}&sort=pushed`))
      .map(repoInfo)
      .filter((repo) => repo !== undefined);
  } catch {
    return [];
  }
  const found = await Promise.all(
    pickSdkRepos(main, siblings).map(async (repo) => {
      try {
        return { repo, summary: summariseReleases(await listReleases(repo.fullName), repo.name) };
      } catch {
        return undefined;
      }
    }),
  );
  return found.filter((item) => item !== undefined);
}

const RATE_LIMITED =
  "Not checked: GitHub's hourly lookup allowance is used up, so the release list could not be read. Try again later. If you answer from web_search instead, use only the project's own release notes or changelog and say the release list itself was not checked.";

/**
 * The tool's whole job. Returns text for the model: the release report, or a
 * line starting "Not checked" that says why and what to do next.
 */
export async function checkLatestRelease(input: { project: string; repo?: string }): Promise<string> {
  const project = input.project.trim();
  const startedAt = Date.now();
  const log = (status: string, extra = "") =>
    console.log(`latest_release: status=${status}${extra} ms=${Date.now() - startedAt}`);
  try {
    if (!input.repo?.trim()) {
      const found = (await getJson(`/search/repositories?q=${encodeURIComponent(project.slice(0, 80))}&per_page=5`)) as
        | { items?: unknown }
        | undefined;
      const candidates = rows(found?.items).map(repoInfo).filter((repo) => repo !== undefined);
      log("candidates", ` count=${candidates.length}`);
      return formatRepoCandidates(project, candidates);
    }
    const asked = parseRepo(input.repo);
    if (!asked) {
      log("bad_repo");
      return 'Not checked: repo must be a GitHub repository written as owner/name (for example "nodejs/node") or its github.com URL.';
    }
    const askedName = `${asked.owner}/${asked.name}`;
    const repo = repoInfo(await getJson(`/repos/${askedName}`));
    if (!repo) {
      log("no_repo");
      return `Not checked: there is no public GitHub repository called ${askedName}. Call latest_release with only the project name to see candidates, or use web_search to find the official repository first.`;
    }

    let from: ReleaseReport["from"] = "releases";
    let entries = await listReleases(repo.fullName);
    let summary = summariseReleases(entries, repo.name);
    if (summary.checked === 0) {
      from = "tags";
      ({ entries, summary } = await listTags(repo.fullName));
    }
    if (summary.checked === 0) {
      log("no_versions", ` repo=${repo.fullName}`);
      return `Not checked: ${repo.fullName} publishes no versioned releases or tags on GitHub${repo.homepage ? ` (its site is ${repo.homepage})` : ""}. Use web_search and answer only from the project's own release notes, changelog or documentation.`;
    }
    const [changelog, sdks] = await Promise.all([readChangelog(repo), sdkVersions(repo)]);
    log("ok", ` repo=${repo.fullName} from=${from} compared=${summary.checked} sdks=${sdks.length}`);
    return formatReleaseReport({
      project,
      repo,
      askedRepo: askedName,
      from,
      truncated: entries.length >= LIST_LIMIT,
      summary,
      changelog,
      sdks,
    });
  } catch (error) {
    if (error instanceof RateLimited) {
      log("rate_limited");
      return RATE_LIMITED;
    }
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    log(timedOut ? "timeout" : "error");
    return `Not checked: ${timedOut ? "GitHub did not answer in time" : "GitHub could not be reached"}. The release list was not read, so do not name a latest version from memory.`;
  }
}
