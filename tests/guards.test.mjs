import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

process.env.GITHUB_TOKEN = "test-github-token";
process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";
process.env.GITHUB_ALLOWED_REPOS = "local/test-repo";
process.env.AI_PROVIDER = "claude";
process.env.AI_COMMAND = 'node tests/fixtures/fake-ai-cli.mjs "{{PROMPT}}"';
process.env.AUTO_MERGE = "false";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));

const { isProtectedBranch, blockedPaths, blockedFiles } = await import("../dist/jobs/guards.js");

// Mirrors the guard at webhook.ts:40 and the re-check at processPrJob.ts:62.
test("isProtectedBranch rejects main, master, and the default branch", () => {
  assert.equal(isProtectedBranch("main", "develop"), true);
  assert.equal(isProtectedBranch("master", "develop"), true);
  assert.equal(isProtectedBranch("develop", "develop"), true);
});

test("isProtectedBranch allows ordinary feature branches", () => {
  assert.equal(isProtectedBranch("feature/x", "main"), false);
  assert.equal(isProtectedBranch("fix/123", "main"), false);
});

test("blockedFiles matches sensitive paths the worker must never commit", () => {
  for (const file of [".env", ".env.production", "config/.env.local", "deploy/run.sh", "deployment/values.yaml", "credentials.json", "app/secrets.ts", ".git/config"]) {
    assert.equal(blockedFiles.test(file), true, `expected blocked: ${file}`);
  }
});

test("blockedFiles does not match ordinary source files", () => {
  for (const file of ["src/index.ts", "README.md", "environment.ts", "tests/secret-handling.test.ts"]) {
    assert.equal(blockedFiles.test(file), false, `expected allowed: ${file}`);
  }
});

test("blockedPaths returns only the blocked entries and normalizes backslashes", () => {
  const files = ["src/index.ts", "config\\.env.local", "README.md", "deploy\\run.sh"];
  assert.deepEqual(blockedPaths(files), ["config\\.env.local", "deploy\\run.sh"]);
});

test("blockedPaths returns an empty array when nothing is blocked", () => {
  assert.deepEqual(blockedPaths(["src/a.ts", "src/b.ts"]), []);
});
