import { config } from "../config.js";
import { renderPlanningPrompt, runAi, runAiPrompt } from "../ai/aiRunner.js";
import { runHermesApply } from "../ai/hermesRunner.js";
import { checksPassed, runChecks, type CheckName, type CheckOutcome, type CheckResults } from "../checks/runChecks.js";
import { changedFiles, commitAndPush, prepareRepo } from "../git/gitManager.js";
import { commentOnPr } from "../github/comments.js";
import { logger } from "../utils/logger.js";
import { maskSecrets } from "../utils/maskSecrets.js";
import { notify } from "../notify/notifier.js";
import { withLock } from "./lock.js";
import { commitMessageForAction, isReadOnlyAction, type PrAction } from "./actions.js";
import { blockedPaths, isProtectedBranch } from "./guards.js";

export interface PrJob {
  repo: string;
  repoCloneUrl: string;
  defaultBranch: string;
  prNumber: number;
  title: string;
  body: string;
  branch: string;
  headSha: string;
  url: string;
  action: PrAction;
}

// Length caps for anything echoed into the PR comment. maskSecrets only catches
// *known* secrets (config.secrets); capping bounds leakage of anything else the
// AI or a check might print.
const NOTES_CAP = 4000;
const SNIPPET_CAP = 2000;

function clip(text: string, cap: number): string {
  const masked = maskSecrets(text, config.secrets);
  if (masked.length <= cap) return masked;
  return `${masked.slice(0, cap)}\n…(truncated, ${masked.length - cap} more characters)`;
}

function aiErrorOutput(error: unknown): string {
  if (error && typeof error === "object") {
    const out = "stdout" in error && typeof error.stdout === "string" ? error.stdout : "";
    const err = "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
    const combined = [out, err].filter(Boolean).join("\n").trim();
    if (combined) return combined;
  }
  return error instanceof Error ? error.message : String(error);
}

// Heuristic: did the AI report that it was blocked from editing? Used only to add
// a non-authoritative hint when an editing action produced no file changes — the
// usual cause is a headless CLI hitting an interactive permission prompt it could
// not answer (e.g. `claude -p` without --permission-mode bypassPermissions).
export function looksPermissionBlocked(text: string): boolean {
  return /permission (?:is )?(?:being )?(?:blocked|denied)|unable to (?:edit|write|modify)|edits? (?:were|was) blocked/i.test(text);
}

function checkLines(checks: CheckResults): string {
  const lines = [
    `- Install: ${checks.install.status}`,
    `- Lint: ${checks.lint.status}`,
    `- Test: ${checks.test.status}`,
    `- Build: ${checks.build.status}`,
    `- E2E: ${checks.e2e.status}`,
  ];
  if (!config.includeRawOutput && Object.values(checks).some((outcome) => outcome.status === "failed")) {
    lines.push("- Failed check output: hidden in PR comment; PM2 logs include a short masked failure preview. Set `INCLUDE_RAW_OUTPUT=true` to include snippets here.");
  }
  return lines.join("\n");
}

function rawCheckOutput(checks: CheckResults): string {
  return (Object.entries(checks) as Array<[CheckName, CheckOutcome]>)
    .filter(([, outcome]) => outcome.status === "failed" && outcome.output)
    .map(([name, outcome]) => `[${name}]\n${outcome.output}`)
    .join("\n\n");
}

export interface Report {
  job: PrJob;
  status: string;
  summary: string;
  notes: string;
  aiStatus?: "passed" | "failed";
  hermesStatus?: "passed" | "failed";
  checks?: CheckResults;
  commit?: string;
}

export function resultComment(report: Report): string {
  const { job, checks } = report;
  const sections: string[] = [
    `## AI PR Worker Result\n\nStatus: ${report.status}`,
    `### Action\n- Action: \`${job.action}\`\n- Repo: ${job.repo}\n- PR: #${job.prNumber}\n- Branch: \`${job.branch}\``,
  ];
  if (report.aiStatus) sections.push(`### AI command\n- Status: ${report.aiStatus}`);
  if (report.hermesStatus) sections.push(`### Hermes apply\n- Status: ${report.hermesStatus}`);
  sections.push(`### Summary\n${report.summary}`);
  sections.push(`### Checks\n${checks ? checkLines(checks) : "- Checks did not run"}`);
  if (checks && checks.e2e.status !== "skipped") {
    sections.push(`### E2E summary\n\`\`\`\n${clip(checks.e2e.output || "(no output)", SNIPPET_CAP)}\n\`\`\``);
  }
  if (report.commit) sections.push(`### Commit\n\`${report.commit}\``);
  sections.push(`### Notes\n${report.notes ? clip(report.notes, NOTES_CAP) : "No additional notes."}`);
  if (config.includeRawOutput && checks) {
    const raw = rawCheckOutput(checks);
    if (raw) sections.push(`### Raw output\n\`\`\`\n${clip(raw, SNIPPET_CAP)}\n\`\`\``);
  }
  return sections.join("\n\n");
}

function readOnlySummary(job: PrJob, checks: CheckResults): string {
  const lines = [`- Ran read-only \`${job.action}\`; no changes were committed.`];
  if (checks.e2e.status !== "skipped") lines.push(`- E2E check: ${checks.e2e.status}.`);
  return lines.join("\n");
}

async function report(job: PrJob, body: string): Promise<void> {
  try {
    await commentOnPr(job.repo, job.prNumber, body);
  } catch (error) {
    logger.error("Could not comment on PR", { repo: job.repo, pr: job.prNumber, error: String(error) });
  }
}

export async function processPrJob(job: PrJob): Promise<void> {
  await withLock(`${job.repo}-${job.prNumber}`, async () => {
    logger.info("Starting PR job", { repo: job.repo, pr: job.prNumber, branch: job.branch, action: job.action });
    await notify(`AI PR Worker started: ${job.repo}#${job.prNumber} (${job.action})`);
    try {
      if (!config.allowedRepos.has(job.repo)) throw new Error("Repository is not allowlisted");
      if (isProtectedBranch(job.branch, job.defaultBranch)) throw new Error("Refusing to work on a protected branch");
      const directory = await prepareRepo(job.repo, job.repoCloneUrl, job.branch);

      let aiStatus: "passed" | "failed" = "passed";
      let hermesStatus: "passed" | "failed" | undefined;
      let aiSummary: string;
      let hermesSummary = "";
      const useHermesExecutor = config.hermesEnabled && !isReadOnlyAction(job.action);
      try {
        aiSummary = useHermesExecutor ? await runAiPrompt(renderPlanningPrompt(job), directory) : await runAi(job, directory);
      } catch (error) {
        aiStatus = "failed";
        aiSummary = aiErrorOutput(error);
        logger.error("AI command failed", { repo: job.repo, pr: job.prNumber, action: job.action });
      }

      if (aiStatus === "failed") {
        await report(job, resultComment({ job, status: "Failed", aiStatus, summary: "- The AI command failed; no changes were committed.", notes: aiSummary }));
        await notify(`AI PR Worker AI step failed: ${job.repo}#${job.prNumber}`);
        return;
      }

      if (useHermesExecutor) {
        hermesStatus = "passed";
        try {
          hermesSummary = await runHermesApply(job, directory, aiSummary);
        } catch (error) {
          hermesStatus = "failed";
          hermesSummary = aiErrorOutput(error);
          logger.error("Hermes apply failed", { repo: job.repo, pr: job.prNumber, action: job.action });
        }

        if (hermesStatus === "failed") {
          await report(
            job,
            resultComment({
              job,
              status: "Failed",
              aiStatus,
              hermesStatus,
              summary: "- Hermes failed while applying the Claude plan; no changes were committed.",
              notes: [`Claude plan:\n${aiSummary}`, `Hermes output:\n${hermesSummary}`].join("\n\n"),
            }),
          );
          await notify(`AI PR Worker Hermes step failed: ${job.repo}#${job.prNumber}`);
          return;
        }
      }

      const checks = await runChecks(directory);
      logger.info("Checks completed", {
        repo: job.repo,
        pr: job.prNumber,
        install: checks.install.status,
        lint: checks.lint.status,
        test: checks.test.status,
        build: checks.build.status,
        e2e: checks.e2e.status,
      });

      // Read-only actions (review, e2e) never touch the branch — report and stop.
      if (isReadOnlyAction(job.action)) {
        await report(job, resultComment({ job, status: "Reviewed", aiStatus, summary: readOnlySummary(job, checks), checks, notes: aiSummary }));
        await notify(`AI PR Worker ${job.action} completed: ${job.repo}#${job.prNumber}`);
        return;
      }

      // Inspect what the AI actually changed before interpreting the checks. A
      // zero-change run from an editing action usually means the AI never wrote
      // anything — most often a headless CLI that hit an interactive permission
      // prompt it could not answer. Report that distinctly instead of blaming the
      // checks, which then ran against unchanged code.
      const files = await changedFiles(directory);
      if (!files.length) {
        const failedChecks = !checksPassed(checks);
        const note = looksPermissionBlocked(aiSummary)
          ? `${aiSummary}\n\n> The AI reported a blocked permission and changed no files. For a headless CLI, grant edit permission in AI_COMMAND (Claude Code: \`--permission-mode bypassPermissions\`).`
          : [aiSummary, hermesSummary].filter(Boolean).join("\n\nHermes output:\n");
        await report(
          job,
          resultComment({
            job,
            status: failedChecks ? "Failed" : "No changes",
            aiStatus,
            hermesStatus,
            summary: failedChecks
              ? "- No file changes were made; nothing to commit.\n- Checks failed against the unchanged checkout."
              : "- No file changes were made; nothing to commit.",
            checks,
            notes: note,
          }),
        );
        await notify(
          failedChecks
            ? `AI PR Worker checks failed with no changes: ${job.repo}#${job.prNumber}`
            : `AI PR Worker completed with no changes: ${job.repo}#${job.prNumber}`,
        );
        return;
      }

      if (!checksPassed(checks)) {
        await report(
          job,
          resultComment({
            job,
            status: "Failed",
            aiStatus,
            hermesStatus,
            summary: "- Changes were left uncommitted because checks failed.",
            checks,
            notes: [aiSummary, hermesSummary].filter(Boolean).join("\n\nHermes output:\n"),
          }),
        );
        await notify(`AI PR Worker checks failed: ${job.repo}#${job.prNumber}`);
        return;
      }

      const blocked = blockedPaths(files);
      if (blocked.length) throw new Error(`Refusing to commit protected file changes: ${blocked.join(", ")}`);

      const commit = await commitAndPush(directory, job.branch, commitMessageForAction(job.action, job.prNumber));
      const pushNote = config.autoPush ? `Pushed commit \`${commit}\`.` : `Created commit \`${commit}\`; AUTO_PUSH is disabled.`;
      await report(
        job,
        resultComment({
          job,
          status: "Success",
          aiStatus,
          hermesStatus,
          summary: `- Updated ${files.length} file(s).\n- ${pushNote}`,
          checks,
          commit,
          notes: [aiSummary, hermesSummary].filter(Boolean).join("\n\nHermes output:\n"),
        }),
      );
      await notify(`AI PR Worker completed: ${job.repo}#${job.prNumber} ${pushNote}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("PR job failed", { repo: job.repo, pr: job.prNumber, error: message });
      await report(job, resultComment({ job, status: "Failed", summary: "- The worker could not complete this task.", notes: message }));
      await notify(`AI PR Worker failed: ${job.repo}#${job.prNumber}: ${message}`);
    }
  });
}
