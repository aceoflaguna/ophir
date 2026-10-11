import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { env } from "../../config/env.ts";
import { isUniqueViolation, pool, query, queryOne, withTransaction, type Queryable } from "../../db/pool.ts";
import { valkey } from "../../db/valkey.ts";
import { conflict, unauthorized } from "../../lib/errors.ts";
import { signAccessToken, type Role } from "../../lib/jwt.ts";
import { revokedSessionKey } from "../../middleware/auth.ts";

export interface UserRow {
  id: string;
  email: string;
  phone: string | null;
  password_hash: string;
  full_name: string;
  role: Role;
  rating_avg: number;
  rating_count: number;
  is_active: boolean;
  created_at: Date;
}

export const toPublicUser = (u: UserRow) => ({
  id: u.id,
  email: u.email,
  phone: u.phone,
  fullName: u.full_name,
  role: u.role,
  rating: { average: u.rating_avg, count: u.rating_count },
  createdAt: u.created_at,
});

interface ClientInfo {
  userAgent?: string | undefined;
  ip?: string | undefined;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const newOpaqueToken = () => randomBytes(48).toString("base64url");
// Valid argon2id hash used to equalise timing when the email does not exist.
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= Bun.password.hash("dummy-password-for-timing", { algorithm: "argon2id" }));

async function issueTokenPair(user: Pick<UserRow, "id" | "role">, familyId: string, info: ClientInfo, db: Queryable) {
  const refreshToken = newOpaqueToken();
  const id = randomUUID();
  await query(
    `INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, expires_at, user_agent, ip)
     VALUES ($1,$2,$3,$4, now() + make_interval(days => $5), $6, $7)`,
    [id, user.id, familyId, sha256(refreshToken), env.REFRESH_TOKEN_TTL_DAYS, info.userAgent?.slice(0, 300) ?? null, info.ip ?? null],
    db,
  );
  return {
    tokenId: id,
    accessToken: signAccessToken({ userId: user.id, role: user.role, sessionId: familyId }),
    refreshToken,
    tokenType: "Bearer" as const,
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
  };
}

export async function register(
  input: { email: string; password: string; fullName: string; phone?: string | undefined; role: "rider" | "driver" },
  info: ClientInfo,
) {
  const hash = await Bun.password.hash(input.password, { algorithm: "argon2id" });
  try {
    return await withTransaction(async (tx) => {
      const user = (
        await query<UserRow>(
          `INSERT INTO users (email, phone, password_hash, full_name, role)
           VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [input.email.trim(), input.phone ?? null, hash, input.fullName, input.role],
          tx,
        )
      )[0]!;
      const tokens = await issueTokenPair(user, randomUUID(), info, tx);
      return { user: toPublicUser(user), tokens: stripId(tokens) };
    });
  } catch (err) {
    if (isUniqueViolation(err, "users_email_lower_uq")) throw conflict("Email already registered", "EMAIL_TAKEN");
    if (isUniqueViolation(err, "users_phone_uq")) throw conflict("Phone already registered", "PHONE_TAKEN");
    throw err;
  }
}

export async function login(input: { email: string; password: string }, info: ClientInfo) {
  const user = await queryOne<UserRow>("SELECT * FROM users WHERE lower(email) = lower($1)", [input.email.trim()]);
  const ok = await Bun.password.verify(input.password, user?.password_hash ?? (await getDummyHash()));
  if (!user || !ok) throw unauthorized("Invalid email or password", "INVALID_CREDENTIALS");
  if (!user.is_active) throw unauthorized("Account disabled", "ACCOUNT_DISABLED");
  const tokens = await issueTokenPair(user, randomUUID(), info, pool);
  return { user: toPublicUser(user), tokens: stripId(tokens) };
}

/**
 * Refresh-token rotation with reuse detection.
 *  - every refresh token is single-use; using it returns a new pair in the same family
 *  - presenting an already-rotated token means it leaked -> the whole family is revoked
 */
export async function refresh(presented: string, info: ClientInfo) {
  type Outcome = { kind: "ok"; value: Awaited<ReturnType<typeof issueTokenPair>> } | { kind: "fail"; code: string; msg: string };

  const outcome: Outcome = await withTransaction(async (tx: PoolClient) => {
    const row = await queryOne<{
      id: string; user_id: string; family_id: string; expires_at: Date; revoked_at: Date | null;
    }>("SELECT id, user_id, family_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE", [sha256(presented)], tx);

    if (!row) return { kind: "fail", code: "INVALID_REFRESH_TOKEN", msg: "Invalid refresh token" };

    if (row.revoked_at) {
      // Reuse of a rotated/revoked token: burn the entire session family.
      await query("UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL", [row.family_id], tx);
      await markSessionRevoked(row.family_id);
      return { kind: "fail", code: "REFRESH_TOKEN_REUSED", msg: "Refresh token reuse detected; session revoked" };
    }
    if (row.expires_at.getTime() <= Date.now()) return { kind: "fail", code: "REFRESH_TOKEN_EXPIRED", msg: "Refresh token expired" };

    const user = await queryOne<UserRow>("SELECT * FROM users WHERE id = $1", [row.user_id], tx);
    if (!user || !user.is_active) return { kind: "fail", code: "ACCOUNT_DISABLED", msg: "Account disabled" };

    const next = await issueTokenPair(user, row.family_id, info, tx);
    await query("UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1", [row.id, next.tokenId], tx);
    return { kind: "ok", value: next };
  });

  if (outcome.kind === "fail") throw unauthorized(outcome.msg, outcome.code);
  return stripId(outcome.value);
}

/** Revoke the session that owns the presented refresh token (idempotent). */
export async function logout(sessionId: string) {
  await query("UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL", [sessionId]);
  await markSessionRevoked(sessionId);
}

export async function logoutAll(userId: string) {
  const rows = await query<{ family_id: string }>(
    "UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL RETURNING family_id",
    [userId],
  );
  for (const f of new Set(rows.map((r) => r.family_id))) await markSessionRevoked(f);
  return new Set(rows.map((r) => r.family_id)).size;
}

export async function listSessions(userId: string, currentSessionId: string) {
  const rows = await query<{ family_id: string; user_agent: string | null; ip: string | null; created_at: Date; last_used: Date; expires_at: Date }>(
    `SELECT family_id, min(created_at) AS created_at, max(created_at) AS last_used,
            max(expires_at) AS expires_at, (array_agg(user_agent ORDER BY created_at DESC))[1] AS user_agent,
            (array_agg(ip ORDER BY created_at DESC))[1] AS ip
       FROM refresh_tokens
      WHERE user_id = $1 AND family_id IN (
              SELECT family_id FROM refresh_tokens WHERE user_id = $1 GROUP BY family_id
              HAVING bool_or(revoked_at IS NULL AND expires_at > now()))
      GROUP BY family_id ORDER BY max(created_at) DESC`,
    [userId],
  );
  return rows.map((r) => ({
    sessionId: r.family_id,
    current: r.family_id === currentSessionId,
    userAgent: r.user_agent,
    ip: r.ip,
    createdAt: r.created_at,
    lastUsedAt: r.last_used,
    expiresAt: r.expires_at,
  }));
}

export async function sessionIdForRefreshToken(token: string): Promise<string | null> {
  const row = await queryOne<{ family_id: string }>("SELECT family_id FROM refresh_tokens WHERE token_hash = $1", [sha256(token)]);
  return row?.family_id ?? null;
}

/** Access tokens are stateless; a short-lived denylist entry lets logout take effect immediately. */
async function markSessionRevoked(sessionId: string) {
  await valkey.set(revokedSessionKey(sessionId), "1", "EX", env.ACCESS_TOKEN_TTL_SECONDS + 5);
}

const stripId = <T extends { tokenId: string }>({ tokenId: _t, ...rest }: T) => rest;
