import type { LlmTool } from "../llm.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "get_repo_state",
  description:
    "Read the state of Aadi's repository on GitHub: the latest commits on main and the open pull requests, and optionally the files a pull request changes with the protected areas it touches.",
  inputSchema: {
    type: "object",
    properties: {
      pr_number: { type: "integer", description: "Also list the files this pull request changes." },
    },
  },
};

export async function handler(input: unknown): Promise<string> {
  const prNumber = (input as { pr_number?: unknown } | undefined)?.pr_number;
  const { config } = await import("../config.js");
  if (!config.githubToken) {
    return JSON.stringify({ available: false, note: "GITHUB_TOKEN is not set, so the repository can't be read." });
  }
  const { listRecentCommits, listOpenPulls, listPullFilenames } = await import("../github_api.js");
  const { protectedAreasTouched } = await import("../build_logic.js");
  const [commits, pulls] = await Promise.all([listRecentCommits("main", 8), listOpenPulls(10)]);
  let files: string[] | undefined;
  if (typeof prNumber === "number") {
    files = await listPullFilenames(prNumber);
  }
  return JSON.stringify({
    repository: `${config.githubOwner}/${config.githubRepo}`,
    main_commits: commits,
    open_pull_requests: pulls,
    ...(files
      ? { pr_number: prNumber, pr_files: files.slice(0, 60), pr_file_count: files.length, protected_areas: protectedAreasTouched(files) }
      : {}),
  });
}
