# AI PR Worker — Improvement Plan

Status: proposed
Last updated: 2026-06-06

This plan extends the worker from a single `need-this` trigger into a small set of
label-driven actions with different automation/risk levels, backed by real tests.
It is the reconciled version of the original proposal — it drops the over-scoped
database orchestration and corrects one wrong assumption about current behavior.

---

## Baseline (what exists today)

Self-hosted GitHub PR worker. It verifies the webhook signature, gates on an
allowlist + the `need-this` label, checks out the PR branch, runs a configured AI
CLI, runs configured checks, commits/pushes if allowed, and comments on the PR.

Key files:

- `src/github/webhook.ts` — signature check (`validSignature`) and the `shouldRun` gate.
- `src/jobs/processPrJob.ts` — orchestration, protected-file blocking (`blockedFiles`), result comment.
- `src/jobs/jobQueue.ts` — in-memory queue with `repo#pr` dedup.
- `src/checks/runChecks.ts` — install/lint/test/build as configurable commands.
- `src/ai/aiRunner.ts` + `prompts/pr-fix.md` — renders the prompt and runs the AI CLI.
- `src/utils/exec.ts` — `runFile` (no-shell spawn, timeout, output cap) and `runShell`.
- `src/config.ts` — env validation and the `secrets` list used for masking.

The worker is **stateless** (in-memory queue, no database) and **repo-agnostic**
(it only runs configured commands inside a checkout). Both properties are design
constraints this plan preserves.

---

## ⚠️ Correct this assumption first

The original plan assumed `need-this` already does a full fix (edit → commit → push).
The code disagrees:

- `processPrJob.ts` is wired for edit → check → commit → push.
- But the actual prompt, `prompts/pr-fix.md`, is a **pure review prompt** (score 1–10,
  ends with `✅ Merge` / `❌ Fix First`). It never instructs the model to change files.

So at runtime `need-this` most likely emits *review text*, `changedFiles()` returns
empty, and the worker posts **"No changes — AI checked this PR but made no changes"**
with the review in the Notes section. The filename says `pr-fix`; the content is
`pr-review`.

**Action (Phase 0):** run the worker once against a real PR with `AUTO_PUSH=false`
and confirm what `need-this` actually does before building anything on top of it.

Consequence for the plan: `review-it` is nearly free (today's behavior minus the
commit/push path). The genuinely *new* prompt work is the **fix** prompt for
`need-this`, not the review prompt.

---

## Label taxonomy

Keep `need-this` for backward compatibility. Add focused action labels; each maps
to a prompt and a behavior with an explicit risk level.

| Label        | Action       | AI edits?            | Commits/pushes? | Risk   |
|--------------|--------------|----------------------|-----------------|--------|
| `review-it`  | `review`     | No                   | No              | Low    |
| `test-it`    | `test`       | Tests only*          | Yes (if checks pass) | Medium |
| `fix-review` | `fix-review` | Yes                  | Yes (if checks pass) | Medium |
| `add-tests`  | `add-tests`  | Tests only (strict)  | Yes (may commit red tests) | Medium |
| `pass-tests` | `pass-tests` | Production code       | Yes (all checks pass)      | Medium |
| `need-this`  | `full-fix`   | Yes                  | Yes (if checks pass) | High   |
| `e2e-it`     | `e2e`        | No (runs e2e check)  | No              | Low/Med |

\* `test-it` limits edits to tests unless a test exposes a real bug.

The `add-tests` / `pass-tests` pair forms a TDD pipeline: `add-tests` commits
edge-case tests (which may be red), `pass-tests` then edits production code to
make them green without changing test logic. Per-action hard constraints live in
`actionConstraints()` (`src/jobs/actions.ts`) and are injected into the direct,
planning, and Hermes apply prompts.

Deliberately **not** adding `lint-it` / `build-it` / `db-it` — no real workflow needs them yet.

`dry-run` is **not** a separate label. It duplicates `AUTO_PUSH=false`. If a per-PR
override is wanted later, implement it explicitly as "override global `AUTO_PUSH` for
this PR" rather than a second way to express the same thing.

### Open decisions to settle before coding

1. **Precedence** when a PR carries multiple action labels. Proposed order (highest
   automation wins, documented and logged): `need-this` > `fix-review` > `test-it` >
   `e2e-it` > `review-it`. The chosen action is named in the PR comment.
2. **Queue dedup key.** Today it is `repo#pr` (`jobQueue.ts:9`). To let, e.g., a review
   and a fix coexist, change to `repo#pr#action`.

---

## Workstreams

### 1. Trigger handling: label → action routing

- `shouldRun` accepts a PR that carries **at least one** known action label, and
  returns the resolved action (apply the precedence rule above).
- `PrJob` gains `action: "review" | "test" | "fix-review" | "full-fix" | "e2e"`.
- `processPrJob` branches on `action`: choose the prompt, and for review/e2e skip the
  commit/push path entirely.
- The PR comment states which label/action ran.
- Update the dedup key to include the action.

### 2. Unit tests (do this first — highest value)

These target the real security/correctness gates. Note: `shouldRun`, `validSignature`
(`webhook.ts`) and `blockedFiles` (`processPrJob.ts:22`) are currently module-private —
export them (or test via the HTTP layer) as step 0.

- Webhook signature validation (valid, invalid, missing, length-mismatch).
- `shouldRun`: ignored vs accepted actions; allowlisted vs not.
- Fork PR rejection (`webhook.ts:36`).
- Protected-branch rejection (both `webhook.ts:40` and `processPrJob.ts:62`).
- Draft PR behavior (`ALLOW_DRAFT_PRS` on/off).
- Queue duplicate handling (`jobQueue.ts` `pendingKeys`).
- `runChecks` passed/failed/skipped matrix and `checksPassed`.
- Protected-file blocking before commit (`blockedFiles` regex).
- Command timeout and output-cap handling (`exec.ts:47` timer + `maxOutputBuffer`).
- Label → action routing + precedence resolution (new).

### 3. Prompts

- `review-it`: reuse the existing review prompt (rename `pr-fix.md` → `pr-review.md`
  to match its content, or split into per-action prompt files).
- `need-this` (full-fix): write a real **fix** prompt that instructs the model to make
  the change.
- `test-it`: prompt focused on adding missing unit tests for the PR change.
- `fix-review`: prompt that addresses existing GitHub review comments and CI/test failures.

### 4. e2e — as a configurable check, **not** DB orchestration

The worker stays stateless and generic. e2e is just one more check, following the
existing `runChecks` pattern:

- Add `RUN_E2E` (bool) and `E2E_COMMAND` (string) to config and `.env.example`.
- The **target repo owns its database** — its own docker-compose / testcontainers run
  inside its own test/e2e command. The worker never spins containers, seeds data, runs
  migrations, or manages `.env.e2e`. (This is the part of the original plan that is cut:
  it would have broken the stateless/generic design and the "unprivileged host without
  production secrets" security posture.)

Separately, build a **worker-level e2e harness** to test the worker itself end to end,
extending the existing `scripts/send-test-webhook.ps1` and `scripts/test-ai-step.mjs`:

- Create temporary git repos.
- Post fake (signed) GitHub webhook payloads.
- Use a fake AI CLI with canned output (the `tests/fixtures/fake-ai-cli.mjs` pattern).
- Run real check commands.
- Assert on the resulting commit/comment behavior. No database required.

### 5. Richer PR comment / result reporting

Extend `resultComment` to include:

- Action label used.
- repo / PR / branch.
- AI command status.
- install / lint / test / build / e2e status.
- e2e summary (if run).
- Final commit SHA (if created).
- Short, length-capped stdout/stderr snippets, masked via the existing `maskSecrets`
  util + `config.secrets`.

**Leakage caution:** `maskSecrets` only masks *known* secrets — it will not catch
arbitrary file contents or tokens the AI echoes. Cap snippet length and consider
gating raw output behind a config flag.

---

## Implementation sequence (thin vertical slices)

Ship and verify in order rather than all at once:

0. **Confirm current `need-this` behavior** on one real PR (`AUTO_PUSH=false`).
1. **Export the gates + write the unit tests** from Workstream 2 (characterize existing behavior).
2. **Add label → action routing + `review-it`** (cheapest real action; reuse today's
   prompt, skip commit/push). Settle precedence + dedup key here.
3. **Write the real fix prompt for `need-this`**; verify edit → check → commit with `AUTO_PUSH=false`.
4. **Worker-level e2e harness** (no DB).
5. **e2e-as-a-check** (`RUN_E2E` / `E2E_COMMAND`), richer comment, README + `.env.example` updates.
6. Re-run the suite, then enable pushing only after `AUTO_PUSH=false` runs look correct.

Re-evaluate after step 3 before committing to 4–6.

---

## What changed from the original proposal

- **Corrected** the premise that `need-this` already fixes code — the current prompt is review-only.
- **Cut** the optional DB / Docker Compose / Testcontainers orchestration; replaced with
  "e2e is just another configurable check command; the target repo owns its DB."
- **Dropped** `dry-run` as a label (duplicates `AUTO_PUSH=false`).
- **Added** explicit label-precedence and queue-dedup-key decisions.
- **Flagged** that `shouldRun` / `validSignature` / `blockedFiles` must be exported to test.
- **Tightened** the comment-output leakage caveat (mask + length cap + optional flag).

---

## Out of scope (unchanged constraints)

The worker does not merge PRs, deploy apps, accept arbitrary repos, or run fork PR
code. It remains a single-host, stateless worker — not a SaaS platform. `AUTO_MERGE`
stays intentionally unsupported (`config.ts:74`).

## Testing note (Windows / PowerShell)

`npm test` can fail under PowerShell when `npm.ps1` is blocked by execution policy;
`npm.cmd test` works, or run via the Bash tool. Prefer fixing the execution policy
over hardcoding `npm.cmd` in scripts.
