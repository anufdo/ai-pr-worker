import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

process.env.GITHUB_TOKEN = "supersecrettoken-abc123";
process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";
process.env.GITHUB_ALLOWED_REPOS = "local/test-repo";
process.env.AI_PROVIDER = "claude";
process.env.AI_COMMAND = 'node tests/fixtures/fake-ai-cli.mjs "{{PROMPT}}"';
process.env.AUTO_MERGE = "false";
process.env.INCLUDE_RAW_OUTPUT = "true"; // opt in to raw check snippets

process.chdir(fileURLToPath(new URL("..", import.meta.url)));

const { resultComment } = await import("../dist/jobs/processPrJob.js");

const job = {
  repo: "local/test-repo",
  repoCloneUrl: "https://github.com/local/test-repo.git",
  defaultBranch: "main",
  prNumber: 42,
  title: "t",
  body: "b",
  branch: "feature/x",
  headSha: "0".repeat(40),
  url: "https://github.com/local/test-repo/pull/42",
  action: "full-fix",
};

function checks(overrides = {}) {
  const base = {
    install: { status: "skipped", output: "" },
    lint: { status: "passed", output: "" },
    test: { status: "passed", output: "" },
    build: { status: "skipped", output: "" },
    e2e: { status: "skipped", output: "" },
  };
  return { ...base, ...overrides };
}

test("resultComment includes a raw output section for failed checks when enabled", () => {
  const body = resultComment({
    job,
    status: "Failed",
    summary: "s",
    notes: "n",
    checks: checks({ test: { status: "failed", output: "AssertionError: expected 1 to equal 2" } }),
  });
  assert.match(body, /### Raw output/);
  assert.match(body, /\[test\]/);
  assert.match(body, /AssertionError: expected 1 to equal 2/);
});

test("raw output still masks known secrets", () => {
  const body = resultComment({
    job,
    status: "Failed",
    summary: "s",
    notes: "n",
    checks: checks({ lint: { status: "failed", output: "token leaked: supersecrettoken-abc123" } }),
  });
  assert.match(body, /### Raw output/);
  assert.doesNotMatch(body, /supersecrettoken-abc123/);
});
