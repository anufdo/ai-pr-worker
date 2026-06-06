import { exec as shellExec, spawn } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";
import { logger } from "./logger.js";
import { maskSecrets } from "./maskSecrets.js";

const shellExecAsync = promisify(shellExec);
const forbiddenCommand = /(^|[\s;&|])sudo([\s;&|]|$)/i;
const maxOutputBuffer = 10 * 1024 * 1024;

export interface ExecResult {
  stdout: string;
  stderr: string;
}

function safeArg(arg: string): string {
  return arg.replace(/\/\/[^/@]+@/g, "//***@");
}

function outputBytes(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value);
  if (Buffer.isBuffer(value)) return value.length;
  return 0;
}

function executableError(
  message: string,
  details: { code?: number | null; signal?: NodeJS.Signals | null; stdout: string; stderr: string },
): Error & { code?: number | null; signal?: NodeJS.Signals | null; stdout: string; stderr: string } {
  return Object.assign(new Error(message), details);
}

export async function runFile(command: string, args: string[], cwd?: string): Promise<ExecResult> {
  logger.info("Running executable", { command, args: args.map(safeArg), cwd });
  try {
    const result = await new Promise<ExecResult>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env: process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let rejected = false;

      const timer = setTimeout(() => {
        rejected = true;
        child.kill("SIGTERM");
        reject(
          executableError(`Command failed: ${command} ${args.join(" ")}`, {
            code: null,
            signal: "SIGTERM",
            stdout,
            stderr,
          }),
        );
      }, config.maxJobMinutes * 60_000);

      const collect = (stream: "stdout" | "stderr", chunk: Buffer | string) => {
        if (rejected) return;
        const text = String(chunk);
        if (stream === "stdout") stdout += text;
        else stderr += text;

        if (Buffer.byteLength(stdout) > maxOutputBuffer || Buffer.byteLength(stderr) > maxOutputBuffer) {
          rejected = true;
          clearTimeout(timer);
          child.kill("SIGTERM");
          reject(
            executableError(`Command output exceeded ${maxOutputBuffer} bytes: ${command} ${args.join(" ")}`, {
              code: null,
              signal: "SIGTERM",
              stdout,
              stderr,
            }),
          );
        }
      };

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => collect("stdout", chunk));
      child.stderr.on("data", (chunk) => collect("stderr", chunk));
      child.on("error", (error) => {
        if (rejected) return;
        rejected = true;
        clearTimeout(timer);
        reject(Object.assign(error, { stdout, stderr }));
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (rejected) return;
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        reject(executableError(`Command failed: ${command} ${args.join(" ")}`, { code, signal, stdout, stderr }));
      });
    });
    logger.info("Executable completed", {
      command,
      cwd,
      stdoutBytes: outputBytes(result.stdout),
      stderrBytes: outputBytes(result.stderr),
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const details =
      error && typeof error === "object"
        ? {
            command,
            cwd,
            code: "code" in error ? error.code : undefined,
            signal: "signal" in error ? error.signal : undefined,
            stdoutBytes: "stdout" in error ? outputBytes(error.stdout) : 0,
            stderrBytes: "stderr" in error ? outputBytes(error.stderr) : 0,
          }
        : { command, cwd };
    logger.error("Executable failed", details);
    throw error;
  }
}

export async function runShell(command: string, cwd?: string): Promise<ExecResult> {
  if (forbiddenCommand.test(command)) throw new Error("Refusing to run a command containing sudo");
  logger.info("Running shell command", { command: maskSecrets(command, config.secrets), cwd });
  const result = await shellExecAsync(command, {
    cwd,
    timeout: config.maxJobMinutes * 60_000,
    maxBuffer: maxOutputBuffer,
    env: process.env,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}
