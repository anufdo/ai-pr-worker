import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

process.env.GITHUB_TOKEN = "test-github-token";
process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";
process.env.GITHUB_ALLOWED_REPOS = "local/test-repo";
process.env.AI_PROVIDER = "claude";
process.env.AI_COMMAND = 'node tests/fixtures/fake-ai-cli.mjs "{{PROMPT}}"';
process.env.AUTO_MERGE = "false";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
process.chdir(repoRoot);

const { runFile } = await import("../dist/utils/exec.js");

test("runFile resolves with captured stdout for a quick command", async () => {
  const { stdout } = await runFile("node", ["-e", "process.stdout.write('ok')"], repoRoot);
  assert.equal(stdout, "ok");
});

test("runFile kills the child and rejects when the timeout elapses", async () => {
  await assert.rejects(
    runFile("node", ["tests/fixtures/sleep-cli.mjs"], repoRoot, { timeoutMs: 250 }),
    (error) => {
      assert.equal(error.signal, "SIGTERM");
      assert.match(error.message, /Command failed/);
      return true;
    },
  );
});

test("runFile kills the child and rejects when output exceeds the cap", async () => {
  await assert.rejects(
    runFile("node", ["tests/fixtures/flood-cli.mjs"], repoRoot, { maxOutputBytes: 200_000 }),
    (error) => {
      assert.match(error.message, /output exceeded 200000 bytes/);
      return true;
    },
  );
});
