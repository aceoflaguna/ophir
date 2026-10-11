import jwt from "jsonwebtoken";
import { env } from "../config/env.ts";
import { unauthorized } from "./errors.ts";

export type Role = "rider" | "driver" | "admin";

export interface AccessClaims {
  sub: string; // user id
  role: Role;
  sid: string; // session (refresh token family) id -> lets us revoke access tokens on logout
}

export function signAccessToken(claims: { userId: string; role: Role; sessionId: string }): string {
  return jwt.sign({ role: claims.role, sid: claims.sessionId }, env.JWT_ACCESS_SECRET, {
    algorithm: "HS256",
    subject: claims.userId,
    issuer: env.JWT_ISSUER,
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
  });
}

export function verifyAccessToken(token: string): AccessClaims {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      algorithms: ["HS256"],
      issuer: env.JWT_ISSUER,
    }) as jwt.JwtPayload;
    if (!payload.sub || !payload.role || !payload.sid) throw new Error("malformed claims");
    return { sub: payload.sub, role: payload.role as Role, sid: payload.sid as string };
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) throw unauthorized("Access token expired", "TOKEN_EXPIRED");
    throw unauthorized("Invalid access token", "INVALID_TOKEN");
  }
}
