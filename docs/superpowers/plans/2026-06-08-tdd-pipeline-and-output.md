# 3-Stage TDD Pipeline + Un-truncated PR Output — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two new label-driven actions — `add-tests` (strictly test-only, edge cases) and `pass-tests` (edit production code to make the committed tests pass, tests frozen except mechanical renames) — and stop truncating the AI's review/plan in the PR comment.

**Architecture:** Three stages chain through the PR branch's committed state (the worker is stateless). `add-tests` may commit *red* tests (the test check is informational for that action only); `pass-tests` commits only when all checks pass. Hard per-action constraints live in one function (`actionConstraints`) and are injected into the direct prompt, the Hermes planning prompt, and the Hermes apply prompt so they hold on every path. A guard restricts `add-tests` to test files; another blocks `pass-tests` from deleting tests. Full AI output that exceeds the comment cap is posted across follow-up "detail" comments via the existing splitter.

**Tech Stack:** Node.js + TypeScript (ESM, compiled `src/` → `dist/`), `node:test` + `node:assert/strict`, Express webhook worker, Octokit, optional Hermes executor.

---

## Conventions for this plan

- **Build before testing.** Tests import compiled code from `dist/`. Run `npm run build` before `node --test ...`. `npm test` does both (`npm run build && node --test tests/*.test.mjs`).
- **Windows/PowerShell:** if `npm.ps1` is blocked, use `npm.cmd ...` or the Bash tool. PowerShell 5.1 has no `&&`; run the two commands on separate lines.
- **Commit messages:** end every commit message with the trailer
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Test env:** any test that imports a module which (transitively) imports `../config.js` MUST set `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_ALLOWED_REPOS`, `AI_COMMAND` (and `AI_PROVIDER=custom`, `AUTO_MERGE=false`) *before* the dynamic import. `guards.ts` imports nothing and needs no env.

## File map

| File | Responsibility | Change |
|------|----------------|--------|
| `src/jobs/actions.ts` | label→action routing, precedence, prompt-file map, per-action constraints | Modify |
| `src/ai/aiRunner.ts` | render prompts, run AI CLI, planning prompt | Modify |
| `src/ai/hermesRunner.ts` | Hermes apply prompt + run | Modify |
| `src/config.ts` | env config + `TEST_FILE_PATTERN` | Modify |
| `src/jobs/guards.ts` | path guards (`nonTestPaths`) | Modify |
| `src/git/gitManager.ts` | git helpers (`deletedPaths`) | Modify |
| `src/checks/runChecks.ts` | check results + `commitBlockingChecks` | Modify |
| `src/jobs/processPrJob.ts` | orchestration, commit gate, guards, `buildReportComments`/`reportResult` | Modify |
| `prompts/pr-add-tests.md` | stage-2 prompt (test-only) | Create |
| `prompts/pr-pass-tests.md` | stage-3 prompt (make tests pass) | Create |
| `tests/actions.test.mjs` | routing/precedence/constraints | Modify |
| `tests/prompts.test.mjs` | prompt-file content | Create |
| `tests/prompt-threading.test.mjs` | constraints injected into prompts | Create |
| `tests/guards.test.mjs` | `nonTestPaths` | Modify |
| `tests/checks.test.mjs` | `commitBlockingChecks` | Modify |
| `tests/comment.test.mjs` | `buildReportComments` splitting | Modify |
| `tests/worker-e2e.test.mjs` | `deletedPaths`, add-tests/pass-tests slices | Modify |
| `README.md`, `docs/IMPROVEMENT_PLAN.md`, `.env.example` | docs | Modify |

---

## Task 1: Add `add-tests` and `pass-tests` actions + routing + precedence

**Files:**
- Modify: `src/jobs/actions.ts:5`, `src/jobs/actions.ts:15-21`, `src/jobs/actions.ts:44-50`
- Test: `tests/actions.test.mjs`

- [ ] **Step 1: Write the failing tests**

In `tests/actions.test.mjs`, add these tests after the existing `promptFileForAction` test (around line 43):

```javascript
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
```

- [ ] **Step 2: Run the tests to verify they fail**

```
npm run build
node --test tests/actions.test.mjs
```
Expected: FAIL — `promptFileForAction("add-tests")` returns `undefined`; `resolveAction(["add-tests"])` returns `null`. (TypeScript also errors that `"add-tests"`/`"pass-tests"` are not `PrAction`s when `npm run build` runs.)

- [ ] **Step 3: Add the actions to the type, routing table, and prompt map**

In `src/jobs/actions.ts`, change line 5:

```typescript
export type PrAction = "review" | "test" | "fix-review" | "full-fix" | "e2e" | "add-tests" | "pass-tests";
```

Replace `ACTION_LABELS` (lines 15-21) with (note precedence: `pass-tests` > `test` > `add-tests`):

```typescript
export const ACTION_LABELS: readonly ActionLabel[] = [
  { label: "need-this", action: "full-fix" },
  { label: "fix-review", action: "fix-review" },
  { label: "pass-tests", action: "pass-tests" },
  { label: "test-it", action: "test" },
  { label: "add-tests", action: "add-tests" },
  { label: "e2e-it", action: "e2e" },
  { label: "review-it", action: "review" },
];
```

Replace `PROMPT_FILES` (lines 44-50) with:

```typescript
const PROMPT_FILES: Record<PrAction, string> = {
  review: "pr-review.md",
  test: "pr-test.md",
  "fix-review": "pr-fix-review.md",
  "full-fix": "pr-full-fix.md",
  "add-tests": "pr-add-tests.md",
  "pass-tests": "pr-pass-tests.md",
  e2e: "pr-review.md",
};
```

`READ_ONLY_ACTIONS` (line 24) is unchanged — both new actions are editing actions.

- [ ] **Step 4: Run the tests to verify they pass**

```
npm run build
node --test tests/actions.test.mjs
```
Expected: PASS (all action tests, old and new).

- [ ] **Step 5: Commit**

```
git add src/jobs/actions.ts tests/actions.test.mjs
git commit -m "feat: add add-tests and pass-tests actions with routing and precedence"
```

---

## Task 2: Single source of truth for per-action hard constraints

**Files:**
- Modify: `src/jobs/actions.ts` (add `actionConstraints`)
- Test: `tests/actions.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add to `tests/actions.test.mjs` (and add `actionConstraints` to the destructured import on line 14, so it reads `const { resolveAction, promptFileForAction, isReadOnlyAction, commitMessageForAction, actionConstraints } = await import("../dist/jobs/actions.js");`):

```javascript
test("actionConstraints for add-tests forbids production edits", () => {
  const c = actionConstraints("add-tests");
  assert.match(c, /ONLY add or edit test files/i);
  assert.match(c, /Do NOT modify any production/i);
  assert.match(c, /MAY fail against the current code/i);
});

test("actionConstraints for pass-tests freezes test logic", () => {
  const c = actionConstraints("pass-tests");
  assert.match(c, /PRODUCTION code only/i);
  assert.match(c, /mechanical rename/i);
  assert.match(c, /Do NOT change test logic/i);
  assert.match(c, /STOP and report/i);
});

test("actionConstraints is empty for actions without extra constraints", () => {
  assert.equal(actionConstraints("review"), "");
  assert.equal(actionConstraints("full-fix"), "");
  assert.equal(actionConstraints("test"), "");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```
npm run build
node --test tests/actions.test.mjs
```
Expected: FAIL — `actionConstraints is not a function` / build error (not exported).

- [ ] **Step 3: Implement `actionConstraints`**

Add to `src/jobs/actions.ts`, after `commitMessageForAction` (end of file):

```typescript
// Canonical, load-bearing constraints for an action. This is the single source
// of truth for what an action may change; it is appended to the direct prompt and
// injected into the Hermes planning and apply prompts so the rules hold on every
// path (Hermes on or off). Only the two pipeline actions add constraints; every
// other action returns "" to preserve its existing behavior.
export function actionConstraints(action: PrAction): string {
  switch (action) {
    case "add-tests":
      return [
        "HARD CONSTRAINTS for this task (add-tests):",
        "- You may ONLY add or edit test files and minimal test fixtures/helpers.",
        "- Do NOT modify any production (non-test) code, for any reason — not even to fix a bug you find.",
        "- Cover the changed behavior: happy path, edge cases, and realistic failure scenarios.",
        "- The new tests MAY fail against the current code — that is expected and acceptable here; a later `pass-tests` run will make them pass.",
        "- Do not weaken a test just to make it pass. List every test file you add or change.",
      ].join("\n");
    case "pass-tests":
      return [
        "HARD CONSTRAINTS for this task (pass-tests):",
        "- Make the existing committed tests pass by editing PRODUCTION code only.",
        "- Keep edits minimal: change only what is needed to make the tests pass; no unrelated changes or refactors.",
        "- Do NOT change test logic, assertions, or expected values.",
        "- You MAY edit a test ONLY for a mechanical rename: when a variable/function it references was renamed, or a call signature / new function call changed. Nothing else.",
        "- Do NOT delete, skip, or weaken any test.",
        "- If a test cannot pass without changing its logic, STOP and report it instead of editing the test.",
        "- List every test-file edit you made and why.",
      ].join("\n");
    default:
      return "";
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```
npm run build
node --test tests/actions.test.mjs
```
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/jobs/actions.ts tests/actions.test.mjs
git commit -m "feat: add actionConstraints as the single source of truth for action rules"
```

---

## Task 3: Create the two prompt files

**Files:**
- Create: `prompts/pr-add-tests.md`, `prompts/pr-pass-tests.md`
- Test: `tests/prompts.test.mjs` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/prompts.test.mjs`:

```javascript
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
  assert.match(p, /STOP/);
  assert.match(p, /\{\{BRANCH\}\}/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```
node --test tests/prompts.test.mjs
```
Expected: FAIL — `ENOENT` (files do not exist). No build needed (reads files directly).

- [ ] **Step 3: Create `prompts/pr-add-tests.md`**

```markdown
You are a senior software engineer adding **edge-case tests** for a pull request, working directly in its checked-out git working tree.

PR context:

- Repository: {{REPO}}
- PR number: #{{PR_NUMBER}}
- Branch: {{BRANCH}}
- Title: {{TITLE}}
- Description:

{{PR_BODY}}

## What to do

1. Identify what this PR changed (inspect the diff against the base branch and the surrounding code) and what behavior is currently unprotected by tests.
2. Add focused tests covering the changed behavior: the happy path, important edge cases, and realistic failure scenarios. Follow the project's existing test framework, file layout, and naming conventions.
3. **Only add or edit test files** (and minimal test fixtures/helpers). Do NOT modify production code for any reason — not even to fix a bug you find. If you find a bug, describe it in your summary so a later `pass-tests` run can fix it.
4. It is acceptable for the tests you add to FAIL against the current code — a failing edge-case test is the signal the code needs fixing. Do not weaken a test just to make it pass.
5. Do not modify `.env` files, anything under `.git/`, `deploy*`/`deployment*` directories, or files that look like `credentials`/`secrets`. Never hardcode secrets in tests.
6. Do not run `git commit`, `git push`, or change git history — the worker commits after its checks pass.

## Output

Print a short, plain-text summary of:

- Which test files you added or changed, and what each covers.
- Which edge cases / failure scenarios are now protected.
- Any bug you found that a later `pass-tests` run should fix (do not fix it yourself).
- Any behavior you could not test and why.
```

- [ ] **Step 4: Create `prompts/pr-pass-tests.md`**

```markdown
You are a senior software engineer making a pull request's **existing tests pass**, working directly in its checked-out git working tree.

PR context:

- Repository: {{REPO}}
- PR number: #{{PR_NUMBER}}
- Branch: {{BRANCH}}
- Title: {{TITLE}}
- Description:

{{PR_BODY}}

## What to do

1. Run the project's test suite and identify exactly which tests fail and why.
2. Make those tests pass by editing **production code only**. Keep each edit as small as possible — change only what is needed; do not add unrelated changes or refactors.
3. Treat the tests as the specification. Do NOT change test logic, assertions, or expected values to make them pass.
4. The only test edits permitted are **mechanical renames**: updating an identifier when a variable/function it references was renamed, or updating a call site when a function signature / new function call changed. Never alter what a test asserts.
5. Do not delete, skip, or weaken any test. If a test cannot pass without changing its logic, STOP, make no further edits to it, and report it in your summary.
6. Do not modify `.env` files, anything under `.git/`, `deploy*`/`deployment*` directories, or files that look like `credentials`/`secrets`.
7. Do not run `git commit`, `git push`, or change git history — the worker commits after its checks pass.

## Output

Print a short, plain-text summary of:

- Which failing tests you addressed and the production change that fixed each.
- Every test-file edit you made (if any) and why it was a mechanical rename.
- Any test you could not make pass without a logic change, and what decision is needed.
```

- [ ] **Step 5: Run the test to verify it passes**

```
node --test tests/prompts.test.mjs
```
Expected: PASS.

- [ ] **Step 6: Commit**

```
git add prompts/pr-add-tests.md prompts/pr-pass-tests.md tests/prompts.test.mjs
git commit -m "feat: add pr-add-tests and pr-pass-tests prompt templates"
```

---

## Task 4: Thread `actionConstraints` into the direct, planning, and apply prompts

**Files:**
- Modify: `src/ai/aiRunner.ts:1-58` (import, `renderActionPrompt`, `runAi`, `renderPlanningPrompt`)
- Modify: `src/ai/hermesRunner.ts:1-29` (import, `hermesApplyPrompt`)
- Test: `tests/prompt-threading.test.mjs` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/prompt-threading.test.mjs`:

```javascript
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
```

- [ ] **Step 2: Run the test to verify it fails**

```
npm run build
node --test tests/prompt-threading.test.mjs
```
Expected: FAIL — `renderActionPrompt is not a function` (build error: not exported), and planning/apply prompts lack the constraint text.

- [ ] **Step 3: Update `src/ai/aiRunner.ts`**

Change the import on line 6:

```typescript
import { promptFileForAction, actionConstraints } from "../jobs/actions.js";
```

Add an exported `renderActionPrompt` and use it in `runAi`. Replace `runAi` (lines 23-27) with:

```typescript
export function renderActionPrompt(template: string, job: PrJob): string {
  const base = render(template, job);
  const constraints = actionConstraints(job.action);
  return constraints ? `${base}\n\n${constraints}` : base;
}

export async function runAi(job: PrJob, directory: string): Promise<string> {
  const templatePath = path.resolve(process.cwd(), "prompts", promptFileForAction(job.action));
  const prompt = renderActionPrompt(await readFile(templatePath, "utf8"), job);
  return runAiPrompt(prompt, directory);
}
```

Replace `renderPlanningPrompt` (lines 36-58) with (inject constraints after the PR body, before `Output:`):

```typescript
export function renderPlanningPrompt(job: PrJob): string {
  const constraints = actionConstraints(job.action);
  return [
    "You are reviewing a checked-out pull request repository.",
    "Do not edit files, run write commands, commit, or push.",
    "Inspect the repository and produce a concrete implementation plan for another local agent to apply.",
    "",
    "PR context:",
    `- Repository: ${job.repo}`,
    `- PR number: #${job.prNumber}`,
    `- Branch: ${job.branch}`,
    `- Title: ${job.title}`,
    "- Description:",
    "",
    job.body || "(empty)",
    "",
    ...(constraints ? [constraints, ""] : []),
    "Output:",
    "- Summarize the requested change.",
    "- List the files/functions likely involved.",
    "- Give exact implementation steps.",
    "- List tests/checks the executor should run.",
    "- Mention any risks or ambiguity.",
  ].join("\n");
}
```

- [ ] **Step 4: Update `src/ai/hermesRunner.ts`**

Add an import at the top (after line 3):

```typescript
import { actionConstraints } from "../jobs/actions.js";
```

Replace `hermesApplyPrompt` (lines 6-29) with (inject constraints after the plan, before `Instructions:`):

```typescript
export function hermesApplyPrompt(job: PrJob, directory: string, plan: string): string {
  const constraints = actionConstraints(job.action);
  return [
    "You are the executor for ai-pr-worker on a checked-out pull request repository.",
    "Apply the requested PR changes directly in the working tree.",
    "",
    "Repository context:",
    `- Repository: ${job.repo}`,
    `- PR number: #${job.prNumber}`,
    `- Branch: ${job.branch}`,
    `- Working directory: ${directory}`,
    `- Action: ${job.action}`,
    `- Title: ${job.title}`,
    "",
    "Claude read-only plan:",
    plan || "(Claude produced no plan.)",
    "",
    ...(constraints ? [constraints, ""] : []),
    "Instructions:",
    "1. Edit files directly in this working tree.",
    "2. Keep the change small and focused.",
    "3. Add or update tests when needed.",
    "4. Do not commit, push, change git history, or modify protected files such as .env, .git, credentials, secrets, deploy, or deployment files.",
    "5. When finished, print a concise summary of changed files, tests considered, and any blocker.",
  ].join("\n");
}
```

- [ ] **Step 5: Run the test to verify it passes**

```
npm run build
node --test tests/prompt-threading.test.mjs
```
Expected: PASS.

- [ ] **Step 6: Commit**

```
git add src/ai/aiRunner.ts src/ai/hermesRunner.ts tests/prompt-threading.test.mjs
git commit -m "feat: inject per-action constraints into direct, planning, and apply prompts"
```

---

## Task 5: Add the `TEST_FILE_PATTERN` config option

**Files:**
- Modify: `src/config.ts:52-53` (add field), `src/config.ts:78` (validation)
- Modify: `.env.example`

- [ ] **Step 1: Add the config field**

In `src/config.ts`, add after the `e2eCommand` line (line 52), before `autoPush`:

```typescript
  testFilePattern:
    process.env.TEST_FILE_PATTERN?.trim() ||
    "\\.(test|spec)\\.[cm]?[jt]sx?$|(^|/)(__tests__|tests?)/|(^|/)test_[^/]*\\.py$|_test\\.(py|go)$",
```

- [ ] **Step 2: Fail fast on an invalid pattern**

In `src/config.ts`, after the `autoMerge` guard (line 78), add:

```typescript
try {
  new RegExp(config.testFilePattern);
} catch {
  throw new Error("TEST_FILE_PATTERN must be a valid regular expression");
}
```

- [ ] **Step 3: Document it in `.env.example`**

Add to `.env.example`, in the AI/commands section just after the `E2E_COMMAND` line:

```
# TEST_FILE_PATTERN is a case-insensitive regex used to decide which changed
# files count as tests. The `add-tests` action may only change matching files;
# the `pass-tests` action may not delete matching files. Leave unset to use the
# built-in default (JS/TS .test/.spec, __tests__/ and tests/ dirs, Python and Go tests).
# TEST_FILE_PATTERN=
```

- [ ] **Step 4: Verify the build compiles and config loads**

```
npm run build
node --test tests/actions.test.mjs
```
Expected: PASS (build succeeds; an already-passing test confirms config still loads).

- [ ] **Step 5: Commit**

```
git add src/config.ts .env.example
git commit -m "feat: add configurable TEST_FILE_PATTERN with a sensible default"
```

---

## Task 6: `nonTestPaths` guard

**Files:**
- Modify: `src/jobs/guards.ts` (add `isTestPath`, `nonTestPaths`)
- Test: `tests/guards.test.mjs`

- [ ] **Step 1: Write the failing tests**

First, replace the existing guards import in `tests/guards.test.mjs` (current: `const { isProtectedBranch, blockedPaths, blockedFiles } = await import("../dist/jobs/guards.js");`) with the extended one:

```javascript
const { isProtectedBranch, blockedPaths, blockedFiles, isTestPath, nonTestPaths } = await import("../dist/jobs/guards.js");
```

Then add these tests:

```javascript
const TEST_RE = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(__tests__|tests?)\/|(^|\/)test_[^/]*\.py$|_test\.(py|go)$/i;

test("isTestPath recognizes common test file conventions", () => {
  for (const file of ["src/a.test.ts", "src/a.spec.js", "app/__tests__/y.tsx", "tests/run.mjs", "pkg/test_foo.py", "pkg/foo_test.go"]) {
    assert.equal(isTestPath(file, TEST_RE), true, `expected test file: ${file}`);
  }
});

test("isTestPath rejects production files and normalizes backslashes", () => {
  assert.equal(isTestPath("src/index.ts", TEST_RE), false);
  assert.equal(isTestPath("app\\__tests__\\y.tsx", TEST_RE), true);
});

test("nonTestPaths returns only the non-test files", () => {
  assert.deepEqual(nonTestPaths(["src/a.test.ts", "src/a.ts", "README.md"], TEST_RE), ["src/a.ts", "README.md"]);
  assert.deepEqual(nonTestPaths(["x.test.ts", "y\\z.spec.ts"], TEST_RE), []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```
npm run build
node --test tests/guards.test.mjs
```
Expected: FAIL — `isTestPath is not a function` / build error.

- [ ] **Step 3: Implement the guard**

Add to `src/jobs/guards.ts` (after `blockedPaths`):

```typescript
// True when a changed path looks like a test file per the configured regex.
// Backslashes are normalized so Windows-style git output matches.
export function isTestPath(file: string, testFileRegex: RegExp): boolean {
  return testFileRegex.test(file.replaceAll("\\", "/"));
}

// Of the given changed files, return the ones that are NOT test files. Used to
// keep the `add-tests` action from touching production code.
export function nonTestPaths(files: readonly string[], testFileRegex: RegExp): string[] {
  return files.filter((file) => !isTestPath(file, testFileRegex));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```
npm run build
node --test tests/guards.test.mjs
```
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/jobs/guards.ts tests/guards.test.mjs
git commit -m "feat: add nonTestPaths guard to restrict add-tests to test files"
```

---

## Task 7: `deletedPaths` git helper

**Files:**
- Modify: `src/git/gitManager.ts` (add `deletedPaths`)
- Test: `tests/worker-e2e.test.mjs`

- [ ] **Step 1: Write the failing test**

In `tests/worker-e2e.test.mjs`, add `deletedPaths` to the gitManager import (line ~29):

```javascript
const { changedFiles, commitAndPush, deletedPaths } = await import("../dist/git/gitManager.js");
```

Add this test (uses the file's existing `makeRepo`, `git`, and imports):

```javascript
test("deletedPaths reports files removed from the working tree", (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return (async () => {
    writeFileSync(path.join(dir, "keep.test.js"), "x\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "add test");
    rmSync(path.join(dir, "keep.test.js"));
    const deleted = await deletedPaths(dir);
    assert.deepEqual(deleted, ["keep.test.js"]);
  })();
});
```

- [ ] **Step 2: Run the test to verify it fails**

```
npm run build
node --test tests/worker-e2e.test.mjs
```
Expected: FAIL — `deletedPaths is not a function` / build error.

- [ ] **Step 3: Implement `deletedPaths`**

Add to `src/git/gitManager.ts` (after `changedFiles`):

```typescript
// Paths git reports as deleted in the working tree (staged or unstaged).
// `git status --porcelain` prefixes each line with a two-char XY status; a "D"
// in either column means the file was removed.
export async function deletedPaths(directory: string): Promise<string[]> {
  const { stdout } = await runFile("git", ["-C", directory, "status", "--porcelain"]);
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => line[0] === "D" || line[1] === "D")
    .map((line) => line.slice(3));
}
```

- [ ] **Step 4: Run the test to verify it passes**

```
npm run build
node --test tests/worker-e2e.test.mjs
```
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/git/gitManager.ts tests/worker-e2e.test.mjs
git commit -m "feat: add deletedPaths git helper to detect removed files"
```

---

## Task 8: Action-aware commit gate (`commitBlockingChecks`)

**Files:**
- Modify: `src/checks/runChecks.ts` (add `commitBlockingChecks`)
- Test: `tests/checks.test.mjs`

- [ ] **Step 1: Write the failing tests**

First, replace the existing import in `tests/checks.test.mjs` (current: `const { runChecks, checksPassed, defaultCheckSpecs } = await import("../dist/checks/runChecks.js");`) with:

```javascript
const { runChecks, checksPassed, defaultCheckSpecs, commitBlockingChecks } = await import("../dist/checks/runChecks.js");
```

Then add these tests:

```javascript
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
});

test("commitBlockingChecks: pass-tests and other actions require the test check", () => {
  assert.equal(commitBlockingChecks("pass-tests", gateChecks({ test: { status: "failed", output: "" } })), false);
  assert.equal(commitBlockingChecks("pass-tests", gateChecks()), true);
  assert.equal(commitBlockingChecks("full-fix", gateChecks({ test: { status: "failed", output: "" } })), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```
npm run build
node --test tests/checks.test.mjs
```
Expected: FAIL — `commitBlockingChecks is not a function` / build error.

- [ ] **Step 3: Implement `commitBlockingChecks`**

In `src/checks/runChecks.ts`, add a type-only import at the top:

```typescript
import type { PrAction } from "../jobs/actions.js";
```

Add after `checksPassed`:

```typescript
// Whether the checks that *block a commit* all passed, for a given action. For
// `add-tests` the test check is informational (the new tests may legitimately be
// red — a later `pass-tests` run makes them green), so it does not block; every
// other check, and every other action, behaves exactly like `checksPassed`.
export function commitBlockingChecks(action: PrAction, checks: CheckResults): boolean {
  if (action === "add-tests") {
    return (Object.entries(checks) as Array<[CheckName, CheckOutcome]>)
      .filter(([name]) => name !== "test")
      .every(([, outcome]) => outcome.status !== "failed");
  }
  return checksPassed(checks);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```
npm run build
node --test tests/checks.test.mjs
```
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/checks/runChecks.ts tests/checks.test.mjs
git commit -m "feat: add action-aware commit gate (add-tests may commit red tests)"
```

---

## Task 9: Un-truncated output — `buildReportComments` + `reportResult`

**Files:**
- Modify: `src/jobs/processPrJob.ts` (add `buildReportComments`, `reportResult`; adjust the Notes section)
- Test: `tests/comment.test.mjs`

- [ ] **Step 1: Write the failing tests**

In `tests/comment.test.mjs`, add `buildReportComments` to the import on line 15:

```javascript
const { resultComment, looksPermissionBlocked, buildReportComments } = await import("../dist/jobs/processPrJob.js");
```

Add these tests:

```javascript
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
```

- [ ] **Step 2: Run the tests to verify they fail**

```
npm run build
node --test tests/comment.test.mjs
```
Expected: FAIL — `buildReportComments is not a function`; and the new "full output in the detail comments below" text is absent.

- [ ] **Step 3: Add a Notes-section helper and update `resultComment`**

In `src/jobs/processPrJob.ts`, add this helper just above `resultComment` (around line 89):

```typescript
function notesSection(notes: string): string {
  if (!notes) return "No additional notes.";
  const masked = maskSecrets(notes, config.secrets);
  if (masked.length <= NOTES_CAP) return masked;
  return `${masked.slice(0, NOTES_CAP)}\n…(truncated, ${masked.length - NOTES_CAP} more characters; full output in the detail comments below.)`;
}
```

In `resultComment`, replace the Notes line (line 104):

```typescript
  sections.push(`### Notes\n${notesSection(report.notes)}`);
```

- [ ] **Step 4: Add `buildReportComments` and `reportResult`**

In `src/jobs/processPrJob.ts`, add after `reportDetails` (around line 144):

```typescript
// Build the comment payload for a result: the main comment (notes clipped to a
// preview when long) plus, when the notes exceed the cap, the complete output
// split across follow-up detail comments so nothing is lost.
export function buildReportComments(result: Report): { main: string; details: string[] } {
  const main = resultComment(result);
  const masked = maskSecrets(result.notes, config.secrets);
  const details = masked.length > NOTES_CAP ? detailComments("AI output", result.notes) : [];
  return { main, details };
}

async function reportResult(job: PrJob, result: Report): Promise<void> {
  const { main, details } = buildReportComments(result);
  await report(job, main);
  for (const body of details) {
    await report(job, body);
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```
npm run build
node --test tests/comment.test.mjs
```
Expected: PASS (including the pre-existing `truncated, \d+ more characters` test, whose substring is preserved).

- [ ] **Step 6: Commit**

```
git add src/jobs/processPrJob.ts tests/comment.test.mjs
git commit -m "feat: post full AI output via detail comments instead of truncating"
```

---

## Task 10: Wire the gate, guards, and reporting into `processPrJob`

**Files:**
- Modify: `src/jobs/processPrJob.ts` (imports, regex, gate, guards, summary, call sites)

> No new unit test here — this is orchestration wiring exercised by Task 11's e2e slices and already-covered helpers. Each step shows the exact edit; verify with a full build.

- [ ] **Step 1: Update imports**

This task replaces both `checksPassed` usages in this file with `commitBlockingChecks`, so **drop `checksPassed`** from the import (the project's `tsconfig.json` has no `noUnusedLocals`, so a stale import would compile silently — remove it now rather than leave dead code). Keep the `CheckName`/`CheckOutcome` type imports — `rawCheckOutput` still uses them.

Replace the runChecks import (current line 4: `import { checksPassed, runChecks, type CheckName, type CheckOutcome, type CheckResults } from "../checks/runChecks.js";`) with:

```typescript
import { commitBlockingChecks, runChecks, type CheckName, type CheckOutcome, type CheckResults } from "../checks/runChecks.js";
```

Replace the gitManager import (current line 5: `import { changedFiles, commitAndPush, prepareRepo } from "../git/gitManager.js";`) with:

```typescript
import { changedFiles, commitAndPush, deletedPaths, prepareRepo } from "../git/gitManager.js";
```

Replace the guards import (current line 12: `import { blockedPaths, isProtectedBranch } from "./guards.js";`) with:

```typescript
import { blockedPaths, nonTestPaths, isProtectedBranch } from "./guards.js";
```

- [ ] **Step 2: Compile the test-file regex once**

Add after the cap constants (after line 32):

```typescript
const testFileRegex = new RegExp(config.testFilePattern, "i");
```

- [ ] **Step 3: Convert the AI-failed report (line 169) to `reportResult`**

```typescript
      if (aiStatus === "failed") {
        await reportResult(job, { job, status: "Failed", aiStatus, summary: "- The AI command failed; no changes were committed.", notes: aiSummary });
        await notify(`AI PR Worker AI step failed: ${job.repo}#${job.prNumber}`);
        return;
      }
```

- [ ] **Step 4: Convert the read-only review report (line 219) to `reportResult`**

```typescript
      if (isReadOnlyAction(job.action)) {
        await reportResult(job, { job, status: "Reviewed", aiStatus, summary: readOnlySummary(job, checks), checks, notes: aiSummary });
        await notify(`AI PR Worker ${job.action} completed: ${job.repo}#${job.prNumber}`);
        return;
      }
```

- [ ] **Step 5: Make the no-changes branch action-aware and use `reportResult`**

Replace the no-changes block (lines 230-255). Change the `failedChecks` computation to the action-aware gate and the `report(...)` to `reportResult(...)`:

```typescript
      const files = await changedFiles(directory);
      if (!files.length) {
        const failedChecks = !commitBlockingChecks(job.action, checks);
        const note = looksPermissionBlocked(aiSummary)
          ? `${aiSummary}\n\n> The AI reported a blocked permission and changed no files. For a headless CLI, grant edit permission in AI_COMMAND (Claude Code: \`--permission-mode bypassPermissions\`).`
          : [aiSummary, hermesSummary].filter(Boolean).join("\n\nHermes output:\n");
        await reportResult(job, {
          job,
          status: failedChecks ? "Failed" : "No changes",
          aiStatus,
          hermesStatus,
          summary: failedChecks
            ? "- No file changes were made; nothing to commit.\n- Checks failed against the unchanged checkout."
            : "- No file changes were made; nothing to commit.",
          checks,
          notes: note,
        });
        await notify(
          failedChecks
            ? `AI PR Worker checks failed with no changes: ${job.repo}#${job.prNumber}`
            : `AI PR Worker completed with no changes: ${job.repo}#${job.prNumber}`,
        );
        return;
      }
```

- [ ] **Step 6: Add the per-action change-scope guards (insert before the commit gate)**

Insert immediately after the no-changes block (before the `if (!checksPassed(checks))` gate):

```typescript
      // Stage 2: add-tests may only touch test files.
      if (job.action === "add-tests") {
        const offenders = nonTestPaths(files, testFileRegex);
        if (offenders.length) {
          await reportResult(job, {
            job,
            status: "Failed",
            aiStatus,
            hermesStatus,
            checks,
            summary: "- `add-tests` may only change test files, but production files were modified; nothing was committed.",
            notes: [`Non-test files changed: ${offenders.join(", ")}`, aiSummary, hermesSummary].filter(Boolean).join("\n\n"),
          });
          await notify(`AI PR Worker add-tests touched non-test files: ${job.repo}#${job.prNumber}`);
          return;
        }
      }

      // Stage 3: pass-tests must not delete tests (a common way to fake a green run).
      if (job.action === "pass-tests") {
        const deletedTests = (await deletedPaths(directory)).filter((file) => testFileRegex.test(file.replaceAll("\\", "/")));
        if (deletedTests.length) {
          await reportResult(job, {
            job,
            status: "Failed",
            aiStatus,
            hermesStatus,
            checks,
            summary: "- `pass-tests` must not delete tests, but test files were removed; nothing was committed.",
            notes: [`Deleted test files: ${deletedTests.join(", ")}`, aiSummary, hermesSummary].filter(Boolean).join("\n\n"),
          });
          await notify(`AI PR Worker pass-tests deleted tests: ${job.repo}#${job.prNumber}`);
          return;
        }
      }
```

- [ ] **Step 7: Make the commit gate action-aware and use `reportResult`**

Replace the failing-checks gate (lines 257-272):

```typescript
      if (!commitBlockingChecks(job.action, checks)) {
        await reportResult(job, {
          job,
          status: "Failed",
          aiStatus,
          hermesStatus,
          summary: "- Changes were left uncommitted because checks failed.",
          checks,
          notes: [aiSummary, hermesSummary].filter(Boolean).join("\n\nHermes output:\n"),
        });
        await notify(`AI PR Worker checks failed: ${job.repo}#${job.prNumber}`);
        return;
      }
```

- [ ] **Step 8: Add the red-tests note to the success report and use `reportResult`**

Replace the success block (lines 274-292):

```typescript
      const blocked = blockedPaths(files);
      if (blocked.length) throw new Error(`Refusing to commit protected file changes: ${blocked.join(", ")}`);

      const commit = await commitAndPush(directory, job.branch, commitMessageForAction(job.action, job.prNumber));
      const pushNote = config.autoPush ? `Pushed commit \`${commit}\`.` : `Created commit \`${commit}\`; AUTO_PUSH is disabled.`;
      const testNote =
        job.action === "add-tests" && checks.test.status === "failed"
          ? "\n- Added tests are currently red (failing) — run `pass-tests` to make them pass."
          : job.action === "add-tests" && checks.test.status === "passed"
            ? "\n- Added tests pass against the current code."
            : "";
      await reportResult(job, {
        job,
        status: "Success",
        aiStatus,
        hermesStatus,
        summary: `- Updated ${files.length} file(s).\n- ${pushNote}${testNote}`,
        checks,
        commit,
        notes: [aiSummary, hermesSummary].filter(Boolean).join("\n\nHermes output:\n"),
      });
      await notify(`AI PR Worker completed: ${job.repo}#${job.prNumber} ${pushNote}`);
```

- [ ] **Step 9: Convert the worker-error catch (line 296) to `reportResult`**

```typescript
      await reportResult(job, { job, status: "Failed", summary: "- The worker could not complete this task.", notes: message });
```

- [ ] **Step 10: Build and run the full suite**

```
npm test
```
Expected: PASS. (`checksPassed` was already removed from this file's imports in Step 1, since both of its usages are now `commitBlockingChecks`.)

- [ ] **Step 11: Commit**

```
git add src/jobs/processPrJob.ts
git commit -m "feat: wire action-aware commit gate, scope guards, and full-output reporting into processPrJob"
```

---

## Task 11: Worker-e2e slices for `add-tests` and `pass-tests`

**Files:**
- Modify: `tests/worker-e2e.test.mjs`

> These reuse the file's existing `makeRepo`, `job`, `git`, `passingChecks`, and the `fake-ai-edit-cli.mjs` fixture (which writes the path in `FAKE_AI_EDIT_FILE`, default `ai-change.txt`). Add `nonTestPaths` and `commitBlockingChecks` to the imports.

- [ ] **Step 1: Extend imports**

Update the import block near the top of `tests/worker-e2e.test.mjs`:

```javascript
const { runChecks, checksPassed, commitBlockingChecks } = await import("../dist/checks/runChecks.js");
const { changedFiles, commitAndPush, deletedPaths } = await import("../dist/git/gitManager.js");
const { blockedPaths, nonTestPaths } = await import("../dist/jobs/guards.js");
```

Add a regex constant near the top (after the imports):

```javascript
const TEST_RE = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(__tests__|tests?)\/|(^|\/)test_[^/]*\.py$|_test\.(py|go)$/i;
```

- [ ] **Step 2: Write the add-tests slice (commits a red test)**

```javascript
test("add-tests slice: a test-only change with red tests is allowed to commit", (t) => {
  process.env.FAKE_AI_EDIT_FILE = "feature.test.js";
  const dir = makeRepo();
  t.after(() => {
    delete process.env.FAKE_AI_EDIT_FILE;
    rmSync(dir, { recursive: true, force: true });
  });

  return (async () => {
    await runAi(job("add-tests", dir), dir);
    const files = await changedFiles(dir);
    assert.ok(files.includes("feature.test.js"), `expected the test file in ${JSON.stringify(files)}`);

    // Only test files changed -> no offenders.
    assert.deepEqual(nonTestPaths(files, TEST_RE), []);

    // Even with the test check red, the add-tests gate allows a commit.
    const redChecks = { install: { status: "skipped", output: "" }, lint: { status: "passed", output: "" }, test: { status: "failed", output: "1 failing" }, build: { status: "skipped", output: "" }, e2e: { status: "skipped", output: "" } };
    assert.equal(commitBlockingChecks("add-tests", redChecks), true);

    const sha = await commitAndPush(dir, "feature/x", "AI (add-tests) for PR #7");
    assert.match(sha, /^[0-9a-f]{40}$/);
    assert.match(git(dir, "show", "--name-only", "--pretty=format:", "HEAD"), /feature\.test\.js/);
  })();
});
```

- [ ] **Step 3: Write the add-tests rejection slice (touches production code)**

```javascript
test("add-tests slice: touching production code is detected as an offender", (t) => {
  process.env.FAKE_AI_EDIT_FILE = "src/feature.js";
  const dir = makeRepo();
  t.after(() => {
    delete process.env.FAKE_AI_EDIT_FILE;
    rmSync(dir, { recursive: true, force: true });
  });

  return (async () => {
    await runAi(job("add-tests", dir), dir);
    const files = await changedFiles(dir);
    assert.deepEqual(nonTestPaths(files, TEST_RE), ["src/feature.js"]); // worker would refuse to commit
  })();
});
```

- [ ] **Step 4: Write the pass-tests slices (commit on green; refuse on test deletion)**

```javascript
test("pass-tests slice: a production edit with all checks green commits", (t) => {
  process.env.FAKE_AI_EDIT_FILE = "src/feature.js";
  const dir = makeRepo();
  t.after(() => {
    delete process.env.FAKE_AI_EDIT_FILE;
    rmSync(dir, { recursive: true, force: true });
  });

  return (async () => {
    await runAi(job("pass-tests", dir), dir);
    const checks = await runChecks(dir, passingChecks);
    assert.equal(commitBlockingChecks("pass-tests", checks), true);
    const files = await changedFiles(dir);
    assert.ok(files.includes("src/feature.js"));
    const sha = await commitAndPush(dir, "feature/x", "AI (pass-tests) for PR #7");
    assert.match(sha, /^[0-9a-f]{40}$/);
  })();
});

test("pass-tests slice: deleting a test file is flagged", (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return (async () => {
    writeFileSync(path.join(dir, "guarded.test.js"), "x\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "add guarded test");
    rmSync(path.join(dir, "guarded.test.js"));
    const deletedTests = (await deletedPaths(dir)).filter((f) => TEST_RE.test(f.replaceAll("\\", "/")));
    assert.deepEqual(deletedTests, ["guarded.test.js"]); // worker would refuse to commit
  })();
});
```

- [ ] **Step 5: Run the suite**

```
npm test
```
Expected: PASS (all e2e slices, old and new).

- [ ] **Step 6: Commit**

```
git add tests/worker-e2e.test.mjs
git commit -m "test: add worker-e2e slices for add-tests and pass-tests actions"
```

---

## Task 12: Documentation

**Files:**
- Modify: `README.md` (label table + a pipeline note), `docs/IMPROVEMENT_PLAN.md` (label taxonomy), `.env.example` (already done in Task 5)

- [ ] **Step 1: Update the README label table**

In `README.md`, replace the label table (lines 11-17) with:

```markdown
| Label        | Action       | AI edits?            | Commits/pushes?               | Risk     |
|--------------|--------------|----------------------|-------------------------------|----------|
| `review-it`  | `review`     | No                   | No                            | Low      |
| `add-tests`  | `add-tests`  | Tests only (strict)  | Yes (may commit failing tests)| Medium   |
| `pass-tests` | `pass-tests` | Production code       | Yes (only if all checks pass) | Medium   |
| `test-it`    | `test`       | Tests only\*         | Yes (if checks pass)          | Medium   |
| `fix-review` | `fix-review` | Yes                  | Yes (if checks pass)          | Medium   |
| `need-this`  | `full-fix`   | Yes                  | Yes (if checks pass)          | High     |
| `e2e-it`     | `e2e`        | No (runs e2e check)  | No                            | Low/Med  |
```

- [ ] **Step 2: Add a pipeline subsection to the README**

After the table's precedence paragraph (after line 21), add:

```markdown
### Review → add tests → make them pass (TDD pipeline)

Three labels run a deliberate test-driven loop, one at a time on the PR branch:

1. `review-it` — read-only review. Long reviews are posted in full: when the
   output exceeds the comment cap, the rest is split across follow-up
   "AI PR Worker Detail" comments instead of being truncated.
2. `add-tests` — adds edge-case tests **only** (happy path, edge cases, failure
   scenarios). It never edits production code. These tests **may be committed
   while failing** — a red edge-case test is the signal that the code needs a
   fix — provided install/lint/build pass and only test files changed
   (`TEST_FILE_PATTERN` decides what counts as a test). The commit/push still
   obeys `AUTO_PUSH`, so this is opt-in.
3. `pass-tests` — edits **production code** to make the committed tests pass.
   Tests are frozen except mechanical renames (updating identifiers when a
   variable/function is renamed or a call signature changes); it will not delete
   tests, and it commits only when all checks (including tests) pass.

Precedence is `need-this` > `fix-review` > `pass-tests` > `test-it` >
`add-tests` > `e2e-it` > `review-it`.
```

- [ ] **Step 3: Update `docs/IMPROVEMENT_PLAN.md` label taxonomy**

In `docs/IMPROVEMENT_PLAN.md`, add two rows to the label table (after the `fix-review` row, ~line 67):

```markdown
| `add-tests`  | `add-tests`  | Tests only (strict)  | Yes (may commit red tests) | Medium |
| `pass-tests` | `pass-tests` | Production code       | Yes (all checks pass)      | Medium |
```

And append a short note under the table:

```markdown
The `add-tests` / `pass-tests` pair forms a TDD pipeline: `add-tests` commits
edge-case tests (which may be red), `pass-tests` then edits production code to
make them green without changing test logic. Per-action hard constraints live in
`actionConstraints()` (`src/jobs/actions.ts`) and are injected into the direct,
planning, and Hermes apply prompts.
```

- [ ] **Step 4: Commit**

```
git add README.md docs/IMPROVEMENT_PLAN.md
git commit -m "docs: document the add-tests/pass-tests pipeline and un-truncated output"
```

---

## Task 13: Final verification

- [ ] **Step 1: Full build + suite**

```
npm test
```
Expected: PASS — all test files green, including `actions`, `guards`, `checks`, `comment`, `prompts`, `prompt-threading`, and `worker-e2e`.

- [ ] **Step 2: Lint/typecheck if configured**

```
npm run lint
```
Expected: PASS (or skip if the script is not defined).

- [ ] **Step 3: Manual smoke of the AI step for the new actions**

```
npm run build
node scripts/test-ai-step.mjs --action add-tests --dir .
node scripts/test-ai-step.mjs --action pass-tests --dir .
```
Expected: each prints an `AI output` block containing the action's hard constraints (confirming `actionConstraints` is threaded through `runAi`). Note: `scripts/test-ai-step.mjs` currently accepts `review | test | fix-review | full-fix | e2e`; if it validates the `--action` value, add `add-tests` and `pass-tests` to its allowed list first (small, self-contained change in that script).

---

## Self-review notes (spec coverage)

- Two new labels/actions + precedence → Task 1. ✅
- Strict test-only stage 2 (no "fix real bug" exception) → Task 2 (`actionConstraints`) + Task 3 (prompt) + Task 6/Task 10 (guard). ✅
- Stage 3 make-tests-pass, tests frozen except mechanical renames → Task 2 + Task 3 + Task 10 (deletion guard). ✅
- Commit red stage-2 tests (action-aware gate) → Task 8 + Task 10. ✅
- Hermes path option A (action-aware planning + apply, single source of truth) → Task 2 + Task 4. ✅
- Un-truncated output via the splitter → Task 9 + Task 10. ✅
- `TEST_FILE_PATTERN` config → Task 5. ✅
- Tests for routing, guard, gate, prompts, splitting, e2e slices → Tasks 1-4, 6-9, 11. ✅
- Docs → Task 12 (+ `.env.example` in Task 5). ✅

**Honest limitations carried from the spec:** the stage-3 "no test-logic changes" rule is prompt-governed + reported + human-reviewed (only test *deletion* is hard-blocked); and when the `add-tests` test check is non-blocking, a pre-existing regression cannot be auto-distinguished from a newly-red test — the report surfaces the failures for a human.
