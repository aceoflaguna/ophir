import type { RequestHandler } from "express";
import type { ZodTypeAny, z } from "zod";
import { badRequest } from "../lib/errors.ts";

type Source = "body" | "query" | "params";

/** Validate and replace req[source] with the parsed (coerced, stripped) value. */
export const validate =
  (schema: ZodTypeAny, source: Source = "body"): RequestHandler =>
  (req, _res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      return next(
        badRequest(
          "Validation failed",
          result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        ),
      );
    }
    // req.query is a getter in some Express versions; define it explicitly.
    Object.defineProperty(req, source, { value: result.data, writable: true, configurable: true });
    next();
  };

export type Infer<T extends ZodTypeAny> = z.infer<T>;
