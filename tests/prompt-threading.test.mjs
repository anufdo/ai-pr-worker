import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

process.env.GITHUB_TOKEN = "test-github-token";
process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";
process.env.GITHUB_ALLOWED_REPOS = "local/test-repo";
process.env.AI_PROVIDER = "custom";
process.env.AI_COMMAND = 'node tests/fixtures/fake-ai-cli.mjs "{{PROMPT}}"';
process.env.AUTO_MERGE = "false";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));

const { renderActionPrompt, renderPlanningPrompt } = await import("../dist/ai/aiRunner.js");
const { hermesApplyPrompt } = await import("../dist/ai/hermesRunner.js");

function job(action) {
  return {
    repo: "local/test-repo",
    repoCloneUrl: "https://github.com/local/test-repo.git",
    defaultBranch: "main",
    prNumber: 7,
    title: "Some change",
    body: "Closes #1",
    branch: "feature/x",
    headSha: "0".repeat(40),
    url: "https://github.com/local/test-repo/pull/7",
    action,
  };
}

test("renderActionPrompt appends the action constraints and renders template vars", () => {
  const out = renderActionPrompt("TASK for {{REPO}} on {{BRANCH}}", job("add-tests"));
  assert.match(out, /TASK for local\/test-repo on feature\/x/);
  assert.match(out, /Do NOT modify any production/i);
});

test("renderActionPrompt adds nothing for an unconstrained action", () => {
  const out = renderActionPrompt("PLAIN {{TITLE}}", job("review"));
  assert.equal(out, "PLAIN Some change");
});

test("renderPlanningPrompt carries the per-action constraints", () => {
  assert.match(renderPlanningPrompt(job("pass-tests")), /mechanical rename/i);
  assert.doesNotMatch(renderPlanningPrompt(job("full-fix")), /mechanical rename/i);
});

test("hermesApplyPrompt carries the per-action constraints", () => {
  const out = hermesApplyPrompt(job("add-tests"), "/tmp/x", "the plan");
  assert.match(out, /Do NOT modify any production/i);
  assert.match(out, /the plan/);
});
