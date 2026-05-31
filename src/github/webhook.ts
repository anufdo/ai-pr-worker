import { createHmac, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { config } from "../config.js";
import { enqueuePrJob } from "../jobs/jobQueue.js";
import { logger } from "../utils/logger.js";

interface PullRequestPayload {
  action: string;
  repository: { full_name: string; default_branch: string };
  pull_request: {
    number: number;
    title: string;
    body: string | null;
    state: string;
    draft: boolean;
    merged: boolean;
    html_url: string;
    labels: Array<{ name: string }>;
    head: { ref: string; sha: string; repo: { full_name: string; clone_url: string } | null };
    base: { ref: string };
  };
}

function validSignature(body: Buffer, signature: string | undefined): boolean {
  if (!signature?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", config.webhookSecret).update(body).digest("hex")}`;
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function shouldRun(payload: PullRequestPayload): { run: boolean; reason?: string } {
  const pr = payload.pull_request;
  if (!["opened", "synchronize", "labeled"].includes(payload.action)) return { run: false, reason: "ignored action" };
  if (!config.allowedRepos.has(payload.repository.full_name)) return { run: false, reason: "repository is not allowlisted" };
  if (pr.head.repo?.full_name !== payload.repository.full_name) return { run: false, reason: "fork PRs are not supported" };
  if (pr.state !== "open" || pr.merged) return { run: false, reason: "PR is not open" };
  if (pr.draft && !config.allowDraftPrs) return { run: false, reason: "draft PRs are disabled" };
  if (!pr.labels.some((label) => label.name === config.triggerLabel)) return { run: false, reason: "trigger label is missing" };
  if ([payload.repository.default_branch, "main", "master"].includes(pr.head.ref)) return { run: false, reason: "refusing protected branch" };
  return { run: true };
}

export const webhookRouter = Router();

webhookRouter.post("/github", (request, response) => {
  const body = request.body as Buffer;
  if (!Buffer.isBuffer(body) || !validSignature(body, request.header("x-hub-signature-256"))) {
    response.status(401).json({ error: "Invalid webhook signature" });
    return;
  }

  if (request.header("x-github-event") !== "pull_request") {
    response.status(202).json({ accepted: false, reason: "ignored event" });
    return;
  }

  let payload: PullRequestPayload;
  try {
    payload = JSON.parse(body.toString("utf8")) as PullRequestPayload;
  } catch {
    response.status(400).json({ error: "Invalid JSON payload" });
    return;
  }

  const decision = shouldRun(payload);
  if (!decision.run) {
    logger.info("Webhook ignored", { repo: payload.repository.full_name, pr: payload.pull_request.number, reason: decision.reason });
    response.status(202).json({ accepted: false, reason: decision.reason });
    return;
  }

  enqueuePrJob({
    repo: payload.repository.full_name,
    repoCloneUrl: payload.pull_request.head.repo!.clone_url,
    defaultBranch: payload.repository.default_branch,
    prNumber: payload.pull_request.number,
    title: payload.pull_request.title,
    body: payload.pull_request.body ?? "",
    branch: payload.pull_request.head.ref,
    headSha: payload.pull_request.head.sha,
    url: payload.pull_request.html_url,
  });
  response.status(202).json({ accepted: true });
});
