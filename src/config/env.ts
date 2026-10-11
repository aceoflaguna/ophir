import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z.string().default("info"),

  DATABASE_URL: z.string().url(),
  PG_POOL_MAX: z.coerce.number().int().default(10),
  VALKEY_URL: z.string().default("redis://localhost:6379"),

  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 characters"),
  JWT_ISSUER: z.string().default("ophir-api"),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  MATCH_SEARCH_RADIUS_KM: z.coerce.number().positive().default(5),
  MATCH_MAX_CANDIDATES: z.coerce.number().int().positive().default(10),
  DRIVER_OFFER_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(20),
  RIDE_SEARCH_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(180),

  BASE_FARE: z.coerce.number().default(2.5),
  PER_KM: z.coerce.number().default(1.2),
  PER_MINUTE: z.coerce.number().default(0.35),
  MIN_FARE: z.coerce.number().default(5),
  CURRENCY: z.string().length(3).default("USD"),
  PLATFORM_FEE_PERCENT: z.coerce.number().min(0).max(100).default(20),

  DRIVER_STALE_SECONDS: z.coerce.number().int().positive().default(120),
  ARRIVAL_RADIUS_KM: z.coerce.number().positive().default(0.5),
  STUCK_RIDE_HOURS: z.coerce.number().positive().default(6),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:");
  for (const issue of parsed.error.issues) console.error(` - ${issue.path.join(".")}: ${issue.message}`);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
