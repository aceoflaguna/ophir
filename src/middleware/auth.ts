import type { RequestHandler } from "express";
import { valkey } from "../db/valkey.ts";
import { forbidden, unauthorized } from "../lib/errors.ts";
import { verifyAccessToken, type Role } from "../lib/jwt.ts";

export const revokedSessionKey = (sid: string) => `auth:revoked-session:${sid}`;

/** Verifies the Bearer access token and that its session has not been logged out. */
export const authenticate: RequestHandler = async (req, _res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw unauthorized("Missing bearer token");
    const claims = verifyAccessToken(header.slice(7));
    if (await valkey.exists(revokedSessionKey(claims.sid))) throw unauthorized("Session revoked", "SESSION_REVOKED");
    req.auth = { userId: claims.sub, role: claims.role, sessionId: claims.sid };
    next();
  } catch (e) {
    next(e);
  }
};

export const requireRole =
  (...roles: Role[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.auth) return next(unauthorized());
    if (!roles.includes(req.auth.role)) return next(forbidden(`Requires role: ${roles.join(" or ")}`));
    next();
  };
