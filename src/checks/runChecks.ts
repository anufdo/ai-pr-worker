import { config } from "../config.js";
import { runShell } from "../utils/exec.js";

export type CheckStatus = "passed" | "failed" | "skipped";
export type CheckResults = Record<"install" | "lint" | "test" | "build", CheckStatus>;

async function check(enabled: boolean, command: string, directory: string): Promise<CheckStatus> {
  if (!enabled) return "skipped";
  try {
    await runShell(command, directory);
    return "passed";
  } catch {
    return "failed";
  }
}

export async function runChecks(directory: string): Promise<CheckResults> {
  return {
    install: await check(config.runInstall, config.installCommand, directory),
    lint: await check(config.runLint, config.lintCommand, directory),
    test: await check(config.runTest, config.testCommand, directory),
    build: await check(config.runBuild, config.buildCommand, directory),
  };
}

export function checksPassed(checks: CheckResults): boolean {
  return Object.values(checks).every((status) => status !== "failed");
}
