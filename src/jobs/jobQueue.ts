import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { processPrJob, type PrJob } from "./processPrJob.js";

const queue: PrJob[] = [];
const pendingKeys = new Set<string>();
let running = 0;

function key(job: PrJob): string {
  return `${job.repo}#${job.prNumber}`;
}

export function enqueuePrJob(job: PrJob): void {
  if (pendingKeys.has(key(job))) {
    logger.info("Skipping duplicate queued job", { repo: job.repo, pr: job.prNumber });
    return;
  }
  queue.push(job);
  pendingKeys.add(key(job));
  logger.info("Queued PR job", { repo: job.repo, pr: job.prNumber, queued: queue.length });
  void drain();
}

async function drain(): Promise<void> {
  while (running < config.maxConcurrentJobs && queue.length) {
    const job = queue.shift()!;
    running += 1;
    void processPrJob(job)
      .catch((error: unknown) => logger.error("Unhandled PR job error", { repo: job.repo, pr: job.prNumber, error: String(error) }))
      .finally(() => {
        running -= 1;
        pendingKeys.delete(key(job));
        void drain();
      });
  }
}
