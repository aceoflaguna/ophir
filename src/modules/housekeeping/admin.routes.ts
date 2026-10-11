import { Router } from "express";
import { z } from "zod";
import { query } from "../../db/pool.ts";
import { ah } from "../../lib/async-handler.ts";
import { authenticate, requireRole } from "../../middleware/auth.ts";
import { validate } from "../../middleware/validate.ts";
import { HOUSEKEEPING_JOBS, housekeepingQueue, matchingQueue } from "../../queues/index.ts";

export const adminRouter = Router();
adminRouter.use(authenticate, requireRole("admin"));

adminRouter.get("/housekeeping/runs", validate(z.object({ job: z.enum(HOUSEKEEPING_JOBS as [string, ...string[]]).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), "query"),
  ah(async (req, res) => {
    const q = req.query as unknown as { job?: string; limit: number };
    const runs = await query(
      `SELECT id, job, started_at AS "startedAt", finished_at AS "finishedAt", affected, error
         FROM housekeeping_runs WHERE ($1::text IS NULL OR job=$1) ORDER BY id DESC LIMIT $2`, [q.job ?? null, q.limit]);
    res.json({ runs });
  }));

/** Trigger a housekeeping job right now (executed by the worker). */
adminRouter.post("/housekeeping/:job/run", validate(z.object({ job: z.enum(HOUSEKEEPING_JOBS as [string, ...string[]]) }), "params"),
  ah(async (req, res) => {
    const job = await housekeepingQueue.add("manual", { job: req.params.job as any });
    res.status(202).json({ queued: true, jobId: job.id });
  }));

adminRouter.get("/queues", ah(async (_req, res) => {
  const [matching, housekeeping] = await Promise.all([matchingQueue.getJobCounts(), housekeepingQueue.getJobCounts()]);
  res.json({ matching, housekeeping });
}));

adminRouter.post("/users/:id/active", validate(z.object({ id: z.string().uuid() }), "params"), validate(z.object({ active: z.boolean() })),
  ah(async (req, res) => {
    await query("UPDATE users SET is_active=$2, updated_at=now() WHERE id=$1", [req.params.id, req.body.active]);
    if (!req.body.active) await query("UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [req.params.id]);
    res.status(204).end();
  }));
