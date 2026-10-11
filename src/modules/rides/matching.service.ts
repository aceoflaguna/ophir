import { env } from "../../config/env.ts";
import { pool, query, queryOne, withTransaction } from "../../db/pool.ts";
import { logger } from "../../lib/logger.ts";
import { enqueueMatch, enqueueOfferTimeout } from "../../queues/index.ts";
import { nearbyDrivers } from "../drivers/drivers.service.ts";
import { logEvent, type RideRow } from "./rides.service.ts";

const RETRY_DELAY_MS = 5_000;

/**
 * One matching step for a ride. Idempotent: safe to run many times concurrently/repeatedly.
 * Offers the ride to the single nearest eligible driver; the offer-timeout job (or a decline)
 * triggers the next step until someone accepts, we run out of time, or the ride is cancelled.
 */
export async function processMatch(rideId: string): Promise<string> {
  const ride = await queryOne<RideRow>("SELECT * FROM rides WHERE id=$1", [rideId]);
  if (!ride || ride.status !== "searching") return "skipped";

  if (Date.now() - ride.requested_at.getTime() > env.RIDE_SEARCH_TIMEOUT_SECONDS * 1000) {
    return (await markNoDrivers(rideId)) ? "no_drivers" : "skipped";
  }

  const candidates = await nearbyDrivers(ride.vehicle_type, ride.pickup_lat, ride.pickup_lng, env.MATCH_SEARCH_RADIUS_KM, env.MATCH_MAX_CANDIDATES * 3);
  const distById = new Map(candidates.map((c) => [c.id, c.distanceKm]));

  // Eligible = online in Postgres, not already offered this ride, no other pending offer.
  let eligible: { user_id: string }[] = [];
  if (candidates.length) {
    eligible = await query<{ user_id: string }>(
      `SELECT d.user_id FROM drivers d
        WHERE d.user_id = ANY($1::uuid[]) AND d.status = 'online'
          AND NOT EXISTS (SELECT 1 FROM ride_offers o WHERE o.ride_id = $2 AND o.driver_id = d.user_id)
          AND NOT EXISTS (SELECT 1 FROM ride_offers o WHERE o.driver_id = d.user_id AND o.status = 'pending' AND o.expires_at > now())`,
      [candidates.map((c) => c.id), rideId],
    );
  }
  const ok = new Set(eligible.map((e) => e.user_id));
  const pick = candidates.find((c) => ok.has(c.id));

  if (!pick) {
    await enqueueMatch(rideId, RETRY_DELAY_MS); // nobody free right now; poll again until timeout
    return "no_candidate_retry";
  }

  const offer = await withTransaction(async (tx) => {
    // Serialise matching steps per ride.
    const locked = await queryOne<{ status: string }>("SELECT status FROM rides WHERE id=$1 FOR UPDATE", [rideId], tx);
    if (locked?.status !== "searching") return null;
    const pending = await queryOne("SELECT 1 FROM ride_offers WHERE ride_id=$1 AND status='pending' AND expires_at > now()", [rideId], tx);
    if (pending) return "pending" as const;
    const row = await queryOne<{ id: string }>(
      `INSERT INTO ride_offers (ride_id, driver_id, distance_km, expires_at)
       VALUES ($1,$2,$3, now() + make_interval(secs => $4))
       ON CONFLICT (ride_id, driver_id) DO NOTHING RETURNING id`,
      [rideId, pick.id, pick.distanceKm, env.DRIVER_OFFER_TIMEOUT_SECONDS], tx);
    if (row) await logEvent(tx, rideId, "offered", pick.id, { distanceKm: pick.distanceKm });
    return row;
  });

  if (offer === "pending") return "waiting_for_response";
  if (!offer) { await enqueueMatch(rideId); return "retry"; }
  await enqueueOfferTimeout(offer.id, rideId, env.DRIVER_OFFER_TIMEOUT_SECONDS * 1000 + 250);
  logger.info({ rideId, driverId: pick.id, distanceKm: distById.get(pick.id) }, "ride offered");
  return "offered";
}

/** Offer TTL elapsed: expire it and move on to the next driver. */
export async function processOfferTimeout(offerId: string, rideId: string): Promise<string> {
  const expired = await queryOne(
    "UPDATE ride_offers SET status='expired', responded_at=now() WHERE id=$1 AND status='pending' RETURNING id", [offerId]);
  if (!expired) return "already_resolved";
  await logEvent(pool, rideId, "offer_expired", null, { offerId });
  await enqueueMatch(rideId);
  return "expired";
}

export async function markNoDrivers(rideId: string): Promise<boolean> {
  return withTransaction(async (tx) => {
    const r = await queryOne(
      `UPDATE rides SET status='no_drivers', cancelled_at=now(), cancelled_by='system', cancel_reason='No drivers available', updated_at=now()
        WHERE id=$1 AND status='searching' RETURNING id`, [rideId], tx);
    if (!r) return false;
    await query("UPDATE ride_offers SET status='cancelled', responded_at=now() WHERE ride_id=$1 AND status='pending'", [rideId], tx);
    await logEvent(tx, rideId, "no_drivers", null);
    return true;
  });
}
