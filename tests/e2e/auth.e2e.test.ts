import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { api, query, signup, startE2E } from "../support/e2e.ts";

let stop: () => Promise<void>;
beforeAll(async () => { stop = await startE2E(); });
afterAll(async () => { await stop(); });

describe("health", () => {
  test("liveness and readiness", async () => {
    const request = (await import("supertest")).default;
    const { app } = await import("../support/e2e.ts");
    expect((await request(app).get("/health")).body).toEqual({ status: "ok" });
    const ready = await request(app).get("/ready");
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({ postgres: true, valkey: true });
  });
  test("unknown route -> 404 JSON", async () => {
    const r = await api("get", "/nope");
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("NOT_FOUND");
  });
});

describe("register", () => {
  test("validation errors list each field", async () => {
    const r = await api("post", "/auth/register", { body: { email: "x", password: "short", fullName: "A" } });
    expect(r.status).toBe(400);
    expect([...new Set(r.body.error.details.map((d: any) => d.path))].sort()).toEqual(["email", "fullName", "password"]);
  });

  test("returns user + tokens and never leaks the password hash", async () => {
    const u = await signup("rider");
    const me = await api("get", "/users/me", { token: u.token });
    expect(me.body.user).toMatchObject({ email: u.email, role: "rider", rating: { average: 5, count: 0 } });
    expect(JSON.stringify(me.body)).not.toMatch(/password/i);
  });

  test("stores only a hash of the refresh token", async () => {
    const u = await signup("rider");
    const rows = await query("SELECT token_hash FROM refresh_tokens WHERE user_id=$1", [u.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).not.toBe(u.refresh);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("duplicate email (case-insensitive) -> 409 EMAIL_TAKEN", async () => {
    const u = await signup("rider");
    const dup = await api("post", "/auth/register", { body: { email: u.email.toUpperCase(), password: "Passw0rdX", fullName: "Dup" } });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("EMAIL_TAKEN");
  });

  test("cannot self-register as admin", async () => {
    const r = await api("post", "/auth/register", { body: { email: `a${Date.now()}@t.dev`, password: "Passw0rdX", fullName: "Evil Admin", role: "admin" } });
    expect(r.status).toBe(400);
  });
});

describe("login", () => {
  test("success, wrong password and unknown email give the same error", async () => {
    const u = await signup("rider");
    const ok = await api("post", "/auth/login", { body: { email: u.email, password: "Passw0rdX" } });
    expect(ok.status).toBe(200);
    const bad = await api("post", "/auth/login", { body: { email: u.email, password: "nope" } });
    const unknown = await api("post", "/auth/login", { body: { email: "ghost@test.dev", password: "Passw0rdX" } });
    expect(bad.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(bad.body).toEqual(unknown.body);
  });

  test("disabled accounts cannot log in", async () => {
    const u = await signup("rider");
    await query("UPDATE users SET is_active=false WHERE id=$1", [u.id]);
    const r = await api("post", "/auth/login", { body: { email: u.email, password: "Passw0rdX" } });
    expect(r.body.error.code).toBe("ACCOUNT_DISABLED");
  });
});

describe("access token handling", () => {
  test("missing / garbage tokens are rejected", async () => {
    expect((await api("get", "/users/me")).status).toBe(401);
    expect((await api("get", "/users/me", { token: "garbage" })).body.error.code).toBe("INVALID_TOKEN");
  });
  test("PATCH /users/me updates profile and rejects empty body", async () => {
    const u = await signup("rider");
    const r = await api("patch", "/users/me", { token: u.token, body: { fullName: "New Name", phone: "+639171234567" } });
    expect(r.body.user).toMatchObject({ fullName: "New Name", phone: "+639171234567" });
    expect((await api("patch", "/users/me", { token: u.token, body: {} })).status).toBe(400);
  });
  test("role guards: rider cannot use driver or admin endpoints", async () => {
    const u = await signup("rider");
    expect((await api("post", "/drivers/me/online", { token: u.token, body: { lat: 1, lng: 1 } })).status).toBe(403);
    expect((await api("get", "/admin/queues", { token: u.token })).status).toBe(403);
  });
});

describe("refresh token rotation", () => {
  test("refresh returns a new pair and the old token is single-use", async () => {
    const u = await signup("rider");
    const r1 = await api("post", "/auth/refresh", { body: { refreshToken: u.refresh } });
    expect(r1.status).toBe(200);
    expect(r1.body.tokens.refreshToken).not.toBe(u.refresh);
    expect((await api("get", "/users/me", { token: r1.body.tokens.accessToken })).status).toBe(200);
  });

  test("reuse of a rotated token revokes the entire session family", async () => {
    const u = await signup("rider");
    const r1 = await api("post", "/auth/refresh", { body: { refreshToken: u.refresh } });
    const reuse = await api("post", "/auth/refresh", { body: { refreshToken: u.refresh } });
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe("REFRESH_TOKEN_REUSED");
    // legit newest token and its access token are dead too
    expect((await api("post", "/auth/refresh", { body: { refreshToken: r1.body.tokens.refreshToken } })).status).toBe(401);
    expect((await api("get", "/users/me", { token: r1.body.tokens.accessToken })).body.error.code).toBe("SESSION_REVOKED");
  });

  test("reuse only burns that family, other sessions survive", async () => {
    const u = await signup("rider");
    const other = await api("post", "/auth/login", { body: { email: u.email, password: "Passw0rdX" } });
    await api("post", "/auth/refresh", { body: { refreshToken: u.refresh } });
    await api("post", "/auth/refresh", { body: { refreshToken: u.refresh } }); // replay
    expect((await api("get", "/users/me", { token: other.body.tokens.accessToken })).status).toBe(200);
  });

  test("unknown and expired refresh tokens", async () => {
    const bogus = await api("post", "/auth/refresh", { body: { refreshToken: "x".repeat(64) } });
    expect(bogus.body.error.code).toBe("INVALID_REFRESH_TOKEN");
    const u = await signup("rider");
    await query("UPDATE refresh_tokens SET expires_at = now() - interval '1 minute' WHERE user_id=$1", [u.id]);
    expect((await api("post", "/auth/refresh", { body: { refreshToken: u.refresh } })).body.error.code).toBe("REFRESH_TOKEN_EXPIRED");
  });

  test("deactivated user cannot refresh", async () => {
    const u = await signup("rider");
    await query("UPDATE users SET is_active=false WHERE id=$1", [u.id]);
    expect((await api("post", "/auth/refresh", { body: { refreshToken: u.refresh } })).body.error.code).toBe("ACCOUNT_DISABLED");
  });

  test("concurrent refresh with the same token: exactly one wins", async () => {
    const u = await signup("rider");
    const results = await Promise.all([1, 2, 3].map(() => api("post", "/auth/refresh", { body: { refreshToken: u.refresh } })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });
});

describe("logout", () => {
  test("logout invalidates that session's access token immediately, others keep working", async () => {
    const u = await signup("rider");
    const second = await api("post", "/auth/login", { body: { email: u.email, password: "Passw0rdX" } });
    expect((await api("get", "/auth/sessions", { token: u.token })).body.sessions).toHaveLength(2);
    expect((await api("post", "/auth/logout", { token: u.token })).status).toBe(204);
    expect((await api("get", "/users/me", { token: u.token })).status).toBe(401);
    expect((await api("post", "/auth/refresh", { body: { refreshToken: u.refresh } })).status).toBe(401);
    expect((await api("get", "/users/me", { token: second.body.tokens.accessToken })).status).toBe(200);
  });

  test("logout via refresh token (access token already expired)", async () => {
    const u = await signup("rider");
    expect((await api("post", "/auth/logout/refresh-token", { body: { refreshToken: u.refresh } })).status).toBe(204);
    expect((await api("post", "/auth/refresh", { body: { refreshToken: u.refresh } })).status).toBe(401);
  });

  test("logout-all revokes every session", async () => {
    const u = await signup("rider");
    const second = await api("post", "/auth/login", { body: { email: u.email, password: "Passw0rdX" } });
    const all = await api("post", "/auth/logout-all", { token: second.body.tokens.accessToken });
    expect(all.body.revokedSessions).toBe(2);
    expect((await api("get", "/users/me", { token: u.token })).status).toBe(401);
    expect((await api("get", "/users/me", { token: second.body.tokens.accessToken })).status).toBe(401);
  });

  test("sessions list marks the current session", async () => {
    const u = await signup("rider");
    const s = (await api("get", "/auth/sessions", { token: u.token })).body.sessions;
    expect(s).toHaveLength(1);
    expect(s[0].current).toBe(true);
  });
});

describe("rate limiting", () => {
  test("auth endpoints return 429 with Retry-After beyond the limit", async () => {
    const { valkey } = await import("../support/e2e.ts");
    // Pre-fill this window's counter for the test client's IP instead of sending 10k requests.
    const window = Math.floor(Date.now() / 1000 / 60);
    for (const ip of ["::ffff:127.0.0.1", "127.0.0.1", "::1"]) await valkey.set(`rl:auth:${ip}:${window}`, "10000", "EX", 70);
    const r = await api("post", "/auth/login", { body: { email: "a@b.co", password: "x" } });
    expect(r.status).toBe(429);
    expect(r.headers["retry-after"]).toBe("60");
    await valkey.flushdb();
  });
});
