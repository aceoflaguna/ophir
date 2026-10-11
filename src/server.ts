import { createApp } from "./app.ts";
import { env } from "./config/env.ts";
import { pool } from "./db/pool.ts";
import { valkey } from "./db/valkey.ts";
import { logger } from "./lib/logger.ts";
import { closeQueues } from "./queues/index.ts";

const app = createApp();
const server = app.listen(env.PORT, () => logger.info(`API listening on :${env.PORT} (${env.NODE_ENV})`));

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  server.close(async () => {
    await closeQueues();
    await valkey.quit().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(0);
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
