import { config } from "../config.js";
import { maskSecrets } from "./maskSecrets.js";

function write(level: string, message: string, details?: unknown): void {
  const suffix = details === undefined ? "" : ` ${JSON.stringify(details)}`;
  console.log(maskSecrets(`${new Date().toISOString()} ${level} ${message}${suffix}`, config.secrets));
}

export const logger = {
  info: (message: string, details?: unknown) => write("INFO", message, details),
  warn: (message: string, details?: unknown) => write("WARN", message, details),
  error: (message: string, details?: unknown) => write("ERROR", message, details),
};
