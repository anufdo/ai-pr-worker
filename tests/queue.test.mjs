import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

process.env.GITHUB_TOKEN = "test-github-token";
process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";
process.env.GITHUB_ALLOWED_REPOS = "local/test-repo";
process.env.AI_PROVIDER = "claude";
process.env.AI_COMMAND = 'node tests/fixtures/fake-ai-cli.mjs "{{PROMPT}}"';
process.env.AUTO_MERGE = "false";
process.env.MAX_CONCURRENT_JOBS = "1";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));

const { enqueuePrJob, dedupKey, __setProcessorForTests } = await import("../dist/jobs/jobQueue.js");

const calls = [];
const pending = [];
__setProcessorForTests((job) => {
  calls.push(job.action);
  return new Promise((resolve) => pending.push(resolve));
});

function make(action) {
  return {
    repo: "local/test-repo",
    repoCloneUrl: "https://github.com/local/test-repo.git",
    defaultBranch: "main",
    prNumber: 1,
    title: "t",
    body: "b",
    branch: "feature/x",
    headSha: "0".repeat(40),
    url: "https://github.com/local/test-repo/pull/1",
    action,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("dedupKey includes repo, PR, and action", () => {
  assert.equal(dedupKey(make("review")), "local/test-repo#1#review");
  assert.equal(dedupKey(make("full-fix")), "local/test-repo#1#full-fix");
});

test("enqueuing the same repo#pr#action twice processes it once", async () => {
  calls.length = 0;
  pending.length = 0;
  enqueuePrJob(make("review"));
  enqueuePrJob(make("review")); // duplicate while the first is still in flight
  assert.deepEqual(calls, ["review"]);
  pending.forEach((resolve) => resolve());
  pending.length = 0;
  await flush();
});

test("a review and a full-fix on the same PR coexist (action is part of the key)", async () => {
  calls.length = 0;
  pending.length = 0;
  enqueuePrJob(make("review"));
  enqueuePrJob(make("full-fix"));
  assert.deepEqual(calls, ["review"]); // full-fix is queued behind the concurrency limit, not dropped
  pending.shift()(); // finish the review
  await flush();
  assert.deepEqual(calls, ["review", "full-fix"]);
  pending.forEach((resolve) => resolve());
  pending.length = 0;
  await flush();
});
