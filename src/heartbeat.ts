import { writeFileSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const HEARTBEAT_FILE = ".aadi-heartbeat";
export const DEPLOY_RESULT_FILE = ".aadi-deploy-result.json";

export function heartbeatPath(cwd = process.cwd()): string {
  return join(cwd, HEARTBEAT_FILE);
}

export function deployResultPath(cwd = process.cwd()): string {
  return join(cwd, DEPLOY_RESULT_FILE);
}

export function writeHeartbeat(cwd = process.cwd()): void {
  writeFileSync(heartbeatPath(cwd), new Date().toISOString());
}

export interface DeployResultFile {
  buildId: number;
  status: "deployed" | "rolled_back" | "failed";
  error?: string;
}

export async function writeDeployResult(
  result: DeployResultFile,
  cwd = process.cwd(),
): Promise<void> {
  await writeFile(deployResultPath(cwd), JSON.stringify(result), "utf8");
}

export async function readDeployResult(
  cwd = process.cwd(),
): Promise<DeployResultFile | undefined> {
  try {
    const raw = await readFile(deployResultPath(cwd), "utf8");
    const parsed = JSON.parse(raw) as DeployResultFile;
    if (!Number.isSafeInteger(parsed.buildId) || parsed.buildId <= 0) {
      return undefined;
    }
    if (
      parsed.status !== "deployed" &&
      parsed.status !== "rolled_back" &&
      parsed.status !== "failed"
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export async function clearDeployResult(cwd = process.cwd()): Promise<void> {
  await unlink(deployResultPath(cwd)).catch(() => undefined);
}
