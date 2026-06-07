import { customCommand, type AiCommand } from "./custom.js";

export const CLAUDE_ROOT_PERMISSION_MESSAGE =
  "Claude Code refuses bypass/dangerous permission modes when running as root or through sudo. Run ai-pr-worker under a non-root PM2 user, then retry the PR job.";

export interface ClaudePermissionOptions {
  allowRoot?: boolean;
  getuid?: () => number;
}

export function claudeCommand(prompt: string): AiCommand {
  return ensureClaudeSafePermissions(customCommand(prompt));
}

export function ensureClaudeSafePermissions(command: AiCommand, options: ClaudePermissionOptions = {}): AiCommand {
  if (!isClaudeExecutable(command.command)) return command;
  if (!options.allowRoot && isRootUser(options.getuid) && requiresUnsafeClaudePermission(command.args)) throw new Error(CLAUDE_ROOT_PERMISSION_MESSAGE);
  return command;
}

function isRootUser(getuid = process.getuid): boolean {
  return typeof getuid === "function" && getuid() === 0;
}

function isClaudeExecutable(command: string): boolean {
  const executable = command.replaceAll("\\", "/").split("/").pop()?.toLowerCase();
  return executable === "claude" || executable === "claude.exe" || executable === "claude.cmd";
}

function requiresUnsafeClaudePermission(args: readonly string[]): boolean {
  const modeIndex = args.findIndex((arg) => arg === "--permission-mode");
  const pairedMode = modeIndex >= 0 ? args[modeIndex + 1] : undefined;
  return (
    pairedMode === "bypassPermissions" ||
    args.some((arg) => arg === "--permission-mode=bypassPermissions" || arg === "--dangerously-skip-permissions")
  );
}
