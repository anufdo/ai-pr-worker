# AI PR Worker

AI PR Worker is a small self-hosted Node.js service for an Ubuntu VPS. When an allowlisted GitHub pull request carries one of its action labels, it verifies the GitHub webhook, checks out the PR branch, runs a configured AI coding CLI with a prompt chosen by the label, runs optional checks, and comments on the PR with the result. For editing actions it also commits and (optionally) pushes the branch; read-only actions only review.

It does not merge PRs, deploy applications, accept arbitrary repositories, or run fork PR code. It is intentionally a single-host, stateless worker rather than a SaaS platform.

## Labels and actions

Add one of these labels to a PR in an allowlisted repository to trigger the worker. Each maps to a prompt and a behavior with an explicit risk level:

| Label        | Action       | AI edits?            | Commits/pushes?               | Risk     |
|--------------|--------------|----------------------|-------------------------------|----------|
| `review-it`  | `review`     | No                   | No                            | Low      |
| `add-tests`  | `add-tests`  | Tests only (strict)  | Yes (may commit failing tests)| Medium   |
| `pass-tests` | `pass-tests` | Production code      | Yes (only if all checks pass) | Medium   |
| `test-it`    | `test`       | Tests only\*         | Yes (if checks pass)          | Medium   |
| `fix-review` | `fix-review` | Yes                  | Yes (if checks pass)          | Medium   |
| `need-this`  | `full-fix`   | Yes                  | Yes (if checks pass)          | High     |
| `e2e-it`     | `e2e`        | No (runs e2e check)  | No                            | Low/Med  |

\* `test-it` limits edits to tests unless a test exposes a real bug.

`need-this` is kept for backward compatibility and is the highest-automation action. The configurable `TRIGGER_LABEL` also maps to `full-fix`. When a PR carries several action labels, the highest automation wins — precedence is `need-this` > `fix-review` > `pass-tests` > `test-it` > `add-tests` > `e2e-it` > `review-it` — and the chosen action is named in the PR comment. Each action uses its own prompt in `prompts/` (`pr-review.md`, `pr-test.md`, `pr-fix-review.md`, `pr-full-fix.md`, `pr-add-tests.md`, `pr-pass-tests.md`; `e2e` reuses the read-only review prompt).

### Review → add tests → make them pass (TDD pipeline)

Three labels run a deliberate test-driven loop, one at a time on the PR branch:

1. `review-it` — read-only review. Long reviews are posted in full: when the
   output exceeds the comment cap, the rest is split across follow-up
   "AI PR Worker Detail" comments instead of being truncated.
2. `add-tests` — adds edge-case tests **only** (happy path, edge cases, failure
   scenarios). It never edits production code. These tests **may be committed
   while failing** — a red edge-case test is the signal that the code needs a
   fix — provided the other checks (install/lint/build) don't fail (a
   skipped check is fine) and only test files changed
   (`TEST_FILE_PATTERN` decides what counts as a test). The commit/push still
   obeys `AUTO_PUSH`, so this is opt-in.
3. `pass-tests` — edits **production code** to make the committed tests pass.
   Tests are frozen except mechanical renames (updating identifiers when a
   variable/function is renamed or a call signature changes); it will not delete
   tests, and it commits only when all checks (including tests) pass.

Precedence is `need-this` > `fix-review` > `pass-tests` > `test-it` >
`add-tests` > `e2e-it` > `review-it`.

## Supported AI runners

Set `AI_PROVIDER` to `codex`, `claude`, `aider`, or `custom`. `AI_COMMAND` is always configurable and must contain `{{PROMPT}}`. The worker parses this value into an executable and argument list, then runs it without a shell. There is no separate model variable: pick the model with the CLI's own flag inside `AI_COMMAND` (for Claude Code, `--model opus`, `--model sonnet`, `--model haiku`, or a pinned id like `--model claude-opus-4-8`).

The worker runs the CLI **non-interactively with stdin closed**, so `AI_COMMAND` must not pause for an interactive permission prompt. If it does, the tool call is blocked, the AI makes no edits, and the CLI still exits successfully — the run looks "passed" but nothing changed. Use each CLI's approve-automatically flag: Claude Code `--permission-mode bypassPermissions`, Codex `--full-auto`, Aider `--yes`. For Claude Code, `bypassPermissions` auto-approves edits and bash and is safe for this worker (unprivileged account, disposable checkout, protected-file commits blocked, never merges); it refuses to run as root outside a sandbox, so run the worker as a normal user.

```env
AI_PROVIDER=codex
AI_COMMAND=codex exec --full-auto "{{PROMPT}}"
```

Other examples:

```env
AI_PROVIDER=claude
AI_COMMAND=claude -p --permission-mode bypassPermissions --model opus "{{PROMPT}}"

AI_PROVIDER=aider
AI_COMMAND=aider --yes --message "{{PROMPT}}"

AI_PROVIDER=custom
AI_COMMAND=node scripts/openrouter-runner.js "{{PROMPT}}"
```

## Setup

Use Node.js 20 or newer. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for Ubuntu, Nginx, TLS, and PM2 setup.

```bash
cp .env.example .env
npm install
npm run build
npm start
```

The health endpoint is `GET /health`. GitHub webhooks are accepted at `POST /webhooks/github`.

Configure a commit identity for the dedicated worker account:

```bash
git config --global user.name "AI PR Worker"
git config --global user.email "ai-pr-worker@example.com"
```

## GitHub token

Create a fine-grained personal access token scoped only to the repositories in `GITHUB_ALLOWED_REPOS`:

```txt
Contents: Read and write
Pull requests: Read and write
Issues: Read and write
Metadata: Read
```

## GitHub webhook

In the repository, open **Settings > Webhooks > Add webhook**:

```txt
Payload URL: https://agent.example.com/webhooks/github
Content type: application/json
Secret: same value as GITHUB_WEBHOOK_SECRET
Events: Pull requests
```

The worker responds to `opened`, `synchronize`, and `labeled` pull-request actions, but runs only while at least one recognized action label (see [Labels and actions](#labels-and-actions)) is present.

## Configuration

Copy `.env.example` to `.env` and set the GitHub token, webhook secret, allowed repositories, work directory, and AI command. Optional install, lint, test, build, e2e, push, concurrency, notification, and Hermes settings are documented inline in `.env.example`.

Validation commands run inside the checked-out repository. Start with `AUTO_PUSH=false` on a disposable repository, then enable pushes after verifying the behavior.

### End-to-end checks

`e2e` is just one more configurable check. Set `RUN_E2E=true` and `E2E_COMMAND` (default `npm run e2e`); it runs alongside install/lint/test/build and a failure blocks the commit just like any other check. The **target repository owns its own database** — its `E2E_COMMAND` spins up whatever it needs (docker-compose, testcontainers, migrations, seed data) inside its own checkout. The worker stays stateless and never manages containers or secrets.

### Result comment output

PR comments report the action, repo/PR/branch, AI command status, the install/lint/test/build/e2e results, an e2e summary when it ran, and the commit SHA when one was created. Set `INCLUDE_RAW_OUTPUT=true` to also include short, masked, length-capped snippets of failed check output. It is **off by default**: `maskSecrets` only redacts known secrets, so raw output can still leak file contents or tokens a tool echoes.

## Testing

Two helper scripts in `scripts/` let you verify the worker without waiting on a real GitHub delivery. Both expect a populated `.env` (`config.ts` validates the required variables on startup).

The unit test suite characterizes the security/correctness gates and the new label routing, plus a worker-level end-to-end harness:

```bash
npm test
```

It covers webhook signature validation, the `shouldRun` gate (ignored/accepted actions, allowlist, fork, protected branch, draft on/off), label → action routing and precedence, the queue dedup key (`repo#pr#action`), the `runChecks` passed/failed/skipped matrix, protected-file blocking, command timeout and output-cap handling, the result-comment format (masking + length caps + the `INCLUDE_RAW_OUTPUT` gate), and an end-to-end slice (`tests/worker-e2e.test.mjs`) that drives `runAi → runChecks → commit` against a throwaway local git repo using a fake file-editing AI CLI. It uses fake local AI CLIs and a local repo, so it requires no Claude login, GitHub token, or network.

> On Windows/PowerShell, `npm test` can fail when `npm.ps1` is blocked by execution policy. Use `npm.cmd test`, run it through a Bash shell, or relax the execution policy rather than hardcoding `npm.cmd` in scripts.

To send the hardcoded prompt `hi` to the real Claude CLI and print the actual stdout/stderr returned to the worker:

```bash
npm run test:claude
```

First, confirm the configured AI CLI runs and is authenticated **as the user that runs the worker** (the service account, not your interactive shell):

```bash
claude -p "Reply with the single word: OK"
```

**AI step in isolation** — exercises the real `runAi` path (render the per-action prompt `prompts/pr-<action>.md`, parse `AI_COMMAND`, run the CLI) against a local checkout. No webhook, token, clone, push, or comment. Build first, then run:

```bash
npm run build
node scripts/test-ai-step.mjs                            # review this repo (default action)
node scripts/test-ai-step.mjs --action full-fix --dir /path/to/repo  # run the fix prompt
node scripts/test-ai-step.mjs --dir /path/to/repo        # review another checkout
```

`--action` is one of `review | test | fix-review | full-fix | e2e` (default `review`).

The `AI output` block it prints is exactly what the worker would post in the PR comment's `### Notes` section.

**Signed webhook end to end** — computes the HMAC signature and POSTs a `pull_request` payload to a locally running worker. Start the server (`npm run dev`), then in another terminal:

```powershell
./scripts/send-test-webhook.ps1 -Repo "owner/repo" -Branch "feature/test"
```

Read the response and the server logs:

- `401 Invalid webhook signature`: secret mismatch between the script and `.env`.
- `202 {"accepted":false,"reason":...}`: signature is valid; the `shouldRun` gate rejected the payload (not allowlisted, label missing, protected branch, fork, and so on).
- `202 {"accepted":true}` plus a `Queued PR job` log line: the webhook path works and the job is running. With a real allowlisted repo, valid token, existing feature branch, and an authenticated AI CLI, the job then clones, runs the CLI, runs checks, and comments on the PR.

Keep `AUTO_PUSH=false` for these runs until you have confirmed the behavior.

## Example workflow

1. Open a branch PR in an allowlisted repository.
2. Add an action label (e.g. `review-it` for a read-only review, or `need-this` for a full fix).
3. GitHub sends the signed webhook.
4. The worker resolves the action from the label, queues the job, and checks out the PR branch.
5. The configured AI CLI runs with that action's prompt; editing actions change the checkout, read-only actions only review.
6. Enabled checks run (install/lint/test/build/e2e).
7. For editing actions, if checks pass and files changed (and no protected files were touched), the worker commits and optionally pushes. Read-only actions skip this.
8. The worker comments with the action, status, check results, e2e summary, commit SHA, and AI output.

## Notifications

Set `NOTIFY_PROVIDER` to `none`, `slack`, `telegram`, `discord`, or `webhook`. Hermes can also receive a summary when `HERMES_ENABLED=true`; it is optional and never required for PR processing.

## Security

Read [docs/SECURITY.md](docs/SECURITY.md) before deployment. Run this service as an unprivileged account on a host without production secrets. Keep GitHub branch protection enabled and require human review before merge.

## Troubleshooting

- `401 Invalid webhook signature`: confirm that GitHub and `.env` use the same webhook secret.
- `repository is not allowlisted`: add the exact `owner/repo` value to `GITHUB_ALLOWED_REPOS`.
- `fork PRs are not supported`: create a branch in the allowlisted repository; fork code is intentionally not executed.
- AI command failure: authenticate the selected CLI as the worker user and run the configured command manually.
- AI ran but changed nothing (or the notes say something like "permission is being blocked"): the CLI hit an interactive permission prompt it could not answer in headless mode. Add the approve-automatically flag to `AI_COMMAND` (Claude Code: `--permission-mode bypassPermissions`).
- Push failure: verify token repository access, `Contents: Read and write`, and branch protection rules.
- Stale lock after a killed process: remove the matching file from the sibling `locks/` directory after confirming no worker job is active.

## License

MIT
