import { describe, expect, test } from "@jest/globals";
import jwt from "jsonwebtoken";
import { signAccessToken, verifyAccessToken } from "../../src/lib/jwt.ts";

const claims = { userId: "11111111-1111-1111-1111-111111111111", role: "driver" as const, sessionId: "22222222-2222-2222-2222-222222222222" };

describe("access tokens", () => {
  test("round-trips subject, role and session id", () => {
    const out = verifyAccessToken(signAccessToken(claims));
    expect(out).toEqual({ sub: claims.userId, role: "driver", sid: claims.sessionId });
  });

  test("expired token -> TOKEN_EXPIRED", () => {
    const expired = jwt.sign({ role: "rider", sid: "s" }, process.env.JWT_ACCESS_SECRET!, {
      subject: "u", issuer: "ophir-api", expiresIn: -10,
    });
    expect(() => verifyAccessToken(expired)).toThrow(expect.objectContaining({ status: 401, code: "TOKEN_EXPIRED" }));
  });

  test("wrong secret, wrong issuer, tampering and garbage -> INVALID_TOKEN", () => {
    const wrongSecret = jwt.sign({ role: "rider", sid: "s" }, "another-secret-another-secret-123456", { subject: "u", issuer: "ophir-api" });
    const wrongIssuer = jwt.sign({ role: "rider", sid: "s" }, process.env.JWT_ACCESS_SECRET!, { subject: "u", issuer: "evil" });
    const tampered = signAccessToken(claims).replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    for (const t of [wrongSecret, wrongIssuer, tampered, "garbage", ""]) {
      expect(() => verifyAccessToken(t)).toThrow(expect.objectContaining({ code: "INVALID_TOKEN" }));
    }
  });

  test("rejects alg=none tokens", () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const none = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: "u", role: "admin", sid: "s", iss: "ophir-api" })}.`;
    expect(() => verifyAccessToken(none)).toThrow(expect.objectContaining({ code: "INVALID_TOKEN" }));
  });

  test("rejects tokens missing required claims", () => {
    const noSid = jwt.sign({ role: "rider" }, process.env.JWT_ACCESS_SECRET!, { subject: "u", issuer: "ophir-api" });
    expect(() => verifyAccessToken(noSid)).toThrow(expect.objectContaining({ code: "INVALID_TOKEN" }));
  });
});
