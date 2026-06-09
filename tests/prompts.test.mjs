import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

function prompt(name) {
  return readFileSync(new URL(`../prompts/${name}`, import.meta.url), "utf8");
}

test("pr-add-tests prompt is strictly test-only and templated", () => {
  const p = prompt("pr-add-tests.md");
  assert.match(p, /Only add or edit test files/i);
  assert.match(p, /Do NOT modify production code/i);
  assert.match(p, /\{\{REPO\}\}/);
  assert.match(p, /\{\{PR_BODY\}\}/);
});

test("pr-pass-tests prompt freezes test logic and is templated", () => {
  const p = prompt("pr-pass-tests.md");
  assert.match(p, /production code only/i);
  assert.match(p, /mechanical rename/i);
  assert.match(p, /Do NOT change test logic/i);
  assert.match(p, /Treat the tests as the specification/i);
  assert.match(p, /STOP/);
  assert.match(p, /\{\{REPO\}\}/);
  assert.match(p, /\{\{BRANCH\}\}/);
  assert.match(p, /\{\{PR_BODY\}\}/);
});
