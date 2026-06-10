import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

process.env.GITHUB_TOKEN = "test-github-token";
process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";
process.env.GITHUB_ALLOWED_REPOS = "local/test-repo";
process.env.AI_PROVIDER = "custom";
process.env.AI_COMMAND = 'node -e "process.exit(0)" "{{PROMPT}}"';

process.chdir(fileURLToPath(new URL("..", import.meta.url)));

const { errorOutput } = await import("../dist/jobs/processPrJob.js");

test("errorOutput surfaces git stderr instead of the bare 'Command failed' message", () => {
  // Shape of the error runFile throws on a non-zero git exit: a generic message
  // plus the real reason on stderr. The worker must report the stderr so the
  // failure is diagnosable, not just "Command failed: git ... checkout -B ...".
  const error = Object.assign(
    new Error("Command failed: git -C /repo checkout -B fix/x origin/fix/x"),
    {
      code: 1,
      stdout: "",
      stderr:
        "error: The following untracked working tree files would be overwritten by checkout:\n\tcollide.txt\nPlease move or remove them before you switch branches.\nAborting",
    },
  );

  const surfaced = errorOutput(error);

  assert.match(surfaced, /untracked working tree files would be overwritten/);
});

test("errorOutput falls back to the message when there is no stdout/stderr", () => {
  assert.equal(errorOutput(new Error("Repository is not allowlisted")), "Repository is not allowlisted");
});

test("errorOutput stringifies non-Error throws", () => {
  assert.equal(errorOutput("boom"), "boom");
});
