import type { PoolClient } from "pg";
import { env } from "../../config/env.ts";
import { isUniqueViolation, pool, query, queryOne, withTransaction } from "../../db/pool.ts";
import { conflict, forbidden, notFound, badRequest } from "../../lib/errors.ts";
import { haversineKm } from "../../lib/geo.ts";
import { calcFare, estimateTrip, splitFare, type VehicleType } from "../../lib/pricing.ts";
import { cancelOfferTimeout, enqueueMatch } from "../../queues/index.ts";
import { getDriver, readLocation, removeFromPool, returnToPool, nearbyDrivers } from "../drivers/drivers.service.ts";

export interface RideRow {
  id: string; rider_id: string; driver_id: string | null;
  status: "searching" | "accepted" | "arrived" | "in_progress" | "completed" | "cancelled" | "no_drivers";
  vehicle_type: VehicleType;
  pickup_lat: number; pickup_lng: number; pickup_address: string | null;
  dropoff_lat: number; dropoff_lng: number; dropoff_address: string | null;
  estimated_distance_km: number; estimated_duration_min: number; estimated_fare: number;
  final_distance_km: number | null; final_fare: number | null; platform_fee: number | null; driver_earnings: number | null;
  currency: string; payment_method: "cash" | "card" | "wallet";
  cancelled_by: string | null; cancel_reason: string | null;
  rider_rating: number | null; driver_rating: number | null;
  requested_at: Date; accepted_at: Date | null; arrived_at: Date | null; started_at: Date | null;
  completed_at: Date | null; cancelled_at: Date | null;
}

export const toRide = (r: RideRow) => ({
  id: r.id,
  status: r.status,
  riderId: r.rider_id,
  driverId: r.driver_id,
  vehicleType: r.vehicle_type,
  pickup: { lat: r.pickup_lat, lng: r.pickup_lng, address: r.pickup_address },
  dropoff: { lat: r.dropoff_lat, lng: r.dropoff_lng, address: r.dropoff_address },
  estimate: { distanceKm: r.estimated_distance_km, durationMin: r.estimated_duration_min, fare: r.estimated_fare },
  final: r.final_fare == null ? null : { distanceKm: r.final_distance_km, fare: r.final_fare, platformFee: r.platform_fee, driverEarnings: r.driver_earnings },
  currency: r.currency.trim(),
  paymentMethod: r.payment_method,
  cancellation: r.cancelled_by ? { by: r.cancelled_by, reason: r.cancel_reason } : null,
  ratings: { riderRating: r.rider_rating, driverRating: r.driver_rating },
  timestamps: {
    requestedAt: r.requested_at, acceptedAt: r.accepted_at, arrivedAt: r.arrived_at,
    startedAt: r.started_at, completedAt: r.completed_at, cancelledAt: r.cancelled_at,
  },
});

export async function logEvent(db: PoolClient | typeof pool, rideId: string, type: string, actorId: string | null, data: object = {}) {
  await query("INSERT INTO ride_events (ride_id, type, actor_id, data) VALUES ($1,$2,$3,$4)", [rideId, type, actorId, JSON.stringify(data)], db);
}

const ACTIVE = ["searching", "accepted", "arrived", "in_progress"];

/* ------------------------------------------------------------------ rider */

export async function estimate(input: { pickup: { lat: number; lng: number }; dropoff: { lat: number; lng: number } }) {
  const types: VehicleType[] = ["economy", "comfort", "xl"];
  const options = await Promise.all(
    types.map(async (t) => {
      const e = estimateTrip(input.pickup, input.dropoff, t);
      const near = await nearbyDrivers(t, input.pickup.lat, input.pickup.lng, env.MATCH_SEARCH_RADIUS_KM, 50);
      const nearest = near[0];
      return {
        vehicleType: t, fare: e.fare, currency: e.currency, distanceKm: e.distanceKm, durationMin: e.durationMin,
        nearbyDrivers: near.length,
        pickupEtaMin: nearest ? Math.max(1, Math.round((nearest.distanceKm * 1.3) / 30 * 60)) : null,
      };
    }),
  );
  return { options };
}

export async function requestRide(
  riderId: string,
  input: {
    pickup: { lat: number; lng: number; address?: string | undefined };
    dropoff: { lat: number; lng: number; address?: string | undefined };
    vehicleType: VehicleType;
    paymentMethod: "cash" | "card" | "wallet";
  },
) {
  const e = estimateTrip(input.pickup, input.dropoff, input.vehicleType);
  if (e.distanceKm < 0.1) throw badRequest("Pickup and dropoff are too close");
  let ride: RideRow;
  try {
    ride = await withTransaction(async (tx) => {
      const r = (
        await query<RideRow>(
          `INSERT INTO rides (rider_id, vehicle_type, pickup_lat, pickup_lng, pickup_address, dropoff_lat, dropoff_lng, dropoff_address,
                              estimated_distance_km, estimated_duration_min, estimated_fare, currency, payment_method)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
          [riderId, input.vehicleType, input.pickup.lat, input.pickup.lng, input.pickup.address ?? null,
           input.dropoff.lat, input.dropoff.lng, input.dropoff.address ?? null,
           e.distanceKm, e.durationMin, e.fare, e.currency, input.paymentMethod],
          tx,
        )
      )[0]!;
      await logEvent(tx, r.id, "requested", riderId, { fare: e.fare });
      return r;
    });
  } catch (err) {
    if (isUniqueViolation(err, "rides_one_active_rider_uq")) throw conflict("You already have an active ride", "ACTIVE_RIDE_EXISTS");
    throw err;
  }
  await enqueueMatch(ride.id); // matching happens asynchronously in the worker
  return toRide(ride);
}

/** Visible to the rider or assigned driver (or admin); drivers with a pending offer may also view it. */
export async function getRideFor(rideId: string, userId: string, role: string) {
  const ride = await queryOne<RideRow>("SELECT * FROM rides WHERE id = $1", [rideId]);
  if (!ride) throw notFound("Ride not found");
  const isParty = ride.rider_id === userId || ride.driver_id === userId;
  let hasOffer = false;
  if (!isParty && role !== "admin") {
    hasOffer = !!(await queryOne("SELECT 1 FROM ride_offers WHERE ride_id=$1 AND driver_id=$2 AND status='pending' AND expires_at > now()", [rideId, userId]));
    if (!hasOffer) throw notFound("Ride not found"); // do not leak existence
  }
  const out: Record<string, unknown> = toRide(ride);
  if (ride.driver_id && ["accepted", "arrived", "in_progress"].includes(ride.status)) {
    const [d, u, loc] = await Promise.all([
      getDriver(ride.driver_id),
      queryOne<{ full_name: string; phone: string | null; rating_avg: number }>("SELECT full_name, phone, rating_avg FROM users WHERE id=$1", [ride.driver_id]),
      readLocation(ride.driver_id),
    ]);
    out.driver = d && u && {
      id: ride.driver_id, name: u.full_name, phone: u.phone, rating: u.rating_avg,
      vehicle: { make: d.vehicle_make, model: d.vehicle_model, color: d.vehicle_color, plate: d.plate_number },
      location: loc ? { lat: loc.lat, lng: loc.lng, updatedAt: new Date(loc.at) } : null,
    };
  }
  if (isParty && ride.rider_id !== userId) {
    const u = await queryOne<{ full_name: string; rating_avg: number }>("SELECT full_name, rating_avg FROM users WHERE id=$1", [ride.rider_id]);
    out.rider = u && { id: ride.rider_id, name: u.full_name, rating: u.rating_avg };
  }
  return out;
}

export async function listRides(userId: string, role: string, opts: { status?: string | undefined; limit: number; offset: number }) {
  const col = role === "driver" ? "driver_id" : "rider_id";
  const rows = await query<RideRow>(
    `SELECT * FROM rides WHERE ${col} = $1 AND ($2::ride_status IS NULL OR status = $2::ride_status)
      ORDER BY requested_at DESC LIMIT $3 OFFSET $4`,
    [userId, opts.status ?? null, opts.limit, opts.offset],
  );
  return rows.map(toRide);
}

export async function activeRide(userId: string, role: string) {
  const col = role === "driver" ? "driver_id" : "rider_id";
  const row = await queryOne<RideRow>(`SELECT id FROM rides WHERE ${col} = $1 AND status = ANY($2::ride_status[]) LIMIT 1`, [userId, ACTIVE] as any);
  return row ? getRideFor((row as any).id, userId, role) : null;
}

/* ----------------------------------------------------------------- cancel */

export async function cancelRide(rideId: string, userId: string, role: string, reason?: string) {
  type Result = { ride: RideRow; freeDriver?: string; rematch?: boolean };
  const result: Result = await withTransaction(async (tx) => {
    const ride = await queryOne<RideRow>("SELECT * FROM rides WHERE id=$1 FOR UPDATE", [rideId], tx);
    if (!ride) throw notFound("Ride not found");

    if (role === "rider" || role === "admin") {
      if (ride.rider_id !== userId && role !== "admin") throw notFound("Ride not found");
      if (!["searching", "accepted", "arrived"].includes(ride.status)) throw conflict(`Cannot cancel a ride that is ${ride.status}`, "INVALID_STATE");
      const updated = (await query<RideRow>(
        `UPDATE rides SET status='cancelled', cancelled_by=$2, cancel_reason=$3, cancelled_at=now(), updated_at=now() WHERE id=$1 RETURNING *`,
        [rideId, role === "admin" ? "system" : "rider", reason ?? null], tx))[0]!;
      await query("UPDATE ride_offers SET status='cancelled', responded_at=now() WHERE ride_id=$1 AND status='pending'", [rideId], tx);
      await logEvent(tx, rideId, "cancelled", userId, { by: role, reason });
      const res: Result = { ride: updated };
      if (ride.driver_id) res.freeDriver = ride.driver_id;
      return res;
    }

    // driver cancels: ride goes back into the pool without this driver
    if (ride.driver_id !== userId) throw notFound("Ride not found");
    if (!["accepted", "arrived"].includes(ride.status)) throw conflict(`Cannot cancel a ride that is ${ride.status}`, "INVALID_STATE");
    const updated = (await query<RideRow>(
      `UPDATE rides SET status='searching', driver_id=NULL, accepted_at=NULL, arrived_at=NULL, updated_at=now() WHERE id=$1 RETURNING *`,
      [rideId], tx))[0]!;
    await logEvent(tx, rideId, "driver_cancelled", userId, { reason });
    return { ride: updated, freeDriver: userId, rematch: true };
  });

  if (result.freeDriver) await releaseDriver(result.freeDriver);
  if (result.rematch) await enqueueMatch(rideId);
  return toRide(result.ride);
}

/** Mark a driver available again after a ride ends / is cancelled. */
export async function releaseDriver(driverId: string) {
  const d = await query<{ vehicle_type: VehicleType }>(
    "UPDATE drivers SET status='online', updated_at=now() WHERE user_id=$1 AND status='busy' RETURNING vehicle_type", [driverId]);
  if (d[0]) await returnToPool(driverId, d[0].vehicle_type);
}

/* ----------------------------------------------------------------- driver */

export async function listOffers(driverId: string) {
  const rows = await query<RideRow & { offer_id: string; expires_at: Date; offer_distance_km: number }>(
    `SELECT r.*, o.id AS offer_id, o.expires_at, o.distance_km AS offer_distance_km
       FROM ride_offers o JOIN rides r ON r.id = o.ride_id
      WHERE o.driver_id=$1 AND o.status='pending' AND o.expires_at > now() AND r.status='searching'
      ORDER BY o.created_at`, [driverId]);
  return rows.map((r) => ({
    offerId: r.offer_id, expiresAt: r.expires_at, distanceToPickupKm: r.offer_distance_km,
    ride: toRide(r),
  }));
}

export async function acceptOffer(driverId: string, offerId: string) {
  const ride = await withTransaction(async (tx) => {
    const offer = await queryOne<{ id: string; ride_id: string; status: string; expires_at: Date }>(
      "SELECT id, ride_id, status, expires_at FROM ride_offers WHERE id=$1 AND driver_id=$2 FOR UPDATE", [offerId, driverId], tx);
    if (!offer) throw notFound("Offer not found");
    if (offer.status !== "pending" || offer.expires_at.getTime() <= Date.now()) throw conflict("Offer is no longer available", "OFFER_EXPIRED");

    const driver = await queryOne<{ status: string }>("SELECT status FROM drivers WHERE user_id=$1 FOR UPDATE", [driverId], tx);
    if (driver?.status !== "online") throw conflict("You must be online and not on another ride", "DRIVER_UNAVAILABLE");

    // Atomic claim: only one driver can move the ride out of 'searching'.
    const claimed = await queryOne<RideRow>(
      `UPDATE rides SET status='accepted', driver_id=$2, accepted_at=now(), updated_at=now()
        WHERE id=$1 AND status='searching' AND driver_id IS NULL RETURNING *`, [offer.ride_id, driverId], tx);
    if (!claimed) {
      await query("UPDATE ride_offers SET status='cancelled', responded_at=now() WHERE id=$1", [offerId], tx);
      // commit the status change by returning a sentinel rather than throwing (throw would roll it back)
      return null;
    }
    await query("UPDATE ride_offers SET status='accepted', responded_at=now() WHERE id=$1", [offerId], tx);
    await query("UPDATE drivers SET status='busy', updated_at=now() WHERE user_id=$1", [driverId], tx);
    await logEvent(tx, claimed.id, "accepted", driverId);
    return claimed;
  });
  if (!ride) throw conflict("Ride is no longer available", "RIDE_UNAVAILABLE");
  const d = (await getDriver(driverId))!;
  await removeFromPool(driverId, d.vehicle_type);
  await cancelOfferTimeout(offerId);
  return toRide(ride);
}

export async function declineOffer(driverId: string, offerId: string) {
  const row = await queryOne<{ ride_id: string }>(
    `UPDATE ride_offers SET status='declined', responded_at=now()
      WHERE id=$1 AND driver_id=$2 AND status='pending' RETURNING ride_id`, [offerId, driverId]);
  if (!row) throw conflict("Offer is no longer available", "OFFER_EXPIRED");
  await cancelOfferTimeout(offerId);
  await enqueueMatch(row.ride_id);
}

async function driverTransition(
  rideId: string, driverId: string, from: RideRow["status"], to: RideRow["status"], tsCol: string, event: string,
  guard?: (ride: RideRow) => Promise<void>,
) {
  return withTransaction(async (tx) => {
    const ride = await queryOne<RideRow>("SELECT * FROM rides WHERE id=$1 AND driver_id=$2 FOR UPDATE", [rideId, driverId], tx);
    if (!ride) throw notFound("Ride not found");
    if (ride.status !== from) throw conflict(`Ride is ${ride.status}, expected ${from}`, "INVALID_STATE");
    if (guard) await guard(ride);
    const updated = (await query<RideRow>(`UPDATE rides SET status=$2, ${tsCol}=now(), updated_at=now() WHERE id=$1 RETURNING *`, [rideId, to], tx))[0]!;
    await logEvent(tx, rideId, event, driverId);
    return updated;
  });
}

export async function arrive(rideId: string, driverId: string) {
  const r = await driverTransition(rideId, driverId, "accepted", "arrived", "arrived_at", "arrived", async (ride) => {
    const loc = await readLocation(driverId);
    if (!loc) throw conflict("No recent driver location", "LOCATION_REQUIRED");
    const km = haversineKm(loc.lat, loc.lng, ride.pickup_lat, ride.pickup_lng);
    if (km > env.ARRIVAL_RADIUS_KM) throw conflict(`You are ${km.toFixed(2)} km from pickup (max ${env.ARRIVAL_RADIUS_KM} km)`, "TOO_FAR_FROM_PICKUP");
  });
  return toRide(r);
}

export async function start(rideId: string, driverId: string) {
  return toRide(await driverTransition(rideId, driverId, "arrived", "in_progress", "started_at", "started"));
}

export async function complete(rideId: string, driverId: string, actual?: { distanceKm?: number | undefined; durationMin?: number | undefined }) {
  const ride = await withTransaction(async (tx) => {
    const r = await queryOne<RideRow>("SELECT * FROM rides WHERE id=$1 AND driver_id=$2 FOR UPDATE", [rideId, driverId], tx);
    if (!r) throw notFound("Ride not found");
    if (r.status !== "in_progress") throw conflict(`Ride is ${r.status}, expected in_progress`, "INVALID_STATE");

    const minutes = actual?.durationMin ?? Math.max(1, (Date.now() - (r.started_at?.getTime() ?? Date.now())) / 60000);
    const distance = actual?.distanceKm ?? r.estimated_distance_km;
    // Never charge less than the quote for the same route and cap runaway fares at 3x the quote.
    const fare = Math.min(r.estimated_fare * 3, Math.max(r.estimated_fare, calcFare(distance, minutes, r.vehicle_type)));
    const { platformFee, driverEarnings } = splitFare(fare);

    const updated = (await query<RideRow>(
      `UPDATE rides SET status='completed', completed_at=now(), final_distance_km=$2, final_fare=$3, platform_fee=$4, driver_earnings=$5, updated_at=now()
        WHERE id=$1 RETURNING *`, [rideId, distance, fare, platformFee, driverEarnings], tx))[0]!;
    // Payment gateway is simulated: all methods settle immediately.
    await query(
      `INSERT INTO payments (ride_id, rider_id, driver_id, amount, currency, method, status) VALUES ($1,$2,$3,$4,$5,$6,'paid')`,
      [rideId, r.rider_id, driverId, fare, r.currency, r.payment_method], tx);
    await query("UPDATE drivers SET total_earnings = total_earnings + $2, updated_at=now() WHERE user_id=$1", [driverId, driverEarnings], tx);
    await logEvent(tx, rideId, "completed", driverId, { fare, distance });
    return updated;
  });
  await releaseDriver(driverId);
  return toRide(ride);
}

/* ---------------------------------------------------------------- ratings */

export async function rate(rideId: string, userId: string, role: string, rating: number, comment?: string) {
  await withTransaction(async (tx) => {
    const r = await queryOne<RideRow>("SELECT * FROM rides WHERE id=$1 FOR UPDATE", [rideId], tx);
    if (!r || (r.rider_id !== userId && r.driver_id !== userId)) throw notFound("Ride not found");
    if (r.status !== "completed") throw conflict("Only completed rides can be rated", "INVALID_STATE");
    const riderRates = r.rider_id === userId;
    if ((riderRates ? r.driver_rating : r.rider_rating) != null) throw conflict("You already rated this ride", "ALREADY_RATED");
    const targetId = riderRates ? r.driver_id! : r.rider_id;
    await query(
      riderRates ? "UPDATE rides SET driver_rating=$2, driver_comment=$3 WHERE id=$1" : "UPDATE rides SET rider_rating=$2, rider_comment=$3 WHERE id=$1",
      [rideId, rating, comment ?? null], tx);
    await query(
      `UPDATE users SET rating_avg = round(((rating_avg * rating_count) + $2) / (rating_count + 1), 2), rating_count = rating_count + 1 WHERE id=$1`,
      [targetId, rating], tx);
    await logEvent(tx, rideId, "rated", userId, { rating });
  });
  void role;
}

export async function rideEvents(rideId: string, userId: string, role: string) {
  await getRideFor(rideId, userId, role); // authorisation
  return query("SELECT id, type, actor_id AS \"actorId\", data, created_at AS \"createdAt\" FROM ride_events WHERE ride_id=$1 ORDER BY id", [rideId]);
}
