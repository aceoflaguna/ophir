import pino from "pino";
import { env } from "../config/env.ts";

export const logger = pino({
  level: env.NODE_ENV === "test" ? "silent" : env.LOG_LEVEL,
  redact: ["req.headers.authorization", "*.password", "*.refreshToken", "*.password_hash"],
});
