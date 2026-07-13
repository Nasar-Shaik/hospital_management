/**
 * User DTOs (Doc 09 §5/§6). `.strict()` — an unexpected field is a 400.
 */
import { z } from "@medicore/validation";

export const createUserSchema = z
  .object({
    email: z.string().email().max(254),
    name: z.string().min(2).max(120),
    phone: z.string().max(20).optional(),
    employeeId: z.string().max(40).optional(),
    /**
     * Roles granted at creation. Optional — a user with no role can log in and
     * do nothing, which is a safe default: an over-privileged account created by
     * accident is far worse than a useless one.
     */
    roles: z
      .array(z.string().regex(/^[A-Z][A-Z0-9_]*$/))
      .max(10)
      .default([]),
    branchIds: z
      .array(z.string().regex(/^[a-f\d]{24}$/i))
      .max(50)
      .default([]),
  })
  .strict();

export const updateUserSchema = z
  .object({
    name: z.string().min(2).max(120).optional(),
    phone: z.string().max(20).optional(),
    employeeId: z.string().max(40).optional(),
  })
  .strict();

export const listUsersQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    q: z.string().max(120).optional(),
    status: z.enum(["invited", "active", "locked", "disabled", "archived"]).optional(),
  })
  .strict();

export const setUserStatusSchema = z
  .object({
    // `archived` is deliberately absent: it is terminal and irreversible, so it
    // does not belong on a routine status toggle in an admin UI.
    status: z.enum(["active", "disabled"]),
  })
  .strict();

export const resetPasswordSchema = z
  .object({
    /** Omit to have a strong temporary password generated and returned once. */
    password: z.string().min(8).max(512).optional(),
  })
  .strict();

export const idParamSchema = z
  .object({ id: z.string().regex(/^[a-f\d]{24}$/i, "invalid user id") })
  .strict();

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
