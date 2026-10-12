import { ApiError, apiBase, call, ping } from "./api.js";
import * as A from "./actors.js";
import { destination, haversineKm, PRESETS } from "./geo.js";
import { apiLog, emit, on, resetAll, rt, save, state } from "./state.js";
import { runner, runScenario, scenarios, stopScenario } from "./scenarios.js";
import { $, $$, esc, fmtTime, money, num, toast } from "./util.js";

let tab = "rider";
let adminOut = "";
let hidePolling = true;
const panel = () => $("#panel");

export const currentTab = () => tab;
export function setTab(t) {
  tab = t;
  $$("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === t));
  render(true);
}

/* ------------------------------------------------------------------ helpers */

const BADGE = { searching: "warning text-dark", accepted: "primary", arrived: "info text-dark", in_progress: "success", completed: "success", cancelled: "secondary", no_drivers: "danger", online: "success", offline: "secondary", busy: "warning text-dark" };
const badge = (s) => `<span class="badge status-badge text-bg-${BADGE[s] ?? "secondary"}">${esc(String(s).replace("_", " "))}</span>`;
const opt = (v, label, cur) => `<option value="${esc(v)}" ${String(cur) === String(v) ? "selected" : ""}>${esc(label)}</option>`;
const presetOptions = () => `<option value="">Jump to…</option>` + PRESETS.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join("");
const llRow = (idLat, idLng, lat, lng, applyAct, label) => `
  <div class="input-group input-group-sm mb-2">
    <span class="input-group-text">${label}</span>
    <input id="${idLat}" class="form-control ll-input" inputmode="decimal" value="${num(lat, 6)}" aria-label="latitude">
    <input id="${idLng}" class="form-control ll-input" inputmode="decimal" value="${num(lng, 6)}" aria-label="longitude">
    <button class="btn btn-dark" data-act="${applyAct}">Set</button>
  </div>`;
const card = (title, body) => `<div class="card-lite"><h6>${title}</h6>${body}</div>`;
const actorSelect = (role) => {
  const list = state.actors.filter((a) => a.role === role);
  const cur = state.selected[role];
  return `<div class="d-flex gap-2 mb-2">
    <select class="form-select form-select-sm" data-chg="select-${role}">${list.length ? list.map((a) => opt(a.id, `${a.name}${role === "driver" ? ` · ${a.status}` : ""}`, cur)).join("") : "<option>none yet</option>"}</select>
    <button class="btn btn-sm btn-dark" data-act="new-${role}">+ New</button>
    <button class="btn btn-sm btn-outline-secondary" data-act="login-${role}" title="Use an existing account">Login</button>
    ${cur ? `<button class="btn btn-sm btn-outline-danger" data-act="remove-actor" data-id="${cur}" title="Remove from simulator">🗑</button>` : ""}
  </div>`;
};
const val = (id) => $(`#${id}`)?.value;
const fnum = (id) => Number(String(val(id)).replace(",", "."));

/* --------------------------------------------------------------- rider tab */

function rideCard(a) {
  const r = rt(a).ride;
  if (!r) return "";
  const live = ["searching", "accepted", "arrived", "in_progress"].includes(r.status);
  const d = r.driver;
  const dist = d?.location ? haversineKm(d.location.lat, d.location.lng, r.pickup.lat, r.pickup.lng) : null;
  let body = `<div class="d-flex justify-content-between align-items-center mb-1">${badge(r.status)}<span class="m small text-secondary">${esc(r.id.slice(0, 8))}</span></div>
    <div class="small">Quote <b>${money(r.estimate.fare, r.currency)}</b> · ${r.estimate.distanceKm} km · ${r.estimate.durationMin} min · ${esc(r.vehicleType)} · ${esc(r.paymentMethod)}</div>`;
  if (r.status === "searching") body += `<div class="small text-secondary mt-1"><span class="spinner-border spinner-border-sm me-1"></span>Matching nearby drivers (one offer at a time)…</div>`;
  if (d) body += `<div class="small mt-2"><b>${esc(d.name)}</b> · ⭐ ${d.rating} · ${esc(d.vehicle.color)} ${esc(d.vehicle.make)} ${esc(d.vehicle.model)} · <span class="m">${esc(d.vehicle.plate)}</span>
    ${dist != null && r.status === "accepted" ? `<br>Driver is ${dist.toFixed(2)} km from pickup (server's view)` : ""}</div>`;
  if (r.final) body += `<div class="small mt-2">Final fare <b>${money(r.final.fare, r.currency)}</b> (platform ${money(r.final.platformFee)}, driver ${money(r.final.driverEarnings)})</div>`;
  if (r.cancellation) body += `<div class="small text-secondary mt-1">Cancelled by ${esc(r.cancellation.by)}${r.cancellation.reason ? `: ${esc(r.cancellation.reason)}` : ""}</div>`;
  const btns = [];
  if (["searching", "accepted", "arrived"].includes(r.status)) btns.push(`<button class="btn btn-sm btn-outline-danger" data-act="cancel-ride">Cancel ride</button>`);
  if (r.status === "completed" && !rt(a).rated) btns.push(`<span class="small me-1">Rate driver:</span>` + [1, 2, 3, 4, 5].map((n) => `<button class="btn btn-sm btn-outline-warning" data-act="rate" data-n="${n}">${n}★</button>`).join(""));
  if (!live) btns.push(`<button class="btn btn-sm btn-dark" data-act="new-ride">New ride</button>`);
  return card("Current ride", body + `<div class="d-flex flex-wrap gap-1 mt-2">${btns.join("")}</div>`);
}

function riderTab() {
  const a = A.selected("rider");
  let h = actorSelect("rider");
  if (!a) return h + `<p class="text-secondary small">Create a rider to begin. The pickup 📍 is the rider's current location: tap the map, drag the pin, or type coordinates.</p>`;
  const { pickup, dropoff } = state.trip;
  const est = rt(a).estimate;
  h += card("Locations (fake GPS)", `
    ${llRow("pu-lat", "pu-lng", pickup.lat, pickup.lng, "apply-pickup", "📍")}
    ${llRow("do-lat", "do-lng", dropoff.lat, dropoff.lng, "apply-dropoff", "🏁")}
    <div class="d-flex gap-2">
      <select class="form-select form-select-sm" data-chg="preset-pickup" aria-label="preset for pickup">${presetOptions()}</select>
      <button class="btn btn-sm btn-outline-secondary text-nowrap" data-act="drop-5km" title="Put the drop-off 5 km north-east of the pickup">Drop +5 km</button>
    </div>`);
  h += card("Request", `
    <div class="row g-2 mb-2">
      <div class="col-6"><select id="veh" class="form-select form-select-sm">${["economy", "comfort", "xl"].map((v) => opt(v, v, rt(a).veh ?? "economy")).join("")}</select></div>
      <div class="col-6"><select id="pay" class="form-select form-select-sm">${["cash", "card", "wallet"].map((v) => opt(v, v, rt(a).pay ?? "cash")).join("")}</select></div>
    </div>
    <div class="d-grid gap-2 d-flex"><button class="btn btn-outline-dark btn-sm flex-fill" data-act="estimate">Estimate</button><button class="btn btn-success btn-sm flex-fill" data-act="request">Request ride</button></div>
    ${est ? `<table class="table table-sm small mt-2 mb-0"><thead><tr><th>Type</th><th>Fare</th><th>Drivers</th><th>ETA</th></tr></thead><tbody>${est.options.map((o) => `<tr><td>${o.vehicleType}</td><td>${o.fare} ${o.currency}</td><td>${o.nearbyDrivers}</td><td>${o.pickupEtaMin ?? "–"} min</td></tr>`).join("")}</tbody></table>` : ""}`);
  const live = rt(a).ride && !A.TERMINAL.includes(rt(a).ride.status);
  return live ? actorSelect("rider") + rideCard(a) + h.slice(actorSelect("rider").length) : h + rideCard(a);
}

/* -------------------------------------------------------------- driver tab */

function driverRideCard(a) {
  const r = rt(a).ride;
  if (!r || A.TERMINAL.includes(r.status)) return "";
  const toPick = haversineKm(a.lat, a.lng, r.pickup.lat, r.pickup.lng), toDrop = haversineKm(a.lat, a.lng, r.dropoff.lat, r.dropoff.lng);
  const driving = A.isDriving(a), auto = rt(a).auto;
  const b = [];
  if (r.status === "accepted") b.push(`<button class="btn btn-sm btn-outline-primary" data-act="drive-pickup">Drive to pickup</button><button class="btn btn-sm btn-primary" data-act="arrive">Arrive</button>`);
  if (r.status === "arrived") b.push(`<button class="btn btn-sm btn-success" data-act="start">Start trip</button>`);
  if (r.status === "in_progress") b.push(`<button class="btn btn-sm btn-outline-primary" data-act="drive-dropoff">Drive to drop-off</button><button class="btn btn-sm btn-success" data-act="complete">Complete</button>`);
  if (["accepted", "arrived"].includes(r.status)) b.push(`<button class="btn btn-sm btn-outline-danger" data-act="drv-cancel">Cancel ride</button>`);
  if (driving) b.push(`<button class="btn btn-sm btn-warning" data-act="stop-drive">⏸ Stop</button>`);
  if (!auto && ["accepted", "arrived", "in_progress"].includes(r.status)) b.push(`<button class="btn btn-sm btn-dark" data-act="autopilot">▶ Autopilot</button>`);
  return card("Active ride", `<div class="d-flex justify-content-between mb-1">${badge(r.status)}<span class="m small text-secondary">${esc(r.id.slice(0, 8))}</span></div>
    <div class="small">Rider <b>${esc(r.rider?.name ?? "")}</b> · fare ${money(r.estimate.fare, r.currency)}<br>
    To pickup <b>${toPick.toFixed(2)} km</b> · to drop-off <b>${toDrop.toFixed(2)} km</b>${driving ? " · 🚗 driving…" : ""}${auto ? " · autopilot on" : ""}</div>
    <div class="d-flex flex-wrap gap-1 mt-2">${b.join("")}</div>`);
}

function offersCard(a) {
  const offers = rt(a).offers;
  if (!offers.length) return a.status === "online" ? card("Offers", `<div class="small text-secondary">No offers. Waiting… (behaviour: ${esc(a.offerBehavior)})</div>`) : "";
  return card("Ride offers", offers.map((o) => `
    <div class="border rounded p-2 mb-2">
      <div class="small"><b>${o.distanceToPickupKm} km</b> to pickup · quote ${money(o.ride.estimate.fare, o.ride.currency)} · ${o.ride.estimate.distanceKm} km trip</div>
      <div class="small text-secondary">expires in <span class="countdown" data-exp="${esc(o.expiresAt)}">…</span></div>
      <div class="d-flex gap-2 mt-1"><button class="btn btn-sm btn-success flex-fill" data-act="accept" data-offer="${o.offerId}">Accept</button><button class="btn btn-sm btn-outline-secondary flex-fill" data-act="decline" data-offer="${o.offerId}">Decline</button></div>
    </div>`).join(""));
}

function driverTab() {
  const a = A.selected("driver");
  let h = actorSelect("driver");
  if (!a) return h + `<p class="text-secondary small">Create a driver. Drag the 🚗 on the map, tap the map in 🚗 mode, or type coordinates to change their position.</p>`;
  const on = a.status !== "offline";
  h += card(`${esc(a.name)} · ${badge(a.status)}`, `
    <div class="small text-secondary mb-2">${esc(a.vehicleType)} · plate <span class="m">${esc(a.plate)}</span></div>
    <div class="d-flex gap-2 mb-2">
      <button class="btn btn-sm ${on ? "btn-outline-secondary" : "btn-success"} flex-fill" data-act="toggle-online" ${a.status === "busy" ? "disabled" : ""}>${on ? "Go offline" : "Go online"}</button>
      <button class="btn btn-sm btn-outline-dark" data-act="earnings">Earnings</button>
    </div>
    ${llRow("dr-lat", "dr-lng", a.lat, a.lng, "apply-driver-loc", "🚗")}
    <div class="d-flex gap-1 align-items-center mb-1">
      <select id="nudge" class="form-select form-select-sm" style="width:auto">${[0.1, 0.5, 1, 5].map((v) => opt(v, `${v} km`, rt(a).nudge ?? 0.5)).join("")}</select>
      ${[["N", "↑"], ["W", "←"], ["S", "↓"], ["E", "→"]].map(([d, s]) => `<button class="btn btn-sm btn-outline-dark" data-act="nudge" data-dir="${d}">${s}</button>`).join("")}
      <button class="btn btn-sm btn-outline-dark ms-auto" data-act="drv-to-pickup" title="Teleport to the pickup">⤓ pickup</button>
    </div>`);
  h += card("Behaviour", `
    <div class="row g-2 align-items-center">
      <div class="col-7"><select class="form-select form-select-sm" data-chg="behavior">${[["manual", "Offers: manual"], ["accept", "Offers: auto-accept"], ["decline", "Offers: auto-decline"], ["ignore", "Offers: ignore (timeout)"]].map(([v, l]) => opt(v, l, a.offerBehavior)).join("")}</select></div>
      <div class="col-5"><div class="input-group input-group-sm"><input id="delay" type="number" min="0" max="60" class="form-control" value="${a.acceptDelay}" data-chg="delay"><span class="input-group-text">s delay</span></div></div>
      <div class="col-6"><div class="form-check form-switch small"><input class="form-check-input" type="checkbox" id="hb" data-chg="heartbeat" ${a.heartbeat ? "checked" : ""}><label class="form-check-label" for="hb">Heartbeat (5 s)</label></div></div>
      <div class="col-6"><div class="form-check form-switch small"><input class="form-check-input" type="checkbox" id="ap" data-chg="autopilot" ${a.autopilot ? "checked" : ""}><label class="form-check-label" for="ap">Autopilot after accept</label></div></div>
      <div class="col-12"><select class="form-select form-select-sm" data-chg="vehicle">${["economy", "comfort", "xl"].map((v) => opt(v, `Vehicle: ${v}`, a.vehicleType)).join("")}</select></div>
    </div>`);
  const top = driverRideCard(a) + offersCard(a);
  const sel = actorSelect("driver");
  return sel + top + h.slice(sel.length);
}

/* ------------------------------------------------------------ scenarios tab */

const stepsHtml = () => runner.steps.map((s) => `<div class="step ${s.kind === "ok" ? "ok" : s.kind === "err" ? "err" : "info"}">${esc(s.text)}</div>`).join("");

function scenariosTab() {
  return `
    <div class="form-check form-switch small mb-2"><input class="form-check-input" type="checkbox" id="fresh" data-chg="fresh" ${state.settings.freshArea ? "checked" : ""}><label class="form-check-label" for="fresh">Jump to a fresh random area first (keeps old drivers out of range)</label></div>
    <div class="d-flex gap-2 mb-2"><button class="btn btn-sm btn-outline-secondary" data-act="offline-all">All my drivers offline</button>${runner.running ? `<button class="btn btn-sm btn-danger" data-act="stop-scenario">■ Stop</button>` : ""}</div>
    ${runner.steps.length ? card(`${esc(runner.name)} ${runner.running ? '<span class="spinner-border spinner-border-sm ms-1"></span>' : ""}`, `<div id="steps">${stepsHtml()}</div>`) : ""}
    ${scenarios.map((s) => `<div class="card-lite"><div class="d-flex justify-content-between align-items-start gap-2"><div><b class="small">${esc(s.title)}</b> <span class="badge text-bg-light border">${esc(s.est)}</span><div class="small text-secondary">${esc(s.desc)}</div></div><button class="btn btn-sm btn-dark" data-act="run-scenario" data-id="${s.id}" ${runner.running ? "disabled" : ""}>Run</button></div></div>`).join("")}
    <p class="small text-secondary">Scenarios register fresh users each run and need the API <i>and</i> <code>bun run worker</code> running.</p>`;
}

/* ---------------------------------------------------------------- log tab */

function logTab() {
  const rows = apiLog.filter((e) => !(hidePolling && e.quiet)).slice(0, 120);
  return `<div class="d-flex gap-2 align-items-center mb-2">
      <div class="form-check form-switch small mb-0"><input class="form-check-input" type="checkbox" id="hp" data-chg="hidepoll" ${hidePolling ? "checked" : ""}><label class="form-check-label" for="hp">Hide polling</label></div>
      <button class="btn btn-sm btn-outline-secondary ms-auto" data-act="log-export">Export</button><button class="btn btn-sm btn-outline-secondary" data-act="log-clear">Clear</button></div>
    ${rows.length ? rows.map((e, i) => `<div class="log-entry" data-act="log-toggle"><span class="badge text-bg-${e.status >= 200 && e.status < 300 ? "success" : "danger"}">${e.status || "ERR"}</span> <b>${e.method}</b> <span class="m">${esc(e.path)}</span> <span class="text-secondary">${e.ms}ms · ${esc(e.who)} · ${fmtTime(e.t)}</span>
      <pre hidden>${esc(JSON.stringify({ request: e.req, response: e.res }, null, 2))}</pre></div>`).join("") : `<p class="small text-secondary">No calls yet.</p>`}`;
}

/* ------------------------------------------------------------- settings tab */

function settingsTab() {
  const s = state.settings;
  return `
    ${card("API", `<div class="input-group input-group-sm mb-2"><input id="api-base" class="form-control" placeholder="${esc(location.origin)}/api/v1" value="${esc(s.apiBase)}"><button class="btn btn-dark" data-act="save-api">Save</button><button class="btn btn-outline-dark" data-act="test-api">Test</button></div><div class="small text-secondary">Using <span class="m">${esc(apiBase())}</span>. Leave empty when served by the API at /client.</div>`)}
    ${card("Map & simulation", `
      <div class="row g-2 align-items-center">
        <div class="col-6"><select class="form-select form-select-sm" data-chg="tiles">${opt("osm", "OpenStreetMap", s.tiles)}${opt("grid", "Offline grid (mockup)", s.tiles)}</select></div>
        <div class="col-6"><div class="input-group input-group-sm"><input type="number" min="1" max="100" step="0.5" class="form-control" value="${s.radiusKm}" data-chg="radius"><span class="input-group-text">km radius</span></div></div>
        <div class="col-12"><label class="small">Driving speed: <b id="speed-v">${s.speed}</b> km/h <span class="text-secondary">(simulated; 400 ≈ 5 km/45 s)</span></label><input type="range" class="form-range" min="10" max="1500" step="10" value="${s.speed}" data-chg="speed"></div>
      </div><div class="small text-secondary">The dashed green circle is the matching radius around the pickup (server default 5 km: <code>MATCH_SEARCH_RADIUS_KM</code>).</div>`)}
    ${card("Admin tools (housekeeping)", `
      <div class="input-group input-group-sm mb-2"><input id="adm-email" class="form-control" value="${esc(s.adminEmail)}"><input id="adm-pass" type="password" class="form-control" value="${esc(s.adminPassword)}"><button class="btn btn-dark" data-act="admin-login">${state.admin ? "✓ " : ""}Login</button></div>
      <div class="d-flex flex-wrap gap-1 mb-2">${["purge-refresh-tokens", "expire-stale-offers", "expire-stale-searches", "release-stuck-rides", "offline-stale-drivers"].map((j) => `<button class="btn btn-sm btn-outline-secondary" data-act="admin-job" data-job="${j}" ${state.admin ? "" : "disabled"}>${j}</button>`).join("")}</div>
      <div class="d-flex gap-1"><button class="btn btn-sm btn-outline-dark" data-act="admin-queues" ${state.admin ? "" : "disabled"}>Queue counts</button><button class="btn btn-sm btn-outline-dark" data-act="admin-runs" ${state.admin ? "" : "disabled"}>Recent runs</button></div>
      ${adminOut ? `<pre class="small mt-2 mb-0" style="white-space:pre-wrap">${esc(adminOut)}</pre>` : ""}
      <div class="small text-secondary mt-1">Needs an admin: run <code>bun run seed</code> on the server.</div>`)}
    ${card(`Simulated users (${state.actors.length})`, state.actors.length ? state.actors.map((a) => `<div class="d-flex justify-content-between small py-1 border-bottom"><span>${a.role === "rider" ? "🧍" : "🚗"} <b>${esc(a.name)}</b> <span class="text-secondary m">${esc(a.email)}</span></span><button class="btn btn-sm btn-link text-danger p-0" data-act="remove-actor" data-id="${a.id}">remove</button></div>`).join("") : '<span class="small text-secondary">None.</span>')}
    <div class="d-flex gap-2"><button class="btn btn-sm btn-outline-danger" data-act="reset-all">Reset all local data</button></div>`;
}

/* ------------------------------------------------------------------ render */

let rafId = 0;
export function render(force = false) {
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(() => {
    const p = panel(); if (!p) return;
    const ae = document.activeElement;
    if (!force && p.contains(ae) && ["INPUT", "SELECT", "TEXTAREA"].includes(ae.tagName) && ae.type !== "checkbox") return; // don't clobber typing
    const top = p.scrollTop;
    p.innerHTML = { rider: riderTab, driver: driverTab, scenarios: scenariosTab, log: logTab, settings: settingsTab }[tab]();
    p.scrollTop = top;
    tickCountdowns();
  });
}

export function tickCountdowns() {
  $$(".countdown").forEach((el) => { const s = Math.max(0, Math.round((new Date(el.dataset.exp) - Date.now()) / 1000)); el.textContent = `${s}s`; });
}

/* ----------------------------------------------------------------- actions */

const errMsg = (e) => (e instanceof ApiError ? `${e.status} ${e.code}: ${e.message}` : e.message);
const attempt = async (fn) => { try { await fn(); } catch (e) { toast(errMsg(e), "danger", 5000); } finally { render(true); } };
const setTrip = (key, lat, lng) => {
  if (![lat, lng].every(Number.isFinite) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return toast("Invalid coordinates", "warning");
  state.trip[key] = { lat: +lat.toFixed(6), lng: +lng.toFixed(6) }; save(); emit("trip");
};

const actions = {
  "new-rider": () => attempt(async () => { const a = await A.createActor({ role: "rider" }); toast(`Rider ${a.name} created`, "success"); }),
  "new-driver": () => attempt(async () => {
    const pos = destination(state.trip.pickup.lat, state.trip.pickup.lng, Math.random() * 360, 0.4 + Math.random() * 1.2);
    const a = await A.createActor({ role: "driver", lat: pos.lat, lng: pos.lng });
    await A.goOnline(a); toast(`Driver ${a.name} online near the pickup`, "success");
  }),
  "login-rider": () => loginPrompt("rider"),
  "login-driver": () => loginPrompt("driver"),
  "remove-actor": (el) => attempt(() => A.removeActor(A.byId(el.dataset.id))),
  "apply-pickup": () => { setTrip("pickup", fnum("pu-lat"), fnum("pu-lng")); emit("fly", state.trip.pickup); render(true); },
  "apply-dropoff": () => { setTrip("dropoff", fnum("do-lat"), fnum("do-lng")); render(true); },
  "drop-5km": () => { const d = destination(state.trip.pickup.lat, state.trip.pickup.lng, 45, 5); setTrip("dropoff", d.lat, d.lng); render(true); },
  estimate: () => attempt(async () => { const a = A.selected("rider"); rt(a).veh = val("veh"); rt(a).est = null; rt(a).estimate = await A.estimate(a); }),
  request: () => attempt(async () => { const a = A.selected("rider"); rt(a).veh = val("veh"); rt(a).pay = val("pay"); await A.requestRide(a, { vehicleType: val("veh"), paymentMethod: val("pay") }); }),
  "cancel-ride": () => attempt(() => A.riderCancel(A.selected("rider"))),
  rate: (el) => attempt(async () => { await A.rateRide(A.selected("rider"), Number(el.dataset.n)); toast("Thanks! Rated.", "success"); }),
  "new-ride": () => { A.clearRide(A.selected("rider")); render(true); },

  "toggle-online": () => attempt(async () => { const a = A.selected("driver"); a.status === "offline" ? await A.goOnline(a) : await A.goOffline(a); }),
  "apply-driver-loc": () => attempt(() => A.setDriverLocation(A.selected("driver"), fnum("dr-lat"), fnum("dr-lng"))),
  nudge: (el) => attempt(() => {
    const a = A.selected("driver"); const km = Number(val("nudge")); rt(a).nudge = km;
    const p = destination(a.lat, a.lng, { N: 0, E: 90, S: 180, W: 270 }[el.dataset.dir], km);
    return A.setDriverLocation(a, p.lat, p.lng);
  }),
  "drv-to-pickup": () => attempt(() => A.setDriverLocation(A.selected("driver"), state.trip.pickup.lat, state.trip.pickup.lng)),
  "drive-pickup": () => { const a = A.selected("driver"); const r = rt(a).ride; A.driveTo(a, r.pickup.lat, r.pickup.lng).then(() => render(true)); render(true); },
  "drive-dropoff": () => { const a = A.selected("driver"); const r = rt(a).ride; A.driveTo(a, r.dropoff.lat, r.dropoff.lng).then(() => render(true)); render(true); },
  "stop-drive": () => { A.stopDriving(A.selected("driver")); render(true); },
  arrive: () => attempt(() => A.arrive(A.selected("driver"))),
  start: () => attempt(() => A.startTrip(A.selected("driver"))),
  complete: () => attempt(async () => { const r = await A.completeTrip(A.selected("driver")); toast(`Completed: fare ${r.final.fare}, driver earns ${r.final.driverEarnings}`, "success"); }),
  "drv-cancel": () => attempt(() => A.driverCancel(A.selected("driver"))),
  autopilot: () => { A.runAutopilot(A.selected("driver")); render(true); },
  accept: (el) => attempt(() => A.acceptOffer(A.selected("driver"), el.dataset.offer)),
  decline: (el) => attempt(() => A.declineOffer(A.selected("driver"), el.dataset.offer)),
  earnings: () => attempt(async () => { const e = await call(A.selected("driver"), "GET", "/drivers/me/earnings"); toast(`Trips ${e.trips} · gross ${e.gross} · fees ${e.fees} · net ${e.net} ${e.currency}`, "dark", 6000); }),

  "run-scenario": (el) => { runScenario(scenarios.find((s) => s.id === el.dataset.id)); setTimeout(() => render(true), 0); },
  "stop-scenario": () => stopScenario(),
  "offline-all": () => attempt(() => A.offlineAll()),

  "log-clear": () => { apiLog.length = 0; render(true); },
  "log-export": () => { const blob = new Blob([JSON.stringify(apiLog, null, 2)], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "ride-sim-log.json"; a.click(); },
  "log-toggle": (el) => { const pre = $("pre", el); pre.hidden = !pre.hidden; },

  "save-api": () => { state.settings.apiBase = val("api-base").trim(); save(); toast("API base saved", "success"); render(true); },
  "test-api": () => attempt(async () => { state.settings.apiBase = val("api-base").trim(); save(); const r = await ping(); toast(r.status === 200 ? "API reachable, Postgres + Valkey OK" : `API responded ${r.status}: ${JSON.stringify(r.json)}`, r.status === 200 ? "success" : "danger"); }),
  "admin-login": () => attempt(async () => {
    state.settings.adminEmail = val("adm-email"); state.settings.adminPassword = val("adm-pass"); save();
    const res = await call(null, "POST", "/auth/login", { email: state.settings.adminEmail, password: state.settings.adminPassword });
    if (res.user.role !== "admin") throw new Error("That account is not an admin");
    state.admin = { id: "admin", role: "admin", name: "admin", tokens: res.tokens }; toast("Admin logged in", "success");
  }),
  "admin-job": (el) => attempt(async () => { await call(state.admin, "POST", `/admin/housekeeping/${el.dataset.job}/run`); toast(`Queued ${el.dataset.job}; see Recent runs`, "success"); }),
  "admin-queues": () => attempt(async () => { adminOut = JSON.stringify(await call(state.admin, "GET", "/admin/queues")); }),
  "admin-runs": () => attempt(async () => { adminOut = (await call(state.admin, "GET", "/admin/housekeeping/runs?limit=8")).runs.map((r) => `${r.job} → ${r.affected} affected${r.error ? " ERR " + r.error : ""}`).join("\n"); }),
  "reset-all": () => { if (confirm("Forget all simulated users and settings on this device?")) resetAll(); },
};

function loginPrompt(role) {
  const email = prompt(`Existing ${role} email:`); if (!email) return;
  const password = prompt("Password:"); if (!password) return;
  attempt(async () => { await A.loginActor({ role, email, password }); toast("Logged in", "success"); });
}

const changes = {
  "select-rider": (el) => A.select("rider", el.value),
  "select-driver": (el) => A.select("driver", el.value),
  "preset-pickup": (el) => { if (el.value === "") return; const p = PRESETS[+el.value]; setTrip("pickup", p.lat, p.lng); const d = destination(p.lat, p.lng, 35, 5); setTrip("dropoff", d.lat, d.lng); emit("fly", p); render(true); },
  behavior: (el) => { const a = A.selected("driver"); a.offerBehavior = el.value; save(); },
  delay: (el) => { const a = A.selected("driver"); a.acceptDelay = Math.max(0, Number(el.value) || 0); save(); },
  heartbeat: (el) => { A.selected("driver").heartbeat = el.checked; save(); },
  autopilot: (el) => { A.selected("driver").autopilot = el.checked; save(); },
  vehicle: (el) => attempt(() => A.setVehicleType(A.selected("driver"), el.value)),
  fresh: (el) => { state.settings.freshArea = el.checked; save(); },
  hidepoll: (el) => { hidePolling = el.checked; render(true); },
  tiles: (el) => { state.settings.tiles = el.value; save(); emit("tiles"); },
  radius: (el) => { state.settings.radiusKm = Number(el.value) || 5; save(); emit("trip"); },
  speed: (el) => { state.settings.speed = Number(el.value); $("#speed-v").textContent = el.value; save(); },
};

export function initUI() {
  const p = panel();
  p.addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]"); if (!el || el.disabled) return;
    actions[el.dataset.act]?.(el);
  });
  p.addEventListener("change", (e) => {
    const el = e.target.closest("[data-chg]"); if (!el) return;
    changes[el.dataset.chg]?.(el);
  });
  p.addEventListener("focusout", () => setTimeout(() => render(), 50));
  for (const ev of ["actors", "ride", "trip", "scenario", "log", "drivers"]) on(ev, () => render());
  setInterval(tickCountdowns, 1000);
  setTab("rider");
}
