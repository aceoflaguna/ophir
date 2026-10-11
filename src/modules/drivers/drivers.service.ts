import { pool, query, queryOne, type Queryable } from "../../db/pool.ts";
import { valkey } from "../../db/valkey.ts";
import { env } from "../../config/env.ts";
import { conflict, forbidden, notFound } from "../../lib/errors.ts";
import type { VehicleType } from "../../lib/pricing.ts";

export const GEO_VEHICLE_TYPES: VehicleType[] = ["economy", "comfort", "xl"];
export const geoKey = (t: VehicleType | string) => `geo:drivers:${t}`;
export const SEEN_KEY = "drivers:last-seen"; // zset: member=driverId, score=epoch seconds
export const locKey = (id: string) => `driver:loc:${id}`;

export interface DriverRow {
  user_id: string;
  status: "offline" | "online" | "busy";
  license_number: string;
  vehicle_make: string;
  vehicle_model: string;
  vehicle_color: string;
  plate_number: string;
  vehicle_type: VehicleType;
  last_lat: number | null;
  last_lng: number | null;
  total_earnings: number;
}

export const toPublicDriver = (d: DriverRow) => ({
  status: d.status,
  licenseNumber: d.license_number,
  vehicle: { make: d.vehicle_make, model: d.vehicle_model, color: d.vehicle_color, plate: d.plate_number, type: d.vehicle_type },
  totalEarnings: d.total_earnings,
});

export async function getDriver(userId: string, db: Queryable = pool) {
  return queryOne<DriverRow>("SELECT * FROM drivers WHERE user_id = $1", [userId], db);
}

export async function requireDriver(userId: string) {
  const d = await getDriver(userId);
  if (!d) throw forbidden("Create your driver profile first (PUT /drivers/me/profile)");
  return d;
}

export async function upsertProfile(
  userId: string,
  p: { licenseNumber: string; vehicleMake: string; vehicleModel: string; vehicleColor: string; plateNumber: string; vehicleType: VehicleType },
) {
  const existing = await getDriver(userId);
  if (existing?.status === "busy") throw conflict("Cannot change profile during an active ride");
  const rows = await query<DriverRow>(
    `INSERT INTO drivers (user_id, license_number, vehicle_make, vehicle_model, vehicle_color, plate_number, vehicle_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (user_id) DO UPDATE SET license_number = EXCLUDED.license_number, vehicle_make = EXCLUDED.vehicle_make,
       vehicle_model = EXCLUDED.vehicle_model, vehicle_color = EXCLUDED.vehicle_color, plate_number = EXCLUDED.plate_number,
       vehicle_type = EXCLUDED.vehicle_type, updated_at = now()
     RETURNING *`,
    [userId, p.licenseNumber, p.vehicleMake, p.vehicleModel, p.vehicleColor, p.plateNumber, p.vehicleType],
  );
  // A type change while online must move the driver between geo indexes.
  if (existing && existing.vehicle_type !== p.vehicleType && existing.status === "online") {
    await valkey.zrem(geoKey(existing.vehicle_type), userId);
    const loc = await readLocation(userId);
    if (loc) await valkey.geoadd(geoKey(p.vehicleType), loc.lng, loc.lat, userId);
  }
  return rows[0]!;
}

export async function readLocation(userId: string): Promise<{ lat: number; lng: number; at: number } | null> {
  const raw = await valkey.get(locKey(userId));
  return raw ? JSON.parse(raw) : null;
}

async function writeLocation(userId: string, lat: number, lng: number) {
  const at = Date.now();
  await valkey.set(locKey(userId), JSON.stringify({ lat, lng, at }), "EX", env.DRIVER_STALE_SECONDS * 3);
  await valkey.zadd(SEEN_KEY, Math.floor(at / 1000), userId);
}

export async function goOnline(userId: string, lat: number, lng: number) {
  const d = await requireDriver(userId);
  if (d.status === "busy") throw conflict("You are on an active ride");
  await query("UPDATE drivers SET status='online', last_lat=$2, last_lng=$3, last_seen_at=now(), updated_at=now() WHERE user_id=$1", [userId, lat, lng]);
  await writeLocation(userId, lat, lng);
  await valkey.geoadd(geoKey(d.vehicle_type), lng, lat, userId);
}

export async function goOffline(userId: string) {
  const d = await requireDriver(userId);
  if (d.status === "busy") throw conflict("Finish or cancel your active ride before going offline");
  await removeFromPool(userId, d.vehicle_type);
  await query("UPDATE drivers SET status='offline', updated_at=now() WHERE user_id=$1", [userId]);
}

export async function updateLocation(userId: string, lat: number, lng: number) {
  const d = await requireDriver(userId);
  if (d.status === "offline") throw conflict("Go online before sending location updates");
  await writeLocation(userId, lat, lng);
  if (d.status === "online") await valkey.geoadd(geoKey(d.vehicle_type), lng, lat, userId);
  // Persist to Postgres at most every 15s per driver to keep write load low.
  if (await valkey.set(`driver:dbsync:${userId}`, "1", "EX", 15, "NX")) {
    await query("UPDATE drivers SET last_lat=$2, last_lng=$3, last_seen_at=now() WHERE user_id=$1", [userId, lat, lng]);
  }
}

/** Make a driver (un)available for matching without changing their DB status. */
export async function removeFromPool(userId: string, type: VehicleType) {
  await valkey.zrem(geoKey(type), userId);
  await valkey.zrem(SEEN_KEY, userId);
}

export async function returnToPool(userId: string, type: VehicleType) {
  const loc = await readLocation(userId);
  if (loc) await valkey.geoadd(geoKey(type), loc.lng, loc.lat, userId);
}

/** Find nearby candidate driver ids, nearest first, with distance in km. */
export async function nearbyDrivers(type: VehicleType, lat: number, lng: number, radiusKm: number, count: number) {
  const res = (await valkey.geosearch(
    geoKey(type), "FROMLONLAT", lng, lat, "BYRADIUS", radiusKm, "km", "ASC", "COUNT", count, "WITHDIST",
  )) as [string, string][];
  return res.map(([id, dist]) => ({ id, distanceKm: parseFloat(dist) }));
}

export async function earnings(userId: string, from?: Date, to?: Date) {
  const rows = await query<{ trips: number; gross: number; fees: number; net: number }>(
    `SELECT count(*)::int AS trips, COALESCE(sum(final_fare),0) AS gross,
            COALESCE(sum(platform_fee),0) AS fees, COALESCE(sum(driver_earnings),0) AS net
       FROM rides WHERE driver_id=$1 AND status='completed'
        AND completed_at >= COALESCE($2, '-infinity'::timestamptz) AND completed_at < COALESCE($3, 'infinity'::timestamptz)`,
    [userId, from ?? null, to ?? null],
  );
  const total = (await getDriver(userId))?.total_earnings ?? 0;
  if (!rows[0]) throw notFound();
  return { ...rows[0], currency: env.CURRENCY, lifetimeEarnings: total };
}
