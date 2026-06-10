import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// gitManager imports config, which needs a minimal valid environment.
process.env.GITHUB_TOKEN = "test-github-token";
process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";
process.env.GITHUB_ALLOWED_REPOS = "local/test-repo";
process.env.AI_PROVIDER = "custom";
process.env.AI_COMMAND = 'node -e "process.exit(0)" "{{PROMPT}}"';

const { checkoutBranch } = await import("../dist/git/gitManager.js");

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

// A throwaway "remote" repo with `main` plus a `feature/x` branch that tracks a
// file `collide.txt`, then a local clone of it (the worker's persistent clone),
// left checked out on `main`.
function makeClone() {
  const origin = mkdtempSync(path.join(os.tmpdir(), "ai-pr-worker-origin-"));
  git(origin, "init", "-q");
  git(origin, "checkout", "-q", "-b", "main");
  git(origin, "config", "user.email", "worker@example.com");
  git(origin, "config", "user.name", "AI PR Worker Test");
  writeFileSync(path.join(origin, "seed.txt"), "seed\n");
  git(origin, "add", "-A");
  git(origin, "commit", "-q", "-m", "init");
  git(origin, "checkout", "-q", "-b", "feature/x");
  writeFileSync(path.join(origin, "collide.txt"), "from-branch\n");
  git(origin, "add", "-A");
  git(origin, "commit", "-q", "-m", "add collide.txt on feature/x");
  git(origin, "checkout", "-q", "main"); // leave origin's HEAD on main

  const work = mkdtempSync(path.join(os.tmpdir(), "ai-pr-worker-clone-"));
  execFileSync("git", ["clone", "-q", origin, work]);
  git(work, "config", "user.email", "worker@example.com");
  git(work, "config", "user.name", "AI PR Worker Test");
  return { origin, work };
}

test("checkoutBranch switches to the PR branch even when a leftover untracked file is in the way", (t) => {
  const { origin, work } = makeClone();
  t.after(() => {
    rmSync(origin, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  return (async () => {
    // Simulate state left behind by a previous job on the persistent clone: an
    // untracked file at a path that the target branch tracks. Plain
    // `git checkout -B` aborts here ("untracked working tree files would be
    // overwritten by checkout"), which is the failure the worker hit.
    writeFileSync(path.join(work, "collide.txt"), "leftover-untracked\n");

    await checkoutBranch(work, "feature/x");

    assert.equal(git(work, "rev-parse", "--abbrev-ref", "HEAD").trim(), "feature/x");
    // The in-the-way file was replaced by the branch's tracked version
    // (line endings normalized: git may apply autocrlf on Windows).
    assert.equal(readFileSync(path.join(work, "collide.txt"), "utf8").replace(/\r\n/g, "\n"), "from-branch\n");
    // Working tree pinned cleanly to the remote branch.
    assert.equal(git(work, "status", "--porcelain").trim(), "");
  })();
});
