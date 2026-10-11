import { Router } from "express";
import { z } from "zod";
import { isUniqueViolation, queryOne } from "../../db/pool.ts";
import { ah } from "../../lib/async-handler.ts";
import { conflict, notFound } from "../../lib/errors.ts";
import { authenticate } from "../../middleware/auth.ts";
import { validate } from "../../middleware/validate.ts";
import { toPublicUser, type UserRow } from "../auth/auth.service.ts";

export const usersRouter = Router();
usersRouter.use(authenticate);

usersRouter.get("/me", ah(async (req, res) => {
  const user = await queryOne<UserRow>("SELECT * FROM users WHERE id = $1", [req.auth!.userId]);
  if (!user) throw notFound("User not found");
  res.json({ user: toPublicUser(user) });
}));

const patchSchema = z
  .object({
    fullName: z.string().trim().min(2).max(100),
    phone: z.string().regex(/^\+?[0-9]{7,15}$/).nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "no fields to update");

usersRouter.patch("/me", validate(patchSchema), ah(async (req, res) => {
  try {
    const user = await queryOne<UserRow>(
      `UPDATE users SET full_name = COALESCE($2, full_name),
                        phone = CASE WHEN $3::boolean THEN $4 ELSE phone END,
                        updated_at = now()
        WHERE id = $1 RETURNING *`,
      [req.auth!.userId, req.body.fullName ?? null, "phone" in req.body, req.body.phone ?? null],
    );
    res.json({ user: toPublicUser(user!) });
  } catch (e) {
    if (isUniqueViolation(e, "users_phone_uq")) throw conflict("Phone already registered", "PHONE_TAKEN");
    throw e;
  }
}));
