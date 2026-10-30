import "dotenv/config";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatHealthReport } from "../src/scheduler.ts";
import {
  formatVersionLine,
  parseVersionFile,
  readDeployVersion,
} from "../src/version.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function testParseAndFormat(): void {
  const parsed = parseVersionFile("hash=b2da422\ndeployed=2026-10-30 21:10 IST\n");
  assert(parsed?.hash === "b2da422", "parses short hash");
  assert(parsed?.deployed === "2026-10-30 21:10 IST", "parses IST deploy time");
  assert(
    formatVersionLine(parsed) === "version: b2da422, deployed 2026-10-30 21:10 IST",
    "formats /health version line",
  );
  const long = parseVersionFile(
    "hash=abcdef0123456789abcdef0123456789abcdef01\ndeployed=2026-10-30 09:00 IST\n",
  );
  assert(long?.hash === "abcdef0", "shortens a full SHA to 7 chars");
  assert(parseVersionFile("") === undefined, "empty VERSION is unknown");
  assert(
    formatVersionLine(undefined) === "version: unknown, deployed unknown",
    "missing VERSION uses unknown",
  );
}

function testReadAndHealth(): void {
  const dir = mkdtempSync(join(tmpdir(), "aadi-version-"));
  try {
    writeFileSync(
      join(dir, "VERSION"),
      "hash=c309604\ndeployed=2026-10-30 20:05 IST\n",
    );
    const info = readDeployVersion(dir);
    assert(info?.hash === "c309604", "reads VERSION from cwd");
    const report = formatHealthReport(new Date("2026-10-30T14:35:00.000Z"), dir);
    assert(report.startsWith("Aadi health\n"), "health still starts with title");
    assert(
      report.includes("version: c309604, deployed 2026-10-30 20:05 IST"),
      "health includes version line",
    );
    assert(
      formatHealthReport(new Date(), join(dir, "missing-subdir")).includes(
        "version: unknown, deployed unknown",
      ),
      "health shows unknown when VERSION is missing",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function testWriteVersionScript(): void {
  const dir = mkdtempSync(join(tmpdir(), "aadi-write-version-"));
  try {
    execFileSync(
      "sh",
      [join(ROOT, "scripts/write-version.sh"), dir, "b2da422abcdef0123456789"],
      { stdio: "pipe" },
    );
    const text = readFileSync(join(dir, "VERSION"), "utf8");
    assert(/^hash=b2da422\n/.test(text), "script writes 7-char hash");
    assert(
      /^deployed=\d{4}-\d{2}-\d{2} \d{2}:\d{2} IST$/m.test(text.trim()),
      "script writes IST deploy time",
    );
    execFileSync(
      "sh",
      [
        join(ROOT, "scripts/write-version.sh"),
        dir,
        "Vishnu99229-aadi-agent-fa0293c0deadbeef",
      ],
      { stdio: "pipe" },
    );
    const zipball = readFileSync(join(dir, "VERSION"), "utf8");
    assert(/^hash=fa0293c\n/.test(zipball), "script extracts hash from zipball dir name");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function testDeployScriptsWriteVersion(): void {
  const deploy = readFileSync(join(ROOT, "deploy.sh"), "utf8");
  assert(deploy.includes("--exclude VERSION"), "Mac deploy does not rsync VERSION");
  assert(
    deploy.includes("scripts/write-version.sh"),
    "Mac deploy writes VERSION on the phone",
  );
  assert(deploy.includes("git rev-parse HEAD"), "Mac deploy uses the current commit");

  const self = readFileSync(join(ROOT, "scripts/phone-self-deploy.sh"), "utf8");
  assert(/\nVERSION\n/.test(self), "/build rsync keeps the live VERSION file");
  assert(
    self.includes("scripts/write-version.sh"),
    "/build writes VERSION after switching the live tree",
  );
  assert(self.includes("INNER_SHA="), "/build reads the zipball commit hash");
}

testParseAndFormat();
testReadAndHealth();
testWriteVersionScript();
testDeployScriptsWriteVersion();
console.log("test-version: ok");
