import { env } from "../../config/env.ts";
import { pool, query, queryOne } from "../../db/pool.ts";
import { valkey } from "../../db/valkey.ts";
import { logger } from "../../lib/logger.ts";
import type { HousekeepingJobName } from "../../queues/index.ts";
import { GEO_VEHICLE_TYPES, SEEN_KEY, geoKey } from "../drivers/drivers.service.ts";
import { markNoDrivers } from "../rides/matching.service.ts";
import { logEvent, releaseDriver } from "../rides/rides.service.ts";

/** Each task returns the number of records it affected. */
const tasks: Record<HousekeepingJobName, () => Promise<number>> = {
  /** Delete refresh tokens that expired, or were revoked/rotated more than 7 days ago. */
  async "purge-refresh-tokens"() {
    const rows = await query(
      `DELETE FROM refresh_tokens
        WHERE expires_at < now() - interval '1 day'
           OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days') RETURNING 1`);
    return rows.length;
  },

  /** Safety net: pending offers whose timeout job was lost (Valkey flush, crash) are expired and the ride re-matched. */
  async "expire-stale-offers"() {
    const { enqueueMatch } = await import("../../queues/index.ts");
    const rows = await query<{ ride_id: string }>(
      `UPDATE ride_offers SET status='expired', responded_at=now()
        WHERE status='pending' AND expires_at < now() - interval '10 seconds' RETURNING ride_id`);
    for (const id of new Set(rows.map((r) => r.ride_id))) await enqueueMatch(id);
    return rows.length;
  },

  /** Rides stuck in 'searching' past the search window (e.g. matching jobs lost) become 'no_drivers'. */
  async "expire-stale-searches"() {
    const rows = await query<{ id: string }>(
      `SELECT id FROM rides WHERE status='searching' AND requested_at < now() - make_interval(secs => $1)`,
      [env.RIDE_SEARCH_TIMEOUT_SECONDS + 30]);
    let n = 0;
    for (const r of rows) if (await markNoDrivers(r.id)) n++;
    return n;
  },

  /** Rides that sat in accepted/arrived/in_progress for hours are almost certainly abandoned: cancel and free the driver. */
  async "release-stuck-rides"() {
    const rows = await query<{ id: string; driver_id: string | null }>(
      `UPDATE rides SET status='cancelled', cancelled_by='system', cancel_reason='Ride timed out (housekeeping)', cancelled_at=now(), updated_at=now()
        WHERE status IN ('accepted','arrived','in_progress') AND updated_at < now() - make_interval(hours => $1)
        RETURNING id, driver_id`, [env.STUCK_RIDE_HOURS]);
    for (const r of rows) {
      await logEvent(pool, r.id, "cancelled", null, { by: "system", reason: "housekeeping" });
      if (r.driver_id) await releaseDriver(r.driver_id);
    }
    return rows.length;
  },

  /** Drivers that stopped sending locations are removed from the geo index and set offline. */
  async "offline-stale-drivers"() {
    const cutoff = Math.floor(Date.now() / 1000) - env.DRIVER_STALE_SECONDS;
    const stale = await valkey.zrangebyscore(SEEN_KEY, "-inf", cutoff);
    let n = 0;
    for (const id of stale) {
      for (const t of GEO_VEHICLE_TYPES) await valkey.zrem(geoKey(t), id);
      await valkey.zrem(SEEN_KEY, id);
      const r = await queryOne("UPDATE drivers SET status='offline', updated_at=now() WHERE user_id=$1 AND status='online' RETURNING 1", [id]);
      if (r) n++;
    }
    // Reconcile: DB says online but they have no heartbeat at all (e.g. Valkey was flushed).
    const orphans = await query<{ user_id: string }>(
      `UPDATE drivers SET status='offline', updated_at=now()
        WHERE status='online' AND (last_seen_at IS NULL OR last_seen_at < now() - make_interval(secs => $1 * 5))
        RETURNING user_id`, [env.DRIVER_STALE_SECONDS]);
    for (const o of orphans) for (const t of GEO_VEHICLE_TYPES) await valkey.zrem(geoKey(t), o.user_id);
    return n + orphans.length;
  },

  async "purge-housekeeping-runs"() {
    const rows = await query("DELETE FROM housekeeping_runs WHERE started_at < now() - interval '30 days' RETURNING 1");
    return rows.length;
  },
};

/** Schedules (cron or every-N-ms) registered with BullMQ job schedulers at worker start-up. */
export const SCHEDULES: Record<HousekeepingJobName, { every?: number; pattern?: string }> = {
  "purge-refresh-tokens": { pattern: "0 3 * * *" }, // daily 03:00
  "expire-stale-offers": { every: 30_000 },
  "expire-stale-searches": { every: 60_000 },
  "release-stuck-rides": { pattern: "*/15 * * * *" },
  "offline-stale-drivers": { every: 30_000 },
  "purge-housekeeping-runs": { pattern: "30 3 * * *" },
};

export async function runHousekeeping(job: HousekeepingJobName): Promise<number> {
  const run = (await queryOne<{ id: number }>("INSERT INTO housekeeping_runs (job) VALUES ($1) RETURNING id", [job]))!;
  try {
    const affected = await tasks[job]();
    await query("UPDATE housekeeping_runs SET finished_at=now(), affected=$2 WHERE id=$1", [run.id, affected]);
    if (affected) logger.info({ job, affected }, "housekeeping");
    return affected;
  } catch (err) {
    await query("UPDATE housekeeping_runs SET finished_at=now(), error=$2 WHERE id=$1", [run.id, String((err as Error).message)]);
    throw err;
  }
}
