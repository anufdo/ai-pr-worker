import { execFile, exec as shellExec } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";
import { logger } from "./logger.js";
import { maskSecrets } from "./maskSecrets.js";

const execFileAsync = promisify(execFile);
const shellExecAsync = promisify(shellExec);
const forbiddenCommand = /(^|[\s;&|])sudo([\s;&|]|$)/i;

export interface ExecResult {
  stdout: string;
  stderr: string;
}

function safeArg(arg: string): string {
  return arg.replace(/\/\/[^/@]+@/g, "//***@");
}

export async function runFile(command: string, args: string[], cwd?: string): Promise<ExecResult> {
  logger.info("Running executable", { command, args: args.map(safeArg), cwd });
  const result = await execFileAsync(command, args, {
    cwd,
    timeout: config.maxJobMinutes * 60_000,
    maxBuffer: 10 * 1024 * 1024,
    env: process.env,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

export async function runShell(command: string, cwd?: string): Promise<ExecResult> {
  if (forbiddenCommand.test(command)) throw new Error("Refusing to run a command containing sudo");
  logger.info("Running shell command", { command: maskSecrets(command, config.secrets), cwd });
  const result = await shellExecAsync(command, {
    cwd,
    timeout: config.maxJobMinutes * 60_000,
    maxBuffer: 10 * 1024 * 1024,
    env: process.env,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}
