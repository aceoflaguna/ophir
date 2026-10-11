import type { RequestHandler } from "express";
import { valkey } from "../db/valkey.ts";
import { tooMany } from "../lib/errors.ts";

/**
 * Fixed-window rate limiter backed by Valkey (shared across API instances).
 * Fails open if Valkey is unreachable so an outage does not take the API down.
 */
export function rateLimit(opts: { name: string; windowSeconds: number; max: number; by?: "ip" | "user" }): RequestHandler {
  return async (req, res, next) => {
    try {
      const id = opts.by === "user" && req.auth ? req.auth.userId : (req.ip ?? "unknown");
      const window = Math.floor(Date.now() / 1000 / opts.windowSeconds);
      const key = `rl:${opts.name}:${id}:${window}`;
      const count = await valkey.incr(key);
      if (count === 1) await valkey.expire(key, opts.windowSeconds + 1);
      res.setHeader("X-RateLimit-Limit", opts.max);
      res.setHeader("X-RateLimit-Remaining", Math.max(0, opts.max - count));
      if (count > opts.max) {
        res.setHeader("Retry-After", opts.windowSeconds);
        return next(tooMany());
      }
      next();
    } catch {
      next();
    }
  };
}
