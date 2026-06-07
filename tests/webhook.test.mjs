import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

process.env.GITHUB_TOKEN = "test-github-token";
process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";
process.env.GITHUB_ALLOWED_REPOS = "local/test-repo";
process.env.AI_PROVIDER = "claude";
process.env.AI_COMMAND = 'node tests/fixtures/fake-ai-cli.mjs "{{PROMPT}}"';
process.env.AUTO_MERGE = "false";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));

const { validSignature, shouldRun } = await import("../dist/github/webhook.js");

const SECRET = "test-webhook-secret";
function sign(body) {
  return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

const allowSettings = { allowedRepos: new Set(["local/test-repo"]), allowDraftPrs: false };

function payload(overrides = {}) {
  const pr = {
    number: 1,
    title: "Test PR",
    body: "body",
    state: "open",
    draft: false,
    merged: false,
    html_url: "https://github.com/local/test-repo/pull/1",
    labels: [{ name: "need-this" }],
    head: { ref: "feature/x", sha: "0".repeat(40), repo: { full_name: "local/test-repo", clone_url: "https://github.com/local/test-repo.git" } },
    base: { ref: "main" },
    ...overrides.pull_request,
  };
  return {
    action: "labeled",
    repository: { full_name: "local/test-repo", default_branch: "main" },
    ...overrides,
    pull_request: pr,
  };
}

// --- validSignature ---

test("validSignature accepts a correct signature", () => {
  const body = Buffer.from('{"hello":"world"}');
  assert.equal(validSignature(body, sign(body)), true);
});

test("validSignature rejects an incorrect signature", () => {
  const body = Buffer.from('{"hello":"world"}');
  const wrong = sign(Buffer.from("different body"));
  assert.equal(validSignature(body, wrong), false);
});

test("validSignature rejects a missing signature", () => {
  assert.equal(validSignature(Buffer.from("x"), undefined), false);
});

test("validSignature rejects a length-mismatched signature without throwing", () => {
  const body = Buffer.from("x");
  assert.equal(validSignature(body, "sha256=deadbeef"), false);
});

test("validSignature rejects a signature without the sha256= prefix", () => {
  const body = Buffer.from("x");
  const hex = createHmac("sha256", SECRET).update(body).digest("hex");
  assert.equal(validSignature(body, hex), false);
});

// --- shouldRun: gate ---

test("shouldRun ignores non-PR actions", () => {
  const decision = shouldRun(payload({ action: "closed" }), allowSettings);
  assert.equal(decision.run, false);
  assert.equal(decision.reason, "ignored action");
});

test("shouldRun accepts an allowlisted, labeled PR and resolves the action", () => {
  const decision = shouldRun(payload(), allowSettings);
  assert.equal(decision.run, true);
  assert.equal(decision.action, "full-fix");
});

test("shouldRun rejects a repo that is not allowlisted", () => {
  const decision = shouldRun(payload(), { allowedRepos: new Set(), allowDraftPrs: false });
  assert.equal(decision.run, false);
  assert.equal(decision.reason, "repository is not allowlisted");
});

test("shouldRun rejects fork PRs", () => {
  const decision = shouldRun(
    payload({ pull_request: { head: { ref: "feature/x", sha: "0".repeat(40), repo: { full_name: "someone/fork", clone_url: "https://github.com/someone/fork.git" } } } }),
    allowSettings,
  );
  assert.equal(decision.run, false);
  assert.equal(decision.reason, "fork PRs are not supported");
});

test("shouldRun rejects a closed/merged PR", () => {
  const decision = shouldRun(payload({ pull_request: { state: "closed" } }), allowSettings);
  assert.equal(decision.run, false);
  assert.equal(decision.reason, "PR is not open");
});

test("shouldRun rejects work targeting a protected head branch", () => {
  const decision = shouldRun(
    payload({ pull_request: { head: { ref: "main", sha: "0".repeat(40), repo: { full_name: "local/test-repo", clone_url: "https://github.com/local/test-repo.git" } } } }),
    allowSettings,
  );
  assert.equal(decision.run, false);
  assert.equal(decision.reason, "refusing protected branch");
});

test("shouldRun rejects a draft PR when drafts are disabled", () => {
  const decision = shouldRun(payload({ pull_request: { draft: true } }), { allowedRepos: new Set(["local/test-repo"]), allowDraftPrs: false });
  assert.equal(decision.run, false);
  assert.equal(decision.reason, "draft PRs are disabled");
});

test("shouldRun accepts a draft PR when drafts are enabled", () => {
  const decision = shouldRun(payload({ pull_request: { draft: true } }), { allowedRepos: new Set(["local/test-repo"]), allowDraftPrs: true });
  assert.equal(decision.run, true);
  assert.equal(decision.action, "full-fix");
});

test("shouldRun rejects a PR with no recognized action label", () => {
  const decision = shouldRun(payload({ pull_request: { labels: [{ name: "unrelated" }] } }), allowSettings);
  assert.equal(decision.run, false);
  assert.equal(decision.reason, "no action label present");
});

// --- shouldRun: action routing + precedence ---

test("shouldRun resolves review-it to the review action", () => {
  const decision = shouldRun(payload({ pull_request: { labels: [{ name: "review-it" }] } }), allowSettings);
  assert.equal(decision.action, "review");
});

test("shouldRun applies precedence: need-this beats review-it", () => {
  const decision = shouldRun(payload({ pull_request: { labels: [{ name: "review-it" }, { name: "need-this" }] } }), allowSettings);
  assert.equal(decision.action, "full-fix");
});

test("shouldRun applies precedence: test-it beats e2e-it and review-it", () => {
  const decision = shouldRun(payload({ pull_request: { labels: [{ name: "review-it" }, { name: "e2e-it" }, { name: "test-it" }] } }), allowSettings);
  assert.equal(decision.action, "test");
});
