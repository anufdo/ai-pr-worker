import { customCommand, type AiCommand } from "./custom.js";
import { logger } from "../../utils/logger.js";

export function claudeCommand(prompt: string): AiCommand {
  return ensureClaudeHeadlessPermissions(customCommand(prompt), prompt);
}

export function ensureClaudeHeadlessPermissions(command: AiCommand, prompt?: string): AiCommand {
  if (!isClaudeExecutable(command.command) || hasPermissionMode(command.args)) return command;

  const promptIndex = promptArgIndex(command.args, prompt);
  const insertAt = promptIndex >= 0 ? promptIndex : command.args.length;
  const args = [
    ...command.args.slice(0, insertAt),
    "--permission-mode",
    "bypassPermissions",
    ...command.args.slice(insertAt),
  ];

  logger.info("Added Claude headless permission mode", { command: command.command, permissionMode: "bypassPermissions" });
  return { ...command, args };
}

function isClaudeExecutable(command: string): boolean {
  const executable = command.replaceAll("\\", "/").split("/").pop()?.toLowerCase();
  return executable === "claude" || executable === "claude.exe" || executable === "claude.cmd";
}

function hasPermissionMode(args: readonly string[]): boolean {
  return args.some(
    (arg) =>
      arg === "--permission-mode" ||
      arg.startsWith("--permission-mode=") ||
      arg === "--dangerously-skip-permissions",
  );
}

function promptArgIndex(args: readonly string[], prompt?: string): number {
  if (prompt !== undefined) {
    const exactIndex = args.findIndex((arg) => arg === prompt);
    if (exactIndex >= 0) return exactIndex;
  }

  for (let index = args.length - 1; index >= 0; index -= 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg.includes("\n") || arg.length > 200) return index;
  }
  return -1;
}
