import { ApiError, call, tryCall } from "./api.js";
import { destination, haversineKm, stepToward } from "./geo.js";
import { dropRt, emit, rt, save, state } from "./state.js";
import { pickOne, rand, sleep, toast } from "./util.js";

const COLORS = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c", "#0891b2", "#be185d", "#65a30d"];
const RIDER_NAMES = ["Rita", "Ravi", "Rosa", "Remy", "Reese", "Rhea"];
const DRIVER_NAMES = ["Dana", "Diego", "Dee", "Dante", "Dilla", "Dex", "Dora", "Dion"];
const PASSWORD = "Passw0rd123";
export const TERMINAL = ["completed", "cancelled", "no_drivers"];

export const riders = () => state.actors.filter((a) => a.role === "rider");
export const drivers = () => state.actors.filter((a) => a.role === "driver");
export const byId = (id) => state.actors.find((a) => a.id === id);
export const selected = (role) => byId(state.selected[role]) ?? null;
export function select(role, id) { state.selected[role] = id; save(); emit("actors"); }
const changed = () => { save(); emit("actors"); };

/* ----------------------------------------------------------------- creation */

function uniqueName(role) {
  const pool = role === "rider" ? RIDER_NAMES : DRIVER_NAMES;
  const used = new Set(state.actors.filter((a) => a.role === role).map((a) => a.name));
  for (const n of pool) if (!used.has(n)) return n;
  return `${pool[0]}${state.actors.filter((a) => a.role === role).length + 1}`;
}

/** Register a brand-new rider/driver account (drivers also get a vehicle profile). */
export async function createActor({ role, name, vehicleType = "economy", lat, lng }) {
  const actor = {
    id: `a_${rand(8)}`, role, name: name || uniqueName(role), email: `${role}.${rand(8)}@sim.test`, password: PASSWORD,
    color: COLORS[state.actors.length % COLORS.length], tokens: null, userId: null,
    lat: lat ?? state.trip.pickup.lat, lng: lng ?? state.trip.pickup.lng,
    status: "offline", offerBehavior: "manual", acceptDelay: 2, heartbeat: true, autopilot: false, rideId: null,
  };
  const res = await call(null, "POST", "/auth/register", { email: actor.email, password: actor.password, fullName: `${actor.name} (${role})`, role });
  actor.tokens = res.tokens; actor.userId = res.user.id;
  if (role === "driver") {
    actor.vehicleType = vehicleType; actor.plate = `S${rand(5).toUpperCase()}`;
    actor.profile = { licenseNumber: `SIM-${rand(6).toUpperCase()}`, vehicleMake: pickOne(["Toyota", "Honda", "Hyundai", "Kia"]), vehicleModel: pickOne(["Vios", "City", "Accent", "Rio"]), vehicleColor: pickOne(["White", "Black", "Silver", "Blue"]), plateNumber: actor.plate };
    await call(actor, "PUT", "/drivers/me/profile", { ...actor.profile, vehicleType });
  }
  state.actors.push(actor);
  if (!state.selected[role]) state.selected[role] = actor.id;
  changed();
  return actor;
}

/** Attach an existing server account (e.g. one created in Postman). */
export async function loginActor({ role, email, password }) {
  const res = await call(null, "POST", "/auth/login", { email, password });
  if (res.user.role !== role) throw new Error(`That account is a ${res.user.role}, not a ${role}`);
  const actor = {
    id: `a_${rand(8)}`, role, name: res.user.fullName.split(" ")[0], email, password, color: COLORS[state.actors.length % COLORS.length],
    tokens: res.tokens, userId: res.user.id, lat: state.trip.pickup.lat, lng: state.trip.pickup.lng,
    status: "offline", offerBehavior: "manual", acceptDelay: 2, heartbeat: true, autopilot: false, rideId: null,
  };
  if (role === "driver") {
    const d = (await call(actor, "GET", "/drivers/me")).driver;
    actor.vehicleType = d.vehicle.type; actor.plate = d.vehicle.plate; actor.status = d.status;
    actor.profile = { licenseNumber: d.licenseNumber, vehicleMake: d.vehicle.make, vehicleModel: d.vehicle.model, vehicleColor: d.vehicle.color, plateNumber: d.vehicle.plate };
  }
  state.actors.push(actor);
  if (!state.selected[role]) state.selected[role] = actor.id;
  changed();
  return actor;
}

export async function removeActor(actor, { goOffline = true } = {}) {
  stopDriving(actor);
  if (goOffline && actor.role === "driver" && actor.status === "online") await call(actor, "POST", "/drivers/me/offline").catch(() => {});
  state.actors = state.actors.filter((a) => a.id !== actor.id);
  for (const role of ["rider", "driver"]) if (state.selected[role] === actor.id) state.selected[role] = state.actors.find((a) => a.role === role)?.id ?? null;
  dropRt(actor);
  changed();
}

/* ------------------------------------------------------------------- driver */

export async function pushLocation(a, quiet = true) {
  try { await call(a, "PUT", "/drivers/me/location", { lat: a.lat, lng: a.lng }, { quiet }); }
  catch (e) { if (!(e instanceof ApiError && e.status === 409)) throw e; } // 409 = offline: nothing to update
}

/** Set the driver's (fake) GPS position; if online the server is updated immediately. */
export async function setDriverLocation(a, lat, lng) {
  a.lat = lat; a.lng = lng; changed();
  if (a.status !== "offline") await pushLocation(a, false);
}

export async function goOnline(a) {
  await call(a, "POST", "/drivers/me/online", { lat: a.lat, lng: a.lng });
  a.status = rt(a).ride && !TERMINAL.includes(rt(a).ride.status) ? "busy" : "online";
  changed();
}
export async function goOffline(a) {
  stopDriving(a);
  await call(a, "POST", "/drivers/me/offline");
  a.status = "offline"; rt(a).offers = []; changed();
}
export async function setVehicleType(a, vehicleType) {
  await call(a, "PUT", "/drivers/me/profile", { ...a.profile, vehicleType });
  a.vehicleType = vehicleType; changed();
}
export async function refreshDriver(a) {
  const d = (await call(a, "GET", "/drivers/me", undefined, { quiet: true })).driver;
  a.status = d.status; changed();
}

export async function acceptOffer(a, offerId) {
  const { ride } = await call(a, "POST", `/drivers/me/offers/${offerId}/accept`);
  const r = rt(a); r.ride = ride; r.offers = []; a.status = "busy"; a.rideId = ride.id;
  changed(); emit("ride", a.id);
  if (a.autopilot) runAutopilot(a);
  return ride;
}
export async function declineOffer(a, offerId) {
  await call(a, "POST", `/drivers/me/offers/${offerId}/decline`);
  rt(a).offers = rt(a).offers.filter((o) => o.offerId !== offerId); emit("ride", a.id);
}

async function driverRideOp(a, op, body) {
  const r = rt(a);
  if (!r.ride) throw new Error("No active ride");
  const { ride } = await call(a, "POST", `/rides/${r.ride.id}/${op}`, body);
  r.ride = ride;
  if (TERMINAL.includes(ride.status) || (op === "cancel" && ride.status === "searching")) { if (op === "cancel") { r.ride = null; a.rideId = null; } a.status = "online"; }
  changed(); emit("ride", a.id);
  return ride;
}
export const arrive = (a) => driverRideOp(a, "arrive");
export const startTrip = (a) => driverRideOp(a, "start");
export const completeTrip = (a, body = {}) => driverRideOp(a, "complete", body);
export async function driverCancel(a) {
  stopDriving(a);
  const ride = await driverRideOp(a, "cancel", { reason: "Driver cancelled (simulator)" });
  return ride;
}

/** Move the driver in a straight line at `speedKmh`, pinging the server every second. Resolves true on arrival, false if cancelled. */
export async function driveTo(a, lat, lng, { speedKmh = state.settings.speed, arriveKm = 0.02 } = {}) {
  stopDriving(a);
  const token = { cancelled: false };
  rt(a).drive = token;
  try {
    while (!token.cancelled) {
      const d = haversineKm(a.lat, a.lng, lat, lng);
      if (d <= arriveKm) { a.lat = lat; a.lng = lng; emit("drivers"); if (a.status !== "offline") await pushLocation(a).catch(() => {}); return true; }
      const p = stepToward(a.lat, a.lng, lat, lng, Math.min(d, speedKmh / 3600));
      a.lat = p.lat; a.lng = p.lng; emit("drivers");
      if (a.status !== "offline") await pushLocation(a).catch(() => {});
      await sleep(1000);
    }
    return false;
  } finally {
    if (rt(a).drive === token) rt(a).drive = null;
  }
}
export function stopDriving(a) { const d = rt(a).drive; if (d) d.cancelled = true; }
export const isDriving = (a) => !!rt(a).drive;

/** Full trip on autopilot: drive to pickup, arrive, start, drive to drop-off, complete. */
export async function runAutopilot(a) {
  const r = rt(a);
  if (r.auto) return;
  r.auto = true; emit("ride", a.id);
  const alive = (status) => r.ride && r.ride.id === a.rideId && r.ride.status === status;
  try {
    const ride = r.ride;
    if (!alive("accepted")) return;
    if (!(await driveTo(a, ride.pickup.lat, ride.pickup.lng))) return;
    await refreshRide(a);
    if (!alive("accepted")) return;
    await arrive(a); await sleep(800);
    if (!alive("arrived")) return;
    await startTrip(a);
    if (!(await driveTo(a, ride.dropoff.lat, ride.dropoff.lng))) return;
    await refreshRide(a);
    if (!alive("in_progress")) return;
    await completeTrip(a);
  } catch (e) {
    toast(`Autopilot (${a.name}): ${e.message}`, "warning");
  } finally { r.auto = false; emit("ride", a.id); }
}

/* -------------------------------------------------------------------- rider */

export async function estimate(a) {
  return call(a, "POST", "/rides/estimate", { pickup: state.trip.pickup, dropoff: state.trip.dropoff });
}

export async function requestRide(a, { vehicleType = "economy", paymentMethod = "cash" } = {}) {
  const { pickup, dropoff } = state.trip;
  const { ride } = await call(a, "POST", "/rides", { pickup, dropoff, vehicleType, paymentMethod });
  const r = rt(a); r.ride = ride; r.rated = false; a.rideId = ride.id;
  changed(); emit("ride", a.id);
  return ride;
}
export async function riderCancel(a, reason = "Cancelled by rider (simulator)") {
  const r = rt(a);
  const { ride } = await call(a, "POST", `/rides/${r.ride.id}/cancel`, { reason });
  r.ride = ride; changed(); emit("ride", a.id);
  return ride;
}
export async function rateRide(a, rating, comment) {
  const r = rt(a);
  await call(a, "POST", `/rides/${r.ride.id}/rate`, { rating, comment });
  r.rated = true; emit("ride", a.id);
}
export function clearRide(a) { rt(a).ride = null; rt(a).rated = false; a.rideId = null; changed(); emit("ride", a.id); }

export async function refreshRide(a, quiet = true) {
  const r = rt(a);
  if (a.role === "driver") {
    const { ride } = await call(a, "GET", "/rides/active", undefined, { quiet });
    r.ride = ride; a.rideId = ride?.id ?? null;
  } else if (a.rideId) {
    const { ride } = await call(a, "GET", `/rides/${a.rideId}`, undefined, { quiet });
    r.ride = ride;
  } else if (!r.checkedActive) {
    r.checkedActive = true;
    const { ride } = await call(a, "GET", "/rides/active", undefined, { quiet });
    if (ride) { r.ride = ride; a.rideId = ride.id; }
  }
  emit("ride", a.id);
  return r.ride;
}

/* ------------------------------------------------------------------- polling */

export async function pollActor(a) {
  const r = rt(a);
  if (!a.tokens || r.polling) return;
  r.polling = true;
  try {
    if (a.role === "rider") {
      if (a.rideId && (!r.ride || !TERMINAL.includes(r.ride.status))) await refreshRide(a);
      else if (!a.rideId && !r.checkedActive) await refreshRide(a);
    } else if (a.status !== "offline") {
      await refreshRide(a);
      if (r.ride && !TERMINAL.includes(r.ride.status)) { if (a.status !== "busy") { a.status = "busy"; changed(); } }
      else {
        if (a.status === "busy") { a.status = "online"; changed(); }
        const { offers } = await call(a, "GET", "/drivers/me/offers", undefined, { quiet: true });
        r.offers = offers; emit("ride", a.id);
        for (const o of offers) autoHandle(a, o);
      }
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) { a.authError = e.code; }
  } finally { r.polling = false; }
}

function autoHandle(a, offer) {
  const r = rt(a);
  if (r.handled.has(offer.offerId) || !["accept", "decline"].includes(a.offerBehavior)) return;
  r.handled.add(offer.offerId);
  setTimeout(async () => {
    try {
      if (a.offerBehavior === "accept") await acceptOffer(a, offer.offerId);
      else await declineOffer(a, offer.offerId);
    } catch (e) { toast(`${a.name}: ${e.message}`, "warning"); }
  }, Math.max(0, a.acceptDelay) * 1000);
}

let tickTimer, hbTimer;
export function startLoops() {
  clearInterval(tickTimer); clearInterval(hbTimer);
  tickTimer = setInterval(() => state.actors.forEach(pollActor), 1000);
  // heartbeat: online drivers re-send their position; turn it off per driver to simulate a phone that lost signal
  hbTimer = setInterval(() => {
    for (const a of drivers()) if (a.status !== "offline" && a.heartbeat && !isDriving(a) && a.tokens) pushLocation(a).catch(() => {});
  }, 5000);
}

export async function offlineAll() {
  await Promise.allSettled(drivers().map(async (a) => {
    stopDriving(a); rt(a).auto = false;
    if (a.status === "online") await call(a, "POST", "/drivers/me/offline").catch(() => {});
    if (a.status !== "busy") a.status = "offline";
  }));
  changed();
}

export { destination };
