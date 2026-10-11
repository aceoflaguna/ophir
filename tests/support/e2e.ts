import { expect } from "@jest/globals";
import request from "supertest";
import { createApp } from "../../src/app.ts";
import { pool, query } from "../../src/db/pool.ts";
import { valkey } from "../../src/db/valkey.ts";
import { closeQueues } from "../../src/queues/index.ts";
import { startWorkers } from "../../src/workers/index.ts";

export const app = createApp();

type Method = "get" | "post" | "put" | "patch" | "delete";
export async function api(method: Method, path: string, opts: { token?: string; body?: object } = {}) {
  let req = request(app)[method](`/api/v1${path}`);
  if (opts.token) req = req.set("Authorization", `Bearer ${opts.token}`);
  if (opts.body) req = req.send(opts.body);
  const res = await req;
  return { status: res.status, body: res.body as any, headers: res.headers };
}

/** Polls until `fn` returns a truthy value (e.g. waiting for the BullMQ worker to create an offer). */
export async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out waiting for condition");
}

let n = 0;
export async function signup(role: "rider" | "driver" = "rider") {
  const email = `${role}${++n}-${Date.now()}@test.dev`;
  const r = await api("post", "/auth/register", { body: { email, password: "Passw0rdX", fullName: `Test ${role} ${n}`, role } });
  expect(r.status).toBe(201);
  return { email, id: r.body.user.id as string, token: r.body.tokens.accessToken as string, refresh: r.body.tokens.refreshToken as string };
}

export async function makeDriver(lat: number, lng: number, vehicleType = "economy") {
  const d = await signup("driver");
  const p = await api("put", "/drivers/me/profile", {
    token: d.token,
    body: { licenseNumber: `LIC${n}999`, vehicleMake: "Toyota", vehicleModel: "Vios", vehicleColor: "white", plateNumber: `ABC${n}${Date.now() % 1000}`, vehicleType },
  });
  expect(p.status).toBe(200);
  expect((await api("post", "/drivers/me/online", { token: d.token, body: { lat, lng } })).status).toBe(200);
  return d;
}

export const offline = (d: { token: string }) => api("post", "/drivers/me/offline", { token: d.token });
export const pendingOffer = (d: { token: string }) => async () => (await api("get", "/drivers/me/offers", { token: d.token })).body.offers[0];

export const PICKUP = { lat: 14.5547, lng: 121.0244, address: "Makati" };
export const DROPOFF = { lat: 14.5995, lng: 121.0369, address: "Ortigas" };

/** Clean state + start the real BullMQ worker. Call in beforeAll; await the returned function in afterAll. */
export async function startE2E() {
  await valkey.flushdb();
  await query("TRUNCATE users CASCADE");
  const workers = await startWorkers({ schedule: false });
  return async () => {
    await workers.close();
    await closeQueues();
    await valkey.quit().catch(() => {});
    await pool.end().catch(() => {});
  };
}

export { query, valkey };
