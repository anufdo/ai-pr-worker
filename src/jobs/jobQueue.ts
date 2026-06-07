import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { processPrJob, type PrJob } from "./processPrJob.js";

const queue: PrJob[] = [];
const pendingKeys = new Set<string>();
let running = 0;

// Indirection so tests can substitute the processor without hitting GitHub.
let processor: (job: PrJob) => Promise<void> = processPrJob;

export function __setProcessorForTests(fn: (job: PrJob) => Promise<void>): void {
  processor = fn;
}

// Dedup key includes the action so, e.g., a review and a full-fix on the same
// PR can coexist instead of one silently dropping the other.
export function dedupKey(job: PrJob): string {
  return `${job.repo}#${job.prNumber}#${job.action}`;
}

export function enqueuePrJob(job: PrJob): void {
  if (pendingKeys.has(dedupKey(job))) {
    logger.info("Skipping duplicate queued job", { repo: job.repo, pr: job.prNumber, action: job.action });
    return;
  }
  queue.push(job);
  pendingKeys.add(dedupKey(job));
  logger.info("Queued PR job", { repo: job.repo, pr: job.prNumber, action: job.action, queued: queue.length });
  void drain();
}

async function drain(): Promise<void> {
  while (running < config.maxConcurrentJobs && queue.length) {
    const job = queue.shift()!;
    running += 1;
    void processor(job)
      .catch((error: unknown) => logger.error("Unhandled PR job error", { repo: job.repo, pr: job.prNumber, error: String(error) }))
      .finally(() => {
        running -= 1;
        pendingKeys.delete(dedupKey(job));
        void drain();
      });
  }
}
