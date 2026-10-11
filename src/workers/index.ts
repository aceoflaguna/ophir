import { Worker } from "bullmq";
import { createBullConnection } from "../db/valkey.ts";
import { logger } from "../lib/logger.ts";
import { runHousekeeping, SCHEDULES } from "../modules/housekeeping/housekeeping.service.ts";
import { processMatch, processOfferTimeout } from "../modules/rides/matching.service.ts";
import { HOUSEKEEPING_JOBS, HOUSEKEEPING_QUEUE, housekeepingQueue, MATCHING_QUEUE, type HousekeepingJobName, type MatchingJob } from "../queues/index.ts";

/**
 * Starts the BullMQ workers. Exported (rather than run at import time) so tests can start/stop them.
 * `schedule: false` skips registering the recurring housekeeping schedules.
 */
export async function startWorkers(opts: { schedule?: boolean } = {}) {
  const matchingConn = createBullConnection();
  const housekeepingConn = createBullConnection();

  const matchingWorker = new Worker<MatchingJob>(
    MATCHING_QUEUE,
    async (job) => {
      switch (job.data.type) {
        case "match-ride": return processMatch(job.data.rideId);
        case "offer-timeout": return processOfferTimeout(job.data.offerId, job.data.rideId);
      }
    },
    { connection: matchingConn, concurrency: 20 },
  );
  const housekeepingWorker = new Worker<{ job: HousekeepingJobName }>(
    HOUSEKEEPING_QUEUE,
    async (job) => runHousekeeping(job.data.job),
    { connection: housekeepingConn, concurrency: 1 },
  );

  for (const w of [matchingWorker, housekeepingWorker]) {
    w.on("failed", (job, err) => logger.error({ queue: w.name, jobId: job?.id, name: job?.name, err: err.message }, "job failed"));
    w.on("error", (err) => logger.error({ queue: w.name, err }, "worker error"));
  }

  if (opts.schedule !== false) {
    // Idempotent: upsertJobScheduler updates the existing schedule, so many worker replicas can start safely.
    for (const name of HOUSEKEEPING_JOBS) {
      const s = SCHEDULES[name];
      await housekeepingQueue.upsertJobScheduler(`hk-${name}`, s.pattern ? { pattern: s.pattern } : { every: s.every! }, { name, data: { job: name } });
    }
    logger.info({ jobs: HOUSEKEEPING_JOBS }, "worker started; housekeeping scheduled");
  }

  return {
    async close() {
      await Promise.allSettled([matchingWorker.close(), housekeepingWorker.close()]);
      await Promise.allSettled([matchingConn.quit(), housekeepingConn.quit()]);
    },
  };
}
