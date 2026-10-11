import cors from "cors";
import express from "express";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import { pool } from "./db/pool.ts";
import { valkey } from "./db/valkey.ts";
import { logger } from "./lib/logger.ts";
import { errorHandler, notFoundHandler } from "./middleware/error.ts";
import { adminRouter } from "./modules/housekeeping/admin.routes.ts";
import { authRouter } from "./modules/auth/auth.routes.ts";
import { driversRouter } from "./modules/drivers/drivers.routes.ts";
import { ridesRouter } from "./modules/rides/rides.routes.ts";
import { usersRouter } from "./modules/users/users.routes.ts";
import { paymentsRouter } from "./modules/payments/payments.routes.ts";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // behind a load balancer; makes req.ip honour X-Forwarded-For
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: "50kb" }));

  app.use((req, res, next) => {
    const id = req.get("x-request-id") ?? randomUUID();
    res.setHeader("x-request-id", id);
    const start = performance.now();
    res.on("finish", () =>
      logger.info({ id, method: req.method, path: req.originalUrl.split("?")[0], status: res.statusCode, ms: Math.round(performance.now() - start) }, "request"));
    next();
  });

  // Liveness: process is up. Readiness: dependencies reachable.
  app.get("/health", (_req, res) => void res.json({ status: "ok" }));
  app.get("/ready", async (_req, res) => {
    const [pg, vk] = await Promise.allSettled([pool.query("SELECT 1"), valkey.ping()]);
    const ok = pg.status === "fulfilled" && vk.status === "fulfilled";
    res.status(ok ? 200 : 503).json({ status: ok ? "ready" : "unavailable", postgres: pg.status === "fulfilled", valkey: vk.status === "fulfilled" });
  });

  const api = express.Router();
  api.use("/auth", authRouter);
  api.use("/users", usersRouter);
  api.use("/drivers", driversRouter);
  api.use("/rides", ridesRouter);
  api.use("/payments", paymentsRouter);
  api.use("/admin", adminRouter);
  app.use("/api/v1", api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
