import { state } from "./state.js";
import { esc } from "./util.js";

/* global L */
let map, tileLayer, pickupM, dropM, routeLine, radiusCircle, serverDriverM;
const driverMarkers = new Map();
const handlers = { tap: () => {}, pickupDrag: () => {}, dropDrag: () => {}, driverDrag: () => {}, driverClick: () => {} };
export const onMap = (name, fn) => { handlers[name] = fn; };

// "Mockup map": offline canvas grid with lat/lng labels. Works with no internet at all.
const GridLayer = L.GridLayer.extend({
  createTile(coords) {
    const tile = document.createElement("canvas");
    const size = this.getTileSize();
    tile.width = size.x; tile.height = size.y;
    const ctx = tile.getContext("2d");
    const dark = document.documentElement.getAttribute("data-bs-theme") === "dark";
    ctx.fillStyle = dark ? "#1f2937" : "#eef2f7"; ctx.fillRect(0, 0, size.x, size.y);
    ctx.strokeStyle = dark ? "#374151" : "#cbd5e1"; ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) { // 4x4 sub-grid
      const p = (i * size.x) / 4;
      ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size.y); ctx.moveTo(0, p); ctx.lineTo(size.x, p); ctx.stroke();
    }
    ctx.strokeStyle = dark ? "#6b7280" : "#94a3b8"; ctx.lineWidth = 2; ctx.strokeRect(0, 0, size.x, size.y);
    const nw = this._map.unproject(coords.scaleBy(size), coords.z);
    ctx.fillStyle = dark ? "#9ca3af" : "#475569"; ctx.font = "11px ui-monospace, monospace";
    ctx.fillText(`${nw.lat.toFixed(4)}, ${nw.lng.toFixed(4)}`, 6, 14);
    ctx.fillText(`z${coords.z}`, 6, size.y - 6);
    return tile;
  },
});

const OSM = () => L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
});

const icon = (html, size = [30, 30], anchor = [15, 15]) => L.divIcon({ html, className: "", iconSize: size, iconAnchor: anchor });

export function initMap(el) {
  const p = state.trip.pickup;
  map = L.map(el, { zoomControl: false, attributionControl: true, tap: true }).setView([p.lat, p.lng], 13);
  L.control.zoom({ position: "bottomleft" }).addTo(map);
  setTiles(state.settings.tiles);

  pickupM = L.marker([p.lat, p.lng], { draggable: true, icon: icon('<div class="mk">📍</div>', [30, 32], [15, 30]), zIndexOffset: 500, title: "Pickup (rider location) - drag me" }).addTo(map);
  const d = state.trip.dropoff;
  dropM = L.marker([d.lat, d.lng], { draggable: true, icon: icon('<div class="mk">🏁</div>', [30, 32], [8, 30]), zIndexOffset: 400, title: "Drop-off - drag me" }).addTo(map);
  routeLine = L.polyline([[p.lat, p.lng], [d.lat, d.lng]], { color: "#2563eb", weight: 3, dashArray: "6 8", opacity: 0.8 }).addTo(map);
  radiusCircle = L.circle([p.lat, p.lng], { radius: state.settings.radiusKm * 1000, color: "#16a34a", weight: 1, fillOpacity: 0.05, dashArray: "4 6", interactive: false }).addTo(map);
  serverDriverM = L.circleMarker([0, 0], { radius: 6, color: "#2563eb", weight: 2, fillColor: "#60a5fa", fillOpacity: 0.9, opacity: 0 }).addTo(map).bindTooltip("driver location as the server sees it");

  map.on("click", (e) => handlers.tap(+e.latlng.lat.toFixed(6), +e.latlng.lng.toFixed(6)));
  pickupM.on("dragend", () => { const ll = pickupM.getLatLng(); handlers.pickupDrag(+ll.lat.toFixed(6), +ll.lng.toFixed(6)); });
  dropM.on("dragend", () => { const ll = dropM.getLatLng(); handlers.dropDrag(+ll.lat.toFixed(6), +ll.lng.toFixed(6)); });
  setTimeout(() => { map.invalidateSize(); centreOn(p.lat, p.lng, 13); }, 80);
  window.addEventListener("resize", () => map.invalidateSize());
  return map;
}

export function setTiles(kind) {
  if (tileLayer) map.removeLayer(tileLayer);
  tileLayer = kind === "grid" ? new GridLayer({ maxZoom: 19 }) : OSM();
  tileLayer.addTo(map);
  tileLayer.bringToBack?.();
}

export function syncTrip() {
  const { pickup, dropoff } = state.trip;
  pickupM.setLatLng([pickup.lat, pickup.lng]);
  dropM.setLatLng([dropoff.lat, dropoff.lng]);
  routeLine.setLatLngs([[pickup.lat, pickup.lng], [dropoff.lat, dropoff.lng]]);
  radiusCircle.setLatLng([pickup.lat, pickup.lng]).setRadius(state.settings.radiusKm * 1000);
}

const driverSig = new Map();
export function syncDrivers(actors, selectedId) {
  const drivers = actors.filter((a) => a.role === "driver" && a.lat != null);
  const live = new Set(drivers.map((a) => a.id));
  for (const [id, m] of driverMarkers) if (!live.has(id)) { map.removeLayer(m); driverMarkers.delete(id); driverSig.delete(id); }
  drivers.forEach((a, i) => {
    const sig = `${a.status}|${a.id === selectedId}|${a.name}`;
    let m = driverMarkers.get(a.id);
    const html = `<div class="mk mk-driver ${a.id === selectedId ? "sel" : ""} ${a.status === "offline" ? "offline" : ""}"><span class="tag" style="background:${a.color}">${esc(a.name)}</span>🚗</div>`;
    if (!m) {
      m = L.marker([a.lat, a.lng], { draggable: true, icon: icon(html), zIndexOffset: 800 }).addTo(map);
      m.on("dragend", () => { const ll = m.getLatLng(); handlers.driverDrag(a.id, +ll.lat.toFixed(6), +ll.lng.toFixed(6)); });
      m.on("click", () => handlers.driverClick(a.id));
      driverMarkers.set(a.id, m);
      driverSig.set(a.id, sig);
    } else {
      if (driverSig.get(a.id) !== sig) { m.setIcon(icon(html)); driverSig.set(a.id, sig); }
      const ll = m.getLatLng();
      if (ll.lat !== a.lat || ll.lng !== a.lng) m.setLatLng([a.lat, a.lng]);
    }
  });
}

/** Blue dot: where the *server* believes the assigned driver is (from GET /rides/:id). */
export function setServerDriver(loc) {
  if (!loc) { serverDriverM.setStyle({ opacity: 0, fillOpacity: 0 }); return; }
  serverDriverM.setLatLng([loc.lat, loc.lng]).setStyle({ opacity: 1, fillOpacity: 0.9 });
}

// On phones the bottom sheet covers the lower part of the map; aim for the centre of the *visible* part.
const sheetPx = () => (window.innerWidth >= 992 ? 0 : document.getElementById("sheet")?.offsetHeight ?? 0);
function visibleCentre(lat, lng, zoom) {
  const dy = sheetPx() / 2;
  if (!dy) return [lat, lng];
  const ll = map.unproject(map.project([lat, lng], zoom).add([0, dy]), zoom);
  return [ll.lat, ll.lng];
}
export function flyTo(lat, lng, zoom) {
  const z = zoom ?? Math.max(map.getZoom(), 13);
  map.flyTo(visibleCentre(lat, lng, z), z, { duration: 0.8 });
}
export function centreOn(lat, lng, zoom = 13) { map.setView(visibleCentre(lat, lng, zoom), zoom, { animate: false }); }
export const panTo = (lat, lng) => map.panTo([lat, lng]);
export const invalidate = () => setTimeout(() => map && map.invalidateSize(), 250);

export function fitAll(actors) {
  const pts = [[state.trip.pickup.lat, state.trip.pickup.lng], [state.trip.dropoff.lat, state.trip.dropoff.lng]];
  for (const a of actors) if (a.role === "driver" && a.lat != null) pts.push([a.lat, a.lng]);
  map.fitBounds(L.latLngBounds(pts), { maxZoom: 16, animate: true, paddingTopLeft: [30, 60], paddingBottomRight: [30, sheetPx() + 30] });
}
