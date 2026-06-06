import { config } from "../../config.js";

export interface AiCommand {
  command: string;
  args: string[];
}

export function customCommand(prompt: string): AiCommand {
  return commandFromTemplate(config.aiCommand, { PROMPT: prompt });
}

export function commandFromTemplate(template: string, values: Record<string, string>): AiCommand {
  const parts = parseCommandLine(template).map((part) => replacePlaceholders(part, values));
  const [command, ...args] = parts;
  if (!command) throw new Error("AI_COMMAND must include an executable");
  return { command, args };
}

function replacePlaceholders(value: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (result, [name, replacement]) => result.replaceAll(`{{${name}}}`, replacement),
    value,
  );
}

function parseCommandLine(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaped) current += "\\";
  if (quote) throw new Error("AI_COMMAND contains an unterminated quote");
  if (current) args.push(current);
  return args;
}
