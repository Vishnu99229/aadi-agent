import type { BuildRecord, BuildStatus } from "./db.js";

export const BUILD_REPO_URL = "https://github.com/Vishnu99229/aadi-agent";

const FOLLOW_UP_RULES = `Follow .cursor/rules/aadi.mdc. Never read, create or modify .env, tokens, credentials, *.db or backups. Add or update tests. Open a pull request; do not merge.`;

export function isBuildConfigured(
  cursorApiKey: string,
  githubToken: string,
): boolean {
  return cursorApiKey.trim() !== "" && githubToken.trim() !== "";
}

export function parseBuildVoice(text: string): string | undefined {
  const match = text.trim().match(/^build:\s*(.+)$/is);
  const task = match?.[1]?.trim();
  return task || undefined;
}

export function wrapBuildPrompt(task: string): string {
  return `${task.trim()}. ${FOLLOW_UP_RULES}`;
}

export function parsePullNumber(prUrl: string): number | undefined {
  const match = prUrl.match(/\/pull\/(\d+)(?:\/|$)/i);
  if (!match) {
    return undefined;
  }
  const n = Number(match[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

export function formatBuildStatus(status: BuildStatus): string {
  switch (status) {
    case "pending_confirm":
      return "waiting to start";
    case "running":
      return "running";
    case "waiting_checks":
      return "checks";
    case "waiting_approval":
    case "review":
      return "waiting for approval";
    case "awaiting_followup":
      return "waiting for changes";
    case "merged":
    case "deploying":
      return "merged";
    case "deployed":
      return "deployed";
    case "discarded":
      return "discarded";
    case "failed":
      return "failed";
    case "rolled_back":
      return "rolled back";
  }
}

export function formatBuildsList(rows: BuildRecord[]): string {
  if (rows.length === 0) {
    return "No builds yet.";
  }
  return rows
    .map((row) => {
      const title = row.task.replace(/\s+/g, " ").trim().slice(0, 60);
      return `#${row.id} ${formatBuildStatus(row.status)} — ${title}`;
    })
    .join("\n");
}

export function formatChangedFiles(files: string[]): string {
  if (files.length === 0) {
    return "Files: none listed";
  }
  const shown = files.slice(0, 20).map((file) => `• ${file}`);
  const extra =
    files.length > 20 ? `\n• …and ${files.length - 20} more` : "";
  return `Files:\n${shown.join("\n")}${extra}`;
}

export function oneLineError(text: string | undefined): string {
  const cleaned = (text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return cleaned || "The Cursor agent failed.";
}

export function shortCursorStartReason(error: {
  status?: number;
  code?: string;
  apiMessage?: string;
  message?: string;
}): string {
  const status = error.status;
  const code = (error.code ?? "").toLowerCase();
  const raw = `${error.apiMessage ?? ""} ${error.message ?? ""}`
    .replace(/\s+/g, " ")
    .trim();
  const text = raw.toLowerCase();

  if (
    status === 401 ||
    /invalid api key|unauthorized|unauthenticated|authentication|api key/.test(
      text,
    )
  ) {
    return "invalid API key";
  }
  if (
    /storage mode is disabled|enable storage|privacy mode \(legacy\)|legacy privacy/.test(
      text,
    )
  ) {
    return "storage is disabled in Cursor settings";
  }
  if (
    /repository not accessible|repo(sitory)? (not found|inaccessible)|does not have access to (the )?repo/.test(
      text,
    )
  ) {
    return "repository not accessible";
  }
  if (/usage-based|spend limit|billing|payment required/.test(text)) {
    return "usage-based pricing is not enabled";
  }
  if (
    code === "feature_unavailable" ||
    /cloud agents? not (enabled|supported)|not enabled on this plan|not available on your plan/.test(
      text,
    )
  ) {
    return "cloud agents not enabled on this plan";
  }
  if (raw) {
    const first = raw.split(/(?<=[.!?])\s/)[0] ?? raw;
    return first.replace(/[.]+$/, "").slice(0, 140);
  }
  if (status === 403) {
    return "cloud agents not enabled on this plan";
  }
  if (status) {
    return `Cursor API returned ${status}`;
  }
  return "the Cursor agent could not start";
}

export function formatCouldNotStart(error: {
  status?: number;
  code?: string;
  apiMessage?: string;
  message?: string;
}): string {
  return `Could not start: ${shortCursorStartReason(error)}`;
}

export function shortSummary(text: string | undefined): string {
  const cleaned = (text ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return "The agent finished.";
  }
  return cleaned.length > 500 ? `${cleaned.slice(0, 497)}...` : cleaned;
}

export interface GithubCheckItem {
  name: string;
  status: string;
  conclusion: string | null;
}

export function summarizeGithubChecks(items: GithubCheckItem[]): {
  state: "pending" | "passed" | "failed";
  reason?: string;
} {
  if (items.length === 0) {
    return { state: "passed" };
  }
  const failed: string[] = [];
  let pending = false;
  for (const item of items) {
    const status = item.status.trim().toLowerCase();
    const conclusion = (item.conclusion ?? "").trim().toLowerCase();
    if (status && status !== "completed") {
      pending = true;
      continue;
    }
    if (
      conclusion === "failure" ||
      conclusion === "cancelled" ||
      conclusion === "timed_out" ||
      conclusion === "action_required" ||
      conclusion === "startup_failure"
    ) {
      failed.push(item.name.trim() || "check");
    }
  }
  if (failed.length > 0) {
    return { state: "failed", reason: failed.slice(0, 4).join(", ") };
  }
  if (pending) {
    return { state: "pending" };
  }
  return { state: "passed" };
}

const PROTECTED_RULES: Array<{ area: string; test: (path: string) => boolean }> =
  [
    {
      area: "email send / approval",
      test: (path) =>
        path === "src/approvals.ts" || path.startsWith("src/google/mail"),
    },
    {
      area: "owner lock",
      test: (path) => path === "src/bot.ts",
    },
    {
      area: "phone deploy",
      test: (path) =>
        path === "deploy.sh" ||
        path.startsWith("scripts/phone-") ||
        path === "scripts/github-revert-main.cjs",
    },
    {
      area: ".env guard",
      test: (path) => path === "src/config.ts",
    },
    {
      area: "local_llm_guard",
      test: (path) => path === "src/local_llm_guard.ts",
    },
    {
      area: "backup logic",
      test: (path) =>
        path === "src/backup.ts" || path === "scripts/sqlite-backup.cjs",
    },
    {
      area: ".cursor/rules",
      test: (path) => path.startsWith(".cursor/rules/"),
    },
    {
      area: ".github/workflows",
      test: (path) => path.startsWith(".github/workflows/"),
    },
  ];

export function protectedAreasTouched(files: string[]): string[] {
  const areas: string[] = [];
  for (const rule of PROTECTED_RULES) {
    if (files.some((file) => rule.test(file.replace(/\\/g, "/")))) {
      areas.push(rule.area);
    }
  }
  return areas;
}

export function compactFileList(files: string[]): string {
  if (files.length === 0) {
    return "none listed";
  }
  const shown = files.slice(0, 12);
  const extra = files.length > 12 ? `, +${files.length - 12} more` : "";
  return `${shown.join(", ")}${extra}`;
}

export function formatDeployedText(params: {
  summary: string;
  files: string[];
  prUrl: string;
}): string {
  const summary =
    params.summary.replace(/\s+/g, " ").trim().slice(0, 140) ||
    "The agent finished.";
  const pr = params.prUrl.trim() || "none";
  return `Deployed: ${summary} Files: ${compactFileList(params.files)}. PR: ${pr}`;
}

export function failedChecksText(reason: string): string {
  const short = reason.replace(/\s+/g, " ").trim().slice(0, 140) || "CI failed";
  return `Build failed checks: ${short}`;
}

export function shouldAutoMerge(params: {
  autoDeploy: boolean;
  protectedAreas: string[];
  filesVerified: boolean;
}): boolean {
  return (
    params.autoDeploy &&
    params.filesVerified &&
    params.protectedAreas.length === 0
  );
}

export function needsApprovalText(areas: string[]): string {
  const labels = areas.length > 0 ? areas.join(", ") : "a protected area";
  return `Needs your approval: touches ${labels}`;
}

export function confirmBuildText(task: string): string {
  return `Build this?\n${task.trim()}\n\nTap Start or Cancel.`;
}

export function failedStartText(
  task: string,
  error: {
    status?: number;
    code?: string;
    apiMessage?: string;
    message?: string;
  },
): string {
  return `${formatCouldNotStart(error)}\n\n${confirmBuildText(task)}`;
}

export function revertCommitMessage(prTitle: string): string {
  const title = prTitle.replace(/\s+/g, " ").trim() || "merged pull request";
  return `Revert ${title} — failed health check`;
}

export function macFixMainCommand(mergeSha?: string): string {
  const sha =
    mergeSha && /^[0-9a-f]{7,40}$/i.test(mergeSha) ? mergeSha : "HEAD";
  return `git pull && git revert --no-edit ${sha} && git push origin main`;
}

export function rollbackTelegram(params: {
  reason: string;
  phoneNote: string;
  revert:
    | { ok: true; message: string }
    | { ok: false; mergeSha?: string };
}): string {
  const prefix = `Deploy failed: ${params.reason} ${params.phoneNote}`.trim();
  if (params.revert.ok) {
    return `${prefix} Reverted GitHub main (${params.revert.message}).`;
  }
  const fix = macFixMainCommand(params.revert.mergeSha);
  return `${prefix} GitHub main is still broken — the revert failed. On the Mac run: ${fix}`;
}
