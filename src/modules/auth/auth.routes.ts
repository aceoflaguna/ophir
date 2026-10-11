import { Router } from "express";
import { z } from "zod";
import { env } from "../../config/env.ts";
import { ah } from "../../lib/async-handler.ts";
import { badRequest } from "../../lib/errors.ts";
import { authenticate } from "../../middleware/auth.ts";
import { rateLimit } from "../../middleware/rate-limit.ts";
import { validate } from "../../middleware/validate.ts";
import * as auth from "./auth.service.ts";

export const authRouter = Router();

const password = z
  .string()
  .min(8, "min 8 characters")
  .max(128)
  .refine((p) => /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p), "must contain upper, lower and a digit");

const registerSchema = z.object({
  email: z.string().email().max(254),
  password,
  fullName: z.string().trim().min(2).max(100),
  phone: z.string().regex(/^\+?[0-9]{7,15}$/, "invalid phone").optional(),
  role: z.enum(["rider", "driver"]).default("rider"),
});
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
const refreshSchema = z.object({ refreshToken: z.string().min(20).max(200) });

const clientInfo = (req: import("express").Request) => ({ userAgent: req.get("user-agent"), ip: req.ip });
const limiter = rateLimit({ name: "auth", windowSeconds: 60, max: env.AUTH_RATE_LIMIT_MAX });

authRouter.post("/register", limiter, validate(registerSchema), ah(async (req, res) => {
  res.status(201).json(await auth.register(req.body, clientInfo(req)));
}));

authRouter.post("/login", limiter, validate(loginSchema), ah(async (req, res) => {
  res.json(await auth.login(req.body, clientInfo(req)));
}));

authRouter.post("/refresh", limiter, validate(refreshSchema), ah(async (req, res) => {
  res.json({ tokens: await auth.refresh(req.body.refreshToken, clientInfo(req)) });
}));

/** Logout the current session (identified by the access token). */
authRouter.post("/logout", authenticate, ah(async (req, res) => {
  await auth.logout(req.auth!.sessionId);
  res.status(204).end();
}));

/** Logout via refresh token (for clients whose access token already expired). */
authRouter.post("/logout/refresh-token", limiter, validate(refreshSchema), ah(async (req, res) => {
  const sid = await auth.sessionIdForRefreshToken(req.body.refreshToken);
  if (!sid) throw badRequest("Unknown refresh token");
  await auth.logout(sid);
  res.status(204).end();
}));

authRouter.post("/logout-all", authenticate, ah(async (req, res) => {
  res.json({ revokedSessions: await auth.logoutAll(req.auth!.userId) });
}));

authRouter.get("/sessions", authenticate, ah(async (req, res) => {
  res.json({ sessions: await auth.listSessions(req.auth!.userId, req.auth!.sessionId) });
}));
