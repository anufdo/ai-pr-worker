import { customCommand, type AiCommand } from "./custom.js";

export function claudeCommand(prompt: string): AiCommand {
  return customCommand(prompt);
}
