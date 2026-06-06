import { customCommand, type AiCommand } from "./custom.js";

export function aiderCommand(prompt: string): AiCommand {
  return customCommand(prompt);
}
