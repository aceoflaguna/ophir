const R = 6371;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export function haversineKm(aLat, aLng, bLat, bLng) {
  const dLat = rad(bLat - aLat), dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function bearingDeg(aLat, aLng, bLat, bLng) {
  const y = Math.sin(rad(bLng - aLng)) * Math.cos(rad(bLat));
  const x = Math.cos(rad(aLat)) * Math.sin(rad(bLat)) - Math.sin(rad(aLat)) * Math.cos(rad(bLat)) * Math.cos(rad(bLng - aLng));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Point `km` away from (lat,lng) along `bearing` degrees (0 = north, 90 = east). */
export function destination(lat, lng, bearing, km) {
  const d = km / R, b = rad(bearing), la1 = rad(lat), lo1 = rad(lng);
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
  const lo2 = lo1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return { lat: +deg(la2).toFixed(6), lng: +(((deg(lo2) + 540) % 360) - 180).toFixed(6) };
}

export function stepToward(lat, lng, toLat, toLng, km) {
  return destination(lat, lng, bearingDeg(lat, lng, toLat, toLng), km);
}

export const PRESETS = [
  { name: "Makati, Manila", lat: 14.5547, lng: 121.0244 },
  { name: "Intramuros, Manila", lat: 14.5896, lng: 120.9747 },
  { name: "Cebu City", lat: 10.3157, lng: 123.8854 },
  { name: "Davao City", lat: 7.1907, lng: 125.4553 },
  { name: "Singapore", lat: 1.3521, lng: 103.8198 },
  { name: "Tokyo (Shibuya)", lat: 35.6595, lng: 139.7005 },
  { name: "Sydney", lat: -33.8688, lng: 151.2093 },
  { name: "London", lat: 51.5074, lng: -0.1278 },
  { name: "New York (Times Sq)", lat: 40.758, lng: -73.9855 },
  { name: "San Francisco", lat: 37.7749, lng: -122.4194 },
  { name: "Null Island (0, 0)", lat: 0, lng: 0 },
];
