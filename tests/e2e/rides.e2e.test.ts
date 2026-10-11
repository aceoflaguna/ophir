import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { api, DROPOFF, makeDriver, offline, pendingOffer, PICKUP, query, signup, startE2E, until } from "../support/e2e.ts";

let stop: () => Promise<void>;
beforeAll(async () => { stop = await startE2E(); });
afterAll(async () => { await stop(); });

const book = (token: string, extra: object = {}) =>
  api("post", "/rides", { token, body: { pickup: PICKUP, dropoff: DROPOFF, ...extra } });

describe("estimate", () => {
  test("quotes every vehicle type and counts nearby drivers", async () => {
    const d = await makeDriver(14.555, 121.025);
    const rider = await signup("rider");
    const r = await api("post", "/rides/estimate", { token: rider.token, body: { pickup: PICKUP, dropoff: DROPOFF } });
    expect(r.status).toBe(200);
    const byType = Object.fromEntries(r.body.options.map((o: any) => [o.vehicleType, o]));
    expect(byType.economy.nearbyDrivers).toBe(1);
    expect(byType.economy.pickupEtaMin).toBeGreaterThanOrEqual(1);
    expect(byType.comfort.nearbyDrivers).toBe(0);
    expect(byType.xl.fare).toBeGreaterThan(byType.comfort.fare);
    expect(byType.comfort.fare).toBeGreaterThan(byType.economy.fare);
    await offline(d);
  });

  test("validates coordinates and requires the rider role", async () => {
    const rider = await signup("rider");
    const driver = await signup("driver");
    expect((await api("post", "/rides/estimate", { token: rider.token, body: { pickup: { lat: 200, lng: 0 }, dropoff: DROPOFF } })).status).toBe(400);
    expect((await api("post", "/rides/estimate", { token: driver.token, body: { pickup: PICKUP, dropoff: DROPOFF } })).status).toBe(403);
  });
});

describe("driver availability", () => {
  test("requires a profile, enforces unique plates, toggles online/offline", async () => {
    const d = await signup("driver");
    expect((await api("post", "/drivers/me/online", { token: d.token, body: { lat: 1, lng: 1 } })).status).toBe(403);
    const profile = { licenseNumber: "LIC-1234", vehicleMake: "Honda", vehicleModel: "City", vehicleColor: "red", plateNumber: `UNQ${Date.now() % 100000}`, vehicleType: "comfort" };
    expect((await api("put", "/drivers/me/profile", { token: d.token, body: profile })).status).toBe(200);
    const other = await signup("driver");
    const dup = await api("put", "/drivers/me/profile", { token: other.token, body: { ...profile, plateNumber: profile.plateNumber.toLowerCase() } });
    expect(dup.body.error.code).toBe("PLATE_TAKEN");

    expect((await api("put", "/drivers/me/location", { token: d.token, body: { lat: 1, lng: 1 } })).status).toBe(409); // offline
    expect((await api("post", "/drivers/me/online", { token: d.token, body: { lat: 14.5, lng: 121 } })).body.status).toBe("online");
    expect((await api("put", "/drivers/me/location", { token: d.token, body: { lat: 14.51, lng: 121 } })).status).toBe(204);
    expect((await offline(d)).body.status).toBe("offline");
  });
});

describe("full ride lifecycle", () => {
  test("request -> decline -> next driver accepts -> arrive -> start -> complete -> rate", async () => {
    const near = await makeDriver(14.5548, 121.0245);
    const far = await makeDriver(14.57, 121.03);
    const rider = await signup("rider");

    const req = await book(rider.token, { paymentMethod: "card" });
    expect(req.status).toBe(201);
    expect(req.body.ride).toMatchObject({ status: "searching", paymentMethod: "card" });
    const rideId = req.body.ride.id;
    expect((await book(rider.token)).body.error.code).toBe("ACTIVE_RIDE_EXISTS");

    // nearest driver is offered first; the other sees nothing yet
    const offer1 = await until(pendingOffer(near));
    expect(offer1.ride.id).toBe(rideId);
    expect(offer1.distanceToPickupKm).toBeLessThan(0.1);
    expect((await api("get", "/drivers/me/offers", { token: far.token })).body.offers).toHaveLength(0);

    expect((await api("post", `/drivers/me/offers/${offer1.offerId}/decline`, { token: near.token })).status).toBe(204);
    const offer2 = await until(pendingOffer(far));
    expect(offer2.ride.id).toBe(rideId);

    const accepted = await api("post", `/drivers/me/offers/${offer2.offerId}/accept`, { token: far.token });
    expect(accepted.body.ride.status).toBe("accepted");
    expect((await api("post", `/drivers/me/offers/${offer2.offerId}/accept`, { token: far.token })).status).toBe(409);

    const view = await api("get", `/rides/${rideId}`, { token: rider.token });
    expect(view.body.ride.driver.vehicle).toMatchObject({ make: "Toyota", model: "Vios" });
    expect((await api("get", "/rides/active", { token: rider.token })).body.ride.id).toBe(rideId);

    // busy driver rules + arrival radius
    expect((await offline(far)).status).toBe(409);
    expect((await api("post", `/rides/${rideId}/arrive`, { token: far.token })).body.error.code).toBe("TOO_FAR_FROM_PICKUP");
    expect((await api("post", `/rides/${rideId}/start`, { token: far.token })).body.error.code).toBe("INVALID_STATE");
    await api("put", "/drivers/me/location", { token: far.token, body: { lat: 14.5548, lng: 121.0245 } });
    expect((await api("post", `/rides/${rideId}/arrive`, { token: far.token })).body.ride.status).toBe("arrived");
    expect((await api("post", `/rides/${rideId}/start`, { token: far.token })).body.ride.status).toBe("in_progress");

    // outsiders can't see or act on the ride
    const stranger = await signup("rider");
    expect((await api("get", `/rides/${rideId}`, { token: stranger.token })).status).toBe(404);
    expect((await api("post", `/rides/${rideId}/complete`, { token: near.token })).status).toBe(404);
    expect((await api("post", `/rides/${rideId}/cancel`, { token: rider.token })).body.error.code).toBe("INVALID_STATE"); // already started

    const done = await api("post", `/rides/${rideId}/complete`, { token: far.token, body: {} });
    expect(done.body.ride.status).toBe("completed");
    const { fare, platformFee, driverEarnings } = done.body.ride.final;
    expect(fare).toBeGreaterThanOrEqual(req.body.ride.estimate.fare);
    expect(Math.round((platformFee + driverEarnings) * 100)).toBe(Math.round(fare * 100));
    expect(platformFee).toBeCloseTo(fare * 0.2, 1);

    const driverNow = await api("get", "/drivers/me", { token: far.token });
    expect(driverNow.body.driver).toMatchObject({ status: "online", totalEarnings: driverEarnings });

    // ratings: each side once; averages update
    expect((await api("post", `/rides/${rideId}/rate`, { token: rider.token, body: { rating: 4, comment: "ok" } })).status).toBe(204);
    expect((await api("post", `/rides/${rideId}/rate`, { token: rider.token, body: { rating: 5 } })).body.error.code).toBe("ALREADY_RATED");
    expect((await api("post", `/rides/${rideId}/rate`, { token: far.token, body: { rating: 2 } })).status).toBe(204);
    expect((await api("get", "/users/me", { token: far.token })).body.user.rating).toEqual({ average: 4, count: 1 });
    expect((await api("get", "/users/me", { token: rider.token })).body.user.rating).toEqual({ average: 2, count: 1 });
    expect((await api("post", `/rides/${rideId}/rate`, { token: stranger.token, body: { rating: 1 } })).status).toBe(404);
    expect((await api("post", `/rides/${rideId}/rate`, { token: rider.token, body: { rating: 6 } })).status).toBe(400);

    // history, payment, earnings, audit trail
    expect((await api("get", "/rides?status=completed", { token: rider.token })).body.rides.map((r: any) => r.id)).toEqual([rideId]);
    expect((await api("get", "/rides", { token: far.token })).body.rides).toHaveLength(1);
    expect((await api("get", "/payments", { token: rider.token })).body.payments[0]).toMatchObject({ rideId, amount: fare, method: "card", status: "paid" });
    expect((await api("get", "/drivers/me/earnings", { token: far.token })).body).toMatchObject({ trips: 1, net: driverEarnings });
    const types = (await api("get", `/rides/${rideId}/events`, { token: rider.token })).body.events.map((e: any) => e.type);
    expect(types).toEqual(expect.arrayContaining(["requested", "offered", "accepted", "arrived", "started", "completed", "rated"]));
    expect(types[0]).toBe("requested");

    // rider can book again
    const again = await book(rider.token);
    expect(again.status).toBe(201);
    await api("post", `/rides/${again.body.ride.id}/cancel`, { token: rider.token });
    await Promise.all([offline(near), offline(far)]);
  });

  test("final fare is capped at 3x the quote and never below it", async () => {
    const d = await makeDriver(14.5548, 121.0245);
    const rider = await signup("rider");
    const req = await book(rider.token);
    const offer = await until(pendingOffer(d));
    await api("post", `/drivers/me/offers/${offer.offerId}/accept`, { token: d.token });
    await api("post", `/rides/${req.body.ride.id}/arrive`, { token: d.token });
    await api("post", `/rides/${req.body.ride.id}/start`, { token: d.token });
    const done = await api("post", `/rides/${req.body.ride.id}/complete`, { token: d.token, body: { actualDistanceKm: 900, actualDurationMin: 1000 } });
    expect(done.body.ride.final.fare).toBeCloseTo(req.body.ride.estimate.fare * 3, 2);
    await offline(d);
  });
});

describe("matching edge cases", () => {
  test("only drivers of the requested vehicle type are offered the ride", async () => {
    const eco = await makeDriver(14.5548, 121.0245, "economy");
    const xl = await makeDriver(14.5549, 121.0246, "xl");
    const rider = await signup("rider");
    const req = await book(rider.token, { vehicleType: "xl" });
    expect((await until(pendingOffer(xl))).ride.id).toBe(req.body.ride.id);
    expect((await api("get", "/drivers/me/offers", { token: eco.token })).body.offers).toHaveLength(0);
    await api("post", `/rides/${req.body.ride.id}/cancel`, { token: rider.token });
    await Promise.all([offline(eco), offline(xl)]);
  });

  test("a driver with a pending offer is not offered a second ride at the same time", async () => {
    const d = await makeDriver(14.5548, 121.0245);
    const r1 = await signup("rider");
    const r2 = await signup("rider");
    await book(r1.token);
    await until(pendingOffer(d));
    await book(r2.token);
    await new Promise((r) => setTimeout(r, 800));
    expect((await api("get", "/drivers/me/offers", { token: d.token })).body.offers).toHaveLength(1);
    await Promise.all([api("post", "/auth/logout", { token: r1.token }), offline(d)]);
  });

  test("unanswered offers expire via the delayed BullMQ job", async () => {
    const d = await makeDriver(14.5548, 121.0245);
    const rider = await signup("rider");
    const req = await book(rider.token);
    const offer = await until(pendingOffer(d));
    await until(async () => (await query("SELECT 1 FROM ride_offers WHERE id=$1 AND status='expired'", [offer.offerId])).length > 0, 8000);
    expect((await api("post", `/drivers/me/offers/${offer.offerId}/accept`, { token: d.token })).body.error.code).toBe("OFFER_EXPIRED");
    const c = await api("post", `/rides/${req.body.ride.id}/cancel`, { token: rider.token, body: { reason: "changed mind" } });
    expect(c.body.ride).toMatchObject({ status: "cancelled", cancellation: { by: "rider", reason: "changed mind" } });
    await offline(d);
  });

  test("two drivers racing to accept: only one wins", async () => {
    // Offers are sequential, so force the race by accepting the same offer concurrently.
    const d = await makeDriver(14.5548, 121.0245);
    const rider = await signup("rider");
    await book(rider.token);
    const offer = await until(pendingOffer(d));
    const results = await Promise.all([1, 2, 3].map(() => api("post", `/drivers/me/offers/${offer.offerId}/accept`, { token: d.token })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    await query("UPDATE rides SET status='cancelled' WHERE rider_id=$1", [rider.id]);
    await query("UPDATE drivers SET status='offline' WHERE user_id=$1", [d.id]);
  });

  test("driver cancel returns the ride to matching with that driver excluded", async () => {
    const a = await makeDriver(14.5548, 121.0245);
    const b = await makeDriver(14.56, 121.03);
    const rider = await signup("rider");
    const req = await book(rider.token);
    const offer = await until(pendingOffer(a));
    await api("post", `/drivers/me/offers/${offer.offerId}/accept`, { token: a.token });
    const c = await api("post", `/rides/${req.body.ride.id}/cancel`, { token: a.token });
    expect(c.body.ride).toMatchObject({ status: "searching", driverId: null });
    expect((await api("get", "/drivers/me", { token: a.token })).body.driver.status).toBe("online"); // freed
    expect((await until(pendingOffer(b))).ride.id).toBe(req.body.ride.id);
    expect((await api("get", "/drivers/me/offers", { token: a.token })).body.offers).toHaveLength(0);
    await api("post", `/rides/${req.body.ride.id}/cancel`, { token: rider.token });
    await Promise.all([offline(a), offline(b)]);
  });

  test("rider cancelling after acceptance frees the driver", async () => {
    const d = await makeDriver(14.5548, 121.0245);
    const rider = await signup("rider");
    const req = await book(rider.token);
    const offer = await until(pendingOffer(d));
    await api("post", `/drivers/me/offers/${offer.offerId}/accept`, { token: d.token });
    expect((await api("post", `/rides/${req.body.ride.id}/cancel`, { token: rider.token })).body.ride.status).toBe("cancelled");
    expect((await api("get", "/drivers/me", { token: d.token })).body.driver.status).toBe("online");
    await offline(d);
  });

  test("no drivers in range -> ride becomes no_drivers after the search window", async () => {
    const rider = await signup("rider");
    const req = await book(rider.token);
    await query("UPDATE rides SET requested_at = now() - interval '5 minutes' WHERE id=$1", [req.body.ride.id]);
    const { enqueueMatch } = await import("../../src/queues/index.ts");
    await enqueueMatch(req.body.ride.id);
    await until(async () => (await api("get", `/rides/${req.body.ride.id}`, { token: rider.token })).body.ride.status === "no_drivers");
    expect((await api("get", "/rides/active", { token: rider.token })).body.ride).toBeNull();
  });
});
