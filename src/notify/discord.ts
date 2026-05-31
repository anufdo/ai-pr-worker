import { postJson } from "./slack.js";

export async function sendDiscord(webhookUrl: string, message: string): Promise<void> {
  await postJson(webhookUrl, { content: message });
}
