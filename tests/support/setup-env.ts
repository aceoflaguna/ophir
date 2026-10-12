/**
 * Runs before every test file: points the app at the test database / Valkey logical DB 1,
 * shortens timeouts, and shims the Bun-only `Bun.password` API so the code runs under Jest (Node).
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const base = process.env.DATABASE_URL ?? "postgres://asyong:asyong@localhost:5432/ophir_test";
const testUrl = new URL(base);
testUrl.pathname = "/ophir_test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = testUrl.toString();
process.env.VALKEY_URL = (process.env.VALKEY_URL ?? "redis://localhost:6379").replace(/\/\d+$/, "") + "/1";
process.env.JWT_ACCESS_SECRET = "test-secret-test-secret-test-secret-123";
process.env.DRIVER_OFFER_TIMEOUT_SECONDS = "2";
process.env.RIDE_SEARCH_TIMEOUT_SECONDS = "30";
process.env.ARRIVAL_RADIUS_KM = "0.5";
process.env.AUTH_RATE_LIMIT_MAX = "10000";

const scryptAsync = (pw: string, salt: Buffer) =>
  new Promise<Buffer>((res, rej) => scrypt(pw, salt, 32, { N: 1024 }, (e, k) => (e ? rej(e) : res(k))));

// Fast, dependency-free stand-in for Bun.password (argon2id) used only under Jest.
(globalThis as any).Bun ??= {
  password: {
    async hash(pw: string) {
      const salt = randomBytes(16);
      return `scrypt$${salt.toString("hex")}$${(await scryptAsync(pw, salt)).toString("hex")}`;
    },
    async verify(pw: string, stored: string) {
      const [, saltHex, keyHex] = stored.split("$");
      if (!saltHex || !keyHex) return false;
      const key = await scryptAsync(pw, Buffer.from(saltHex, "hex"));
      const expected = Buffer.from(keyHex, "hex");
      return key.length === expected.length && timingSafeEqual(key, expected);
    },
  },
};
