# Security

AI PR Worker executes commands and edits repositories on its host. Run it as a dedicated, unprivileged Linux user on a VPS that does not contain production credentials.

## Built-in controls

- GitHub webhooks must have a valid `X-Hub-Signature-256` HMAC signature.
- Only repositories listed in `GITHUB_ALLOWED_REPOS` are accepted.
- Fork PRs are rejected. The PR branch must belong to the allowlisted repository.
- Closed, merged, and draft PRs are rejected by default.
- Work on `main`, `master`, and the repository default branch is rejected.
- Jobs are queued with bounded concurrency and guarded by file locks.
- Commands containing `sudo` are rejected.
- Changes to `.env`, secret, credential, and deployment-related paths are not committed.
- Configured secrets are masked in worker logs.
- `AUTO_MERGE=true` is intentionally rejected at startup.

## Operational requirements

- Protect default branches in GitHub and require review before merge.
- Use a fine-grained token limited to allowlisted repositories.
- Keep `AUTO_PUSH=false` until the installation has been tested on a disposable repository.
- Review the AI command and validation commands before enabling a repository.
- Keep the VPS updated and restrict inbound traffic to SSH, HTTP, and HTTPS.
- Do not place deployment keys, cloud credentials, or production `.env` files in the worker account.

The AI process can still read files available to the worker account. OS-level isolation is the primary boundary.
