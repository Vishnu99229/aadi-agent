#!/usr/bin/env node
"use strict";

const { mkdirSync, existsSync } = require("node:fs");
const { dirname, resolve } = require("node:path");
const Database = require("better-sqlite3");

const destArg = process.argv[2];
if (!destArg) {
  console.error("Usage: node scripts/sqlite-backup.cjs <dest.db>");
  process.exit(1);
}

const source = resolve(process.cwd(), "aadi.db");
const dest = resolve(destArg);

if (!existsSync(source)) {
  console.error("No aadi.db in the current directory.");
  process.exit(1);
}

mkdirSync(dirname(dest), { recursive: true });
const db = new Database(source, { readonly: true, fileMustExist: true, timeout: 5000 });
db.backup(dest)
  .then(() => {
    db.close();
  })
  .catch((error) => {
    try {
      db.close();
    } catch {
      // ignore
    }
    console.error(error instanceof Error ? error.message : "backup failed");
    process.exit(1);
  });
