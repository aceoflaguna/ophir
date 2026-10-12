/**
 * Runs once before all suites: creates an isolated `ophir_test` database and applies migrations.
 * Needs Postgres at DATABASE_URL (user must be able to CREATE DATABASE) and the `bun` binary for the migration runner.
 */
import { spawnSync } from "node:child_process";
import pg from "pg";

export default async function globalSetup() {
  const base = process.env.DATABASE_URL ?? "postgres://asyong:asyong@localhost:5432/ophir_test";
  const test = new URL(base);
  test.pathname = "/ophir_test";
  const admin = new URL(base);
  admin.pathname = "/postgres";

  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = 'ophir_test'");
  if (!exists.rowCount) await client.query("CREATE DATABASE ophir_test");
  await client.end();

  const res = spawnSync("bun", ["scripts/migrate.ts", "up"], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: "test", DATABASE_URL: test.toString(), JWT_ACCESS_SECRET: "x".repeat(32) },
    encoding: "utf8",
  });
  if (res.status !== 0) throw new Error(`test migrations failed:\n${res.stdout}\n${res.stderr}`);
}
