import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Api } from "grammy";
import { InputFile } from "grammy";
import cron, { type ScheduledTask } from "node-cron";
import { wrapClockJob } from "./scheduler.js";
import { config } from "./config.js";
import { backupDatabaseTo } from "./db.js";

const execFileAsync = promisify(execFile);
const TIME_ZONE = "Asia/Kolkata";
export const OPENSSL_ITER = "600000";

function kolkataStamp(now = new Date()): { date: string; file: string } {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(now)
    .replace(":", "");
  return { date, file: `${date.replaceAll("-", "")}-${time}` };
}

export function backupCaption(kind: "weekly" | "on-demand", now = new Date()): string {
  const { date } = kolkataStamp(now);
  return kind === "weekly"
    ? `Weekly Aadi backup, ${date}`
    : `Aadi backup, ${date}`;
}

export function encryptedBackupFilename(now = new Date()): string {
  return `aadi-${kolkataStamp(now).file}.db.enc`;
}

function opensslArgs(mode: "-d" | "encrypt", input: string, output: string): string[] {
  const args = [
    "enc",
    "-aes-256-cbc",
    "-pbkdf2",
    "-iter",
    OPENSSL_ITER,
    "-md",
    "sha256",
    "-salt",
    "-in",
    input,
    "-out",
    output,
    "-pass",
    "env:BACKUP_PASSWORD",
  ];
  if (mode === "-d") {
    args.splice(1, 0, "-d");
  }
  return args;
}

export async function encryptFile(
  inputPath: string,
  outputPath: string,
  password: string,
): Promise<void> {
  await execFileAsync("openssl", opensslArgs("encrypt", inputPath, outputPath), {
    env: { ...process.env, BACKUP_PASSWORD: password },
  });
}

export async function decryptFile(
  inputPath: string,
  outputPath: string,
  password: string,
): Promise<void> {
  await execFileAsync("openssl", opensslArgs("-d", inputPath, outputPath), {
    env: { ...process.env, BACKUP_PASSWORD: password },
  });
}

export async function sendEncryptedSqliteFile(
  api: Api,
  sqlitePath: string,
  kind: "weekly" | "on-demand" = "on-demand",
): Promise<"sent" | "skipped"> {
  const password = config.backupPassword;
  if (!password) {
    console.log("Telegram backup skipped: BACKUP_PASSWORD is not set.");
    return "skipped";
  }

  const dir = await mkdtemp(join(tmpdir(), "aadi-backup-"));
  const filename = encryptedBackupFilename();
  const encrypted = join(dir, filename);
  try {
    await encryptFile(sqlitePath, encrypted, password);
    await api.sendDocument(
      config.ownerTelegramId,
      new InputFile(encrypted, filename),
      { caption: backupCaption(kind) },
    );
    console.log(`Telegram backup sent (${filename}).`);
    return "sent";
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function sendDatabaseBackup(
  api: Api,
  kind: "weekly" | "on-demand" = "on-demand",
): Promise<"sent" | "skipped"> {
  if (!config.backupPassword) {
    console.log("Telegram backup skipped: BACKUP_PASSWORD is not set.");
    return "skipped";
  }

  const dir = await mkdtemp(join(tmpdir(), "aadi-backup-"));
  const snapshot = join(dir, "aadi.db");
  try {
    await backupDatabaseTo(snapshot);
    return await sendEncryptedSqliteFile(api, snapshot, kind);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function registerWeeklyBackup(api: Api): ScheduledTask {
  const task = cron.schedule(
    "0 21 * * 0",
    wrapClockJob(
      "weekly-backup",
      21,
      0,
      async () => {
        await sendDatabaseBackup(api, "weekly");
      },
      [0],
    ),
    { name: "aadi-weekly-backup", timezone: TIME_ZONE, noOverlap: true },
  );
  console.log(`Weekly encrypted backup scheduled Sundays at 21:00 ${TIME_ZONE}.`);
  return task;
}
