import { Queue } from "bullmq";
import { createBullConnection } from "../db/valkey.ts";

export const MATCHING_QUEUE = "ride-matching";
export const HOUSEKEEPING_QUEUE = "housekeeping";

export type MatchingJob =
  | { type: "match-ride"; rideId: string }
  | { type: "offer-timeout"; offerId: string; rideId: string };

export type HousekeepingJobName =
  | "purge-refresh-tokens"
  | "expire-stale-offers"
  | "expire-stale-searches"
  | "release-stuck-rides"
  | "offline-stale-drivers"
  | "purge-housekeeping-runs";

export const HOUSEKEEPING_JOBS: HousekeepingJobName[] = [
  "purge-refresh-tokens",
  "expire-stale-offers",
  "expire-stale-searches",
  "release-stuck-rides",
  "offline-stale-drivers",
  "purge-housekeeping-runs",
];

const connection = createBullConnection();

export const matchingQueue = new Queue<MatchingJob>(MATCHING_QUEUE, {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 24 * 3600 },
  },
});

export const housekeepingQueue = new Queue<{ job: HousekeepingJobName }>(HOUSEKEEPING_QUEUE, {
  connection,
  defaultJobOptions: { removeOnComplete: { count: 100 }, removeOnFail: { count: 100 }, attempts: 2 },
});

/** BullMQ custom job ids must not contain ":" so we use "-" separators. */
export const enqueueMatch = (rideId: string, delayMs = 0) =>
  matchingQueue.add("match-ride", { type: "match-ride", rideId }, { delay: delayMs });

export const enqueueOfferTimeout = (offerId: string, rideId: string, delayMs: number) =>
  matchingQueue.add("offer-timeout", { type: "offer-timeout", offerId, rideId }, { delay: delayMs, jobId: `offer-timeout-${offerId}` });

export const cancelOfferTimeout = async (offerId: string) => {
  const job = await matchingQueue.getJob(`offer-timeout-${offerId}`);
  await job?.remove().catch(() => {});
};

export async function closeQueues() {
  await Promise.allSettled([matchingQueue.close(), housekeepingQueue.close()]);
  await connection.quit().catch(() => {});
}
