import { customCommand, type AiCommand } from "./custom.js";

export function codexCommand(prompt: string): AiCommand {
  return customCommand(prompt);
}
