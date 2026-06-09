#!/usr/bin/env node
/**
 * Layer 2 test harness: exercise the worker's AI step (runAi) against a local
 * checkout, with no GitHub webhook, token, clone, push, or comment involved.
 *
 * It imports the REAL compiled runAi(), so it tests the actual code path:
 *   prompts/pr-<action>.md -> render placeholders -> parse AI_COMMAND -> execFile.
 * The prompt is chosen by --action (default: review -> prompts/pr-review.md).
 * Whatever runAi returns is exactly what the worker would post in the PR
 * comment's "### Notes" section.
 *
 * Prereqs:
 *   1. npm run build            (produces dist/)
 *   2. .env present with AI_PROVIDER + AI_COMMAND (config.ts loads it on import).
 *      Note: config.ts also requires GITHUB_TOKEN, GITHUB_WEBHOOK_SECRET, and
 *      GITHUB_ALLOWED_REPOS to be set, even though this harness never uses them.
 *   3. The AI CLI on PATH and authenticated AS THE USER running this script.
 *
 * Usage (from anywhere; the script chdir's to the repo root itself):
 *   node scripts/test-ai-step.mjs                       # full review of this repo
 *   node scripts/test-ai-step.mjs --prompt "hi"         # isolate the CLI: run
 *                                                       # AI_COMMAND with a tiny
 *                                                       # prompt, skip the prompt file
 *   node scripts/test-ai-step.mjs --dir /path/to/repo
 *   node scripts/test-ai-step.mjs --action full-fix --dir ../some-repo  # run the fix prompt
 *   node scripts/test-ai-step.mjs --dir ../some-repo --pr 42 --repo me/app \
 *        --branch feature/x --title "Add widget" --body "Closes #1"
 *
 * --action is one of: review | test | fix-review | full-fix | e2e | add-tests | pass-tests
 * (default: review).
 */
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

let parsed;
try {
  parsed = parseArgs({
    options: {
      dir: { type: "string" },
      prompt: { type: "string" },
      action: { type: "string", default: "review" },
      pr: { type: "string", default: "1" },
      repo: { type: "string", default: "local/test-repo" },
      branch: { type: "string", default: "feature/test" },
      title: { type: "string", default: "Test PR (test-ai-step harness)" },
      body: { type: "string", default: "Manual AI-step test." },
      help: { type: "boolean", short: "h", default: false },
    },
  });
} catch (error) {
  console.error(`Argument error: ${error.message}`);
  process.exit(2);
}

const { values } = parsed;
if (values.help) {
  console.log("See the comment block at the top of scripts/test-ai-step.mjs for usage.");
  process.exit(0);
}

// runAi reads the per-action prompt from prompts/ under process.cwd(), and config.ts loads .env
// from process.cwd() on import. Pin cwd to the repo root so both resolve
// regardless of where the script was invoked. Must happen BEFORE importing dist.
process.chdir(repoRoot);

const distEntry = new URL("../dist/ai/aiRunner.js", import.meta.url);
if (!existsSync(fileURLToPath(distEntry))) {
  console.error("dist/ai/aiRunner.js not found. Run `npm run build` first.");
  process.exit(1);
}

// Resolve the target directory the AI CLI will run in (cwd of the child process).
const targetDir = path.resolve(values.dir ?? repoRoot);
if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
  console.error(`--dir is not an existing directory: ${targetDir}`);
  process.exit(1);
}

const prNumber = Number.parseInt(values.pr, 10);
if (!Number.isInteger(prNumber) || prNumber <= 0) {
  console.error(`--pr must be a positive integer (got "${values.pr}").`);
  process.exit(1);
}

const ACTIONS = ["review", "test", "fix-review", "full-fix", "e2e", "add-tests", "pass-tests"];
if (!ACTIONS.includes(values.action)) {
  console.error(`--action must be one of: ${ACTIONS.join(", ")} (got "${values.action}").`);
  process.exit(1);
}

let runAi;
let config;
let commandFromTemplate;
let runFile;
try {
  // Importing aiRunner transitively loads config.ts, which validates env vars
  // and throws on anything missing — surface that as a clear message.
  ({ runAi } = await import(distEntry));
  ({ config } = await import(new URL("../dist/config.js", import.meta.url)));
  // Same helpers runAi uses internally — reused for the --prompt path.
  ({ commandFromTemplate } = await import(new URL("../dist/ai/providers/custom.js", import.meta.url)));
  ({ runFile } = await import(new URL("../dist/utils/exec.js", import.meta.url)));
} catch (error) {
  console.error("Failed to load the worker (config validation or build issue):");
  console.error(`  ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

console.log("=== AI step test ===");
console.log(`Provider   : ${config.aiProvider}`);
console.log(`AI_COMMAND : ${config.aiCommand}`);
console.log(`Run in dir : ${targetDir}`);
console.log(`Timeout    : ${config.maxJobMinutes} min (MAX_JOB_MINUTES)`);

const startedAt = process.hrtime.bigint();
try {
  let output;
  if (values.prompt !== undefined) {
    // Isolate the CLI: build argv from AI_COMMAND with a literal prompt and run
    // it through the worker's own parser + execFile (shell:false, env inherited).
    // This is byte-for-byte how the worker invokes the AI, minus the prompt file.
    const { command, args } = commandFromTemplate(config.aiCommand, { PROMPT: values.prompt });
    const shownArgs = args.map((a) => (a === values.prompt ? "<prompt>" : a)).join(" ");
    console.log(`Mode       : direct prompt ("${values.prompt}")`);
    console.log(`Exec       : ${command} ${shownArgs}`);
    console.log("Running the AI CLI...\n");
    const { stdout, stderr } = await runFile(command, args, targetDir);
    output = [stdout, stderr].filter(Boolean).join("\n").trim();
  } else {
    const job = {
      repo: values.repo,
      repoCloneUrl: `https://github.com/${values.repo}.git`,
      defaultBranch: "main",
      prNumber,
      title: values.title,
      body: values.body,
      branch: values.branch,
      headSha: "0".repeat(40),
      url: `https://github.com/${values.repo}/pull/${prNumber}`,
      action: values.action,
    };
    console.log(`Mode       : ${job.action} (prompts/pr-${job.action === "e2e" ? "review" : job.action}.md)`);
    console.log(`Fake PR    : ${job.repo}#${job.prNumber} (${job.branch})`);
    console.log("Running the AI CLI... (this can take a while)\n");
    output = await runAi(job, targetDir);
  }
  const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
  console.log(`--- AI output (${seconds.toFixed(1)}s) — this is the comment body the worker would post ---\n`);
  console.log(output || "(empty output)");
  console.log("\n=== OK: AI step completed ===");
} catch (error) {
  const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
  console.error(`\n=== FAILED after ${seconds.toFixed(1)}s ===`);
  // execFile errors carry stdout/stderr/code — the actionable bits.
  if (error && typeof error === "object") {
    if ("code" in error) console.error(`exit code: ${error.code}`);
    if ("stderr" in error && error.stderr) console.error(`stderr:\n${error.stderr}`);
    if ("stdout" in error && error.stdout) console.error(`stdout:\n${error.stdout}`);
  }
  console.error(error instanceof Error ? error.message : String(error));
  console.error(
    "\nCommon causes: AI CLI not on PATH for THIS user, CLI not authenticated, " +
      "or AI_COMMAND missing {{PROMPT}}.",
  );
  process.exit(1);
}
