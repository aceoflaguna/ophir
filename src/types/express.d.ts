import "express";

declare global {
  namespace Express {
    interface Request {
      auth?: { userId: string; role: "rider" | "driver" | "admin"; sessionId: string };
    }
  }
}
export {};
