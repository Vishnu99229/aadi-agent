import type { LlmTool } from "../llm.js";
import { checkLatestRelease } from "../releases.js";

export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "latest_release",
  description:
    "Find the latest release of a piece of software, a library or a protocol from its official release list on GitHub. It compares version numbers and release dates and reports the latest stable release, the latest major release, any newer prerelease, what the changelog says, and the versions of the project's SDKs, which are numbered separately. Use it whenever Vishnu asks what the latest or current version or release of something is, or whether a version is out: a web search alone often returns an article about an older release. Pass repo when you know the project's official repository; otherwise pass only project, and choose the official repository from the candidates it returns. Report the versions and dates exactly as returned.",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: 'The software or protocol as Vishnu named it, e.g. "A2A protocol", "Kubernetes", "React".',
      },
      repo: {
        type: "string",
        description:
          'The project\'s official GitHub repository as owner/name or a github.com URL, e.g. "nodejs/node". For a protocol or product, give the repository of the specification or product itself, not of one of its SDKs. Leave it out if you are not sure.',
      },
    },
    required: ["project"],
  },
};

export async function handler(input: unknown): Promise<string> {
  const values = input as { project?: unknown; repo?: unknown };
  const project = typeof values.project === "string" ? values.project.trim() : "";
  if (!project) {
    throw new Error("project must be the name of the software or protocol.");
  }
  return checkLatestRelease({
    project,
    repo: typeof values.repo === "string" ? values.repo : undefined,
  });
}
