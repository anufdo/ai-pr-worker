# Design: 3-Stage TDD Pipeline + Un-truncated PR Output

Status: approved (pending spec review)
Date: 2026-06-08
Author: brainstorming session

## Problem

Two problems with the current AI PR Worker:

1. **Truncated output.** The AI's review/plan is clipped to `NOTES_CAP = 4000`
   characters in the PR result comment (`…(truncated, 6044 more characters)`),
   so reviews and plans are unusable. A `detailComments()` splitter that posts
   the full text across multiple 12k-char comments already exists but is only
   wired into the Hermes-failure path.

2. **No deliberate review → test → fix pipeline.** The user wants three
   tag-driven stages, run one at a time on a PR branch:
   - **Stage 1 — review.** Read-only review.
   - **Stage 2 — add edge-case tests, test-only.** Add tests (happy / edge /
     failure). Edit **test files only**; never touch production code.
   - **Stage 3 — make the tests pass.** Edit production code so the stage-2
     tests pass. Tests are frozen except **mechanical renames** (update an
     identifier when a variable/function is renamed or a call signature/new
     function call changes). Never change test logic, assertions, or expected
     values; if a test cannot pass without a logic change, stop and report.

The worker is stateless and repo-agnostic; stages chain naturally because each
stage commits to the PR branch, so the next stage sees the previous stage's work
in the working tree. These constraints are preserved.

## Approved decisions

- **Two new labels** (keep `review-it` for stage 1; leave existing `test-it` /
  `fix-review` / `full-fix` untouched for ad-hoc use).
- **Reuse the `detailComments()` splitter** for full output (no data lost).
- **Stage 3: mechanical renames only** in test files; prompt-governed + reported
  + human-reviewed (a diff cannot prove a rename vs a logic change).
- **Hermes path = option A**: make the Hermes planning + apply prompts
  action-aware so the new constraints survive under `HERMES_ENABLED` (also fixes
  the existing latent gap where Hermes ignores the per-action prompt files).
- **Stage 2 may commit red tests** (see below) — required for the handoff.

## A. New labels → actions

Stage 1 reuses the existing `review-it` → `review` (read-only). Add two editing
actions:

| Stage | Label (placeholder) | Action       | Edits              | Commits when…                         |
|-------|---------------------|--------------|--------------------|---------------------------------------|
| 2     | `add-tests`         | `add-tests`  | test files only    | install/lint/build pass (test = info) |
| 3     | `pass-tests`        | `pass-tests` | production code     | **all** checks pass (incl. tests)     |

- Add both to `PrAction` and `ACTION_LABELS`.
- Precedence (highest automation first):
  `full-fix > fix-review > pass-tests > test > add-tests > e2e > review`.
- Both are editing (non-read-only) actions: commit/push subject to the gate
  below + `AUTO_PUSH` + protected-file/branch guards.
- The dedup key already includes the action — no change.
- Labels are placeholders; renaming (e.g. `spec-it` / `green-it`) is trivial.

## B. The crux — stage 2 must be able to commit *red* tests

Today an editing action commits only if **all** checks pass. The pipeline needs
stage 2 to add edge-case tests that may *fail* against current code (that failure
is the bug they catch), commit them, so stage 3 can turn them green. So the
commit gate becomes **action-aware**:

- **`add-tests`**: the **test** check is informational and **non-blocking** —
  commit even when the new tests are red, provided install/lint/build pass (the
  tests must be valid, parseable, lintable code) and the test-only guard passes.
  The comment reports "N tests added, currently red — ready for `pass-tests`."
- **`pass-tests`**: unchanged gate — commit only when **all** checks pass; green
  is the success criterion, and the worker's own `runChecks` test run is the
  proof the stage-2 tests now pass.
- All other actions: unchanged.

Implementation: a per-action policy (e.g. `commitBlockingChecks(action, checks)`)
that excludes the `test` check from the blocking set for `add-tests` only.

**Honest limitation.** When the test check is non-blocking we cannot
auto-distinguish a newly-red stage-2 test from a regression in a pre-existing
test. The result comment surfaces the failing-test output and the human decides.
Committing red tests to the PR branch will make that PR's external CI go red
mid-pipeline; this is an intentional, conscious part of the flow and is gated by
`AUTO_PUSH`.

## C. Enforcing the boundaries

- **Stage 2 hard guard.** Add `nonTestPaths(files)` beside `blockedPaths` in
  `guards.ts`. For `add-tests`, if any changed file is **not** a test file,
  refuse to commit and report the offending files. "Test file" is decided by a
  configurable `TEST_FILE_PATTERN` (default regex covering `.test.`/`.spec.`,
  `__tests__/`, `tests?/`, `*_test.(py|go)`, etc.).
- **Stage 3 boundary** (tests frozen except mechanical renames). No reliable
  mechanical guard exists (a diff cannot distinguish a rename from a logic
  change), so this is **prompt-governed + reported + human-reviewed**: the prompt
  forbids test-logic changes and requires the agent to list every test-file edit
  and why. One cheap hard guard is included: refuse if `pass-tests` **deletes**
  a test file (blocks the worst "fake green" move).

## D. Prompts + Hermes path (option A)

- New `prompts/pr-add-tests.md` — strict test-only; cover happy path, edge cases,
  realistic failure scenarios; never edit production code; list test files added.
- New `prompts/pr-pass-tests.md` — run the suite, identify failures, edit
  production code **minimally** to make the committed tests pass; tests frozen
  except mechanical renames; list every test-file edit and why; stop and report
  if a test needs a logic change.
- **Hermes action-awareness.** When `HERMES_ENABLED`, editing actions currently
  bypass the per-action `.md` and use the generic `renderPlanningPrompt` /
  `hermesApplyPrompt`, so the constraints would be lost. Thread each action's
  hard constraints into **both** the planning and apply prompts (single source
  of truth per action), so behavior is identical with Hermes on or off. This
  also fixes the pre-existing gap for `test` / `fix-review` / `full-fix`.

## E. Truncation fix

Centralize a `reportResult(job, report)` helper that:

1. Posts the main `resultComment` — notes kept as a short preview with a "full
   output below" pointer.
2. When the AI and/or Hermes output exceeds the cap, posts the **complete** text
   via the existing `detailComments()` splitter (12k-char chunks across
   follow-up comments).

It replaces the ~5 ad-hoc `report(job, resultComment(...))` call sites in
`processPrJob.ts` (review, no-changes, failed, success, worker-error). Result:
review/plan output is never lost.

## F. Config, tests, docs

- **Config.** Add `TEST_FILE_PATTERN` (string regex, with a sensible default) to
  `config.ts` and `.env.example`.
- **Worker's own tests.**
  - Routing + precedence for the two new actions (`tests/actions.test.mjs`).
  - `nonTestPaths` guard: allowed vs blocked changes (`tests/guards.test.mjs`).
  - Action-aware commit gate: `add-tests` commits with red tests; `pass-tests`
    does not.
  - `pass-tests` test-deletion guard.
  - Action-aware Hermes/planning prompts contain the right per-action constraints.
  - `reportResult` splits over-cap notes into the main comment + N detail
    comments (`tests/comment.test.mjs`).
  - Optional worker-e2e slice exercising the two new actions with fake CLIs.
- **Docs.** README label table, `IMPROVEMENT_PLAN.md`, `.env.example`.

## Out of scope (unchanged constraints)

No merging, deploying, arbitrary repos, or fork-PR code. The worker stays a
single-host, stateless, repo-agnostic worker. Stages are driven by the committed
branch state, not by reading prior bot comments (no new GitHub-comment fetching).
