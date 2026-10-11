import { Router } from "express";
import { query } from "../../db/pool.ts";
import { ah } from "../../lib/async-handler.ts";
import { authenticate, requireRole } from "../../middleware/auth.ts";

export const paymentsRouter = Router();
paymentsRouter.use(authenticate, requireRole("rider", "driver"));

/** Payment history for the current user (as rider or as driver). */
paymentsRouter.get("/", ah(async (req, res) => {
  const col = req.auth!.role === "driver" ? "driver_id" : "rider_id";
  const payments = await query(
    `SELECT id, ride_id AS "rideId", amount, currency, method, status, created_at AS "createdAt"
       FROM payments WHERE ${col} = $1 ORDER BY created_at DESC LIMIT 100`, [req.auth!.userId]);
  res.json({ payments });
}));
