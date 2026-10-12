import * as A from "./actors.js";
import { ping } from "./api.js";
import * as M from "./map.js";
import { emit, on, rt, save, state } from "./state.js";
import { $, $$, num, toast } from "./util.js";
import { initUI, setTab } from "./ui.js";

M.initMap($("#map"));
M.syncTrip();
const syncDrivers = () => M.syncDrivers(state.actors, state.selected.driver);
syncDrivers();

/* -------- map interactions: tap sets pickup / drop-off / selected driver's location */
const coordsEl = $("#clock-coords");
const showCoords = (lat, lng) => { coordsEl.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`; };

M.onMap("tap", async (lat, lng) => {
  showCoords(lat, lng);
  try {
    if (state.tapMode === "pickup") { state.trip.pickup = { lat, lng }; save(); emit("trip"); }
    else if (state.tapMode === "dropoff") { state.trip.dropoff = { lat, lng }; save(); emit("trip"); }
    else {
      const d = A.selected("driver");
      if (!d) return toast("Create a driver first (Driver tab)", "warning");
      await A.setDriverLocation(d, lat, lng);
    }
  } catch (e) { toast(e.message, "danger"); }
});
M.onMap("pickupDrag", (lat, lng) => { state.trip.pickup = { lat, lng }; showCoords(lat, lng); save(); emit("trip"); });
M.onMap("dropDrag", (lat, lng) => { state.trip.dropoff = { lat, lng }; showCoords(lat, lng); save(); emit("trip"); });
M.onMap("driverDrag", async (id, lat, lng) => {
  const d = A.byId(id); if (!d) return;
  A.select("driver", id); showCoords(lat, lng);
  try { await A.setDriverLocation(d, lat, lng); } catch (e) { toast(e.message, "danger"); }
});
M.onMap("driverClick", (id) => { A.select("driver", id); setTab("driver"); });

on("trip", () => { M.syncTrip(); });
on("drivers", syncDrivers);
on("actors", syncDrivers);
on("ride", (id) => {
  syncDrivers();
  const a = A.byId(id);
  if (a?.role === "rider") M.setServerDriver(rt(a).ride?.driver?.location ?? null);
});
on("fly", (p) => M.flyTo(p.lat, p.lng, 13));
on("tiles", () => M.setTiles(state.settings.tiles));

/* -------- controls */
$$('input[name="tap"]').forEach((r) => { r.checked = r.value === state.tapMode; r.addEventListener("change", () => { state.tapMode = r.value; save(); }); });
$("#btn-layer").addEventListener("click", () => { state.settings.tiles = state.settings.tiles === "osm" ? "grid" : "osm"; save(); M.setTiles(state.settings.tiles); toast(state.settings.tiles === "osm" ? "OpenStreetMap" : "Offline grid map", "dark", 1500); });
$("#btn-fit").addEventListener("click", () => M.fitAll(state.actors));
$("#btn-gps").addEventListener("click", () => {
  if (!navigator.geolocation) return toast("Geolocation not available", "warning");
  navigator.geolocation.getCurrentPosition(
    (pos) => { const lat = num(pos.coords.latitude, 6), lng = num(pos.coords.longitude, 6); state.trip.pickup = { lat, lng }; save(); emit("trip"); M.flyTo(lat, lng, 15); toast("Pickup set to your real GPS position", "success"); },
    (err) => toast(`GPS: ${err.message}`, "warning"), { enableHighAccuracy: true, timeout: 8000 },
  );
});

/* -------- bottom sheet + nav */
const sheet = $("#sheet");
const STATES = ["peek", "half", "full"];
$("#sheet-handle").addEventListener("click", () => { sheet.dataset.state = STATES[(STATES.indexOf(sheet.dataset.state) + 1) % 3]; M.invalidate(); });
$$("#nav button").forEach((b) => b.addEventListener("click", () => {
  if (sheet.dataset.state === "peek") sheet.dataset.state = "half";
  setTab(b.dataset.tab);
}));
initUI();

/* -------- connection indicator */
async function checkConn() {
  const r = await ping();
  $("#conn").className = `conn-dot ${r.status === 200 ? "ok" : "bad"}`;
  $("#conn-text").textContent = r.status === 200 ? "API ready" : r.status === 0 ? "API unreachable" : `API ${r.status}`;
}
checkConn(); setInterval(checkConn, 10000);

/* -------- PWA: service worker + install prompt */
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
  navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW registration failed", e));
}
let deferredPrompt;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferredPrompt = e; $("#btn-install").classList.remove("d-none"); });
$("#btn-install").addEventListener("click", async () => { if (!deferredPrompt) return; deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; $("#btn-install").classList.add("d-none"); });
window.addEventListener("appinstalled", () => $("#btn-install").classList.add("d-none"));

/* -------- go */
A.startLoops();
state.actors.forEach((a) => { if (a.role === "driver" && a.status !== "offline") A.refreshDriver(a).catch(() => {}); });
window.sim = { state, A, M, rt }; // handy in the browser console / automated tests
