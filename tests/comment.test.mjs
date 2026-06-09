import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

process.env.GITHUB_TOKEN = "supersecrettoken-abc123";
process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";
process.env.GITHUB_ALLOWED_REPOS = "local/test-repo";
process.env.AI_PROVIDER = "claude";
process.env.AI_COMMAND = 'node tests/fixtures/fake-ai-cli.mjs "{{PROMPT}}"';
process.env.AUTO_MERGE = "false";
// INCLUDE_RAW_OUTPUT intentionally unset → defaults to false (no raw leakage).

process.chdir(fileURLToPath(new URL("..", import.meta.url)));

const { resultComment, looksPermissionBlocked, buildReportComments } = await import("../dist/jobs/processPrJob.js");

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

test("resultComment reports the action, repo, PR, and branch", () => {
  const body = resultComment({ job, status: "Success", aiStatus: "passed", summary: "- done", notes: "notes", checks: checks(), commit: "deadbeef" });
  assert.match(body, /Action: `full-fix`/);
  assert.match(body, /Repo: local\/test-repo/);
  assert.match(body, /PR: #42/);
  assert.match(body, /Branch: `feature\/x`/);
  assert.match(body, /### AI command\n- Status: passed/);
});

test("resultComment lists all five checks including e2e", () => {
  const body = resultComment({ job, status: "Success", summary: "s", notes: "n", checks: checks() });
  assert.match(body, /- Install: skipped/);
  assert.match(body, /- Lint: passed/);
  assert.match(body, /- Test: passed/);
  assert.match(body, /- Build: skipped/);
  assert.match(body, /- E2E: skipped/);
});

test("resultComment shows an E2E summary only when e2e ran", () => {
  const ran = resultComment({ job, status: "Reviewed", summary: "s", notes: "n", checks: checks({ e2e: { status: "passed", output: "e2e ran 5 specs" } }) });
  assert.match(ran, /### E2E summary/);
  assert.match(ran, /e2e ran 5 specs/);

  const skipped = resultComment({ job, status: "Reviewed", summary: "s", notes: "n", checks: checks() });
  assert.doesNotMatch(skipped, /### E2E summary/);
});

test("resultComment includes the commit SHA only when a commit was created", () => {
  const withCommit = resultComment({ job, status: "Success", summary: "s", notes: "n", checks: checks(), commit: "abc1234" });
  assert.match(withCommit, /### Commit\n`abc1234`/);

  const without = resultComment({ job, status: "No changes", summary: "s", notes: "n", checks: checks() });
  assert.doesNotMatch(without, /### Commit/);
});

test("resultComment masks known secrets that appear in the notes", () => {
  const body = resultComment({ job, status: "Reviewed", summary: "s", notes: "leaked supersecrettoken-abc123 here", checks: checks() });
  assert.doesNotMatch(body, /supersecrettoken-abc123/);
  assert.match(body, /\*\*\*/);
});

test("resultComment length-caps long notes", () => {
  const body = resultComment({ job, status: "Reviewed", summary: "s", notes: "A".repeat(5000), checks: checks() });
  assert.match(body, /truncated, \d+ more characters/);
});

test("looksPermissionBlocked flags AI output that reports a blocked edit", () => {
  assert.equal(looksPermissionBlocked("I'm unable to edit the test files — permission is being blocked."), true);
  assert.equal(looksPermissionBlocked("Permission denied while writing the file."), true);
  assert.equal(looksPermissionBlocked("The edits were blocked by the sandbox."), true);
  assert.equal(looksPermissionBlocked("Applied the requested change and updated the tests."), false);
});

test("resultComment does not include raw check output when INCLUDE_RAW_OUTPUT is off", () => {
  const body = resultComment({
    job,
    status: "Failed",
    summary: "s",
    notes: "n",
    checks: checks({ test: { status: "failed", output: "secret-failure-detail-xyz" } }),
  });
  assert.doesNotMatch(body, /### Raw output/);
  assert.doesNotMatch(body, /secret-failure-detail-xyz/);
});

test("buildReportComments keeps short notes inline with no detail comments", () => {
  const { main, details } = buildReportComments({ job, status: "Reviewed", summary: "s", notes: "short notes", checks: checks() });
  assert.match(main, /short notes/);
  assert.deepEqual(details, []);
});

test("buildReportComments splits over-cap notes into numbered detail comments", () => {
  const notes = "A".repeat(30000);
  const { main, details } = buildReportComments({ job, status: "Reviewed", summary: "s", notes, checks: checks() });
  assert.match(main, /truncated, \d+ more characters/);
  assert.match(main, /full output in the detail comments below/);
  assert.equal(details.length, 3); // 30000 / 12000 -> 3 chunks
  assert.match(details[0], /## AI PR Worker Detail: AI output \(1\/3\)/);
  assert.ok(details.every((d) => d.includes("AAAA")));
});
