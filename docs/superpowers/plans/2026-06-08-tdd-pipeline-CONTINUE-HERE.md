# CONTINUE HERE — TDD Pipeline + Un-truncated Output

This is the resume point for the subagent-driven execution of
`docs/superpowers/plans/2026-06-08-tdd-pipeline-and-output.md`
(design spec: `docs/superpowers/specs/2026-06-08-tdd-pipeline-design.md`).

**Tasks 1–5 are complete and committed. Resume at Task 6.**

---

## Current state

- **Branch:** `feat/tdd-pipeline-and-output` (off `main`). Work happens here; `main` is untouched. Merge/PR at the end.
- **HEAD:** `29fe2db` — working tree clean.
- **Baseline before this work:** 68 tests passing. The suite is run with `npm test` (which does `npm run build && node --test tests/*.test.mjs`). New tests added so far: `tests/actions.test.mjs` (now 13), `tests/prompts.test.mjs` (2), `tests/prompt-threading.test.mjs` (4).
- **Task tracker:** 13 tasks were created (IDs 1–13). 1–5 = completed, 6–13 = pending. If the tracker is gone in a new session, recreate from the plan's task list.

### Commit log (newest first)

```
29fe2db refactor: include offending value and engine message in TEST_FILE_PATTERN error   (Task 5 fix)
b9502bc feat: add configurable TEST_FILE_PATTERN with a sensible default                  (Task 5)
46dfc93 feat: inject per-action constraints into direct, planning, and apply prompts      (Task 4)
b39e061 refactor: clarify pass-tests prompt wording and strengthen prompt tests           (Task 3 fix)
c2e2c73 feat: add pr-add-tests and pr-pass-tests prompt templates                         (Task 3)
7b55a57 feat: add actionConstraints as the single source of truth for action rules        (Task 2)
7c99421 feat: add add-tests and pass-tests actions with routing and precedence            (Task 1)
268d8b9 docs: spec and implementation plan for TDD pipeline + un-truncated output         (planning)
```

---

## What's done (Tasks 1–5)

| # | Summary | Files | Status |
|---|---------|-------|--------|
| 1 | `add-tests`/`pass-tests` actions, `ACTION_LABELS` precedence, `PROMPT_FILES` | `src/jobs/actions.ts`, `tests/actions.test.mjs` | ✅ spec + quality reviewed |
| 2 | `actionConstraints(action)` — single source of truth (strict add-tests / pass-tests rules; `""` otherwise) | `src/jobs/actions.ts`, `tests/actions.test.mjs` | ✅ |
| 3 | Prompt templates `pr-add-tests.md`, `pr-pass-tests.md` + content test | `prompts/*`, `tests/prompts.test.mjs` | ✅ (incl. wording-clarity fix) |
| 4 | Thread `actionConstraints` into `renderActionPrompt`/`runAi`, `renderPlanningPrompt`, `hermesApplyPrompt` | `src/ai/aiRunner.ts`, `src/ai/hermesRunner.ts`, `tests/prompt-threading.test.mjs` | ✅ |
| 5 | `config.testFilePattern` (regex string + fail-fast validation) + `.env.example` | `src/config.ts`, `.env.example` | ✅ (incl. richer error message) |

### Review decisions worth remembering

- **Strict `add-tests` is intentional.** A reviewer flagged that `add-tests` forbids all production edits (unlike the existing `test` action's "fix a real bug" exception). This was **kept by design** — the user explicitly wanted stage 2 to be strictly test-only. Do not "reconcile" them.
- **Task 1's "missing prompt files" was resolved by Task 3** (the files now exist).
- `.env.example` documentation for `TEST_FILE_PATTERN` was **already added in Task 5** — do not re-add it in Task 12.

---

## What remains (Tasks 6–13)

Read the full text + complete code for each in the plan
(`docs/superpowers/plans/2026-06-08-tdd-pipeline-and-output.md`). Quick map:

| # | Summary | Files | Notes / gotchas |
|---|---------|-------|-----------------|
| 6 | `isTestPath` + `nonTestPaths(files, regex)` guard | `src/jobs/guards.ts`, `tests/guards.test.mjs` | `guards.ts` imports nothing → the test needs **no env vars**. Replace the existing guards import line to add `isTestPath, nonTestPaths`. |
| 7 | `deletedPaths(directory)` git helper | `src/git/gitManager.ts`, `tests/worker-e2e.test.mjs` | Parses `git status --porcelain` (`line[0]==='D' \|\| line[1]==='D'`, `slice(3)`). Add `deletedPaths` to the worker-e2e gitManager import. |
| 8 | `commitBlockingChecks(action, checks)` | `src/checks/runChecks.ts`, `tests/checks.test.mjs` | Add `import type { PrAction } from "../jobs/actions.js"` (type-only; no runtime cycle). `add-tests` excludes the `test` check; all else = `checksPassed` semantics (skipped counts as pass). Extend the checks.test import (currently `runChecks, checksPassed, defaultCheckSpecs`). |
| 9 | `notesSection` + `buildReportComments` + `reportResult` (un-truncate) | `src/jobs/processPrJob.ts`, `tests/comment.test.mjs` | `notesSection` MUST keep the substring `truncated, <N> more characters` (a pre-existing test asserts it). 30000 chars → 3 detail comments (`DETAIL_CHUNK_CAP=12000`). Add `buildReportComments` to the comment.test import. |
| 10 | Wire gate + guards + reporting into `processPrJob` | `src/jobs/processPrJob.ts` | **Drop `checksPassed` from the import** (becomes unused — tsconfig has no `noUnusedLocals`, so it won't error, but remove it). Replace both gate usages with `commitBlockingChecks(job.action, checks)`. Add `const testFileRegex = new RegExp(config.testFilePattern, "i");`. Add the add-tests (non-test files) and pass-tests (deleted tests) guards. Convert the normal `report(job, resultComment(...))` sites to `reportResult(...)` (leave the Hermes-failure path as-is). Add the red-test summary note. No new unit test — verified by Task 11 + build. |
| 11 | Worker-e2e slices for the two actions | `tests/worker-e2e.test.mjs` | Extend imports (`commitBlockingChecks`, `deletedPaths`, `nonTestPaths`); add a `TEST_RE` const. Reuses `makeRepo`/`job`/`git`/`passingChecks`/`runAi` and the `fake-ai-edit-cli.mjs` fixture (`FAKE_AI_EDIT_FILE` controls the path it writes). |
| 12 | Docs | `README.md`, `docs/IMPROVEMENT_PLAN.md` | Label table + pipeline section + taxonomy. (`.env.example` already done.) |
| 13 | Final verification | — | `npm test`, `npm run lint`, AI-step smoke. `scripts/test-ai-step.mjs` may need `add-tests`/`pass-tests` added to its `--action` allowlist before the smoke step. |

After Task 13: dispatch a **final full code review** over the whole branch, then use `superpowers:finishing-a-development-branch`.

---

## How to resume (subagent-driven)

1. Confirm state: `git rev-parse --short HEAD` → `29fe2db`; `git status` clean; `npm test` green.
2. Re-enter the process via the `superpowers:subagent-driven-development` skill.
3. For Task N (start at 6): dispatch a **fresh implementer subagent** (general-purpose, model `sonnet` is sufficient — the plan provides complete code) with the **full task text pasted in** (don't make it read the plan file). Then **spec-compliance review**, then **code-quality review**, fix loops until both pass, then mark complete. One task at a time, never parallel.
4. **Base SHA for the next task's review = current HEAD** (start: `29fe2db`).

### Standing instructions for every implementer/reviewer subagent

- Work from `C:\projects\ai-pr-worker`.
- Use the **Bash tool** for all `npm`/`node`/`git` (Windows PowerShell `npm.ps1` may be blocked by execution policy).
- Tests import compiled code from `dist/`, so **`npm run build` before `node --test`**. `npm test` builds first.
- Tests that import any module which transitively imports `src/config.ts` must set `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_ALLOWED_REPOS`, `AI_COMMAND` (+ `AI_PROVIDER=custom`, `AUTO_MERGE=false`) **before** the dynamic import. `guards.ts` imports nothing and needs no env.
- Do **not** modify anything under `docs/`.
- End every commit message with the trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Follow the plan's TDD steps exactly (write failing test → confirm fail → implement → confirm pass → commit). The code is provided complete; no extra features (YAGNI). If a step's anchor text doesn't match or anything is unclear, STOP and report rather than guessing.
