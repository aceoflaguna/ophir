import { Router } from "express";
import { z } from "zod";
import { ah } from "../../lib/async-handler.ts";
import { authenticate, requireRole } from "../../middleware/auth.ts";
import { rateLimit } from "../../middleware/rate-limit.ts";
import { validate } from "../../middleware/validate.ts";
import * as rides from "./rides.service.ts";

export const ridesRouter = Router();
ridesRouter.use(authenticate);

const point = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const place = point.extend({ address: z.string().max(300).optional() });
const idParam = z.object({ id: z.string().uuid() });

ridesRouter.post("/estimate", requireRole("rider"), validate(z.object({ pickup: point, dropoff: point })), ah(async (req, res) => {
  res.json(await rides.estimate(req.body));
}));

ridesRouter.post("/", requireRole("rider"), rateLimit({ name: "ride-request", windowSeconds: 60, max: 10, by: "user" }),
  validate(z.object({
    pickup: place, dropoff: place,
    vehicleType: z.enum(["economy", "comfort", "xl"]).default("economy"),
    paymentMethod: z.enum(["cash", "card", "wallet"]).default("cash"),
  })),
  ah(async (req, res) => {
    res.status(201).json({ ride: await rides.requestRide(req.auth!.userId, req.body) });
  }));

const listSchema = z.object({
  status: z.enum(["searching", "accepted", "arrived", "in_progress", "completed", "cancelled", "no_drivers"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
ridesRouter.get("/", requireRole("rider", "driver"), validate(listSchema, "query"), ah(async (req, res) => {
  const q = req.query as unknown as z.infer<typeof listSchema>;
  res.json({ rides: await rides.listRides(req.auth!.userId, req.auth!.role, q), limit: q.limit, offset: q.offset });
}));

// Registered before "/:id" so "active" is not parsed as an id.
ridesRouter.get("/active", requireRole("rider", "driver"), ah(async (req, res) => {
  res.json({ ride: await rides.activeRide(req.auth!.userId, req.auth!.role) });
}));

ridesRouter.get("/:id", validate(idParam, "params"), ah(async (req, res) => {
  res.json({ ride: await rides.getRideFor(req.params.id!, req.auth!.userId, req.auth!.role) });
}));
ridesRouter.get("/:id/events", validate(idParam, "params"), ah(async (req, res) => {
  res.json({ events: await rides.rideEvents(req.params.id!, req.auth!.userId, req.auth!.role) });
}));

import * as messages from "./messages.service.ts";   // next to the rides.service import

// Rider <-> driver chat (polling). Only available while the ride is accepted / arrived / in_progress.
const messagesQuery = z.object({ after: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(100).default(50) });
ridesRouter.get("/:id/messages", requireRole("rider", "driver"), validate(idParam, "params"), validate(messagesQuery, "query"), ah(async (req, res) => {
  const q = req.query as unknown as z.infer<typeof messagesQuery>;
  res.json({ messages: await messages.listMessages(req.params.id!, req.auth!.userId, q.after, q.limit) });
}));
ridesRouter.post("/:id/messages", requireRole("rider", "driver"), rateLimit({ name: "ride-message", windowSeconds: 10, max: 10, by: "user" }),
  validate(idParam, "params"), validate(z.object({ body: z.string().trim().min(1).max(1000) })),
  ah(async (req, res) => {
    res.status(201).json({ message: await messages.sendMessage(req.params.id!, req.auth!.userId, req.body.body) });
  }));

ridesRouter.post("/:id/cancel", validate(idParam, "params"), validate(z.object({ reason: z.string().max(300).optional() })),
  ah(async (req, res) => {
    res.json({ ride: await rides.cancelRide(req.params.id!, req.auth!.userId, req.auth!.role, req.body.reason) });
  }));

ridesRouter.post("/:id/arrive", requireRole("driver"), validate(idParam, "params"), ah(async (req, res) => {
  res.json({ ride: await rides.arrive(req.params.id!, req.auth!.userId) });
}));
ridesRouter.post("/:id/start", requireRole("driver"), validate(idParam, "params"), ah(async (req, res) => {
  res.json({ ride: await rides.start(req.params.id!, req.auth!.userId) });
}));
ridesRouter.post("/:id/complete", requireRole("driver"), validate(idParam, "params"),
  validate(z.object({ actualDistanceKm: z.number().positive().max(1000).optional(), actualDurationMin: z.number().positive().max(1440).optional() })),
  ah(async (req, res) => {
    res.json({ ride: await rides.complete(req.params.id!, req.auth!.userId, { distanceKm: req.body.actualDistanceKm, durationMin: req.body.actualDurationMin }) });
  }));

ridesRouter.post("/:id/rate", requireRole("rider", "driver"), validate(idParam, "params"),
  validate(z.object({ rating: z.number().int().min(1).max(5), comment: z.string().max(500).optional() })),
  ah(async (req, res) => {
    await rides.rate(req.params.id!, req.auth!.userId, req.auth!.role, req.body.rating, req.body.comment);
    res.status(204).end();
  }));
