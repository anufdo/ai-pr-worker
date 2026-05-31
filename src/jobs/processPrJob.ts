import { config } from "../config.js";
import { runAi } from "../ai/aiRunner.js";
import { checksPassed, runChecks, type CheckResults } from "../checks/runChecks.js";
import { changedFiles, commitAndPush, prepareRepo } from "../git/gitManager.js";
import { commentOnPr } from "../github/comments.js";
import { logger } from "../utils/logger.js";
import { notify } from "../notify/notifier.js";
import { withLock } from "./lock.js";

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
}

const blockedFiles = /(^|\/)(\.env($|\.)|\.git\/|deploy($|\/)|deployment($|\/)|credentials?($|\.)|secrets?($|\.))/i;

function checkLines(checks: CheckResults): string {
  return [
    `- Install: ${checks.install}`,
    `- Lint: ${checks.lint}`,
    `- Test: ${checks.test}`,
    `- Build: ${checks.build}`,
  ].join("\n");
}

function resultComment(status: string, summary: string, checks?: CheckResults, notes = ""): string {
  return `## AI PR Worker Result

Status: ${status}

### Summary
${summary}

### Checks
${checks ? checkLines(checks) : "- Checks did not run"}

### Notes
${notes || "No additional notes."}`;
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
    logger.info("Starting PR job", { repo: job.repo, pr: job.prNumber, branch: job.branch });
    await notify(`AI PR Worker started: ${job.repo}#${job.prNumber}`);
    try {
      if (!config.allowedRepos.has(job.repo)) throw new Error("Repository is not allowlisted");
      if ([job.defaultBranch, "main", "master"].includes(job.branch)) throw new Error("Refusing to work on a protected branch");
      const directory = await prepareRepo(job.repo, job.repoCloneUrl, job.branch);
      const aiSummary = await runAi(job, directory);
      const checks = await runChecks(directory);
      if (!checksPassed(checks)) {
        const body = resultComment("Failed", "- AI changes were left uncommitted because checks failed.", checks, aiSummary);
        await report(job, body);
        await notify(`AI PR Worker checks failed: ${job.repo}#${job.prNumber}`);
        return;
      }
      const files = await changedFiles(directory);
      const blocked = files.filter((file) => blockedFiles.test(file.replaceAll("\\", "/")));
      if (blocked.length) throw new Error(`Refusing to commit protected file changes: ${blocked.join(", ")}`);
      if (!files.length) {
        await report(job, resultComment("No changes", "- AI checked this PR but made no changes.", checks, aiSummary));
        await notify(`AI PR Worker completed with no changes: ${job.repo}#${job.prNumber}`);
        return;
      }

      const commit = await commitAndPush(directory, job.branch);
      const pushNote = config.autoPush ? `Pushed commit \`${commit}\`.` : `Created commit \`${commit}\`; AUTO_PUSH is disabled.`;
      await report(job, resultComment("Success", `- Updated ${files.length} file(s).\n- ${pushNote}`, checks, aiSummary));
      await notify(`AI PR Worker completed: ${job.repo}#${job.prNumber} ${pushNote}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("PR job failed", { repo: job.repo, pr: job.prNumber, error: message });
      await report(job, resultComment("Failed", "- The worker could not complete this task.", undefined, message));
      await notify(`AI PR Worker failed: ${job.repo}#${job.prNumber}: ${message}`);
    }
  });
}
