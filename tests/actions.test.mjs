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

const { resolveAction, promptFileForAction, isReadOnlyAction, commitMessageForAction } = await import("../dist/jobs/actions.js");

test("resolveAction maps each label to its action", () => {
  assert.equal(resolveAction(["review-it"]), "review");
  assert.equal(resolveAction(["test-it"]), "test");
  assert.equal(resolveAction(["fix-review"]), "fix-review");
  assert.equal(resolveAction(["need-this"]), "full-fix");
  assert.equal(resolveAction(["e2e-it"]), "e2e");
});

test("resolveAction returns null when no action label is present", () => {
  assert.equal(resolveAction([]), null);
  assert.equal(resolveAction(["bug", "wontfix"]), null);
});

test("resolveAction applies precedence (highest automation wins)", () => {
  assert.equal(resolveAction(["review-it", "need-this"]), "full-fix");
  assert.equal(resolveAction(["review-it", "fix-review"]), "fix-review");
  assert.equal(resolveAction(["e2e-it", "test-it"]), "test");
  assert.equal(resolveAction(["review-it", "e2e-it"]), "e2e");
  assert.equal(resolveAction(["need-this", "fix-review", "test-it", "e2e-it", "review-it"]), "full-fix");
});

test("promptFileForAction maps actions to per-action prompt files", () => {
  assert.equal(promptFileForAction("review"), "pr-review.md");
  assert.equal(promptFileForAction("test"), "pr-test.md");
  assert.equal(promptFileForAction("fix-review"), "pr-fix-review.md");
  assert.equal(promptFileForAction("full-fix"), "pr-full-fix.md");
  assert.equal(promptFileForAction("e2e"), "pr-review.md");
});

test("isReadOnlyAction is true only for review and e2e", () => {
  assert.equal(isReadOnlyAction("review"), true);
  assert.equal(isReadOnlyAction("e2e"), true);
  assert.equal(isReadOnlyAction("test"), false);
  assert.equal(isReadOnlyAction("fix-review"), false);
  assert.equal(isReadOnlyAction("full-fix"), false);
});

test("commitMessageForAction names the action and PR", () => {
  assert.equal(commitMessageForAction("full-fix", 42), "AI (full-fix) for PR #42");
});

test("resolveAction maps the two new pipeline labels", () => {
  assert.equal(resolveAction(["add-tests"]), "add-tests");
  assert.equal(resolveAction(["pass-tests"]), "pass-tests");
});

test("resolveAction precedence places pass-tests above test above add-tests", () => {
  assert.equal(resolveAction(["add-tests", "pass-tests"]), "pass-tests");
  assert.equal(resolveAction(["test-it", "add-tests"]), "test");
  assert.equal(resolveAction(["fix-review", "pass-tests"]), "fix-review");
  assert.equal(resolveAction(["review-it", "add-tests"]), "add-tests");
  assert.equal(resolveAction(["need-this", "pass-tests", "add-tests"]), "full-fix");
});

test("promptFileForAction maps the new actions to their prompt files", () => {
  assert.equal(promptFileForAction("add-tests"), "pr-add-tests.md");
  assert.equal(promptFileForAction("pass-tests"), "pr-pass-tests.md");
});

test("the new actions are editing (not read-only) actions", () => {
  assert.equal(isReadOnlyAction("add-tests"), false);
  assert.equal(isReadOnlyAction("pass-tests"), false);
});
