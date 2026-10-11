export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new AppError(400, "BAD_REQUEST", msg, details);
export const unauthorized = (msg = "Unauthorized", code = "UNAUTHORIZED") => new AppError(401, code, msg);
export const forbidden = (msg = "Forbidden") => new AppError(403, "FORBIDDEN", msg);
export const notFound = (msg = "Not found") => new AppError(404, "NOT_FOUND", msg);
export const conflict = (msg: string, code = "CONFLICT") => new AppError(409, code, msg);
export const tooMany = (msg = "Too many requests") => new AppError(429, "RATE_LIMITED", msg);
