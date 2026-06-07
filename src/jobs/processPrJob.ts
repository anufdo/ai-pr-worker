import { config } from "../config.js";
import { runAi } from "../ai/aiRunner.js";
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

function checkLines(checks: CheckResults): string {
  return [
    `- Install: ${checks.install.status}`,
    `- Lint: ${checks.lint.status}`,
    `- Test: ${checks.test.status}`,
    `- Build: ${checks.build.status}`,
    `- E2E: ${checks.e2e.status}`,
  ].join("\n");
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
      let aiSummary: string;
      try {
        aiSummary = await runAi(job, directory);
      } catch (error) {
        aiStatus = "failed";
        aiSummary = aiErrorOutput(error);
        logger.error("AI command failed", { repo: job.repo, pr: job.prNumber, action: job.action });
      }

      const checks = await runChecks(directory);

      // Read-only actions (review, e2e) never touch the branch — report and stop.
      if (isReadOnlyAction(job.action)) {
        const status = aiStatus === "failed" ? "Failed" : "Reviewed";
        await report(job, resultComment({ job, status, aiStatus, summary: readOnlySummary(job, checks), checks, notes: aiSummary }));
        await notify(`AI PR Worker ${job.action} completed: ${job.repo}#${job.prNumber}`);
        return;
      }

      if (aiStatus === "failed") {
        await report(job, resultComment({ job, status: "Failed", aiStatus, summary: "- The AI command failed; no changes were committed.", checks, notes: aiSummary }));
        await notify(`AI PR Worker AI step failed: ${job.repo}#${job.prNumber}`);
        return;
      }

      if (!checksPassed(checks)) {
        await report(job, resultComment({ job, status: "Failed", aiStatus, summary: "- AI changes were left uncommitted because checks failed.", checks, notes: aiSummary }));
        await notify(`AI PR Worker checks failed: ${job.repo}#${job.prNumber}`);
        return;
      }

      const files = await changedFiles(directory);
      const blocked = blockedPaths(files);
      if (blocked.length) throw new Error(`Refusing to commit protected file changes: ${blocked.join(", ")}`);
      if (!files.length) {
        await report(job, resultComment({ job, status: "No changes", aiStatus, summary: "- AI checked this PR but made no changes.", checks, notes: aiSummary }));
        await notify(`AI PR Worker completed with no changes: ${job.repo}#${job.prNumber}`);
        return;
      }

      const commit = await commitAndPush(directory, job.branch, commitMessageForAction(job.action, job.prNumber));
      const pushNote = config.autoPush ? `Pushed commit \`${commit}\`.` : `Created commit \`${commit}\`; AUTO_PUSH is disabled.`;
      await report(
        job,
        resultComment({ job, status: "Success", aiStatus, summary: `- Updated ${files.length} file(s).\n- ${pushNote}`, checks, commit, notes: aiSummary }),
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
