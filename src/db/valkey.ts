import { Redis, type RedisOptions } from "ioredis";
import { env } from "../config/env.ts";
import { logger } from "../lib/logger.ts";

/** Shared general-purpose client (rate limits, geo index, token denylist). */
export const valkey = new Redis(env.VALKEY_URL, { maxRetriesPerRequest: 3, lazyConnect: false });
valkey.on("error", (err) => logger.error({ err }, "valkey error"));

/** BullMQ needs dedicated connections with maxRetriesPerRequest = null. */
export function createBullConnection(opts: RedisOptions = {}) {
  const conn = new Redis(env.VALKEY_URL, { maxRetriesPerRequest: null, ...opts });
  conn.on("error", (err) => logger.error({ err }, "valkey (bullmq) error"));
  return conn;
}
