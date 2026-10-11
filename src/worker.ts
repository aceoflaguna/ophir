/**
 * Background worker process: ride matching + housekeeping.
 * Run separately from the API so it can be scaled independently:  bun run worker
 */
import { pool } from "./db/pool.ts";
import { valkey } from "./db/valkey.ts";
import { logger } from "./lib/logger.ts";
import { closeQueues } from "./queues/index.ts";
import { startWorkers } from "./workers/index.ts";

const workers = await startWorkers();

async function shutdown(signal: string) {
  logger.info({ signal }, "worker shutting down");
  await workers.close();
  await closeQueues();
  await valkey.quit().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
