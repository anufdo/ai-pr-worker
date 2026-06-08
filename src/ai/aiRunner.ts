import { readFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { runFile } from "../utils/exec.js";
import type { PrJob } from "../jobs/processPrJob.js";
import { promptFileForAction, actionConstraints } from "../jobs/actions.js";
import { aiderCommand } from "./providers/aider.js";
import { claudeCommand } from "./providers/claude.js";
import { codexCommand } from "./providers/codex.js";
import { customCommand } from "./providers/custom.js";

function render(template: string, job: PrJob): string {
  const values: Record<string, string> = {
    PR_NUMBER: String(job.prNumber),
    REPO: job.repo,
    BRANCH: job.branch,
    TITLE: job.title,
    PR_BODY: job.body,
  };
  return Object.entries(values).reduce((result, [key, value]) => result.replaceAll(`{{${key}}}`, value), template);
}

export function renderActionPrompt(template: string, job: PrJob): string {
  const base = render(template, job);
  const constraints = actionConstraints(job.action);
  return constraints ? `${base}\n\n${constraints}` : base;
}

export async function runAi(job: PrJob, directory: string): Promise<string> {
  const templatePath = path.resolve(process.cwd(), "prompts", promptFileForAction(job.action));
  const prompt = renderActionPrompt(await readFile(templatePath, "utf8"), job);
  return runAiPrompt(prompt, directory);
}

export async function runAiPrompt(prompt: string, directory: string): Promise<string> {
  const factories = { codex: codexCommand, claude: claudeCommand, aider: aiderCommand, custom: customCommand };
  const { command, args } = factories[config.aiProvider](prompt);
  const { stdout, stderr } = await runFile(command, args, directory);
  return [stdout, stderr].filter(Boolean).join("\n").trim();
}

export function renderPlanningPrompt(job: PrJob): string {
  const constraints = actionConstraints(job.action);
  return [
    "You are reviewing a checked-out pull request repository.",
    "Do not edit files, run write commands, commit, or push.",
    "Inspect the repository and produce a concrete implementation plan for another local agent to apply.",
    "",
    "PR context:",
    `- Repository: ${job.repo}`,
    `- PR number: #${job.prNumber}`,
    `- Branch: ${job.branch}`,
    `- Title: ${job.title}`,
    "- Description:",
    "",
    job.body || "(empty)",
    "",
    ...(constraints ? [constraints, ""] : []),
    "Output:",
    "- Summarize the requested change.",
    "- List the files/functions likely involved.",
    "- Give exact implementation steps.",
    "- List tests/checks the executor should run.",
    "- Mention any risks or ambiguity.",
  ].join("\n");
}
