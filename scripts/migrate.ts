/**
 * Minimal SQL migration runner (no ORM, no extra dependency).
 *   bun scripts/migrate.ts up      -> apply all pending *.up.sql
 *   bun scripts/migrate.ts down    -> revert the latest applied migration
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pool } from "../src/db/pool.ts";

const dir = join(import.meta.dir, "..", "migrations");
const direction = process.argv[2] ?? "up";
const LOCK_KEY = 727_001; // arbitrary advisory lock id

const client = await pool.connect();
try {
  await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const { rows } = await client.query<{ name: string }>("SELECT name FROM schema_migrations ORDER BY name");
  const applied = new Set(rows.map((r) => r.name));
  const names = readdirSync(dir)
    .filter((f) => f.endsWith(".up.sql"))
    .map((f) => f.replace(".up.sql", ""))
    .sort();

  if (direction === "up") {
    let count = 0;
    for (const name of names.filter((n) => !applied.has(n))) {
      const sql = readFileSync(join(dir, `${name}.up.sql`), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [name]);
        await client.query("COMMIT");
        console.log(`applied  ${name}`);
        count++;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    }
    console.log(count ? `${count} migration(s) applied` : "database is up to date");
  } else if (direction === "down") {
    const last = [...names].reverse().find((n) => applied.has(n));
    if (!last) console.log("nothing to revert");
    else {
      const sql = readFileSync(join(dir, `${last}.down.sql`), "utf8");
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("DELETE FROM schema_migrations WHERE name = $1", [last]);
      await client.query("COMMIT");
      console.log(`reverted ${last}`);
    }
  } else {
    console.error("usage: migrate.ts [up|down]");
    process.exitCode = 1;
  }
} finally {
  await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
  client.release();
  await pool.end();
}
