import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { runHousekeeping } from "../../src/modules/housekeeping/housekeeping.service.ts";
import { api, DROPOFF, makeDriver, pendingOffer, PICKUP, query, signup, startE2E, until } from "../support/e2e.ts";

let stop: () => Promise<void>;
beforeAll(async () => { stop = await startE2E(); });
afterAll(async () => { await stop(); });

describe("rider <-> driver chat", () => {
  let rider: any, driver: any, stranger: any, rideId: string;

  beforeAll(async () => {
    driver = await makeDriver(PICKUP.lat + 0.0001, PICKUP.lng + 0.0001);
    rider = await signup("rider");
    stranger = await signup("rider");
    rideId = (await api("post", "/rides", { token: rider.token, body: { pickup: PICKUP, dropoff: DROPOFF } })).body.ride.id;
  });

  const send = (who: any, body: unknown) => api("post", `/rides/${rideId}/messages`, { token: who.token, body: { body } });
  const poll = (who: any, after = 0) => api("get", `/rides/${rideId}/messages?after=${after}`, { token: who.token });

  test("closed while the ride is still searching", async () => {
    const r = await send(rider, "hello?");
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("CHAT_CLOSED");
    expect((await poll(rider)).status).toBe(409);
  });

  test("open once accepted: both parties exchange messages and poll with a cursor", async () => {
    const offer = await until(pendingOffer(driver));
    await api("post", `/drivers/me/offers/${offer.offerId}/accept`, { token: driver.token });

    const m1 = await send(driver, "  On my way, white Vios  ");
    expect(m1.status).toBe(201);
    expect(m1.body.message).toMatchObject({ senderRole: "driver", body: "On my way, white Vios", rideId, senderId: driver.id });
    const m2 = await send(rider, "I'm at the gate");
    expect(m2.body.message.senderRole).toBe("rider");

    const all = await poll(rider);
    expect(all.body.messages.map((m: any) => m.body)).toEqual(["On my way, white Vios", "I'm at the gate"]);
    const after = await poll(driver, m1.body.message.id);
    expect(after.body.messages.map((m: any) => m.id)).toEqual([m2.body.message.id]);
    expect((await poll(driver, m2.body.message.id)).body.messages).toEqual([]);
  });

  test("validation: empty / too long bodies are rejected", async () => {
    expect((await send(rider, "   ")).status).toBe(400);
    expect((await send(rider, "x".repeat(1001))).status).toBe(400);
  });

  test("outsiders cannot read or write (404, no existence leak)", async () => {
    expect((await send(stranger, "hi")).status).toBe(404);
    expect((await poll(stranger)).status).toBe(404);
  });

  test("closes again when the trip completes", async () => {
    await api("put", "/drivers/me/location", { token: driver.token, body: { lat: PICKUP.lat, lng: PICKUP.lng } });
    await api("post", `/rides/${rideId}/arrive`, { token: driver.token });
    expect((await send(driver, "here")).status).toBe(201); // arrived is still live
    await api("post", `/rides/${rideId}/start`, { token: driver.token });
    await api("post", `/rides/${rideId}/complete`, { token: driver.token, body: {} });
    expect((await send(rider, "thanks")).body.error.code).toBe("CHAT_CLOSED");
    expect((await poll(rider)).status).toBe(409);
  });

  test("housekeeping purges messages older than 7 days and keeps newer ones", async () => {
    const before = (await query("SELECT count(*)::int AS n FROM ride_messages"))[0].n;
    await query("UPDATE ride_messages SET created_at = now() - interval '8 days' WHERE id = (SELECT min(id) FROM ride_messages WHERE ride_id=$1)", [rideId]);
    await query("UPDATE ride_messages SET created_at = now() - interval '6 days' WHERE id = (SELECT max(id) FROM ride_messages WHERE ride_id=$1)", [rideId]);
    expect(await runHousekeeping("purge-ride-messages")).toBe(1);
    expect((await query("SELECT count(*)::int AS n FROM ride_messages"))[0].n).toBe(before - 1);
  });
});