import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { runHousekeeping } from "../../src/modules/housekeeping/housekeeping.service.ts";
import { api, DROPOFF, makeDriver, pendingOffer, PICKUP, query, signup, startE2E, until, valkey } from "../support/e2e.ts";

let stop: () => Promise<void>;
beforeAll(async () => { stop = await startE2E(); });
afterAll(async () => { await stop(); });

describe("purge-refresh-tokens", () => {
  test("removes long-expired and long-revoked tokens but keeps recent ones", async () => {
    const u = await signup("rider"); // 1 live token
    const ins = (hash: string, exp: string, rev: string | null) =>
      query(`INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, revoked_at) VALUES ($1, gen_random_uuid(), $2, ${exp}, ${rev})`, [u.id, hash]);
    await ins("expired-old", "now() - interval '3 days'", "NULL");
    await ins("revoked-old", "now() + interval '3 days'", "now() - interval '10 days'");
    await ins("revoked-recent", "now() + interval '3 days'", "now() - interval '1 hour'"); // kept: needed for reuse detection
    await ins("expired-recent", "now() - interval '1 hour'", "NULL");                       // kept: < 1 day
    expect(await runHousekeeping("purge-refresh-tokens")).toBe(2);
    const left = (await query("SELECT token_hash FROM refresh_tokens WHERE user_id=$1", [u.id])).map((r) => r.token_hash);
    expect(left).toEqual(expect.arrayContaining(["revoked-recent", "expired-recent"]));
    expect(left).not.toEqual(expect.arrayContaining(["expired-old"]));
    expect(left).toHaveLength(3);
  });
});

describe("offline-stale-drivers", () => {
  test("silent drivers go offline and leave the geo index; fresh ones stay", async () => {
    const stale = await makeDriver(14.5, 121.0);
    const fresh = await makeDriver(14.5, 121.01);
    await valkey.zadd("drivers:last-seen", Math.floor(Date.now() / 1000) - 3600, stale.id);
    expect(await runHousekeeping("offline-stale-drivers")).toBe(1);
    expect((await api("get", "/drivers/me", { token: stale.token })).body.driver.status).toBe("offline");
    expect(await valkey.zscore("geo:drivers:economy", stale.id)).toBeNull();
    expect((await api("get", "/drivers/me", { token: fresh.token })).body.driver.status).toBe("online");
    expect(await valkey.zscore("geo:drivers:economy", fresh.id)).not.toBeNull();
  });

  test("reconciles drivers online in Postgres with no heartbeat at all (Valkey flushed)", async () => {
    const d = await makeDriver(14.5, 121.0);
    await valkey.flushdb();
    await query("UPDATE drivers SET last_seen_at = now() - interval '1 hour' WHERE user_id=$1", [d.id]);
    expect(await runHousekeeping("offline-stale-drivers")).toBeGreaterThanOrEqual(1);
    expect((await query("SELECT status FROM drivers WHERE user_id=$1", [d.id]))[0].status).toBe("offline");
  });
});

describe("rides", () => {
  test("release-stuck-rides cancels abandoned rides and frees the driver", async () => {
    const d = await makeDriver(14.5548, 121.0245);
    const rider = await signup("rider");
    const req = await api("post", "/rides", { token: rider.token, body: { pickup: PICKUP, dropoff: DROPOFF } });
    const offer = await until(pendingOffer(d));
    await api("post", `/drivers/me/offers/${offer.offerId}/accept`, { token: d.token });
    expect(await runHousekeeping("release-stuck-rides")).toBe(0); // fresh ride untouched
    await query("UPDATE rides SET updated_at = now() - interval '10 hours' WHERE id=$1", [req.body.ride.id]);
    expect(await runHousekeeping("release-stuck-rides")).toBe(1);
    const ride = (await api("get", `/rides/${req.body.ride.id}`, { token: rider.token })).body.ride;
    expect(ride).toMatchObject({ status: "cancelled", cancellation: { by: "system" } });
    expect((await api("get", "/drivers/me", { token: d.token })).body.driver.status).toBe("online");
  });

  test("expire-stale-offers expires lost-timeout offers and re-matches", async () => {
    const a = await makeDriver(14.5548, 121.0245);
    const b = await makeDriver(14.56, 121.03);
    const rider = await signup("rider");
    const req = await api("post", "/rides", { token: rider.token, body: { pickup: PICKUP, dropoff: DROPOFF } });
    const offer = await until(pendingOffer(a));
    // simulate the delayed BullMQ timeout job being lost, offer long past its expiry
    const { cancelOfferTimeout } = await import("../../src/queues/index.ts");
    await cancelOfferTimeout(offer.offerId);
    await query("UPDATE ride_offers SET expires_at = now() - interval '1 minute' WHERE id=$1", [offer.offerId]);
    expect(await runHousekeeping("expire-stale-offers")).toBeGreaterThanOrEqual(1);
    expect((await until(pendingOffer(b))).ride.id).toBe(req.body.ride.id);
    await api("post", `/rides/${req.body.ride.id}/cancel`, { token: rider.token });
  });

  test("expire-stale-searches marks old searching rides as no_drivers", async () => {
    const rider = await signup("rider");
    const req = await api("post", "/rides", { token: rider.token, body: { pickup: { lat: 10, lng: 10 }, dropoff: { lat: 10.1, lng: 10.1 } } });
    await query("UPDATE rides SET requested_at = now() - interval '10 minutes' WHERE id=$1", [req.body.ride.id]);
    expect(await runHousekeeping("expire-stale-searches")).toBe(1);
    expect((await api("get", `/rides/${req.body.ride.id}`, { token: rider.token })).body.ride.status).toBe("no_drivers");
  });
});

describe("run log + admin endpoints", () => {
  test("purge-housekeeping-runs trims only runs older than 30 days", async () => {
    await query("INSERT INTO housekeeping_runs (job, started_at, finished_at) VALUES ('x', now() - interval '40 days', now())");
    expect(await runHousekeeping("purge-housekeeping-runs")).toBe(1);
  });

  test("every run is logged; admin can list runs, queue counts and trigger jobs", async () => {
    const u = await signup("rider");
    await query("UPDATE users SET role='admin' WHERE id=$1", [u.id]);
    const login = await api("post", "/auth/login", { body: { email: u.email, password: "Passw0rdX" } }); // new token carries the admin role
    const admin = login.body.tokens.accessToken as string;

    const runs = await api("get", "/admin/housekeeping/runs?job=release-stuck-rides", { token: admin });
    expect(runs.body.runs.length).toBeGreaterThan(0);
    expect(runs.body.runs[0]).toMatchObject({ job: "release-stuck-rides", error: null });
    expect(runs.body.runs[0].finishedAt).not.toBeNull();

    expect(Object.keys((await api("get", "/admin/queues", { token: admin })).body)).toEqual(["matching", "housekeeping"]);
    expect((await api("post", "/admin/housekeeping/nonexistent/run", { token: admin })).status).toBe(400);

    const before = (await query("SELECT count(*)::int AS c FROM housekeeping_runs WHERE job='purge-refresh-tokens'"))[0].c;
    const queued = await api("post", "/admin/housekeeping/purge-refresh-tokens/run", { token: admin });
    expect(queued.status).toBe(202);
    await until(async () => (await query("SELECT count(*)::int AS c FROM housekeeping_runs WHERE job='purge-refresh-tokens'"))[0].c > before);
  });

  test("admin deactivating a user revokes their refresh tokens", async () => {
    const admin = await signup("rider");
    await query("UPDATE users SET role='admin' WHERE id=$1", [admin.id]);
    const at = (await api("post", "/auth/login", { body: { email: admin.email, password: "Passw0rdX" } })).body.tokens.accessToken;
    const victim = await signup("rider");
    expect((await api("post", `/admin/users/${victim.id}/active`, { token: at, body: { active: false } })).status).toBe(204);
    expect((await api("post", "/auth/refresh", { body: { refreshToken: victim.refresh } })).status).toBe(401);
    expect((await api("post", "/auth/login", { body: { email: victim.email, password: "Passw0rdX" } })).body.error.code).toBe("ACCOUNT_DISABLED");
  });
});
