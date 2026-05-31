import "dotenv/config";
import path from "node:path";

export type AiProvider = "codex" | "claude" | "aider" | "custom";
export type NotifyProvider = "none" | "slack" | "telegram" | "discord" | "webhook";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function boolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  return value === undefined ? fallback : value.toLowerCase() === "true";
}

function positiveInteger(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function oneOf<T extends string>(name: string, fallback: T, values: readonly T[]): T {
  const value = (process.env[name]?.trim() || fallback) as T;
  if (!values.includes(value)) throw new Error(`${name} must be one of: ${values.join(", ")}`);
  return value;
}

const githubToken = required("GITHUB_TOKEN");
const webhookSecret = required("GITHUB_WEBHOOK_SECRET");

export const config = {
  port: positiveInteger("PORT", 8787),
  appBaseUrl: process.env.APP_BASE_URL?.trim() ?? "",
  githubToken,
  webhookSecret,
  allowedRepos: new Set(required("GITHUB_ALLOWED_REPOS").split(",").map((repo) => repo.trim()).filter(Boolean)),
  triggerLabel: process.env.TRIGGER_LABEL?.trim() || "need-this",
  workdir: path.resolve(process.env.WORKDIR?.trim() || "./repos"),
  aiProvider: oneOf<AiProvider>("AI_PROVIDER", "custom", ["codex", "claude", "aider", "custom"]),
  aiCommand: required("AI_COMMAND"),
  runInstall: boolean("RUN_INSTALL", false),
  runLint: boolean("RUN_LINT", true),
  runTest: boolean("RUN_TEST", true),
  runBuild: boolean("RUN_BUILD", false),
  installCommand: process.env.INSTALL_COMMAND?.trim() || "npm install",
  lintCommand: process.env.LINT_COMMAND?.trim() || "npm run lint",
  testCommand: process.env.TEST_COMMAND?.trim() || "npm test",
  buildCommand: process.env.BUILD_COMMAND?.trim() || "npm run build",
  autoPush: boolean("AUTO_PUSH", true),
  autoMerge: boolean("AUTO_MERGE", false),
  allowDraftPrs: boolean("ALLOW_DRAFT_PRS", false),
  maxJobMinutes: positiveInteger("MAX_JOB_MINUTES", 30),
  maxConcurrentJobs: positiveInteger("MAX_CONCURRENT_JOBS", 1),
  notifyProvider: oneOf<NotifyProvider>("NOTIFY_PROVIDER", "none", ["none", "slack", "telegram", "discord", "webhook"]),
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL?.trim() || "",
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN?.trim() || "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID?.trim() || "",
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL?.trim() || "",
  notifyWebhookUrl: process.env.NOTIFY_WEBHOOK_URL?.trim() || "",
  hermesEnabled: boolean("HERMES_ENABLED", false),
  hermesCommand: process.env.HERMES_COMMAND?.trim() || 'hermes chat github-worker "{{MESSAGE}}"',
  secrets: [
    githubToken,
    webhookSecret,
    process.env.SLACK_WEBHOOK_URL,
    process.env.TELEGRAM_BOT_TOKEN,
    process.env.DISCORD_WEBHOOK_URL,
    process.env.NOTIFY_WEBHOOK_URL,
  ].filter((value): value is string => Boolean(value)),
} as const;

if (config.autoMerge) throw new Error("AUTO_MERGE is intentionally unsupported. Set AUTO_MERGE=false.");
