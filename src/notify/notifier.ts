import { config } from "../config.js";
import { runFile } from "../utils/exec.js";
import { logger } from "../utils/logger.js";
import { commandFromTemplate } from "../ai/providers/custom.js";
import { sendDiscord } from "./discord.js";
import { postJson, sendSlack } from "./slack.js";
import { sendTelegram } from "./telegram.js";

export async function notify(message: string): Promise<void> {
  try {
    if (config.notifyProvider === "slack") await sendSlack(config.slackWebhookUrl, message);
    if (config.notifyProvider === "telegram") await sendTelegram(config.telegramBotToken, config.telegramChatId, message);
    if (config.notifyProvider === "discord") await sendDiscord(config.discordWebhookUrl, message);
    if (config.notifyProvider === "webhook") await postJson(config.notifyWebhookUrl, { message });
    if (config.hermesEnabled) {
      const { command, args } = commandFromTemplate(config.hermesCommand, { MESSAGE: message });
      await runFile(command, args);
    }
  } catch (error) {
    logger.warn("Notification failed", { error: String(error) });
  }
}
