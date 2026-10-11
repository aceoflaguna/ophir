import pg from "pg";
import { env } from "../config/env.ts";
import { logger } from "../lib/logger.ts";

// Return NUMERIC as JS numbers (our money values are small, 2dp) and BIGINT as number.
pg.types.setTypeParser(1700, (v) => parseFloat(v));
pg.types.setTypeParser(20, (v) => parseInt(v, 10));

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.PG_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (err) => logger.error({ err }, "unexpected pg pool error"));

export type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

/** Run a parameterised query and return all rows. */
export async function query<T extends pg.QueryResultRow = any>(
  sql: string,
  params: unknown[] = [],
  db: Queryable = pool,
): Promise<T[]> {
  const res = await db.query<T>(sql, params as any[]);
  return res.rows;
}

/** Return the first row or null. */
export async function queryOne<T extends pg.QueryResultRow = any>(
  sql: string,
  params: unknown[] = [],
  db: Queryable = pool,
): Promise<T | null> {
  const rows = await query<T>(sql, params, db);
  return rows[0] ?? null;
}

/** Run `fn` inside a transaction. Commits on success, rolls back on throw. */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export const isUniqueViolation = (err: unknown, constraint?: string) =>
  typeof err === "object" &&
  err !== null &&
  (err as any).code === "23505" &&
  (!constraint || (err as any).constraint === constraint);
