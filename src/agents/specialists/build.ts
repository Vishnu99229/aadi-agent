import type { CardButton } from "../helpers.js";
import type { SpecialistDefinition } from "../specialist.js";

/**
 * The Build Agent: changes to Aadi's own code through a Cursor cloud agent. It
 * wraps the existing build state machine (builds.ts), which already survives
 * restarts through the builds table and the build poll. Nothing here starts,
 * merges or deploys on its own: a build starts on Vishnu's Start tap, and a pull
 * request that touches protected areas waits for his Deploy tap.
 */
export const buildAgent: SpecialistDefinition = {
  id: "build",
  name: "Build Agent",
  description:
    "Reasons about changes to Aadi's own code: reads builds, pull requests, CI results and the repository, explains failures, judges whether a build looks ready, and prepares a Cursor build request for Vishnu's Start tap.",
  version: "2.0.0",
  promptFile: "build.md",
  // Reads, plus one tool that only prepares a card. Nothing here can start,
  // merge or deploy: those stay behind Vishnu's Start and Deploy taps.
  tools: [
    { name: "get_build", effect: "read", retry: "safe" },
    { name: "list_recent_builds", effect: "read", retry: "safe" },
    { name: "get_build_checks", effect: "read", retry: "safe" },
    { name: "get_repo_state", effect: "read", retry: "safe" },
    { name: "prepare_build", effect: "draft", retry: "never" },
  ],
  sharedTools: ["get_current_time"],
  routing: {
    patterns: [
      /\b(?:deploy(?:s|ed|ing|ment)?|codebase|builds?|pull\s+requests?|cursor|repo(?:sitory)?|merge[sd]?\s+(?:the\s+)?(?:pr|pull)|ci\s+(?:run|check|fail\w*)|(?:failing|failed)\s+(?:tests?|checks?))\b/i,
      /\bPRs?\b/,
      /\b(?:aadi(?:'s|’s)?|the|my|your)\s+code\b|\bcode\s+(?:change|problem|issue|fix)\w*\b/i,
    ],
    commandKinds: [],
  },
  capabilities: [
    {
      name: "request_build",
      description:
        "Prepare a code change for Aadi. Returns a card with Start and Cancel: the Cursor agent only starts when Vishnu taps Start.",
      kind: "workflow",
      effect: "draft",
      retry: "never",
      usesLlm: false,
      inputSchema: {
        type: "object",
        properties: { task: { type: "string", description: "What to change, in his words." } },
        required: ["task"],
        additionalProperties: false,
      },
      handler: async (input) => {
        const { config } = await import("../../config.js");
        const { isBuildConfigured, confirmBuildText } = await import("../../build_logic.js");
        const { notSetupMessage } = await import("../../builds.js");
        if (!isBuildConfigured(config.cursorApiKey, config.githubToken)) {
          return { text: notSetupMessage(), output: { ready: false } };
        }
        const task = String(input.task).trim();
        if (!task) {
          return { text: "Send /build plus what you want changed.", output: { ready: false } };
        }
        const { createBuild } = await import("../../db.js");
        const build = createBuild(task);
        console.log(`Build ${build.id}: status -> pending_confirm`);
        const buttons: CardButton[][] = [
          [
            { text: "Start", data: `build:go:${build.id}` },
            { text: "Cancel", data: `build:no:${build.id}` },
          ],
        ];
        return {
          text: confirmBuildText(task),
          output: { ready: true, build_id: build.id, status: build.status, buttons },
          nextAction: "Await Vishnu's Start tap.",
        };
      },
    },
    {
      name: "list_builds",
      description: "The recent builds and the state each is in.",
      kind: "workflow",
      effect: "read",
      retry: "safe",
      usesLlm: false,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      examples: ["Show my builds."],
      triggers: [/^(?:show|list)\s+(?:me\s+)?(?:my\s+|the\s+)?(?:recent\s+)?(?:cursor\s+)?builds[.?!]*$/i],
      handler: async () => {
        const { formatRecentBuilds } = await import("../../builds.js");
        return { text: formatRecentBuilds() };
      },
    },
    {
      name: "build_status",
      description:
        "Where one build stands: running, waiting on checks, waiting for approval, deployed or failed. The latest build when no id is given.",
      kind: "workflow",
      effect: "read",
      retry: "safe",
      usesLlm: false,
      inputSchema: {
        type: "object",
        properties: { build_id: { type: "integer" } },
        additionalProperties: false,
      },
      examples: ["Show my latest Cursor build.", "How is the build going?"],
      triggers: [
        /^(?:show|what(?:'s|’s| is))\s+(?:me\s+)?(?:my\s+|the\s+)?(?:latest|last|most\s+recent)\s+(?:cursor\s+)?build(?:\s+status)?[.?!]*$/i,
      ],
      handler: async (input) => {
        const { getBuild, listBuilds } = await import("../../db.js");
        const { formatBuildStatus, protectedAreasTouched } = await import("../../build_logic.js");
        const build = typeof input.build_id === "number" ? getBuild(input.build_id) : listBuilds(1)[0];
        if (!build) {
          return { text: "No builds yet.", output: { found: false } };
        }
        let files: string[] = [];
        try {
          const parsed = JSON.parse(build.files_json ?? "[]") as unknown;
          files = Array.isArray(parsed) ? parsed.map(String) : [];
        } catch {
          files = [];
        }
        const areas = protectedAreasTouched(files);
        const waiting =
          build.status === "pending_confirm"
            ? "Waiting for your Start tap."
            : build.status === "waiting_approval" || build.status === "review"
              ? "Waiting for your Deploy tap."
              : "";
        const lines = [
          `Build #${build.id}: ${formatBuildStatus(build.status)}`,
          build.task.replace(/\s+/g, " ").trim().slice(0, 200),
          build.pr_url ? `PR: ${build.pr_url}` : "",
          areas.length > 0 ? `Touches protected areas: ${areas.join(", ")}` : "",
          build.error ? `Error: ${build.error.slice(0, 200)}` : "",
          waiting,
        ].filter(Boolean);
        return {
          text: lines.join("\n"),
          output: {
            found: true,
            build_id: build.id,
            status: build.status,
            pr_url: build.pr_url ?? "",
            protected_areas: areas,
            needs_approval: Boolean(waiting),
          },
        };
      },
    },
  ],
  jobs: async () => {
    const { registerBuildPoll } = await import("../../builds.js");
    return [registerBuildPoll()];
  },
};
