#!/usr/bin/env node
/**
 * Real Claude smoke test.
 *
 * Sends the hardcoded prompt "hi" through the same command parser and execFile
 * runner used by the worker, then prints Claude's actual stdout/stderr.
 */
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
process.chdir(repoRoot);

process.env.GITHUB_TOKEN ||= "test-github-token";
process.env.GITHUB_WEBHOOK_SECRET ||= "test-webhook-secret";
process.env.GITHUB_ALLOWED_REPOS ||= "local/test-repo";
process.env.AI_PROVIDER = "claude";
process.env.AI_COMMAND = 'claude -p --permission-mode bypassPermissions --model opus "{{PROMPT}}"';
process.env.MAX_JOB_MINUTES ||= "5";
process.env.AUTO_MERGE ||= "false";

const prompt = "hi";

function resolveExecutable(command) {
  if (process.platform !== "win32" || command.toLowerCase() !== "claude") return command;

  const npmClaudeExe = process.env.APPDATA
    ? path.join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")
    : "";
  return npmClaudeExe && existsSync(npmClaudeExe) ? npmClaudeExe : command;
}

let commandFromTemplate;
let runFile;
try {
  ({ commandFromTemplate } = await import("../dist/ai/providers/custom.js"));
  ({ runFile } = await import("../dist/utils/exec.js"));
} catch (error) {
  console.error("Failed to load compiled worker code. Run `npm run build` first.");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const { command, args } = commandFromTemplate(process.env.AI_COMMAND, { PROMPT: prompt });
const executable = resolveExecutable(command);
const shownArgs = args.map((arg) => (arg === prompt ? '"hi"' : arg)).join(" ");

console.log("=== Real Claude AI_COMMAND test ===");
console.log(`Prompt     : ${prompt}`);
console.log(`AI_COMMAND : ${process.env.AI_COMMAND}`);
console.log(`Exec       : ${command} ${shownArgs}`);
if (executable !== command) console.log(`Resolved   : ${executable}`);
console.log("");

const startedAt = process.hrtime.bigint();
try {
  const { stdout, stderr } = await runFile(executable, args, repoRoot);
  const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
  const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;

  console.log(`--- stdout (${Buffer.byteLength(stdout)} bytes) ---`);
  console.log(stdout || "(empty stdout)");
  console.log(`--- stderr (${Buffer.byteLength(stderr)} bytes) ---`);
  console.log(stderr || "(empty stderr)");
  console.log(`--- combined result returned by worker (${seconds.toFixed(1)}s) ---`);
  console.log(combined || "(empty combined output)");
  console.log("\n=== OK: Claude command completed ===");
} catch (error) {
  const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
  console.error(`\n=== FAILED after ${seconds.toFixed(1)}s ===`);
  if (error && typeof error === "object") {
    if ("code" in error) console.error(`exit code: ${error.code}`);
    if ("signal" in error) console.error(`signal: ${error.signal}`);
    if ("stdout" in error) {
      console.error(`stdout (${Buffer.byteLength(String(error.stdout ?? ""))} bytes):`);
      console.error(error.stdout || "(empty stdout)");
    }
    if ("stderr" in error) {
      console.error(`stderr (${Buffer.byteLength(String(error.stderr ?? ""))} bytes):`);
      console.error(error.stderr || "(empty stderr)");
    }
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
