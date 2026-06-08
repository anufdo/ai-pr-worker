import { config } from "../config.js";
import type { PrJob } from "../jobs/processPrJob.js";
import { commandFromTemplate } from "./providers/custom.js";
import { runFile } from "../utils/exec.js";

export function hermesApplyPrompt(job: PrJob, directory: string, plan: string): string {
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
    "Instructions:",
    "1. Edit files directly in this working tree.",
    "2. Keep the change small and focused.",
    "3. Add or update tests when needed.",
    "4. Do not commit, push, change git history, or modify protected files such as .env, .git, credentials, secrets, deploy, or deployment files.",
    "5. When finished, print a concise summary of changed files, tests considered, and any blocker.",
  ].join("\n");
}

export async function runHermesApply(job: PrJob, directory: string, plan: string): Promise<string> {
  const message = hermesApplyPrompt(job, directory, plan);
  const { command, args } = hermesCommandFromTemplate(config.hermesCommand, message);
  const { stdout, stderr } = await runFile(command, args, directory);
  return [stdout, stderr].filter(Boolean).join("\n").trim();
}

export function hermesCommandFromTemplate(template: string, message: string): { command: string; args: string[] } {
  const parsed = commandFromTemplate(template, { MESSAGE: message });
  return normalizeHermesCommand(parsed.command, parsed.args, message);
}

function normalizeHermesCommand(command: string, args: string[], message: string): { command: string; args: string[] } {
  const executable = command.replaceAll("\\", "/").split("/").pop()?.toLowerCase();
  const messageIndex = args.findIndex((arg) => arg === message);

  if (executable === "hermes" && args[0] === "chat" && messageIndex >= 0) {
    return { command, args: ["-z", message, "chat"] };
  }

  return { command, args };
}
