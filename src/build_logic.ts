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
    case "review":
      return "ready to review";
    case "awaiting_followup":
      return "waiting for changes";
    case "deploying":
      return "deploying";
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

export function shortSummary(text: string | undefined): string {
  const cleaned = (text ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return "The agent finished.";
  }
  return cleaned.length > 500 ? `${cleaned.slice(0, 497)}...` : cleaned;
}

export function confirmBuildText(task: string): string {
  return `Build this?\n${task.trim()}`;
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
