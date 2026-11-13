/**
 * Working out which release of a piece of software is the latest, from its
 * official release list. Pure logic: no network, no clock, nothing about any
 * one project. `releases.ts` fetches the lists; this file reads them.
 *
 * The rules:
 * - "Latest" is the highest stable version number, not whatever was published
 *   last. A patch on an older line published afterwards is reported as that.
 * - A version marked alpha, beta, rc and so on (by its tag or by GitHub's
 *   prerelease flag) is never the latest stable release.
 * - x.0.0 is a major release, x.y.0 a minor one, x.y.z a patch.
 * - Tags for different packages in one repository are not compared with each
 *   other, and an SDK's version is not the version of the thing it implements.
 */

export type ReleaseKind = "major" | "minor" | "patch" | "dated" | "prerelease";

export interface ParsedVersion {
  /** What comes before the number in the tag, tidied: "" for v1.2.3, "sdk" for sdk-v1.2.3. */
  track: string;
  numbers: number[];
  /** Set when the tag says the version is not final. */
  pre?: { label: string; rank: number; n: number };
  /** A date or a year-first version (2025-06-18, 2024.2) rather than major.minor.patch. */
  dated: boolean;
}

/** One entry of a release list, as published. */
export interface ReleaseEntry {
  tag: string;
  name?: string;
  /** ISO time it was published. */
  publishedAt?: string;
  /** GitHub's own prerelease flag. */
  prerelease?: boolean;
  url?: string;
}

export interface RatedRelease extends ReleaseEntry {
  version: ParsedVersion;
  kind: ReleaseKind;
  /** publishedAt in ms, when known. */
  at?: number;
}

const PRE_WORDS: Array<[RegExp, number]> = [
  [/^(?:dev|nightly|canary|snapshot|experimental|unstable|insiders?)$/, 0],
  [/^(?:alpha|a|pre|preview|next|ea|milestone|m)$/, 1],
  [/^(?:beta|b)$/, 2],
  [/^(?:rc|c|cr)$/, 3],
];

const PRE_SUFFIX =
  /^[-._ ]?(alpha|beta|rc|preview|pre|dev|canary|nightly|next|snapshot|experimental|unstable|insiders?|ea|cr|milestone)(?![a-z])[-._ ]?(\d+)?/i;
/** 3.13.0a1, 1.0b2, 2.0.0-M1: one letter counts only with a number after it. */
const PRE_LETTER = /^[-._]?([abcm])(\d+)(?![\w])/i;

function preOf(suffix: string): ParsedVersion["pre"] {
  const text = suffix.replace(/\+.*$/, "");
  const match = text.match(PRE_SUFFIX) ?? text.match(PRE_LETTER);
  if (!match) {
    return undefined;
  }
  const label = match[1]!.toLowerCase();
  const rank = PRE_WORDS.find(([pattern]) => pattern.test(label))?.[1] ?? 1;
  return { label, rank, n: match[2] ? Number(match[2]) : 0 };
}

function trackOf(prefix: string): string {
  const text = prefix
    .toLowerCase()
    .replace(/v$/, "")
    .replace(/^[-_/@ .]+|[-_/@ .]+$/g, "");
  return /^(?:release|releases|rel|version|ver|stable|tag)$/.test(text) ? "" : text;
}

/**
 * Reads the version out of a tag: v1.0.1, 1.0.0-rc.1, 3.13.0a1, REL_17_2,
 * @scope/pkg@0.3.4, go1.23.4, 2025-06-18. Undefined when there is no version
 * in it (nightly, latest).
 */
export function parseVersion(tag: string): ParsedVersion | undefined {
  const raw = tag.trim();
  if (!raw) {
    return undefined;
  }
  const date = raw.match(/^([^\d]*)(\d{4})-(\d{2})-(\d{2})(.*)$/s);
  if (date) {
    const [year, month, day] = [Number(date[2]), Number(date[3]), Number(date[4])];
    if (year >= 1990 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { track: trackOf(date[1]!), numbers: [year, month, day], pre: preOf(date[5]!), dated: true };
    }
  }
  const found =
    raw.match(/^(.*?)(\d+(?:\.\d+)+)(.*)$/s) ??
    raw.match(/^(.*?)(\d+(?:_\d+)+)(.*)$/s) ??
    raw.match(/^([A-Za-z]*[-_ ]?)(\d+)(.*)$/s);
  if (!found) {
    return undefined;
  }
  const numbers = found[2]!.split(/[._]/).map(Number);
  if (numbers.some((value) => !Number.isSafeInteger(value))) {
    return undefined;
  }
  return {
    track: trackOf(found[1]!),
    numbers,
    pre: preOf(found[3]!),
    dated: numbers[0]! >= 1990 && numbers[0]! <= 2100,
  };
}

/** Negative when a is the older version, positive when it is the newer one. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  const length = Math.max(a.numbers.length, b.numbers.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (a.numbers[i] ?? 0) - (b.numbers[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  if (!a.pre || !b.pre) {
    // 1.0.0 is newer than 1.0.0-rc.1.
    return a.pre ? -1 : b.pre ? 1 : 0;
  }
  return a.pre.rank - b.pre.rank || a.pre.n - b.pre.n;
}

export function kindOf(version: ParsedVersion, flaggedPrerelease = false): ReleaseKind {
  if (flaggedPrerelease || version.pre) {
    return "prerelease";
  }
  if (version.dated) {
    return "dated";
  }
  if (version.numbers.slice(2).some((value) => value > 0)) {
    return "patch";
  }
  return (version.numbers[1] ?? 0) > 0 ? "minor" : "major";
}

export function rateRelease(entry: ReleaseEntry): RatedRelease | undefined {
  const version = parseVersion(entry.tag) ?? (entry.name ? parseVersion(entry.name) : undefined);
  if (!version) {
    return undefined;
  }
  const at = entry.publishedAt ? Date.parse(entry.publishedAt) : NaN;
  return {
    ...entry,
    version,
    kind: kindOf(version, entry.prerelease === true),
    ...(Number.isFinite(at) ? { at } : {}),
  };
}

export interface ReleaseSummary {
  /** Which set of tags was compared ("" when the repository has only one). */
  track: string;
  /** Releases looked at in that set. */
  checked: number;
  /** The highest version that is not a prerelease. */
  latestStable?: RatedRelease;
  /** The stable release published last, when that is not the highest version. */
  newestPublished?: RatedRelease;
  /** The lowest stable version sharing the latest one's first number. */
  lineStart?: RatedRelease;
  /** A prerelease of a version above the latest stable one. */
  newerPrerelease?: RatedRelease;
  /** Highest versions first. */
  recent: RatedRelease[];
  /** Other packages released from the same repository, each with its own latest. */
  otherTracks: Array<{ track: string; latest: RatedRelease }>;
  /** Entries with no version in them (nightly, latest). */
  unversioned: string[];
}

function normal(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function highest(list: RatedRelease[]): RatedRelease | undefined {
  return list.reduce<RatedRelease | undefined>(
    (best, item) => (!best || compareVersions(item.version, best.version) > 0 ? item : best),
    undefined,
  );
}

function pickTrack(rated: RatedRelease[], repoName: string): string {
  const counts = new Map<string, number>();
  for (const item of rated) {
    counts.set(item.version.track, (counts.get(item.version.track) ?? 0) + 1);
  }
  if (counts.size <= 1 || counts.has("")) {
    return counts.size === 1 ? [...counts.keys()][0]! : "";
  }
  const repo = normal(repoName);
  const named = [...counts.keys()].find((track) => normal(track) === repo);
  if (named !== undefined) {
    return named;
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}

/** Compares a release list's versions and dates and says which is which. */
export function summariseReleases(entries: readonly ReleaseEntry[], repoName = ""): ReleaseSummary {
  const rated: RatedRelease[] = [];
  const unversioned: string[] = [];
  for (const entry of entries) {
    const item = rateRelease(entry);
    if (item) {
      rated.push(item);
    } else {
      unversioned.push(entry.tag);
    }
  }
  const track = pickTrack(rated, repoName);
  const mine = rated.filter((item) => item.version.track === track);
  const stable = mine.filter((item) => item.kind !== "prerelease");
  const latestStable = highest(stable);

  const lastPublished = stable.reduce<RatedRelease | undefined>(
    (best, item) => (item.at !== undefined && (!best || item.at > best.at!) ? item : best),
    undefined,
  );
  const newestPublished =
    latestStable && lastPublished && lastPublished !== latestStable && latestStable.at !== undefined && lastPublished.at! > latestStable.at
      ? lastPublished
      : undefined;

  const line = latestStable && !latestStable.version.dated
    ? stable.filter((item) => item.version.numbers[0] === latestStable.version.numbers[0])
    : [];
  const lineStart = line.reduce<RatedRelease | undefined>(
    (best, item) => (!best || compareVersions(item.version, best.version) < 0 ? item : best),
    undefined,
  );

  const topPrerelease = highest(mine.filter((item) => item.kind === "prerelease"));
  const newerPrerelease =
    topPrerelease && (!latestStable || compareVersions(topPrerelease.version, latestStable.version) > 0)
      ? topPrerelease
      : undefined;

  const otherTracks = [...new Set(rated.map((item) => item.version.track))]
    .filter((name) => name !== track)
    .map((name) => {
      const inTrack = rated.filter((item) => item.version.track === name);
      return { track: name, latest: highest(inTrack.filter((item) => item.kind !== "prerelease")) ?? highest(inTrack)! };
    })
    .sort((a, b) => (b.latest.at ?? 0) - (a.latest.at ?? 0))
    .slice(0, 5);

  return {
    track,
    checked: mine.length,
    latestStable,
    newestPublished,
    lineStart,
    newerPrerelease,
    recent: [...mine].sort((a, b) => compareVersions(b.version, a.version)).slice(0, 6),
    otherTracks,
    unversioned: unversioned.slice(0, 5),
  };
}

const DAY = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "long",
  year: "numeric",
});

export function releaseDay(release: Pick<RatedRelease, "at">): string {
  return release.at === undefined ? "date not listed" : DAY.format(new Date(release.at));
}

export function lineName(version: ParsedVersion): string {
  return `${version.numbers[0]}.x`;
}

const KIND_TEXT: Record<ReleaseKind, string> = {
  major: "major release",
  minor: "minor release",
  patch: "patch release",
  dated: "date-versioned release",
  prerelease: "prerelease",
};

export function kindText(release: RatedRelease): string {
  if (release.kind === "prerelease") {
    return release.version.pre ? `prerelease (${release.version.pre.label})` : "prerelease";
  }
  return KIND_TEXT[release.kind];
}

/** The top entry of a changelog: its newest version and the date it gives. */
export function changelogTop(text: string): { version: ParsedVersion; label: string; date?: string } | undefined {
  for (const line of text.split("\n").slice(0, 600)) {
    const heading = line.match(/^\s{0,3}#{1,4}\s+(.+)$/)?.[1];
    if (!heading) {
      continue;
    }
    const plain = heading.replace(/\]\([^)]*\)/g, "]");
    const date = plain.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1];
    const rest = date ? plain.replace(date, " ") : plain;
    const label = rest.match(/v?\d+(?:\.\d+)+[-.\w]*/)?.[0]?.replace(/[\])]+$/, "");
    const version = label ? parseVersion(label) : undefined;
    if (label && version) {
      return { version, label, ...(date ? { date } : {}) };
    }
  }
  return undefined;
}

const SDK_WORD =
  /(?:^|[-_.])(sdks?|clients?|python|py|js|javascript|typescript|ts|node|nodejs|java|kotlin|go|golang|dotnet|csharp|rust|ruby|php|swift|cpp|elixir)(?:$|[-_.])/i;

/** True for a repository named like a client library: a2a-python, typescript-sdk, client-go. */
export function looksLikeSdk(repoName: string): boolean {
  return SDK_WORD.test(repoName);
}

export interface RepoInfo {
  fullName: string;
  name: string;
  owner: string;
  description?: string;
  homepage?: string;
  stars: number;
  fork: boolean;
  archived: boolean;
  defaultBranch?: string;
}

/**
 * The owner's other repositories that are SDKs or client libraries of this
 * project. In an organisation named after the project every SDK-named
 * repository counts; elsewhere it must also carry the project's name.
 */
export function pickSdkRepos(main: RepoInfo, siblings: readonly RepoInfo[], limit = 4): RepoInfo[] {
  const project = normal(main.name);
  const owner = normal(main.owner);
  const dedicated = project.length >= 3 && owner.length >= 3 && (owner.includes(project) || project.includes(owner));
  return siblings
    .filter(
      (repo) =>
        repo.fullName.toLowerCase() !== main.fullName.toLowerCase() &&
        !repo.fork &&
        !repo.archived &&
        looksLikeSdk(repo.name) &&
        (dedicated || (project.length >= 3 && normal(repo.name).includes(project))),
    )
    .sort((a, b) => b.stars - a.stars)
    .slice(0, limit);
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/** "owner/name", a github.com URL or "github.com/owner/name". Nothing else. */
export function parseRepo(input: string): { owner: string; name: string } | undefined {
  const text = input.trim().replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "").replace(/\.git$/i, "");
  const [owner, name] = text.split(/[/?#]/);
  if (!owner || !name || !OWNER.test(owner) || !REPO.test(name) || /^\.+$/.test(name)) {
    return undefined;
  }
  return { owner, name };
}

/**
 * Plainly asking which version or release is the latest. Strict, because the
 * Knowledge Agent takes a message on this alone.
 */
export const RELEASE_QUESTION =
  /\b(?:latest|newest|current|most\s+recent)\b[^.?!\n]{0,60}\b(?:versions?|releases?)\b|\b(?:versions?|releases?)\b[^.?!\n]{0,40}\b(?:latest|newest|current|most\s+recent)\b|\bwh(?:at|ich)(?:'s|\s+is|\s+was)?\s+(?:the\s+)?version\s+(?:of|is)\b|\b(?:changelog|release\s+notes)\b/i;

/** Looser wording that is still about a release: "new release", "is 2.1 out yet". */
const ABOUT_A_RELEASE =
  /\b(?:last|recent|new)\b[^.?!\n]{0,40}\b(?:versions?|releases?)\b|\b(?:versions?|releases?)\b[^.?!\n]{0,40}\b(?:out\s+yet|is\s+out|came\s+out)\b|\b(?:v\d+|\d+\.\d+(?:\.\d+)*|version\s+\d+)\b[^.?!\n]{0,30}\b(?:released|out|available|shipped)\b/i;
const NOT_SOFTWARE = /\b(?:press|news|media)\s+releases?\b/i;

/** "What's the latest version of X?", "has X 2.0 been released?", "latest X release". */
export function isReleaseQuestion(text: string): boolean {
  return (RELEASE_QUESTION.test(text) || ABOUT_A_RELEASE.test(text)) && !NOT_SOFTWARE.test(text);
}

/** GitHub repositories that appear in a set of URLs, most-mentioned first. */
export function reposInUrls(urls: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const url of urls) {
    const match = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+)/i);
    const repo = match ? parseRepo(`${match[1]}/${match[2]}`) : undefined;
    if (repo && !/^(?:orgs|topics|search|features|sponsors|marketplace|about)$/i.test(repo.owner)) {
      const key = `${repo.owner}/${repo.name}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
}

/** A project's own release list or changelog on GitHub, as opposed to a page about it. */
export function isReleasePage(url: string): boolean {
  return /^https?:\/\/(?:www\.)?github\.com\/[^/]+\/[^/]+\/(?:releases|tags)\b|^https?:\/\/(?:www\.)?github\.com\/[^/]+\/[^/]+\/blob\/[^?#]*\b(?:CHANGELOG|CHANGES|RELEASES?|HISTORY)\b/i.test(url);
}

/** Search hits with the project's own release pages first, the rest in their original order. */
export function releasePagesFirst<T extends { url: string }>(hits: readonly T[]): T[] {
  return [...hits.filter((hit) => isReleasePage(hit.url)), ...hits.filter((hit) => !isReleasePage(hit.url))];
}

/** Added to a web search result when the question was about a release. */
export function releaseSearchNote(urls: readonly string[]): string {
  const repos = reposInUrls(urls).slice(0, 3);
  return [
    "RELEASE QUESTION: these are search results, and articles about a release are often older than the newest release.",
    "If this is about software or a protocol, do not name a latest version from them alone. Call latest_release, which reads the project's official release list and compares versions and dates.",
    repos.length > 0
      ? `GitHub repositories in these results: ${repos.join(", ")}. Pass the official one as repo.`
      : "Pass repo if you know the project's official repository, or just the project name to get candidates.",
    "If the project is not on GitHub, answer only from the vendor's own release notes, changelog or documentation, give the version and its date, and say so when all you have is a third-party page.",
  ].join("\n");
}

export interface ReleaseReport {
  /** The project as Vishnu named it. */
  project: string;
  repo: RepoInfo;
  /** The repository that was asked for, when it has since moved. */
  askedRepo?: string;
  /** Where the versions came from. */
  from: "releases" | "tags";
  /** True when the list was cut at the most recent `limit` entries. */
  truncated: boolean;
  summary: ReleaseSummary;
  changelog?: { file: string; url: string; label: string; version: ParsedVersion; date?: string };
  sdks: Array<{ repo: RepoInfo; summary: ReleaseSummary }>;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function dated(release: RatedRelease): string {
  return release.at === undefined ? release.tag : `${release.tag}, published ${releaseDay(release)}`;
}

function changelogLine(report: ReleaseReport): string | undefined {
  const { changelog, summary } = report;
  if (!changelog) {
    return undefined;
  }
  const entry = `${changelog.file}'s top entry is ${changelog.label}${changelog.date ? ` (dated ${changelog.date})` : ""}`;
  const against = changelog.version.pre ? summary.newerPrerelease ?? summary.latestStable : summary.latestStable;
  if (!against) {
    return `Changelog: ${entry}.`;
  }
  const order = compareVersions({ ...changelog.version, track: "" }, { ...against.version, track: "" });
  if (order === 0) {
    return `Changelog: ${entry}, which matches the release list.`;
  }
  return order > 0
    ? `Changelog: ${entry}, which is newer than any published release. It may not be released yet: say so rather than calling it the latest release.`
    : `Changelog: ${entry}, which is behind the release list. The release list is the newer of the two.`;
}

function sdkLine(sdk: ReleaseReport["sdks"][number]): string {
  const { latestStable, newerPrerelease } = sdk.summary;
  if (!latestStable && !newerPrerelease) {
    return `- ${sdk.repo.fullName}: no versioned releases`;
  }
  const parts = [
    latestStable ? `latest stable ${dated(latestStable)}` : "no stable release yet",
    ...(newerPrerelease ? [`newer prerelease ${dated(newerPrerelease)}`] : []),
  ];
  return `- ${sdk.repo.fullName}: ${parts.join("; ")}`;
}

/** The tool result: what the release list shows, in words the model repeats rather than works out. */
export function formatReleaseReport(report: ReleaseReport): string {
  const { repo, summary } = report;
  const { latestStable, lineStart, newerPrerelease, newestPublished } = summary;
  const source = report.from === "releases" ? "its GitHub Releases" : "its git tags (it publishes no GitHub Releases)";
  const lines: string[] = [
    `Release check ok: ${repo.fullName}, from ${source} (${summary.checked} compared${report.truncated ? ", the most recent only" : ""}).`,
    `Repository: ${repo.fullName}, ${repo.stars.toLocaleString("en-US")} stars.${repo.description ? ` "${clip(repo.description, 160)}"` : ""}${repo.homepage ? ` Project site: ${clip(repo.homepage, 120)}` : ""}`,
  ];
  if (report.askedRepo && report.askedRepo.toLowerCase() !== repo.fullName.toLowerCase()) {
    lines.push(`Note: ${report.askedRepo} now lives at ${repo.fullName}.`);
  }
  const warnings = [
    ...(repo.fork ? ["it is a fork, not the original project"] : []),
    ...(repo.archived ? ["it is archived, so no longer maintained here"] : []),
    ...(looksLikeSdk(repo.name)
      ? ["it is named like an SDK or client library, so these are the library's versions, not the version of the protocol or product it implements"]
      : []),
  ];
  if (warnings.length > 0) {
    lines.push(`Warning about this repository: ${warnings.join("; ")}.`);
  }
  lines.push("");

  if (latestStable) {
    const line = lineName(latestStable.version);
    const onLine = latestStable.version.dated ? "" : ` on the ${line} line`;
    lines.push(`Latest stable release: ${dated(latestStable)}. It is a ${kindText(latestStable)}${onLine}.`);
    if (!latestStable.version.dated) {
      if (latestStable.version.numbers[0] === 0) {
        lines.push("Latest major release: none. The project is still on 0.x versions, with no 1.0 yet.");
      } else if (latestStable.kind === "major") {
        lines.push(`Latest major release: the same one, ${latestStable.tag}, the first release of the ${line} line.`);
      } else if (lineStart && lineStart.kind === "major") {
        lines.push(`Latest major release: ${dated(lineStart)}, the first release of the ${line} line.`);
      } else {
        lines.push(`Latest major release: the ${line} line; its first release is not among the releases compared.`);
      }
    }
  } else {
    lines.push("Latest stable release: none. Nothing here is marked as a stable release.");
  }
  lines.push(
    newerPrerelease
      ? `Newer prerelease: ${dated(newerPrerelease)} (${kindText(newerPrerelease)}). It is not a stable release.`
      : `Prerelease: none newer than ${latestStable?.tag ?? "the versions above"}.`,
  );
  if (newestPublished && latestStable) {
    const older = newestPublished.version.dated ? "" : ` on the older ${lineName(newestPublished.version)} line`;
    lines.push(
      `Published most recently: ${dated(newestPublished)}, a ${kindText(newestPublished)}${older}. It is newer by date but a lower version, so it is not the latest release.`,
    );
  }
  const changelog = changelogLine(report);
  if (changelog) {
    lines.push(changelog);
  }

  lines.push("", "Versions compared, highest first:");
  for (const release of summary.recent) {
    lines.push(`- ${release.tag}: ${releaseDay(release)}, ${kindText(release)}`);
  }
  if (summary.otherTracks.length > 0) {
    lines.push(
      "",
      "Other packages released from this repository (separate version numbers, not compared with the above):",
      ...summary.otherTracks.map((other) => `- ${other.track}: ${dated(other.latest)}, ${kindText(other.latest)}`),
    );
  }
  if (report.sdks.length > 0) {
    lines.push(
      "",
      `SDKs and client libraries (each has its own version numbers; none of them is the version of ${report.project}):`,
      ...report.sdks.map(sdkLine),
    );
  }

  lines.push(
    "",
    "When you answer: give the latest stable release and its date exactly as above. Call it a major release only if it says so above; otherwise name the latest major release separately. Mention a prerelease only as a prerelease. Never give an SDK's version as the version of the project itself. If search results or your own memory disagree with this list, the list is right: say what it shows.",
  );

  const sources: string[] = [];
  if (latestStable?.url) {
    sources.push(`${repo.fullName} ${latestStable.tag} release | ${latestStable.url}`);
  } else {
    sources.push(`${repo.fullName} releases | https://github.com/${repo.fullName}/${report.from === "releases" ? "releases" : "tags"}`);
  }
  if (report.changelog) {
    sources.push(`${repo.fullName} ${report.changelog.file} | ${report.changelog.url}`);
  }
  lines.push("", `---sources---\n${sources.join("\n")}\n---end---`);
  return lines.join("\n");
}

/** Shown when the repository wasn't named: the model picks, the tool never guesses. */
export function formatRepoCandidates(project: string, candidates: readonly RepoInfo[]): string {
  if (candidates.length === 0) {
    return `Not checked: GitHub has no repository matching "${clip(project, 60)}". If the project has an official repository, call latest_release again with repo set to it. If it is not on GitHub, use web_search and answer only from the vendor's own release notes, changelog or documentation.`;
  }
  const rows = candidates.map((repo, index) => {
    const flags = [...(repo.fork ? ["fork"] : []), ...(repo.archived ? ["archived"] : [])];
    return `${index + 1}. ${repo.fullName}, ${repo.stars.toLocaleString("en-US")} stars${flags.length > 0 ? ` (${flags.join(", ")})` : ""}${repo.description ? `: "${clip(repo.description, 120)}"` : ""}${repo.homepage ? ` Site: ${clip(repo.homepage, 100)}` : ""}`;
  });
  return [
    `Not checked yet: no repository was named for "${clip(project, 60)}", and the most popular match is not always the official one. GitHub's closest matches:`,
    ...rows,
    "Call latest_release again with repo set to the project's official repository (the one its own site or documentation links to). It need not be in this list. If the project is not on GitHub, use web_search and answer only from the vendor's own release notes, changelog or documentation.",
  ].join("\n");
}
