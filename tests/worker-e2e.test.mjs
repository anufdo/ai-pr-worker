import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Worker-level e2e harness (no database, no GitHub, no network). It drives the
// real worker code paths — runAi -> runChecks -> changedFiles -> commitAndPush —
// against a throwaway local git repo, using a fake AI CLI that actually edits a
// file. AUTO_PUSH is off, so commitAndPush commits locally and never pushes.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/fake-ai-edit-cli.mjs", import.meta.url)).replaceAll("\\", "/");

process.env.GITHUB_TOKEN = "test-github-token";
process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";
process.env.GITHUB_ALLOWED_REPOS = "local/test-repo";
process.env.AI_PROVIDER = "custom";
process.env.AI_COMMAND = `node "${fixture}" "{{PROMPT}}"`;
process.env.AUTO_MERGE = "false";
process.env.AUTO_PUSH = "false";

process.chdir(repoRoot); // runAi reads prompts/ relative to cwd

const { runAi } = await import("../dist/ai/aiRunner.js");
const { runChecks, checksPassed } = await import("../dist/checks/runChecks.js");
const { changedFiles, commitAndPush } = await import("../dist/git/gitManager.js");
const { blockedPaths } = await import("../dist/jobs/guards.js");

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

function makeRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ai-pr-worker-e2e-"));
  git(dir, "init", "--quiet");
  git(dir, "checkout", "-q", "-b", "feature/x");
  git(dir, "config", "user.email", "worker@example.com");
  git(dir, "config", "user.name", "AI PR Worker Test");
  writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "initial");
  return dir;
}

function job(action, dir) {
  return {
    repo: "local/test-repo",
    repoCloneUrl: "https://github.com/local/test-repo.git",
    defaultBranch: "main",
    prNumber: 7,
    title: "Add a thing",
    body: "Closes #1",
    branch: "feature/x",
    headSha: "0".repeat(40),
    url: "https://github.com/local/test-repo/pull/7",
    action,
  };
}

const passingChecks = [
  { name: "install", enabled: false, command: "" },
  { name: "lint", enabled: false, command: "" },
  { name: "test", enabled: true, command: 'node -e "process.exit(0)"' },
  { name: "build", enabled: false, command: "" },
  { name: "e2e", enabled: false, command: "" },
];

test("full-fix slice: AI edits a file, checks pass, the worker commits locally", (t) => {
  delete process.env.FAKE_AI_EDIT_FILE; // default edits ai-change.txt
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  return (async () => {
    const aiOutput = await runAi(job("full-fix", dir), dir);
    assert.match(aiOutput, /applied the requested change/);
    assert.ok(existsSync(path.join(dir, "ai-change.txt")), "fake AI should have written the file");

    const checks = await runChecks(dir, passingChecks);
    assert.equal(checksPassed(checks), true);

    const files = await changedFiles(dir);
    assert.ok(files.includes("ai-change.txt"), `expected ai-change.txt in ${JSON.stringify(files)}`);
    assert.deepEqual(blockedPaths(files), []);

    const sha = await commitAndPush(dir, "feature/x", "AI (full-fix) for PR #7");
    assert.match(sha, /^[0-9a-f]{40}$/);

    // The commit really landed on the branch with our message and file.
    assert.match(git(dir, "log", "-1", "--pretty=%s"), /AI \(full-fix\) for PR #7/);
    assert.match(git(dir, "show", "--name-only", "--pretty=format:", "HEAD"), /ai-change\.txt/);
    // AUTO_PUSH=false → no remote was contacted (none is configured).
    assert.equal(git(dir, "remote").trim(), "");
  })();
});

test("blocked-file slice: the worker refuses to commit a protected file the AI touched", (t) => {
  process.env.FAKE_AI_EDIT_FILE = ".env";
  const dir = makeRepo();
  t.after(() => {
    delete process.env.FAKE_AI_EDIT_FILE;
    rmSync(dir, { recursive: true, force: true });
  });

  return (async () => {
    await runAi(job("full-fix", dir), dir);
    const files = await changedFiles(dir);
    assert.ok(files.includes(".env"), `expected .env in ${JSON.stringify(files)}`);
    assert.deepEqual(blockedPaths(files), [".env"]); // worker would throw before committing
  })();
});

test("no-changes slice: a read-only review makes no edits to commit", (t) => {
  delete process.env.FAKE_AI_EDIT_FILE;
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  return (async () => {
    // The review prompt is read-only; simulate it by running checks without an AI edit.
    const checks = await runChecks(dir, passingChecks);
    assert.equal(checksPassed(checks), true);
    const files = await changedFiles(dir);
    assert.deepEqual(files, []);
  })();
});
