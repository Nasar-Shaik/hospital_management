/**
 * RBAC DTOs (Doc 09 §5/§6). `.strict()` — an unexpected field is a 400.
 */
import { z } from "@medicore/validation";

const roleCode = z
  .string()
  .min(3)
  .max(40)
  .regex(/^[A-Z][A-Z0-9_]*$/, "must be SCREAMING_SNAKE (e.g. WARD_CLERK)");

export const createRoleSchema = z
  .object({
    code: roleCode,
    name: z.string().min(2).max(80),
    description: z.string().max(300).optional(),
    /** Codes are validated against the catalog in the service — an unknown one is a 400. */
    permissions: z.array(z.string().min(3)).max(500).default([]),
  })
  .strict();

export const setRolePermissionsSchema = z
  .object({
    permissions: z.array(z.string().min(3)).max(500),
  })
  .strict();

export const assignRoleSchema = z
  .object({
    roleCode: roleCode,
    /** Empty means "not restricted to specific branches" — see scopeFilter. */
    branchIds: z
      .array(z.string().regex(/^[a-f\d]{24}$/i))
      .max(50)
      .default([]),
  })
  .strict();

export const idParamSchema = z
  .object({ id: z.string().regex(/^[a-f\d]{24}$/i, "invalid id") })
  .strict();

export const userRoleParamSchema = z
  .object({
    id: z.string().regex(/^[a-f\d]{24}$/i, "invalid user id"),
    roleCode: roleCode,
  })
  .strict();
