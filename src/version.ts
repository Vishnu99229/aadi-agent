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

export function formatVersionLine(info: DeployVersion | undefined): string {
  if (!info) {
    return "version: unknown, deployed unknown";
  }
  return `version: ${info.hash}, deployed ${info.deployed}`;
}
