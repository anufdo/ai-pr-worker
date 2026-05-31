import express from "express";
import { config } from "./config.js";
import { webhookRouter } from "./github/webhook.js";
import { logger } from "./utils/logger.js";

const app = express();

app.get("/health", (_request, response) => response.json({ ok: true }));
app.use("/webhooks", express.raw({ type: "application/json", limit: "1mb" }), webhookRouter);

app.listen(config.port, "127.0.0.1", () => {
  logger.info("AI PR Worker listening", { port: config.port });
});
