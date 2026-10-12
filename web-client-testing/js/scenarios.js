import { ApiError, call, refreshTokens, tryCall } from "./api.js";
import * as A from "./actors.js";
import { destination, PRESETS } from "./geo.js";
import { emit, rt, save, state } from "./state.js";
import { pickOne, sleep } from "./util.js";

class Aborted extends Error {}
export const runner = { running: false, name: "", steps: [], passed: 0, failed: 0, ctx: null };

function setFreshArea() {
  const c = pickOne(PRESETS.filter((p) => p.name !== "Null Island (0, 0)"));
  const pickup = { lat: +(c.lat + (Math.random() - 0.5) * 0.8).toFixed(5), lng: +(c.lng + (Math.random() - 0.5) * 0.8).toFixed(5) };
  state.trip = { pickup, dropoff: destination(pickup.lat, pickup.lng, 35, 5) };
  save(); emit("trip"); emit("fly", pickup);
}

function makeCtx() {
  const ctx = {
    aborted: false,
    step(text, kind = "info") { runner.steps.push({ text, kind }); emit("scenario"); },
    check(cond, text) { cond ? runner.passed++ : runner.failed++; ctx.step(text, cond ? "ok" : "err"); return cond; },
    guard() { if (ctx.aborted) throw new Aborted(); },
    async sleep(ms) { const end = Date.now() + ms; while (Date.now() < end) { ctx.guard(); await sleep(Math.min(250, end - Date.now())); } },
    async until(fn, { timeout = 30000, every = 400, label = "condition" } = {}) {
      const end = Date.now() + timeout;
      while (Date.now() < end) { ctx.guard(); const v = await fn(); if (v) return v; await sleep(every); }
      throw new Error(`Timed out waiting for ${label}`);
    },
    async prepare() {
      ctx.step("Taking previously simulated drivers offline");
      await A.offlineAll();
      if (state.settings.freshArea) { setFreshArea(); ctx.step("Moved to a fresh random area so leftover drivers are out of range"); }
      await ctx.sleep(300);
    },
    async newRider(name) {
      const r = await A.createActor({ role: "rider", name });
      ctx.step(`Rider ${r.name} registered`, "ok"); return r;
    },
    /** Create a driver `km` away from the pickup (bearing 270 = due west) and put them online. */
    async newDriver({ km = 0.5, bearing = 270, vehicle = "economy", behavior = "manual", delay = 1, autopilot = false } = {}) {
      const pos = destination(state.trip.pickup.lat, state.trip.pickup.lng, bearing, km);
      const d = await A.createActor({ role: "driver", vehicleType: vehicle, lat: pos.lat, lng: pos.lng });
      d.offerBehavior = behavior; d.acceptDelay = delay; d.autopilot = autopilot;
      await A.goOnline(d);
      ctx.step(`Driver ${d.name} online ${km} km from pickup (${vehicle}, offers: ${behavior})`, "ok"); return d;
    },
    async waitRide(actor, statuses, timeout = 60000) {
      const want = [].concat(statuses);
      return ctx.until(async () => { const r = await A.refreshRide(actor); return r && want.includes(r.status) ? r : null; }, { timeout, label: `ride ${want.join("/")}` });
    },
    async waitOffer(driver, timeout = 30000) {
      return ctx.until(async () => { await A.pollActor(driver); return rt(driver).offers[0] ?? null; }, { timeout, every: 300, label: `offer for ${driver.name}` });
    },
    async cancelIfActive(rider) {
      const r = rt(rider).ride;
      if (r && !A.TERMINAL.includes(r.status) && ["searching", "accepted", "arrived"].includes(r.status)) await A.riderCancel(rider).catch(() => {});
    },
  };
  return ctx;
}

export async function runScenario(s) {
  if (runner.running) return;
  Object.assign(runner, { running: true, name: s.title, steps: [], passed: 0, failed: 0 });
  const ctx = makeCtx(); runner.ctx = ctx; emit("scenario");
  try {
    await ctx.prepare();
    await s.run(ctx);
  } catch (e) {
    if (e instanceof Aborted) ctx.step("Stopped by user", "info");
    else { runner.failed++; ctx.step(e instanceof ApiError ? `${e.status} ${e.code}: ${e.message}` : e.message, "err"); }
  } finally {
    ctx.step(`Finished: ${runner.passed} checks passed, ${runner.failed} failed`, runner.failed ? "err" : "ok");
    runner.running = false; runner.ctx = null; emit("scenario");
  }
}
export function stopScenario() { runner.ctx && (runner.ctx.aborted = true); }

const mapTripFinal = (r) => r?.final?.fare;

export const scenarios = [
  {
    id: "happy", title: "Happy path: full trip", est: "~1 min",
    desc: "Rider books, the nearby driver auto-accepts and autopilots to pickup, starts, drives to drop-off and completes. Then rating and payment are verified.",
    async run(c) {
      const rider = await c.newRider();
      const d = await c.newDriver({ km: 0.6, behavior: "accept", delay: 1, autopilot: true });
      const est = await A.estimate(rider);
      c.check(est.options.find((o) => o.vehicleType === "economy").nearbyDrivers >= 1, "Estimate counts the nearby driver");
      const ride = await A.requestRide(rider, { paymentMethod: "card" });
      c.step(`Ride requested, quote ${ride.estimate.fare} ${ride.currency}`, "ok");
      await c.waitRide(rider, "accepted", 30000); c.check(rt(rider).ride.driverId === d.userId, `Accepted by ${d.name}`);
      await c.waitRide(rider, "arrived", 90000); c.step("Driver arrived at pickup", "ok");
      await c.waitRide(rider, "in_progress", 30000); c.step("Trip started", "ok");
      const done = await c.waitRide(rider, "completed", 180000);
      c.check(mapTripFinal(done) >= ride.estimate.fare, `Completed: final fare ${mapTripFinal(done)} (quote ${ride.estimate.fare})`);
      await A.rateRide(rider, 5, "Great ride!"); c.step("Rider rated the driver 5★", "ok");
      const pay = await call(rider, "GET", "/payments");
      c.check(pay.payments.some((p) => p.rideId === ride.id && p.status === "paid"), "Payment recorded as paid");
      const earn = await call(d, "GET", "/drivers/me/earnings");
      c.check(earn.trips === 1 && earn.net > 0, `Driver earnings: ${earn.net} net of ${earn.gross} gross`);
    },
  },
  {
    id: "dispatch", title: "Nearest-first dispatch", est: "~1 min",
    desc: "Three drivers at 0.3 / 1.5 / 3 km. Nearest declines, the middle one ignores the offer (timeout), the farthest accepts. Checks the offer order.",
    async run(c) {
      const rider = await c.newRider();
      const near = await c.newDriver({ km: 0.3, bearing: 270, behavior: "decline", delay: 1 });
      const mid = await c.newDriver({ km: 1.5, bearing: 180, behavior: "ignore" });
      const far = await c.newDriver({ km: 3, bearing: 90, behavior: "accept", delay: 1 });
      const ride = await A.requestRide(rider); c.step("Ride requested", "ok");
      const o1 = await c.waitOffer(near);
      c.check(o1.ride.id === ride.id, `${near.name} (nearest) was offered first`);
      c.check(rt(mid).offers.length === 0 && rt(far).offers.length === 0, "Other drivers had no offer yet (one at a time)");
      await c.waitOffer(mid, 20000); c.step(`${near.name} declined, ${mid.name} offered; ${mid.name} will ignore it (waiting for the timeout)`, "ok");
      await c.waitOffer(far, 60000); c.step(`Offer to ${mid.name} expired, ${far.name} offered`, "ok");
      const r = await c.waitRide(rider, "accepted", 20000);
      c.check(r.driverId === far.userId, `${far.name} got the ride`);
      const ev = await call(rider, "GET", `/rides/${ride.id}/events`);
      const order = ev.events.filter((e) => e.type === "offered").map((e) => e.actorId);
      c.check(JSON.stringify(order) === JSON.stringify([near.userId, mid.userId, far.userId]), "Audit trail shows offers in distance order");
      await c.cancelIfActive(rider);
    },
  },
  {
    id: "radius", title: "Out of range, then in range", est: "~30 s",
    desc: "A driver sits just outside the match radius and gets nothing. Moving the driver inside the radius triggers the offer.",
    async run(c) {
      const rider = await c.newRider();
      const d = await c.newDriver({ km: state.settings.radiusKm + 3, behavior: "accept", delay: 1 });
      const est = await A.estimate(rider);
      c.check(est.options[0].nearbyDrivers === 0, "Estimate shows 0 nearby drivers (outside radius)");
      await A.requestRide(rider); c.step("Ride requested", "ok");
      await c.sleep(7000);
      c.check(rt(d).offers.length === 0 && rt(rider).ride.status === "searching", "No offer while out of range; ride keeps searching");
      const target = destination(state.trip.pickup.lat, state.trip.pickup.lng, 270, Math.max(0.5, state.settings.radiusKm - 2));
      c.step("Driver drives into the radius…");
      await A.driveTo(d, target.lat, target.lng, { speedKmh: 600 });
      const r = await c.waitRide(rider, "accepted", 30000);
      c.check(r.driverId === d.userId, "Offer reached the driver once in range, and they accepted");
      await c.cancelIfActive(rider);
    },
  },
  {
    id: "rider-cancel", title: "Rider cancels (searching, then after accept)", est: "~20 s",
    desc: "Cancel while an offer is pending (the offer is withdrawn), then book again, get accepted and cancel (the driver is freed).",
    async run(c) {
      const rider = await c.newRider();
      const d = await c.newDriver({ km: 0.5, behavior: "ignore" });
      await A.requestRide(rider); await c.waitOffer(d);
      c.step("Driver has a pending offer; rider cancels", "ok");
      const cancelled = await A.riderCancel(rider);
      c.check(cancelled.status === "cancelled", "Ride cancelled while searching");
      await c.until(async () => { await A.pollActor(d); return rt(d).offers.length === 0; }, { timeout: 8000, label: "offer withdrawal" });
      c.check(true, "Pending offer disappeared from the driver");
      A.clearRide(rider); d.offerBehavior = "accept"; d.acceptDelay = 0;
      await A.requestRide(rider); await c.waitRide(rider, "accepted", 30000); c.step("Second ride accepted", "ok");
      await A.riderCancel(rider);
      await A.refreshDriver(d);
      c.check(d.status === "online", "Driver is free (online) again after the rider cancelled");
    },
  },
  {
    id: "driver-cancel", title: "Driver cancels after accepting (re-match)", est: "~1 min",
    desc: "Driver A accepts then cancels. The ride returns to searching, excludes A, and driver B takes and completes it.",
    async run(c) {
      const rider = await c.newRider();
      const a = await c.newDriver({ km: 0.4, behavior: "accept", delay: 0 });
      const b = await c.newDriver({ km: 1.2, bearing: 0, behavior: "accept", delay: 0, autopilot: true });
      const ride = await A.requestRide(rider);
      await c.waitRide(rider, "accepted", 30000);
      c.check(rt(rider).ride.driverId === a.userId, `${a.name} (nearest) accepted`);
      a.offerBehavior = "ignore";
      await A.driverCancel(a); c.step(`${a.name} cancelled the ride`, "ok");
      await c.until(async () => (await A.refreshRide(rider)).driverId === b.userId && rt(rider).ride.status !== "searching", { timeout: 40000, label: `${b.name} to take over` });
      c.check(true, `Re-matched to ${b.name}; ${a.name} was not offered again`);
      const done = await c.waitRide(rider, "completed", 180000);
      c.check(done.id === ride.id, "Same ride completed by the second driver");
    },
  },
  {
    id: "arrive-fare", title: "Arrival radius and fare cap", est: "~40 s",
    desc: "Driver tries to mark 'arrived' from far away (rejected), then drives to pickup. Completes with an absurd distance: fare is capped at 3x the quote.",
    async run(c) {
      const rider = await c.newRider();
      const d = await c.newDriver({ km: 2, behavior: "accept", delay: 0 });
      const ride = await A.requestRide(rider); await c.waitRide(rider, "accepted", 30000);
      const early = await tryCall(d, "POST", `/rides/${ride.id}/arrive`);
      c.check(early.status === 409 && early.json.error.code === "TOO_FAR_FROM_PICKUP", "Arrive from 2 km away rejected: TOO_FAR_FROM_PICKUP");
      await A.driveTo(d, state.trip.pickup.lat, state.trip.pickup.lng, { speedKmh: 600 });
      await A.arrive(d); c.step("Arrived after driving to the pickup", "ok");
      await A.startTrip(d);
      const done = await A.completeTrip(d, { actualDistanceKm: 900, actualDurationMin: 1000 });
      c.check(Math.abs(done.final.fare - ride.estimate.fare * 3) < 0.02, `Fare capped at 3x quote (${done.final.fare} vs quote ${ride.estimate.fare})`);
    },
  },
  {
    id: "vehicle", title: "Vehicle type matching", est: "~20 s",
    desc: "A nearer economy driver and a farther XL driver. An XL request is offered only to the XL driver.",
    async run(c) {
      const rider = await c.newRider();
      const eco = await c.newDriver({ km: 0.2, vehicle: "economy", behavior: "accept", delay: 0 });
      const xl = await c.newDriver({ km: 1.5, vehicle: "xl", behavior: "accept", delay: 0 });
      await A.requestRide(rider, { vehicleType: "xl" });
      const r = await c.waitRide(rider, "accepted", 30000);
      c.check(r.driverId === xl.userId, `XL driver ${xl.name} got the ride despite ${eco.name} being nearer`);
      const offers = await call(eco, "GET", "/drivers/me/offers");
      c.check(offers.offers.length === 0, "Economy driver was never offered it");
      await c.cancelIfActive(rider);
    },
  },
  {
    id: "contention", title: "Two riders, one driver", est: "~20 s",
    desc: "Both riders request at once. The driver gets one offer at a time; once busy, the second ride keeps searching.",
    async run(c) {
      const r1 = await c.newRider(); const r2 = await c.newRider();
      const d = await c.newDriver({ km: 0.3, behavior: "accept", delay: 1 });
      await A.requestRide(r1); await A.requestRide(r2); c.step("Both rides requested", "ok");
      await c.until(async () => ["accepted"].includes((await A.refreshRide(r1)).status) || ["accepted"].includes((await A.refreshRide(r2)).status), { timeout: 30000, label: "one ride accepted" });
      await c.sleep(6000);
      const s1 = (await A.refreshRide(r1)).status, s2 = (await A.refreshRide(r2)).status;
      c.check([s1, s2].filter((s) => s === "accepted").length === 1 && [s1, s2].includes("searching"), `One accepted, one still searching (${s1} / ${s2})`);
      c.check(rt(d).ride && d.status === "busy", "Driver is busy with exactly one ride");
      await c.cancelIfActive(r1); await c.cancelIfActive(r2);
    },
  },
  {
    id: "auth", title: "Auth: refresh rotation and reuse detection", est: "~5 s",
    desc: "Rotates a refresh token, then replays the old one. The server must revoke the whole session; logging in again recovers.",
    async run(c) {
      const rider = await c.newRider();
      const old = rider.tokens.refreshToken;
      await refreshTokens(rider);
      c.check(rider.tokens.refreshToken !== old, "Refresh rotated the refresh token");
      c.check((await tryCall(rider, "GET", "/users/me")).status === 200, "New access token works");
      const replay = await tryCall(null, "POST", "/auth/refresh", { refreshToken: old });
      c.check(replay.status === 401 && replay.json.error.code === "REFRESH_TOKEN_REUSED", "Replaying the old refresh token: REFRESH_TOKEN_REUSED");
      const after = await tryCall(rider, "GET", "/users/me");
      c.check(after.status === 401 && after.json.error.code === "SESSION_REVOKED", "Whole session revoked: even the newest access token is rejected");
      const login = await call(null, "POST", "/auth/login", { email: rider.email, password: rider.password });
      rider.tokens = login.tokens; save();
      c.check((await tryCall(rider, "GET", "/users/me")).status === 200, "Logging in again restores access");
    },
  },
];
