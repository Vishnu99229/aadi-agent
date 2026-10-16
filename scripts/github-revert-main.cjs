#!/usr/bin/env node
"use strict";

const OWNER = "Vishnu99229";
const REPO = "aadi-agent";
const API = "https://api.github.com";
const API_VERSION = "2022-11-28";

function revertCommitMessage(prTitle) {
  const title = String(prTitle || "")
    .replace(/\s+/g, " ")
    .trim() || "merged pull request";
  return `Revert ${title} — failed health check`;
}

function token() {
  return String(process.env.GITHUB_TOKEN || "").trim();
}

async function github(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = {};
    }
  }
  if (!response.ok) {
    console.error(`GitHub ${method} ${path}: status=${response.status}`);
    const error = new Error(`GitHub API returned ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function revertMergedPull(prNumber) {
  const pr = await github("GET", `/repos/${OWNER}/${REPO}/pulls/${prNumber}`);
  const title = typeof pr.title === "string" ? pr.title : "";
  const mergeSha =
    typeof pr.merge_commit_sha === "string" ? pr.merge_commit_sha : "";
  if (!mergeSha) {
    throw new Error("PR has no merge commit.");
  }
  const ref = await github(
    "GET",
    `/repos/${OWNER}/${REPO}/git/ref/heads/main`,
  );
  const mainSha = ref.object && typeof ref.object.sha === "string" ? ref.object.sha : "";
  if (!mainSha) {
    throw new Error("Could not read main.");
  }
  if (mainSha !== mergeSha) {
    throw new Error("main has moved past the merge commit.");
  }
  const mergeCommit = await github(
    "GET",
    `/repos/${OWNER}/${REPO}/git/commits/${mergeSha}`,
  );
  const parentSha = mergeCommit.parents?.[0]?.sha;
  if (typeof parentSha !== "string" || !parentSha) {
    throw new Error("Merge commit has no parent.");
  }
  const parentCommit = await github(
    "GET",
    `/repos/${OWNER}/${REPO}/git/commits/${parentSha}`,
  );
  const treeSha = parentCommit.tree?.sha;
  if (typeof treeSha !== "string" || !treeSha) {
    throw new Error("Parent commit has no tree.");
  }
  const message = revertCommitMessage(title);
  const created = await github("POST", `/repos/${OWNER}/${REPO}/git/commits`, {
    message,
    tree: treeSha,
    parents: [mergeSha],
  });
  const newSha = typeof created.sha === "string" ? created.sha : "";
  if (!newSha) {
    throw new Error("Create commit returned no SHA.");
  }
  await github("PATCH", `/repos/${OWNER}/${REPO}/git/refs/heads/main`, {
    sha: newSha,
    force: false,
  });
  return { ok: true, message, mergeSha, revertSha: newSha };
}

async function main() {
  const prNumber = Number(process.argv[2]);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    process.stdout.write(JSON.stringify({ ok: false, error: "bad_pr" }));
    process.exit(1);
  }
  if (!token()) {
    process.stdout.write(JSON.stringify({ ok: false, error: "missing_token" }));
    process.exit(1);
  }
  try {
    const result = await revertMergedPull(prNumber);
    process.stdout.write(
      JSON.stringify({
        ok: true,
        message: result.message,
        mergeSha: result.mergeSha,
      }),
    );
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(`GitHub revert failed (${errorType})`);
    let mergeSha;
    try {
      const pr = await github(
        "GET",
        `/repos/${OWNER}/${REPO}/pulls/${prNumber}`,
      );
      if (typeof pr.merge_commit_sha === "string") {
        mergeSha = pr.merge_commit_sha;
      }
    } catch {
      // ids only; ignore
    }
    process.stdout.write(
      JSON.stringify({ ok: false, mergeSha: mergeSha || undefined }),
    );
    process.exit(1);
  }
}

void main();
