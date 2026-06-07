import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.GITHUB_TOKEN = "test-github-token";
process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";
process.env.GITHUB_ALLOWED_REPOS = "local/test-repo";
process.env.AI_PROVIDER = "claude";
process.env.AI_COMMAND = 'node tests/fixtures/fake-ai-cli.mjs "{{PROMPT}}"';
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const hermesFixture = fileURLToPath(new URL("./fixtures/fake-hermes-edit-cli.mjs", import.meta.url)).replaceAll("\\", "/");
process.env.HERMES_COMMAND = `node "${hermesFixture}" "{{MESSAGE}}"`;
process.env.AUTO_MERGE = "false";

process.chdir(repoRoot);

const { hermesApplyPrompt, runHermesApply } = await import("../dist/ai/hermesRunner.js");
const { resultComment } = await import("../dist/jobs/processPrJob.js");

const job = {
  repo: "local/test-repo",
  repoCloneUrl: "https://github.com/local/test-repo.git",
  defaultBranch: "main",
  prNumber: 42,
  title: "Add thing",
  body: "body",
  branch: "feature/x",
  headSha: "0".repeat(40),
  url: "https://github.com/local/test-repo/pull/42",
  action: "full-fix",
};

test("hermesApplyPrompt gives Hermes repo context and the Claude plan", () => {
  const prompt = hermesApplyPrompt(job, "/tmp/repo", "Step 1: edit a file");

  assert.match(prompt, /Working directory: \/tmp\/repo/);
  assert.match(prompt, /Claude read-only plan:/);
  assert.match(prompt, /Step 1: edit a file/);
  assert.match(prompt, /Do not commit, push, change git history/);
});

test("runHermesApply executes the configured Hermes command in the checkout", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ai-pr-worker-hermes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const output = await runHermesApply(job, dir, "Plan from Claude");
  const changedFile = path.join(dir, "hermes-change.txt");

  assert.match(output, /hermes applied the plan/);
  assert.equal(existsSync(changedFile), true);
  assert.match(readFileSync(changedFile, "utf8"), /true/);
});

test("resultComment includes Hermes apply status", () => {
  const body = resultComment({
    job,
    status: "Success",
    aiStatus: "passed",
    hermesStatus: "passed",
    summary: "- Updated 1 file.",
    notes: "n",
  });

  assert.match(body, /### Hermes apply\n- Status: passed/);
});

test("Hermes failure comment keeps Hermes output before long Claude plan", () => {
  const body = resultComment({
    job,
    status: "Failed",
    aiStatus: "passed",
    hermesStatus: "failed",
    summary: "- Hermes failed.",
    notes: [`Hermes output:\nusage: hermes chat <agent> <message>`, `Claude plan:\n${"plan ".repeat(2000)}`].join("\n\n"),
  });

  assert.match(body, /Hermes output:\nusage: hermes chat <agent> <message>/);
  assert.ok(body.indexOf("Hermes output:") < body.indexOf("Claude plan:"));
});
