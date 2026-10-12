import { describe, expect, test } from "@jest/globals";
import { haversineKm } from "../../src/lib/geo.ts";
import { calcFare, estimateTrip, splitFare } from "../../src/lib/pricing.ts";

describe("haversineKm", () => {
  test("zero distance for identical points", () => {
    expect(haversineKm(14.55, 121.02, 14.55, 121.02)).toBe(0);
  });
  test("one degree of latitude is ~111 km", () => {
    expect(haversineKm(0, 0, 1, 0)).toBeCloseTo(111.19, 1);
  });
  test("is symmetric", () => {
    expect(haversineKm(14.55, 121.02, 14.6, 121.05)).toBeCloseTo(haversineKm(14.6, 121.05, 14.55, 121.02), 10);
  });
});

describe("calcFare", () => {
  test("minimum fare applies to very short trips", () => {
    expect(calcFare(0.2, 1, "economy")).toBe(5);
  });
  test("follows base + per-km + per-minute (defaults 2.5 / 1.2 / 0.35)", () => {
    expect(calcFare(10, 20, "economy")).toBe(21.5); // 2.5 + 12 + 7
  });
  test.each<["economy" | "comfort" | "xl", number]>([
    ["economy", 1],
    ["comfort", 1.3],
    ["xl", 1.6],
  ])("%s multiplier", (type, mult) => {
    expect(calcFare(10, 20, type)).toBeCloseTo(21.5 * mult, 2);
  });
  test("rounds to 2 decimals", () => {
    const f = calcFare(3.333, 7.77, "comfort");
    expect(Math.round(f * 100)).toBe(f * 100);
  });
});

describe("estimateTrip", () => {
  test("applies the road factor and returns consistent distance/duration/fare", () => {
    const a = { lat: 14.5547, lng: 121.0244 };
    const b = { lat: 14.5995, lng: 121.0369 };
    const e = estimateTrip(a, b, "economy");
    expect(e.distanceKm).toBeGreaterThan(haversineKm(a.lat, a.lng, b.lat, b.lng));
    expect(e.durationMin).toBeGreaterThan(0);
    expect(e.fare).toBe(calcFare(e.distanceKm, e.durationMin, "economy"));
    expect(e.currency).toBe("PHP");
  });
});

describe("splitFare", () => {
  test("20% platform fee by default and the parts add up", () => {
    expect(splitFare(20)).toEqual({ platformFee: 4, driverEarnings: 16 });
    const { platformFee, driverEarnings } = splitFare(17.77);
    expect(Math.round((platformFee + driverEarnings) * 100)).toBe(1777);
  });
});
