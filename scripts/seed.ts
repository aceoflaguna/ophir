/** Creates an admin user (and optionally demo rider/driver):  ADMIN_EMAIL / ADMIN_PASSWORD env vars override defaults. */
import { pool, query } from "../src/db/pool.ts";

async function upsert(email: string, password: string, name: string, role: string) {
  const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
  await query(
    `INSERT INTO users (email, password_hash, full_name, role) VALUES ($1,$2,$3,$4)
     ON CONFLICT ((lower(email))) DO UPDATE SET role = EXCLUDED.role, password_hash = EXCLUDED.password_hash`,
    [email, hash, name, role],
  );
  console.log(`seeded ${role}: ${email}`);
}

await upsert(process.env.ADMIN_EMAIL ?? "admin@example.com", process.env.ADMIN_PASSWORD ?? "Admin12345", "Admin", "admin");
if (process.argv.includes("--demo")) {
  await upsert("rider@example.com", "Rider12345", "Demo Rider", "rider");
  await upsert("driver@example.com", "Driver12345", "Demo Driver", "driver");
}
await pool.end();
