import { config } from "../config.js";
import { runShell } from "../utils/exec.js";

export type CheckStatus = "passed" | "failed" | "skipped";
export type CheckName = "install" | "lint" | "test" | "build" | "e2e";

export interface CheckOutcome {
  status: CheckStatus;
  // Captured stdout/stderr from the command (empty when skipped). Callers must
  // mask and length-cap this before surfacing it anywhere user-visible.
  output: string;
}

export type CheckResults = Record<CheckName, CheckOutcome>;

export interface CheckSpec {
  name: CheckName;
  enabled: boolean;
  command: string;
}

function combine(stdout: string, stderr: string): string {
  return [stdout, stderr].filter(Boolean).join("\n").trim();
}

function errorOutput(error: unknown): string {
  if (error && typeof error === "object" && ("stdout" in error || "stderr" in error)) {
    const out = "stdout" in error && typeof error.stdout === "string" ? error.stdout : "";
    const err = "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
    const combined = combine(out, err);
    if (combined) return combined;
  }
  return error instanceof Error ? error.message : String(error);
}

async function check(name: CheckName, enabled: boolean, command: string, directory: string): Promise<CheckOutcome> {
  if (!enabled) return { status: "skipped", output: "" };
  try {
    const { stdout, stderr } = await runShell(command, directory, { label: name });
    return { status: "passed", output: combine(stdout, stderr) };
  } catch (error) {
    return { status: "failed", output: errorOutput(error) };
  }
}

export function defaultCheckSpecs(): CheckSpec[] {
  return [
    { name: "install", enabled: config.runInstall, command: config.installCommand },
    { name: "lint", enabled: config.runLint, command: config.lintCommand },
    { name: "test", enabled: config.runTest, command: config.testCommand },
    { name: "build", enabled: config.runBuild, command: config.buildCommand },
    { name: "e2e", enabled: config.runE2e, command: config.e2eCommand },
  ];
}

export async function runChecks(
  directory: string,
  specs: CheckSpec[] = defaultCheckSpecs(),
): Promise<CheckResults> {
  const results = {} as CheckResults;
  for (const spec of specs) {
    results[spec.name] = await check(spec.name, spec.enabled, spec.command, directory);
  }
  return results;
}

export function checksPassed(checks: CheckResults): boolean {
  return Object.values(checks).every((outcome) => outcome.status !== "failed");
}
