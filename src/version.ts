import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const VERSION_FILE = "VERSION";

export interface DeployVersion {
  hash: string;
  deployed: string;
}

export function versionPath(cwd = process.cwd()): string {
  return join(cwd, VERSION_FILE);
}

export function parseVersionFile(text: string): DeployVersion | undefined {
  let hash = "";
  let deployed = "";
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("hash=")) {
      hash = trimmed.slice("hash=".length).trim();
    } else if (trimmed.startsWith("deployed=")) {
      deployed = trimmed.slice("deployed=".length).trim();
    }
  }
  if (!hash && !deployed) {
    return undefined;
  }
  const short = hash.toLowerCase().replace(/[^0-9a-f]/g, "").slice(0, 7);
  return {
    hash: short.length >= 4 ? short : "unknown",
    deployed: deployed || "unknown",
  };
}

export function readDeployVersion(cwd = process.cwd()): DeployVersion | undefined {
  const path = versionPath(cwd);
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return parseVersionFile(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** The checkout's commit, when this process was not deployed (no VERSION file). */
export function readLocalGitHash(cwd = process.cwd()): string {
  try {
    const hash = execFileSync("git", ["-C", cwd, "rev-parse", "--short=7", "HEAD"], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[0-9a-f]{4,12}$/i.test(hash) ? hash.toLowerCase() : "";
  } catch {
    return "";
  }
}

/**
 * A VERSION file is a real deploy. Without one, this is a local checkout:
 * show its commit and do not call it deployed.
 */
export function formatVersionLine(info: DeployVersion | undefined, localHash = ""): string {
  if (!info) {
    return localHash
      ? `version: ${localHash} (local, not deployed)`
      : "version: unknown (local, not deployed)";
  }
  return `version: ${info.hash}, deployed ${info.deployed}`;
}
