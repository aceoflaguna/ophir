const KEY = "ride-sim-v1";

const defaults = () => ({
  settings: { apiBase: "", tiles: "osm", speed: 400, radiusKm: 5, freshArea: true, adminEmail: "admin@example.com", adminPassword: "Admin12345" },
  actors: [],
  selected: { rider: null, driver: null },
  trip: { pickup: { lat: 14.5547, lng: 121.0244 }, dropoff: { lat: 14.5995, lng: 121.0369 } },
  tapMode: "pickup",
  admin: null,
});

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    if (saved) {
      const d = defaults();
      return { ...d, ...saved, settings: { ...d.settings, ...saved.settings }, trip: { ...d.trip, ...saved.trip } };
    }
  } catch { /* ignore corrupt storage */ }
  return defaults();
}

export const state = load();

let saveTimer;
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* quota / private mode */ }
  }, 150);
}
export function resetAll() {
  try { localStorage.removeItem(KEY); } catch { /* */ }
  location.reload();
}

// tiny pub/sub
const bus = new EventTarget();
export const on = (name, fn) => bus.addEventListener(name, (e) => fn(e.detail));
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));

// per-actor runtime (never persisted): live ride, offers, timers, flags
const runtimes = new Map();
export const rt = (actor) => {
  let r = runtimes.get(actor.id);
  if (!r) runtimes.set(actor.id, (r = { ride: null, offers: [], handled: new Set(), polling: false, drive: null, auto: false, checkedActive: false, rated: false }));
  return r;
};
export const dropRt = (actor) => runtimes.delete(actor.id);

// API call log (memory only)
export const apiLog = [];
export function addLog(entry) {
  apiLog.unshift(entry);
  if (apiLog.length > 400) apiLog.pop();
  emit("log");
}
