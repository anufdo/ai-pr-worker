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

const { runChecks, checksPassed, defaultCheckSpecs, commitBlockingChecks } = await import("../dist/checks/runChecks.js");

const PASS = 'node -e "process.exit(0)"';
const FAIL = 'node -e "process.exit(1)"';

function outcome(status, output = "") {
  return { status, output };
}

test("runChecks reports passed / failed / skipped per the spec matrix", async () => {
  const results = await runChecks(repoRoot, [
    { name: "install", enabled: false, command: PASS },
    { name: "lint", enabled: true, command: PASS },
    { name: "test", enabled: true, command: FAIL },
    { name: "build", enabled: false, command: PASS },
    { name: "e2e", enabled: true, command: PASS },
  ]);

  assert.equal(results.install.status, "skipped");
  assert.equal(results.lint.status, "passed");
  assert.equal(results.test.status, "failed");
  assert.equal(results.build.status, "skipped");
  assert.equal(results.e2e.status, "passed");
});

test("runChecks captures command output", async () => {
  const results = await runChecks(repoRoot, [
    { name: "install", enabled: false, command: PASS },
    { name: "lint", enabled: false, command: PASS },
    { name: "test", enabled: true, command: 'node -e "console.log(\'hello-from-test\')"' },
    { name: "build", enabled: false, command: PASS },
    { name: "e2e", enabled: false, command: PASS },
  ]);
  assert.match(results.test.output, /hello-from-test/);
});

test("runChecks includes the e2e check in its default specs", () => {
  const names = defaultCheckSpecs().map((spec) => spec.name);
  assert.deepEqual(names, ["install", "lint", "test", "build", "e2e"]);
});

test("checksPassed is true when nothing failed (skipped is fine)", () => {
  assert.equal(
    checksPassed({
      install: outcome("skipped"),
      lint: outcome("passed"),
      test: outcome("passed"),
      build: outcome("skipped"),
      e2e: outcome("skipped"),
    }),
    true,
  );
});

test("checksPassed is false when any check failed", () => {
  assert.equal(
    checksPassed({
      install: outcome("skipped"),
      lint: outcome("passed"),
      test: outcome("failed", "boom"),
      build: outcome("skipped"),
      e2e: outcome("skipped"),
    }),
    false,
  );
});

function gateChecks(overrides = {}) {
  const base = {
    install: { status: "passed", output: "" },
    lint: { status: "passed", output: "" },
    test: { status: "passed", output: "" },
    build: { status: "passed", output: "" },
    e2e: { status: "skipped", output: "" },
  };
  return { ...base, ...overrides };
}

test("commitBlockingChecks: add-tests ignores a failing test check", () => {
  assert.equal(commitBlockingChecks("add-tests", gateChecks({ test: { status: "failed", output: "" } })), true);
});

test("commitBlockingChecks: add-tests still blocks on lint/build/install", () => {
  assert.equal(commitBlockingChecks("add-tests", gateChecks({ lint: { status: "failed", output: "" } })), false);
  assert.equal(commitBlockingChecks("add-tests", gateChecks({ build: { status: "failed", output: "" } })), false);
  assert.equal(commitBlockingChecks("add-tests", gateChecks({ install: { status: "failed", output: "" } })), false);
});

test("commitBlockingChecks: pass-tests and other actions require the test check", () => {
  assert.equal(commitBlockingChecks("pass-tests", gateChecks({ test: { status: "failed", output: "" } })), false);
  assert.equal(commitBlockingChecks("pass-tests", gateChecks()), true);
  assert.equal(commitBlockingChecks("full-fix", gateChecks({ test: { status: "failed", output: "" } })), false);
});
