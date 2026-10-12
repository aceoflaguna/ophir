/* Service worker: precaches the app shell so the client installs and opens offline.
   API calls (/api/*) and map tiles are never cached; the OSM layer needs a network, the "Offline grid" layer does not. */
const VERSION = "v2";
const CACHE = `ride-sim-${VERSION}`;
const SHELL = [
  "./", "index.html", "manifest.webmanifest",
  "css/app.css", "js/theme.js", "js/main.js", "js/state.js", "js/api.js", "js/geo.js", "js/map.js",
  "js/actors.js", "js/scenarios.js", "js/ui.js", "js/util.js",
  "vendor/bootstrap/bootstrap.min.css", "vendor/bootstrap/bootstrap.bundle.min.js",
  "vendor/leaflet/leaflet.css", "vendor/leaflet/leaflet.js",
  "vendor/leaflet/images/marker-icon.png", "vendor/leaflet/images/marker-shadow.png", "vendor/leaflet/images/layers.png",
  "icons/favicon.svg", "icons/icon-192.png", "icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("ride-sim-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return; // tiles, other origins: browser default
  if (url.pathname.startsWith("/api/") || !url.pathname.startsWith(new URL("./", self.location).pathname)) return;

  // Stale-while-revalidate for the shell: instant loads, picks up updates on the next visit.
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req).then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => null);
      return cached || (await network) || (req.mode === "navigate" ? cache.match("index.html") : Response.error());
    }),
  );
});
