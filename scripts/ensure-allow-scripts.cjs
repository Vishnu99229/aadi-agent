#!/usr/bin/env node
"use strict";

const { readFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

const pkgPath = resolve(process.cwd(), "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const allow = { ...(pkg.allowScripts || {}) };
const sqlite = pkg.dependencies?.["better-sqlite3"];
if (typeof sqlite === "string" && sqlite) {
  const version = sqlite.replace(/^[^\d]*/, "");
  if (version) {
    allow[`better-sqlite3@${version}`] = true;
  }
}
const hasEsbuild = Object.keys(allow).some((key) => key.startsWith("esbuild@"));
if (!hasEsbuild) {
  allow["esbuild@0.28.2"] = true;
}
for (const key of Object.keys(allow)) {
  if (key.startsWith("better-sqlite3@") || key.startsWith("esbuild@")) {
    allow[key] = true;
  }
}
pkg.allowScripts = allow;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
