import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";

// Replace the Valkey client so middleware can be tested without a server.
jest.mock("../../src/db/valkey.ts", () => ({
  valkey: { exists: jest.fn(), incr: jest.fn(), expire: jest.fn() },
  createBullConnection: jest.fn(),
}));

// NOTE: required (not imported) so they load *after* jest.mock above regardless of import hoisting.
/* eslint-disable @typescript-eslint/no-require-imports */
const valkey = require("../../src/db/valkey.ts").valkey as {
  exists: jest.Mock<(k: string) => Promise<number>>;
  incr: jest.Mock<(k: string) => Promise<number>>;
  expire: jest.Mock<(...a: any[]) => Promise<number>>;
};
const { badRequest } = require("../../src/lib/errors.ts") as typeof import("../../src/lib/errors.ts");
const { signAccessToken } = require("../../src/lib/jwt.ts") as typeof import("../../src/lib/jwt.ts");
const { authenticate, requireRole } = require("../../src/middleware/auth.ts") as typeof import("../../src/middleware/auth.ts");
const { errorHandler, notFoundHandler } = require("../../src/middleware/error.ts") as typeof import("../../src/middleware/error.ts");
const { rateLimit } = require("../../src/middleware/rate-limit.ts") as typeof import("../../src/middleware/rate-limit.ts");
const { validate } = require("../../src/middleware/validate.ts") as typeof import("../../src/middleware/validate.ts");
import type { AppError } from "../../src/lib/errors.ts";

const run = async (mw: (req: Request, res: Response, next: NextFunction) => unknown, req: Partial<Request>, res: Partial<Response> = {}) => {
  const next = jest.fn();
  await mw(req as Request, res as Response, next as unknown as NextFunction);
  return next;
};
const mockRes = () => {
  const res: any = { headers: {} as Record<string, unknown> };
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.setHeader = jest.fn((k: string, v: unknown) => { res.headers[k] = v; });
  return res;
};
const token = signAccessToken({ userId: "u1", role: "rider", sessionId: "s1" });

beforeEach(() => { valkey.exists.mockResolvedValue(0); });

describe("authenticate", () => {
  test("accepts a valid bearer token and sets req.auth", async () => {
    const req: any = { headers: { authorization: `Bearer ${token}` } };
    const next = await run(authenticate, req);
    expect(next).toHaveBeenCalledWith();
    expect(req.auth).toEqual({ userId: "u1", role: "rider", sessionId: "s1" });
    expect(valkey.exists).toHaveBeenCalledWith("auth:revoked-session:s1");
  });

  test("missing/non-bearer header -> 401", async () => {
    for (const headers of [{}, { authorization: "Basic abc" }]) {
      const next = await run(authenticate, { headers } as any);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
    }
  });

  test("revoked session -> SESSION_REVOKED", async () => {
    valkey.exists.mockResolvedValue(1);
    const next = await run(authenticate, { headers: { authorization: `Bearer ${token}` } } as any);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: "SESSION_REVOKED" }));
  });
});

describe("requireRole", () => {
  test("allows listed roles, forbids others, 401 when unauthenticated", async () => {
    expect(await run(requireRole("driver", "admin"), { auth: { role: "driver" } } as any)).toHaveBeenCalledWith();
    expect(await run(requireRole("driver"), { auth: { role: "rider" } } as any)).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(await run(requireRole("driver"), {} as any)).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
  });
});

describe("validate", () => {
  const schema = z.object({ n: z.coerce.number().int().min(1).default(5), name: z.string().trim() });

  test("replaces the source with parsed, coerced, stripped data", async () => {
    const req: any = { body: { n: "3", name: "  bob ", extra: true } };
    const next = await run(validate(schema), req);
    expect(next).toHaveBeenCalledWith();
    expect(req.body).toEqual({ n: 3, name: "bob" });
  });

  test("validates query and params too", async () => {
    const req: any = { query: { name: "x" } };
    await run(validate(schema, "query"), req);
    expect(req.query).toEqual({ n: 5, name: "x" });
  });

  test("invalid input -> 400 with per-field details", async () => {
    const next = await run(validate(schema), { body: { n: 0 } } as any);
    const err = (next.mock.calls[0] as unknown[])[0] as AppError;
    expect(err.status).toBe(400);
    expect(err.details).toEqual(expect.arrayContaining([expect.objectContaining({ path: "n" }), expect.objectContaining({ path: "name" })]));
  });
});

describe("rateLimit", () => {
  const limiter = rateLimit({ name: "t", windowSeconds: 60, max: 2 });

  test("sets the TTL on the first hit and reports remaining quota", async () => {
    valkey.incr.mockResolvedValue(1);
    const res = mockRes();
    const next = await run(limiter, { ip: "1.2.3.4" } as any, res);
    expect(valkey.expire).toHaveBeenCalledTimes(1);
    expect(res.headers["X-RateLimit-Remaining"]).toBe(1);
    expect(next).toHaveBeenCalledWith();
  });

  test("blocks over the limit with 429 + Retry-After", async () => {
    valkey.incr.mockResolvedValue(3);
    const res = mockRes();
    const next = await run(limiter, { ip: "1.2.3.4" } as any, res);
    expect(res.headers["Retry-After"]).toBe(60);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 429, code: "RATE_LIMITED" }));
  });

  test("keys by user id when configured and authenticated", async () => {
    valkey.incr.mockResolvedValue(1);
    await run(rateLimit({ name: "u", windowSeconds: 10, max: 5, by: "user" }), { ip: "9.9.9.9", auth: { userId: "abc" } } as any, mockRes());
    expect(valkey.incr.mock.calls[0]![0]).toContain(":abc:");
  });

  test("fails open when Valkey errors", async () => {
    valkey.incr.mockRejectedValue(new Error("down"));
    const next = await run(limiter, { ip: "1.1.1.1" } as any, mockRes());
    expect(next).toHaveBeenCalledWith();
  });
});

describe("error handling", () => {
  const req: any = { path: "/x", method: "GET" };

  test("AppError -> its status and code, details included", () => {
    const res = mockRes();
    errorHandler(badRequest("nope", [{ path: "a" }]), req, res, jest.fn() as any);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: { code: "BAD_REQUEST", message: "nope", details: [{ path: "a" }] } });
  });

  test("malformed JSON -> 400 BAD_JSON", () => {
    const res = mockRes();
    errorHandler({ type: "entity.parse.failed" }, req, res, jest.fn() as any);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: { code: "BAD_JSON", message: "Malformed JSON body" } });
  });

  test("unknown errors -> generic 500 without leaking the message", () => {
    const res = mockRes();
    errorHandler(new Error("secret db password"), req, res, jest.fn() as any);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify((res.json as jest.Mock).mock.calls[0])).not.toContain("secret");
  });

  test("404 handler", () => {
    const res = mockRes();
    notFoundHandler({ method: "GET", path: "/nope" } as any, res, jest.fn() as any);
    expect(res.status).toHaveBeenCalledWith(404);
  });
});
