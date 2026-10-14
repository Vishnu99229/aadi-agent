import "dotenv/config";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  decryptFile,
  encryptFile,
  sendEncryptedSqliteFile,
} from "../src/backup.ts";
import { Bot } from "grammy";
import { config } from "../src/config.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const sqlitePath = process.argv[2];
if (!sqlitePath) {
  throw new Error("Usage: tsx scripts/test-backup.ts <snapshot.db>");
}

const dir = await mkdtemp(join(tmpdir(), "aadi-backup-test-"));
const encPath = join(dir, "aadi.db.enc");
const restoredPath = join(dir, "aadi-restored.db");
const productionPassword = process.env.BACKUP_PASSWORD?.trim() ?? "";
const password = productionPassword || randomBytes(24).toString("base64url");

try {
  const header = await readFile(sqlitePath);
  assert(header.subarray(0, 16).toString() === "SQLite format 3\0", "snapshot is not SQLite");

  await encryptFile(sqlitePath, encPath, password);
  const encrypted = await readFile(encPath);
  assert(encrypted.subarray(0, 16).toString() !== "SQLite format 3\0", "encrypted file must not be raw SQLite");

  await decryptFile(encPath, restoredPath, password);
  const restored = new Database(restoredPath, { readonly: true, fileMustExist: true });
  const integrity = restored.pragma("integrity_check", { simple: true });
  assert(integrity === "ok", `integrity_check failed: ${String(integrity)}`);
  const names = restored
    .prepare("SELECT name FROM accounts ORDER BY id")
    .all() as Array<{ name: string }>;
  restored.close();
  const found = names.map((row) => row.name);
  for (const wanted of ["Pinnacle Teleservices", "Eternal", "Shriram Life"]) {
    assert(found.includes(wanted), `missing account: ${wanted}`);
  }
  console.log(`Decrypted backup is valid SQLite with accounts: ${found.join(", ")}`);

  if (!productionPassword) {
    console.log("Telegram send skipped in this test: BACKUP_PASSWORD is not set.");
  } else {
    const bot = new Bot(config.telegramBotToken);
    const result = await sendEncryptedSqliteFile(bot.api, sqlitePath, "on-demand");
    console.log(`Telegram backup: ${result}`);
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
