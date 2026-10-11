import { Router } from "express";
import { z } from "zod";
import { isUniqueViolation } from "../../db/pool.ts";
import { ah } from "../../lib/async-handler.ts";
import { conflict } from "../../lib/errors.ts";
import { authenticate, requireRole } from "../../middleware/auth.ts";
import { rateLimit } from "../../middleware/rate-limit.ts";
import { validate } from "../../middleware/validate.ts";
import * as rides from "../rides/rides.service.ts";
import * as drivers from "./drivers.service.ts";

export const driversRouter = Router();
driversRouter.use(authenticate, requireRole("driver"));

const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);
const point = z.object({ lat, lng });

const profileSchema = z.object({
  licenseNumber: z.string().trim().min(4).max(40),
  vehicleMake: z.string().trim().min(1).max(40),
  vehicleModel: z.string().trim().min(1).max(40),
  vehicleColor: z.string().trim().min(1).max(30),
  plateNumber: z.string().trim().min(2).max(15),
  vehicleType: z.enum(["economy", "comfort", "xl"]).default("economy"),
});

driversRouter.get("/me", ah(async (req, res) => {
  res.json({ driver: drivers.toPublicDriver(await drivers.requireDriver(req.auth!.userId)) });
}));

driversRouter.put("/me/profile", validate(profileSchema), ah(async (req, res) => {
  try {
    res.json({ driver: drivers.toPublicDriver(await drivers.upsertProfile(req.auth!.userId, req.body)) });
  } catch (e) {
    if (isUniqueViolation(e, "drivers_plate_uq")) throw conflict("Plate number already registered", "PLATE_TAKEN");
    throw e;
  }
}));

driversRouter.post("/me/online", validate(point), ah(async (req, res) => {
  await drivers.goOnline(req.auth!.userId, req.body.lat, req.body.lng);
  res.json({ status: "online" });
}));

driversRouter.post("/me/offline", ah(async (req, res) => {
  await drivers.goOffline(req.auth!.userId);
  res.json({ status: "offline" });
}));

// Drivers typically ping every 3-5s.
driversRouter.put("/me/location", rateLimit({ name: "loc", windowSeconds: 10, max: 20, by: "user" }), validate(point), ah(async (req, res) => {
  await drivers.updateLocation(req.auth!.userId, req.body.lat, req.body.lng);
  res.status(204).end();
}));

driversRouter.get("/me/offers", ah(async (req, res) => {
  res.json({ offers: await rides.listOffers(req.auth!.userId) });
}));
driversRouter.post("/me/offers/:offerId/accept", validate(z.object({ offerId: z.string().uuid() }), "params"), ah(async (req, res) => {
  res.json({ ride: await rides.acceptOffer(req.auth!.userId, req.params.offerId!) });
}));
driversRouter.post("/me/offers/:offerId/decline", validate(z.object({ offerId: z.string().uuid() }), "params"), ah(async (req, res) => {
  await rides.declineOffer(req.auth!.userId, req.params.offerId!);
  res.status(204).end();
}));

const rangeSchema = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() });
driversRouter.get("/me/earnings", validate(rangeSchema, "query"), ah(async (req, res) => {
  const q = req.query as unknown as z.infer<typeof rangeSchema>;
  res.json(await drivers.earnings(req.auth!.userId, q.from, q.to));
}));
