import { env } from "../config/env.ts";
import { haversineKm } from "./geo.ts";

export type VehicleType = "economy" | "comfort" | "xl";

const MULTIPLIER: Record<VehicleType, number> = { economy: 1, comfort: 1.3, xl: 1.6 };
const ROAD_FACTOR = 1.3; // straight-line -> approximate road distance
const AVG_SPEED_KMH = 30;

const round2 = (n: number) => Math.round(n * 100) / 100;

export function calcFare(distanceKm: number, durationMin: number, vehicleType: VehicleType): number {
  const raw = env.BASE_FARE + distanceKm * env.PER_KM + durationMin * env.PER_MINUTE;
  return round2(Math.max(env.MIN_FARE, raw) * MULTIPLIER[vehicleType]);
}

export function estimateTrip(
  pickup: { lat: number; lng: number },
  dropoff: { lat: number; lng: number },
  vehicleType: VehicleType,
) {
  const distanceKm = round2(haversineKm(pickup.lat, pickup.lng, dropoff.lat, dropoff.lng) * ROAD_FACTOR);
  const durationMin = Math.round((distanceKm / AVG_SPEED_KMH) * 60 * 10) / 10;
  return { distanceKm, durationMin, fare: calcFare(distanceKm, durationMin, vehicleType), currency: env.CURRENCY };
}

/** Split a fare into platform fee and driver earnings. */
export function splitFare(fare: number) {
  const platformFee = round2((fare * env.PLATFORM_FEE_PERCENT) / 100);
  return { platformFee, driverEarnings: round2(fare - platformFee) };
}
