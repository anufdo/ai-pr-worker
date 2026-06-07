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

export interface RunShellOptions {
  label?: string;
}

export interface RunFileOptions {
  // Override the kill timeout (defaults to MAX_JOB_MINUTES). Used by tests to
  // exercise the timeout path without waiting whole minutes.
  timeoutMs?: number;
  // Override the output cap in bytes (defaults to 10 MiB).
  maxOutputBytes?: number;
}

function safeArg(arg: string): string {
  return arg.replace(/\/\/[^/@]+@/g, "//***@");
}

function outputBytes(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value);
  if (Buffer.isBuffer(value)) return value.length;
  return 0;
}

function combinedOutput(stdout: unknown, stderr: unknown): string {
  return [stdout, stderr].filter((value): value is string => typeof value === "string" && value.length > 0).join("\n").trim();
}

function outputPreview(stdout: unknown, stderr: unknown, fallback: string): string {
  const combined = combinedOutput(stdout, stderr) || fallback;
  const masked = maskSecrets(combined, config.secrets);
  const cap = 1200;
  return masked.length <= cap ? masked : `${masked.slice(0, cap)}\n...(truncated, ${masked.length - cap} more characters)`;
}

function executableError(
  message: string,
  details: { code?: number | null; signal?: NodeJS.Signals | null; stdout: string; stderr: string },
): Error & { code?: number | null; signal?: NodeJS.Signals | null; stdout: string; stderr: string } {
  return Object.assign(new Error(message), details);
}

export async function runFile(
  command: string,
  args: string[],
  cwd?: string,
  options: RunFileOptions = {},
): Promise<ExecResult> {
  const timeoutMs = options.timeoutMs ?? config.maxJobMinutes * 60_000;
  const outputCap = options.maxOutputBytes ?? maxOutputBuffer;
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
      }, timeoutMs);

      const collect = (stream: "stdout" | "stderr", chunk: Buffer | string) => {
        if (rejected) return;
        const text = String(chunk);
        if (stream === "stdout") stdout += text;
        else stderr += text;

        if (Buffer.byteLength(stdout) > outputCap || Buffer.byteLength(stderr) > outputCap) {
          rejected = true;
          clearTimeout(timer);
          child.kill("SIGTERM");
          reject(
            executableError(`Command output exceeded ${outputCap} bytes: ${command} ${args.join(" ")}`, {
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

export async function runShell(command: string, cwd?: string, options: RunShellOptions = {}): Promise<ExecResult> {
  if (forbiddenCommand.test(command)) throw new Error("Refusing to run a command containing sudo");
  const startedAt = Date.now();
  logger.info("Running shell command", { label: options.label, command: maskSecrets(command, config.secrets), cwd });
  try {
    const result = await shellExecAsync(command, {
      cwd,
      timeout: config.maxJobMinutes * 60_000,
      maxBuffer: maxOutputBuffer,
      env: process.env,
    });
    logger.info("Shell command completed", {
      label: options.label,
      command: maskSecrets(command, config.secrets),
      cwd,
      durationMs: Date.now() - startedAt,
      stdoutBytes: outputBytes(result.stdout),
      stderrBytes: outputBytes(result.stderr),
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const details =
      error && typeof error === "object"
        ? {
            label: options.label,
            command: maskSecrets(command, config.secrets),
            cwd,
            durationMs: Date.now() - startedAt,
            code: "code" in error ? error.code : undefined,
            signal: "signal" in error ? error.signal : undefined,
            stdoutBytes: "stdout" in error ? outputBytes(error.stdout) : 0,
            stderrBytes: "stderr" in error ? outputBytes(error.stderr) : 0,
            outputPreview: outputPreview(
              "stdout" in error ? error.stdout : "",
              "stderr" in error ? error.stderr : "",
              error instanceof Error ? error.message : String(error),
            ),
          }
        : { label: options.label, command: maskSecrets(command, config.secrets), cwd, durationMs: Date.now() - startedAt };
    logger.error("Shell command failed", details);
    throw error;
  }
}
