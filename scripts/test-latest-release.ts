/**
 * "What's the latest release of X?" is answered from X's official release
 * list, with versions and dates compared in code.
 *
 * Every project here is invented, and each check is run on more than one
 * release history, so nothing depends on one project or one version number.
 * The GitHub API and the search providers are fakes; the tools, the agent loop
 * and the routing are the real ones, with a scripted model.
 */
import "dotenv/config";
import { setToolInterceptorForTests } from "../src/agent.ts";
import { localSpecialists, specialistFor } from "../src/agents/index.ts";
import { pickRoute, runOwnerTurn, type Route } from "../src/agents/orchestrator.ts";
import { allToolOwnership } from "../src/agents/registry.ts";
import { setCompleteForTests, type CompleteParams } from "../src/llm.ts";
import { isSuccessfulToolResult, receiptFailureMessage, unreceiptedClaims } from "../src/receipt.ts";
import {
  changelogTop,
  compareVersions,
  isReleaseQuestion,
  kindOf,
  looksLikeSdk,
  parseRepo,
  parseVersion,
  pickSdkRepos,
  releasePagesFirst,
  reposInUrls,
  summariseReleases,
  type ReleaseEntry,
  type RepoInfo,
} from "../src/release_logic.ts";
import { checkLatestRelease, setReleaseFetchForTests, type FetchedPage } from "../src/releases.ts";
import { FORWARDED_TOOLS, tools } from "../src/tools/index.ts";
import { formatSearchToolResult, setSearchProvidersForTests } from "../src/web_search.ts";
import { modelReply, nextMessageId } from "./fakes.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

if (process.env.AADI_DB_PATH !== ":memory:") {
  throw new Error("test-latest-release.ts must run with AADI_DB_PATH=:memory:");
}

const log = console.log;
console.log = () => undefined;
console.error = () => undefined;
const ok = (line: string) => log(`ok  ${line}`);

// ---------------------------------------------------------------- versions

const kind = (tag: string, flagged = false) => kindOf(parseVersion(tag)!, flagged);
const numbers = (tag: string) => parseVersion(tag)?.numbers.join(".");

assert(numbers("v1.0.1") === "1.0.1" && numbers("1.0.1") === "1.0.1" && numbers("release-2.4.0") === "2.4.0", "plain and prefixed tags");
assert(numbers("REL_17_2") === "17.2" && numbers("curl-8_11_0") === "8.11.0" && numbers("go1.23.4") === "1.23.4", "underscore and name-prefixed tags");
assert(numbers("@lumen/sdk@0.3.4") === "0.3.4" && parseVersion("@lumen/sdk@0.3.4")?.track === "lumen/sdk", "a package tag keeps its package name apart from its number");
assert(parseVersion("v1.0.1")?.track === "" && parseVersion("release-2.4.0")?.track === "" && parseVersion("REL_17_2")?.track === "", "v, release- and REL_ are not package names");
assert(numbers("2025-06-18") === "2025.6.18" && kind("2025-06-18") === "dated" && kind("2024.2.1") === "dated", "date and year-first versions are date-versioned, not major or patch");
assert(parseVersion("nightly") === undefined && parseVersion("latest") === undefined, "a tag with no number has no version");
assert(kind("v2.0.0") === "major" && kind("v2.3.0") === "minor" && kind("v2.3.4") === "patch" && kind("v3.0") === "major" && kind("17.2") === "minor", "major, minor and patch");
for (const tag of ["1.0.0-rc.1", "v2.0.0-beta.2", "3.13.0a1", "1.0b2", "2.0.0-M1", "1.2.0-alpha", "v4.0.0-preview.3", "1.5.0-dev.20260101", "REL_18_BETA1", "5.0.0-canary.7", "2.0.0-SNAPSHOT", "v1.0.0-next.4"]) {
  assert(kind(tag) === "prerelease", `${tag} is a prerelease by its tag`);
}
for (const tag of ["v1.2.3", "1.2.3.post1", "1.2.3+build.5", "v1.2.3-lts", "4.0.0.RELEASE", "1.2.3-a11y", "1.2.3-b4f2a1c"]) {
  assert(kind(tag) !== "prerelease", `${tag} is not a prerelease`);
}
assert(kind("v3.0.0", true) === "prerelease", "GitHub's prerelease flag makes a plain tag a prerelease");
const order = ["0.9.0", "0.10.0", "1.0.0-alpha.1", "1.0.0-beta.1", "1.0.0-rc.1", "1.0.0-rc.2", "1.0.0", "1.0.1", "1.1.0", "2.0.0"];
for (let i = 1; i < order.length; i += 1) {
  assert(compareVersions(parseVersion(order[i - 1]!)!, parseVersion(order[i]!)!) < 0, `${order[i - 1]} is older than ${order[i]}`);
}
assert(compareVersions(parseVersion("v1.0")!, parseVersion("1.0.0")!) === 0, "1.0 and 1.0.0 are the same version");
ok("versions: tags in ten styles are read as numbers; 0.10 > 0.9; alpha < beta < rc < final; major, minor, patch, prerelease and date-versioned are told apart");

// ---------------------------------------------------------------- release lists

const rel = (tag: string, date: string, extra: Partial<ReleaseEntry> = {}): ReleaseEntry => ({
  tag,
  name: tag,
  publishedAt: `${date}T12:00:00Z`,
  prerelease: false,
  url: `https://github.com/lumenproto/lumen/releases/tag/${tag}`,
  ...extra,
});

/** A history shaped like a real one: early 0.x tags published out of order, then 1.0.0, then a patch. */
const history: ReleaseEntry[] = [
  rel("v1.0.1", "2026-05-28"),
  rel("v1.0.0", "2026-03-12"),
  rel("v0.3.0", "2025-07-30"),
  rel("v0.2.2", "2025-06-09"),
  rel("v0.2.0", "2025-06-10"),
  rel("v0.1.0", "2025-06-11"),
];

let summary = summariseReleases(history, "lumen");
assert(summary.latestStable?.tag === "v1.0.1" && summary.latestStable.kind === "patch", `the patch after the major is the latest stable release (${summary.latestStable?.tag})`);
assert(summary.lineStart?.tag === "v1.0.0" && summary.lineStart.kind === "major", "and the major release is the x.0.0 that began its line");
assert(summary.newerPrerelease === undefined && summary.newestPublished === undefined, "with no prerelease and nothing newer by date");
ok("patch after a major: latest stable is the patch (v1.0.1), latest major is v1.0.0; the two are not confused");

// The same code, later histories: nothing is tied to one version.
const later: Array<[ReleaseEntry, string, string, string]> = [
  [rel("v1.0.2", "2026-08-01"), "v1.0.2", "patch", "v1.0.0"],
  [rel("v1.1.0", "2026-09-15"), "v1.1.0", "minor", "v1.0.0"],
  [rel("v1.1.1", "2026-10-02"), "v1.1.1", "patch", "v1.0.0"],
  [rel("v2.0.0", "2027-01-20"), "v2.0.0", "major", "v2.0.0"],
  [rel("v2.0.1", "2027-02-03"), "v2.0.1", "patch", "v2.0.0"],
];
const growing = [...history];
for (const [added, latest, itsKind, major] of later) {
  growing.unshift(added);
  summary = summariseReleases(growing, "lumen");
  assert(summary.latestStable?.tag === latest && summary.latestStable.kind === itsKind, `after ${added.tag}: latest stable is ${latest}, a ${itsKind} (got ${summary.latestStable?.tag} ${summary.latestStable?.kind})`);
  assert(summary.lineStart?.tag === major, `after ${added.tag}: the latest major release is ${major} (got ${summary.lineStart?.tag})`);
}
ok("future releases: as v1.0.2, v1.1.0, v1.1.1, v2.0.0 and v2.0.1 are published, the latest stable and latest major follow the list");

// A patch on an old line published after the newest version.
summary = summariseReleases([rel("v0.3.1", "2026-06-20"), ...history], "lumen");
assert(summary.latestStable?.tag === "v1.0.1", `a later backport is not the latest release (${summary.latestStable?.tag})`);
assert(summary.newestPublished?.tag === "v0.3.1", "it is reported as published most recently");
ok("dates versus versions: v0.3.1 published after v1.0.1 is reported as the most recent by date, and v1.0.1 stays the latest version");

// Prereleases.
summary = summariseReleases([rel("v2.0.0-rc.1", "2026-07-01", { prerelease: true }), rel("v1.0.0-rc.3", "2026-03-01", { prerelease: true }), ...history], "lumen");
assert(summary.latestStable?.tag === "v1.0.1" && summary.newerPrerelease?.tag === "v2.0.0-rc.1", "a release candidate of the next major is a newer prerelease, not the latest release");
summary = summariseReleases([rel("v1.1.0-beta.1", "2026-07-01", { prerelease: false }), ...history], "lumen");
assert(summary.latestStable?.tag === "v1.0.1" && summary.newerPrerelease?.tag === "v1.1.0-beta.1", "a beta is a prerelease even when GitHub's flag was left off");
summary = summariseReleases([rel("v1.1.0", "2026-07-01", { prerelease: true }), ...history], "lumen");
assert(summary.latestStable?.tag === "v1.0.1" && summary.newerPrerelease?.tag === "v1.1.0", "a plain tag flagged as a prerelease on GitHub is a prerelease");
summary = summariseReleases([rel("v1.0.0-rc.3", "2026-03-01", { prerelease: true }), ...history], "lumen");
assert(summary.newerPrerelease === undefined, "a release candidate of a version already released is not reported as newer");
summary = summariseReleases([rel("v0.1.0-alpha.2", "2026-02-01", { prerelease: true }), rel("v0.1.0-alpha.1", "2026-01-01", { prerelease: true })], "newthing");
assert(summary.latestStable === undefined && summary.newerPrerelease?.tag === "v0.1.0-alpha.2", "a project with only prereleases has no stable release");
ok("prereleases: rc, beta and flagged releases are never the latest stable release, by tag or by GitHub's flag; an rc of a released version is not news");

// Several packages released from one repository.
summary = summariseReleases([rel("sdk-v3.2.0", "2026-06-01"), rel("v1.0.1", "2026-05-28"), rel("sdk-v3.1.0", "2026-04-01"), rel("v1.0.0", "2026-03-12")], "lumen");
assert(summary.latestStable?.tag === "v1.0.1", `an SDK tag with a higher number is not the project's version (${summary.latestStable?.tag})`);
assert(summary.otherTracks.length === 1 && summary.otherTracks[0]!.track === "sdk" && summary.otherTracks[0]!.latest.tag === "sdk-v3.2.0", "it is listed as a separate package");
summary = summariseReleases([rel("2025-11-25", "2025-11-25"), rel("2025-06-18", "2025-06-18"), rel("2025-03-26", "2025-03-26")], "spec");
assert(summary.latestStable?.tag === "2025-11-25" && summary.latestStable.kind === "dated" && summary.lineStart === undefined, "a date-versioned project has a latest release but no major or patch");
summary = summariseReleases([rel("v0.10.0", "2026-02-01"), rel("v0.9.3", "2026-01-01")], "young");
assert(summary.latestStable?.tag === "v0.10.0" && summary.latestStable.kind === "minor", "0.10.0 is newer than 0.9.3");
ok("other shapes: SDK tags in the same repository are a separate package; date-versioned and 0.x projects are handled");

// ---------------------------------------------------------------- changelogs, SDKs, repositories

assert(changelogTop("# Changelog\n\n## [1.0.1](https://github.com/x/y/compare/v1.0.0...v1.0.1) (2026-05-26)\n\n### Bug Fixes\n\n## [1.0.0](https://x) (2026-03-12)")?.label === "1.0.1", "release-please heading");
assert(changelogTop("# Changelog\n\n## [Unreleased]\n\n## [2.3.0] - 2026-01-05\n\n## [2.2.9] - 2025-12-01")?.label === "2.3.0", "keep-a-changelog skips Unreleased");
const plain = changelogTop("Changes\n=======\n\n## v4.1.0-rc.1 (2026-02-02)\n\n## v4.0.3");
assert(plain?.label === "v4.1.0-rc.1" && plain.date === "2026-02-02" && plain.version.pre?.label === "rc", "a prerelease heading with its date");
assert(changelogTop("# Notes\n\nNothing versioned here.\n\n## 1. Introduction") === undefined, "no versions, no entry");

assert(["lumen-python", "typescript-sdk", "client-go", "lumen.js", "lumen-dotnet"].every(looksLikeSdk), "SDK-style names");
assert(!["lumen", "lumen-samples", "website", "kubernetes", "pygments"].some(looksLikeSdk), "names that are not SDKs");
const repo = (fullName: string, extra: Partial<RepoInfo> = {}): RepoInfo => ({
  fullName,
  owner: fullName.split("/")[0]!,
  name: fullName.split("/")[1]!,
  stars: 10,
  fork: false,
  archived: false,
  ...extra,
});
const picked = pickSdkRepos(repo("lumenproto/lumen"), [
  repo("lumenproto/lumen"),
  repo("lumenproto/lumen-python", { stars: 900 }),
  repo("lumenproto/typescript-sdk", { stars: 500 }),
  repo("lumenproto/lumen-samples", { stars: 5000 }),
  repo("lumenproto/lumen-go", { fork: true }),
  repo("lumenproto/lumen-java", { archived: true }),
]).map((item) => item.name);
assert(picked.join(",") === "lumen-python,typescript-sdk", `SDKs in the project's own organisation (${picked.join(",")})`);
const bigOrg = pickSdkRepos(repo("megacorp/lumen"), [repo("megacorp/lumen-python"), repo("megacorp/python-sdk"), repo("megacorp/other-js")]).map((item) => item.name);
assert(bigOrg.join(",") === "lumen-python", `in a shared organisation an SDK must carry the project's name (${bigOrg.join(",")})`);

assert(parseRepo("nodejs/node")?.owner === "nodejs" && parseRepo("https://github.com/lumenproto/lumen/releases/tag/v1")?.name === "lumen" && parseRepo("github.com/a/b.git")?.name === "b", "owner/name and github.com URLs");
for (const bad of ["lumen", "https://evil.example/a/b", "a/..", "../../etc/passwd", "a b/c", "api.github.com/x", ""]) {
  assert(parseRepo(bad) === undefined, `"${bad}" is not a repository`);
}
ok("changelogs in three formats; SDK repositories picked by name and organisation; only owner/name on github.com is accepted as a repository");

// ---------------------------------------------------------------- wording and routing

for (const text of [
  "Search the web for the latest A2A protocol release",
  "What's the latest version of Kubernetes?",
  "which is the current stable release of Node.js",
  "what version of React is the newest",
  "Is Postgres 18.1 out yet?",
  "has TypeScript 6.0 been released",
  "show me the changelog for Bun",
]) {
  assert(isReleaseQuestion(text), `"${text}" is a release question`);
}
for (const text of ["Has the client released the payment?", "draft a press release about the latest funding", "what's the latest on the Acme deal", "who won the match yesterday", "release the hold on my Thursday slot"]) {
  assert(!isReleaseQuestion(text), `"${text}" is not a release question`);
}
const routeOf = (text: string) => {
  const route = pickRoute(text, { mode: "full" });
  return route.kind === "specialist" ? route.agentId : route.kind;
};
for (const text of ["What's the latest version of Kubernetes?", "which is the current stable release of Node.js", "Search the web for the latest A2A protocol release", "what is the newest release of the MCP spec"]) {
  assert(routeOf(text) === "knowledge", `"${text}" goes to the Knowledge Agent (got ${routeOf(text)})`);
}
assert(routeOf("Has the client released the payment?") !== "knowledge", "a payment being released is not a Knowledge Agent question");
assert(routeOf("email Priya the latest version of the pricing sheet") !== "knowledge", "a request that also sends stays with Aadi");
const knowledge = specialistFor("knowledge")!;
assert(knowledge.toolNames().includes("latest_release") && knowledge.toolNames().includes("web_search"), "the Knowledge Agent has both tools");
const owner = allToolOwnership().find((entry) => entry.tool === "latest_release");
assert(owner?.owner === "knowledge" && owner.effect === "read", "latest_release is a Knowledge Agent read");
// Public GitHub release data only, so other agents may ask for it over A2A (knowledge.latest_release).
const opened = localSpecialists().flatMap((agent) => agent.remoteCapabilities());
assert(
  opened.some((item) => item.name === "latest_release" && item.effect === "read") && owner.remoteExposed === true,
  "it is opened to other agents, as a read",
);
assert((FORWARDED_TOOLS as readonly string[]).includes("latest_release") && tools.latest_release !== undefined, "a forwarded message may use it, as it may web_search");
ok("routing: a question about the latest version or release goes to the Knowledge Agent without the word \"search\"; payments and press releases do not");

// ---------------------------------------------------------------- the lookup, against a fake GitHub

type Reply = unknown;
let requested: string[] = [];
function github(routes: Record<string, Reply>): void {
  requested = [];
  setReleaseFetchForTests((url): FetchedPage => {
    requested.push(url);
    const key = url.replace("https://api.github.com", "").replace("https://raw.githubusercontent.com", "raw:").replace(/\?.*$/, "");
    const value = routes[key];
    if (value === "RATE") {
      return { status: 403, body: "", rateLimited: true };
    }
    if (value === undefined) {
      return { status: 404, body: '{"message":"Not Found"}' };
    }
    return { status: 200, body: typeof value === "string" ? value : JSON.stringify(value) };
  });
}
const apiRepo = (fullName: string, extra: Record<string, unknown> = {}) => ({
  full_name: fullName,
  name: fullName.split("/")[1],
  owner: { login: fullName.split("/")[0] },
  description: "An open protocol for lamps to talk to each other.",
  homepage: "https://lumen-protocol.example",
  stargazers_count: 21500,
  fork: false,
  archived: false,
  default_branch: "main",
  ...extra,
});
const apiRelease = (fullName: string, entry: ReleaseEntry) => ({
  tag_name: entry.tag,
  name: entry.name,
  published_at: entry.publishedAt,
  prerelease: entry.prerelease === true,
  draft: false,
  html_url: `https://github.com/${fullName}/releases/tag/${entry.tag}`,
});
const lumen = (releases: ReleaseEntry[], extra: Record<string, Reply> = {}): Record<string, Reply> => ({
  "/repos/lumenproto/lumen": apiRepo("lumenproto/lumen"),
  "/repos/lumenproto/lumen/releases": [
    ...releases.map((entry) => apiRelease("lumenproto/lumen", entry)),
    { tag_name: "v9.9.9", name: "draft", published_at: null, prerelease: false, draft: true },
  ],
  "/users/lumenproto/repos": [
    apiRepo("lumenproto/lumen"),
    apiRepo("lumenproto/lumen-python", { stargazers_count: 900 }),
    apiRepo("lumenproto/lumen-js", { stargazers_count: 400 }),
    apiRepo("lumenproto/lumen-samples", { stargazers_count: 3000 }),
  ],
  "/repos/lumenproto/lumen-python/releases": [
    apiRelease("lumenproto/lumen-python", rel("v1.0.0a2", "2026-06-02", { prerelease: true })),
    apiRelease("lumenproto/lumen-python", rel("v0.3.25", "2026-05-30")),
    apiRelease("lumenproto/lumen-python", rel("v0.3.24", "2026-05-01")),
  ],
  "/repos/lumenproto/lumen-js/releases": [apiRelease("lumenproto/lumen-js", rel("v0.4.1", "2026-04-18"))],
  "raw:/lumenproto/lumen/HEAD/CHANGELOG.md":
    "# Changelog\n\n## [1.0.1](https://github.com/lumenproto/lumen/compare/v1.0.0...v1.0.1) (2026-05-26)\n\n### Bug Fixes\n\n## [1.0.0](https://github.com/lumenproto/lumen/compare/v0.3.0...v1.0.0) (2026-03-12)\n",
  ...extra,
});

github(lumen(history));
let report = await checkLatestRelease({ project: "Lumen protocol", repo: "lumenproto/lumen" });
assert(isSuccessfulToolResult(report) && report.startsWith("Release check ok: lumenproto/lumen, from its GitHub Releases (6 compared)"), `a report (${report.slice(0, 90)})`);
assert(report.includes("Latest stable release: v1.0.1, published 28 May 2026. It is a patch release on the 1.x line."), "latest stable, its date and that it is a patch");
assert(report.includes("Latest major release: v1.0.0, published 12 March 2026, the first release of the 1.x line."), "the major release named separately");
assert(report.includes("Prerelease: none newer than v1.0.1."), "no prerelease");
assert(report.includes("Changelog: CHANGELOG.md's top entry is 1.0.1 (dated 2026-05-26), which matches the release list."), "the changelog agrees");
assert(!report.includes("v9.9.9"), "a draft release is not a release");
assert(report.includes("none of them is the version of Lumen protocol"), "SDK versions are set apart");
assert(report.includes("- lumenproto/lumen-python: latest stable v0.3.25, published 30 May 2026; newer prerelease v1.0.0a2, published 2 June 2026"), "the Python SDK's stable and prerelease versions");
assert(report.includes("- lumenproto/lumen-js: latest stable v0.4.1, published 18 April 2026") && !report.includes("lumen-samples:"), "the JS SDK, and not the samples repository");
assert(report.includes("Project site: https://lumen-protocol.example"), "the vendor's site from the repository");
assert(/---sources---\nlumenproto\/lumen v1\.0\.1 release \| https:\/\/github\.com\/lumenproto\/lumen\/releases\/tag\/v1\.0\.1\nlumenproto\/lumen CHANGELOG\.md \| https:\/\/github\.com\/lumenproto\/lumen\/blob\/main\/CHANGELOG\.md\n---end---/.test(report), "the release page and changelog are the sources");
assert(requested.every((url) => url.startsWith("https://api.github.com/") || url.startsWith("https://raw.githubusercontent.com/")), "only GitHub's API and raw files are fetched");
ok("lookup: the report gives latest stable (patch) with its date, the major release separately, no prerelease, the changelog's agreement, and SDK versions apart; drafts are ignored");

github(lumen([rel("v2.0.0-rc.1", "2026-09-01", { prerelease: true }), rel("v1.1.0", "2026-08-10"), rel("v0.3.1", "2026-08-20"), ...history], {
  "raw:/lumenproto/lumen/HEAD/CHANGELOG.md": "# Changelog\n\n## [1.2.0](https://x) (2026-09-05)\n\n## [1.1.0](https://x) (2026-08-10)\n",
}));
report = await checkLatestRelease({ project: "Lumen protocol", repo: "https://github.com/lumenproto/lumen" });
assert(report.includes("Latest stable release: v1.1.0, published 10 August 2026. It is a minor release on the 1.x line."), `a later history gives a later answer (${report.split("\n")[3]})`);
assert(report.includes("Newer prerelease: v2.0.0-rc.1, published 1 September 2026 (prerelease (rc)). It is not a stable release."), "the release candidate is reported as a prerelease");
assert(report.includes("Published most recently: v0.3.1, published 20 August 2026, a patch release on the older 0.x line. It is newer by date but a lower version, so it is not the latest release."), "the backport is explained");
assert(report.includes("top entry is 1.2.0 (dated 2026-09-05), which is newer than any published release"), "a changelog ahead of the releases is flagged, not announced");
ok("lookup, later history: a minor release, a newer rc, a backport published afterwards and a changelog ahead of the releases are each reported for what they are");

github({ ...lumen(history), "/repos/oldorg/lumen": apiRepo("lumenproto/lumen") });
report = await checkLatestRelease({ project: "Lumen", repo: "oldorg/lumen" });
assert(report.includes("Note: oldorg/lumen now lives at lumenproto/lumen.") && report.includes("Latest stable release: v1.0.1"), "a moved repository is followed and said");

github({ ...lumen(history), "/repos/lumenproto/lumen-python": apiRepo("lumenproto/lumen-python", { description: "Python SDK for Lumen" }) });
report = await checkLatestRelease({ project: "Lumen protocol", repo: "lumenproto/lumen-python" });
assert(report.includes("Latest stable release: v0.3.25") && /Warning about this repository: it is named like an SDK or client library/.test(report), "asking an SDK repository for the protocol's version comes back with a warning");
ok("lookup: a renamed repository is followed; an SDK repository's versions are labelled as the library's, not the protocol's");

// Another kind of project: tags only, in its own tag style.
github({
  "/repos/elephantdb/elephant": apiRepo("elephantdb/elephant", { description: "A database.", homepage: "https://elephantdb.example" }),
  "/repos/elephantdb/elephant/releases": [],
  "/repos/elephantdb/elephant/tags": [
    { name: "REL_18_BETA1", commit: { sha: "c3" } },
    { name: "REL_17_2", commit: { sha: "c2" } },
    { name: "REL_17_1", commit: { sha: "c1" } },
    { name: "REL_17_0", commit: { sha: "c0" } },
    { name: "REL_16_6", commit: { sha: "b6" } },
  ],
  "/repos/elephantdb/elephant/commits/c3": { commit: { committer: { date: "2026-05-20T10:00:00Z" } } },
  "/repos/elephantdb/elephant/commits/c2": { commit: { committer: { date: "2026-02-12T10:00:00Z" } } },
  "/repos/elephantdb/elephant/commits/c0": { commit: { committer: { date: "2025-09-25T10:00:00Z" } } },
});
report = await checkLatestRelease({ project: "ElephantDB", repo: "elephantdb/elephant" });
assert(report.startsWith("Release check ok: elephantdb/elephant, from its git tags (it publishes no GitHub Releases) (5 compared)"), `tags are used when there are no releases (${report.slice(0, 100)})`);
assert(report.includes("Latest stable release: REL_17_2, published 12 February 2026. It is a minor release on the 17.x line."), "latest stable from tags, dated from its commit");
assert(report.includes("Latest major release: REL_17_0, published 25 September 2025, the first release of the 17.x line."), "its major release");
assert(report.includes("Newer prerelease: REL_18_BETA1, published 20 May 2026 (prerelease (beta))."), "its beta");
ok("other software: a project with git tags only (REL_17_2 style) gets the same answer shape, with the beta of the next major kept apart");

// No repository named: it never guesses.
github({
  "/search/repositories": {
    items: [
      apiRepo("TheTutorials/Lumen", { stargazers_count: 190000, description: "All tutorials implemented in Lumen" }),
      apiRepo("lumenproto/lumen"),
      apiRepo("someone/lumen-fork", { fork: true, stargazers_count: 3 }),
    ],
  },
});
report = await checkLatestRelease({ project: "Lumen" });
assert(report.startsWith("Not checked yet:") && !isSuccessfulToolResult(report), "no repository named: nothing is checked");
assert(report.includes("1. TheTutorials/Lumen, 190,000 stars") && report.includes("2. lumenproto/lumen, 21,500 stars") && report.includes("(fork)"), "the candidates are listed");
assert(requested.length === 1 && !/Latest stable/.test(report), "and the most popular match is not looked up or presented as the answer");
github({});
assert((await checkLatestRelease({ project: "Lumen", repo: "nobody/nothing" })).startsWith("Not checked: there is no public GitHub repository called nobody/nothing"), "an unknown repository");
assert((await checkLatestRelease({ project: "Lumen", repo: "https://evil.example/a/b" })).startsWith("Not checked: repo must be a GitHub repository") && requested.length === 1, "a URL that is not github.com is refused without a request");
github({ "/repos/lumenproto/lumen": "RATE" });
report = await checkLatestRelease({ project: "Lumen", repo: "lumenproto/lumen" });
assert(report.startsWith("Not checked: GitHub's hourly lookup allowance is used up") && !isSuccessfulToolResult(report), "a rate limit is said plainly");
github({ "/repos/quiet/thing": apiRepo("quiet/thing"), "/repos/quiet/thing/releases": [], "/repos/quiet/thing/tags": [{ name: "nightly", commit: { sha: "x" } }] });
assert((await checkLatestRelease({ project: "Thing", repo: "quiet/thing" })).startsWith("Not checked: quiet/thing publishes no versioned releases or tags"), "a repository with nothing versioned");
ok("unknown: with no repository named it lists candidates and picks none; unknown repositories, non-GitHub URLs, rate limits and unversioned projects each say \"Not checked\" and why");

// ---------------------------------------------------------------- web_search on a release question

const blog = { title: "What's new in Lumen v1.0", url: "https://lumen-fans.example/docs/whats-new-v1/", snippet: "Lumen v1.0 is here." };
const news = { title: "Lumen 1.0 launches", url: "https://technews.example/lumen-1-0", snippet: "The latest release, v1.0." };
const releasesPage = { title: "Releases · lumenproto/lumen", url: "https://github.com/lumenproto/lumen/releases", snippet: "" };
setSearchProvidersForTests({ deepseek: async () => ({ hits: [blog, news, releasesPage] }) });
const searchTurn = { iteration: 1, calledTools: ["web_search"] };
const searched = await tools.web_search!.handler({ query: "latest Lumen protocol release" }, searchTurn);
assert(searched.indexOf(releasesPage.url) < searched.indexOf(blog.url), "the project's own release page is listed before articles about it");
assert(/RELEASE QUESTION:.*\n.*Call latest_release/.test(searched) && searched.includes("GitHub repositories in these results: lumenproto/lumen."), "the result says to check the release list and names the repository it saw");
const viaHisWords = await tools.web_search!.handler({ query: "Lumen protocol" }, { ...searchTurn, userText: "what's the latest version of the Lumen protocol?" });
assert(viaHisWords.includes("RELEASE QUESTION:"), "his own words make it a release question even when the query does not");
const ordinary = await tools.web_search!.handler({ query: "Lumen conference dates" }, searchTurn);
assert(ordinary === formatSearchToolResult({ ok: true, provider: "deepseek", hits: [blog, news, releasesPage], attempts: [] }), "any other search is returned exactly as before");
assert(reposInUrls([blog.url, releasesPage.url, "https://github.com/topics/lumen", "https://github.com/lumenproto/lumen/issues/4"]).join(",") === "lumenproto/lumen", "repositories are read from GitHub URLs only");
assert(releasePagesFirst([blog, { url: "https://github.com/a/b/blob/main/CHANGELOG.md" }, news])[0]!.url.endsWith("CHANGELOG.md"), "a changelog on GitHub counts as the project's own page");
ok("web search: on a release question the project's own release page leads and the result tells the model to check the release list; other searches are unchanged");

// ---------------------------------------------------------------- the whole turn, through the Knowledge Agent

let modelCalls: CompleteParams[] = [];
let script: Array<{ text?: string; tools?: Array<{ name: string; input?: unknown }> }> = [];
setCompleteForTests(async (params) => {
  if (params.tools.length === 0) {
    return modelReply({ text: '{"facts":[]}' });
  }
  modelCalls.push({ ...params, messages: [...params.messages] });
  const next = script.shift();
  if (!next) {
    throw new Error("the model was called more times than the test scripted");
  }
  return modelReply(next);
});
setToolInterceptorForTests(undefined);
const ask = async (text: string) => {
  modelCalls = [];
  const route: { value?: Route } = {};
  const reply = await runOwnerTurn(text, {
    ownerText: text,
    guardText: text,
    chatId: 1,
    sendConfirmation: { chatId: 1, messageId: nextMessageId() },
    skipHistory: true,
    saveUserMessage: false,
    saveAssistantMessage: false,
    route,
  });
  return { reply, route: route.value };
};
const lastToolResult = (call: CompleteParams) => JSON.stringify(call.messages.at(-1));

github(lumen(history));
script = [
  { tools: [{ name: "web_search", input: { query: "latest Lumen protocol release" } }] },
  { tools: [{ name: "latest_release", input: { project: "Lumen protocol", repo: "lumenproto/lumen" } }] },
  { text: "The latest stable release of the Lumen protocol is v1.0.1, published 28 May 2026. It is a patch on the 1.x line; the latest major release is v1.0.0 (12 March 2026)." },
];
const turn = await ask("Search the web for the latest Lumen protocol release");
assert(turn.route?.kind === "specialist" && turn.route.agentId === "knowledge", "the Knowledge Agent took the turn");
assert(modelCalls[0]!.tools.some((tool) => "name" in tool && tool.name === "latest_release"), "and was offered latest_release");
assert(/RELEASE QUESTION/.test(lastToolResult(modelCalls[1]!)) && /lumenproto\/lumen/.test(lastToolResult(modelCalls[1]!)), "after searching it was told to check the release list");
assert(/Latest stable release: v1\.0\.1, published 28 May 2026/.test(lastToolResult(modelCalls[2]!)), "the release list gave it the answer");
assert(turn.reply.includes("https://github.com/lumenproto/lumen/releases/tag/v1.0.1") && turn.reply.includes("CHANGELOG.md"), `the reply cites the official release page and changelog (${turn.reply.slice(-200)})`);
assert(!turn.reply.includes(blog.url) && !turn.reply.includes(news.url), "and not the articles it did not use");
ok("the turn: \"Search the web for the latest … release\" → Knowledge Agent → web_search → latest_release → an answer citing the official release page and changelog, not the articles");

github(lumen(history));
script = [
  { tools: [{ name: "latest_release", input: { project: "Lumen protocol", repo: "lumenproto/lumen" } }] },
  { text: "As of today the latest stable release is v1.0.1 (28 May 2026)." },
];
const direct = await ask("What's the latest version of the Lumen protocol?");
assert(direct.reply.startsWith("As of today the latest stable release is v1.0.1"), `a release check counts as a live lookup (${direct.reply.slice(0, 80)})`);
assert(unreceiptedClaims("As of today the latest stable release is v1.0.1.", [{ name: "latest_release", success: true }]).length === 0, "for the reply check too");

github({ "/search/repositories": { items: [apiRepo("TheTutorials/Lumen"), apiRepo("lumenproto/lumen")] } });
script = [
  { tools: [{ name: "latest_release", input: { project: "Lumen" } }] },
  { text: "As of today the latest release of Lumen is v3.2." },
  { text: "As of today the latest release of Lumen is v3.2." },
];
const guessed = await ask("What's the latest version of Lumen?");
assert(guessed.reply === receiptFailureMessage(["searched"]), `a version named after nothing was checked is not delivered (${guessed.reply})`);
ok("the reply check: a release check counts as a live lookup; naming a latest version when nothing was checked is blocked");

// No project or version is baked into the lookup code. The invented histories
// above already move past v1.0.1; this check keeps A2A (or any other project)
// out of the comparing and reporting itself.
const { readFileSync } = await import("node:fs");
for (const file of ["src/release_logic.ts", "src/releases.ts", "src/tools/latest_release.ts"]) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  assert(!/\ba2aproject\b/i.test(source), `${file} must not name a2aproject`);
  assert(!/\bA2A\b.*\bv?1\.0\.1\b|\bv?1\.0\.1\b.*\bA2A\b/.test(source), `${file} must not hardcode A2A v1.0.1`);
}
ok("no hardcoding: the lookup code names no real project repository and no A2A version");

setReleaseFetchForTests(undefined);
setSearchProvidersForTests(undefined);
setCompleteForTests(undefined);
log("Latest release checks passed.");
process.exit(0);
