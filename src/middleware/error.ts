import type { ErrorRequestHandler, RequestHandler } from "express";
import { AppError } from "../lib/errors.ts";
import { logger } from "../lib/logger.ts";

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ error: { code: "NOT_FOUND", message: `Route ${req.method} ${req.path} not found` } });
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof AppError) {
    return void res
      .status(err.status)
      .json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
  }
  if (err?.type === "entity.parse.failed") {
    return void res.status(400).json({ error: { code: "BAD_JSON", message: "Malformed JSON body" } });
  }
  if (err?.type === "entity.too.large") {
    return void res.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Body too large" } });
  }
  logger.error({ err, path: req.path, method: req.method }, "unhandled error");
  res.status(500).json({ error: { code: "INTERNAL", message: "Internal server error" } });
};
