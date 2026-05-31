import { postJson } from "./slack.js";

export async function sendTelegram(token: string, chatId: string, message: string): Promise<void> {
  await postJson(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chatId, text: message });
}
