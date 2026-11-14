import type { LlmTool } from "../llm.js";

/**
 * Where one build stands, with everything Aadi recorded about it: the request,
 * the Cursor agent's summary, the pull request, changed files, protected areas
 * and the last error. Reads the builds table only.
 */
export const definition: Extract<LlmTool, { type: "function" }> = {
  type: "function",
  name: "get_build",
  description:
    "Read one code build of Aadi: its request, status, the Cursor agent's summary, the pull request, changed files, protected areas it touches and its last error. Without build_id it reads the latest build; with status it reads the latest build in that status (for example failed).",
  inputSchema: {
    type: "object",
    properties: {
      build_id: { type: "integer", description: "The build number." },
      status: {
        type: "string",
        enum: ["failed", "running", "waiting_checks", "waiting_approval", "review", "deployed", "merged", "rolled_back"],
        description: "Read the latest build in this status.",
      },
    },
  },
};

export async function handler(input: unknown): Promise<string> {
  const values = (input ?? {}) as { build_id?: unknown; status?: unknown };
  const { getBuild, listBuilds } = await import("../db.js");
  const { formatBuildStatus, protectedAreasTouched } = await import("../build_logic.js");
  const build =
    typeof values.build_id === "number"
      ? getBuild(values.build_id)
      : typeof values.status === "string"
        ? listBuilds(30).find((row) => row.status === values.status)
        : listBuilds(1)[0];
  if (!build) {
    return JSON.stringify({ found: false, note: "No build matches." });
  }
  let files: string[] = [];
  try {
    const parsed = JSON.parse(build.files_json ?? "[]") as unknown;
    files = Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    files = [];
  }
  return JSON.stringify({
    found: true,
    build_id: build.id,
    status: build.status,
    status_text: formatBuildStatus(build.status),
    request: build.task.replace(/\s+/g, " ").slice(0, 600),
    agent_summary: (build.summary ?? "").replace(/\s+/g, " ").slice(0, 1200),
    pr_number: build.pr_number,
    pr_url: build.pr_url ?? "",
    changed_files: files.slice(0, 40),
    changed_file_count: files.length,
    protected_areas: protectedAreasTouched(files),
    last_error: (build.error ?? "").slice(0, 600),
    created_at: build.created_at,
    updated_at: build.updated_at,
  });
}
