# AI PR Worker

AI PR Worker is a small self-hosted Node.js service for an Ubuntu VPS. When an allowlisted GitHub pull request has the `need-this` label, it verifies the GitHub webhook, checks out the PR branch, runs a configured AI coding CLI, runs optional checks, commits changes, pushes the branch, and comments on the PR.

It does not merge PRs, deploy applications, accept arbitrary repositories, or run fork PR code. It is intentionally a single-host worker rather than a SaaS platform.

## Supported AI runners

Set `AI_PROVIDER` to `codex`, `claude`, `aider`, or `custom`. `AI_COMMAND` is always configurable and must contain `{{PROMPT}}`. The worker parses this value into an executable and argument list, then runs it without a shell.

```env
AI_PROVIDER=codex
AI_COMMAND=codex exec --full-auto "{{PROMPT}}"
```

Other examples:

```env
AI_PROVIDER=claude
AI_COMMAND=claude -p "{{PROMPT}}"

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

The worker responds to `opened`, `synchronize`, and `labeled` pull-request actions, but runs only while the trigger label is present.

## Configuration

Copy `.env.example` to `.env` and set the GitHub token, webhook secret, allowed repositories, work directory, and AI command. Optional lint, test, build, install, push, concurrency, notification, and Hermes settings are documented inline in `.env.example`.

Validation commands run inside the checked-out repository. Start with `AUTO_PUSH=false` on a disposable repository, then enable pushes after verifying the behavior.

## Example workflow

1. Open a branch PR in an allowlisted repository.
2. Add the `need-this` label.
3. GitHub sends the signed webhook.
4. The worker queues the job and checks out the PR branch.
5. The configured AI CLI edits the checkout.
6. Enabled checks run.
7. If checks pass and files changed, the worker commits and optionally pushes.
8. The worker comments with the status, check results, and AI output.

## Notifications

Set `NOTIFY_PROVIDER` to `none`, `slack`, `telegram`, `discord`, or `webhook`. Hermes can also receive a summary when `HERMES_ENABLED=true`; it is optional and never required for PR processing.

## Security

Read [docs/SECURITY.md](docs/SECURITY.md) before deployment. Run this service as an unprivileged account on a host without production secrets. Keep GitHub branch protection enabled and require human review before merge.

## Troubleshooting

- `401 Invalid webhook signature`: confirm that GitHub and `.env` use the same webhook secret.
- `repository is not allowlisted`: add the exact `owner/repo` value to `GITHUB_ALLOWED_REPOS`.
- `fork PRs are not supported`: create a branch in the allowlisted repository; fork code is intentionally not executed.
- AI command failure: authenticate the selected CLI as the worker user and run the configured command manually.
- Push failure: verify token repository access, `Contents: Read and write`, and branch protection rules.
- Stale lock after a killed process: remove the matching file from the sibling `locks/` directory after confirming no worker job is active.

## License

MIT
