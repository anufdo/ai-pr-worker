export async function sendSlack(webhookUrl: string, message: string): Promise<void> {
  await postJson(webhookUrl, { text: message });
}

export async function postJson(url: string, body: unknown): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Notification request failed with HTTP ${response.status}`);
}
