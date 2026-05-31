import { config } from "../../config.js";

export function customCommand(prompt: string): string {
  return replaceShellValue(config.aiCommand, "PROMPT", prompt);
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function replaceShellValue(template: string, name: string, value: string): string {
  const placeholder = `{{${name}}}`;
  return template
    .replaceAll(`"${placeholder}"`, shellQuote(value))
    .replaceAll(`'${placeholder}'`, shellQuote(value))
    .replaceAll(placeholder, shellQuote(value));
}
