import { readFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { runShell } from "../utils/exec.js";
import type { PrJob } from "../jobs/processPrJob.js";
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

export async function runAi(job: PrJob, directory: string): Promise<string> {
  const templatePath = path.resolve(process.cwd(), "prompts", "pr-fix.md");
  const prompt = render(await readFile(templatePath, "utf8"), job);
  const factories = { codex: codexCommand, claude: claudeCommand, aider: aiderCommand, custom: customCommand };
  const { stdout, stderr } = await runShell(factories[config.aiProvider](prompt), directory);
  return [stdout, stderr].filter(Boolean).join("\n").trim();
}
