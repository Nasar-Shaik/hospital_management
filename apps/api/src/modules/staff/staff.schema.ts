/**
 * User DTOs (Doc 09 §5/§6). `.strict()` — an unexpected field is a 400.
 */
import { z } from "@medicore/validation";
import { env } from "../../config/env.js";

/**
 * The professional / HR profile. Every field optional — a form that refuses to save an
 * urgently-hired doctor until every box is filled is a form that gets bypassed on paper.
 * `YYYY-MM-DD` dates are coerced to Date at the controller edge, never parsed in a service.
 */
export const staffProfileSchema = z
  .object({
    designation: z.string().max(120).optional(),
    department: z.string().max(120).optional(),
    specialty: z.string().max(120).optional(),
    /** Doctors' OP consultation fee, in PAISE. Non-negative whole number. */
    consultationFee: z.number().int().min(0).max(100_000_000).optional(),
    qualification: z.string().max(200).optional(),
    registrationNo: z.string().max(80).optional(),
    gender: z.enum(["male", "female", "other"]).optional(),
    dateOfBirth: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
      .optional(),
    joiningDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
      .optional(),
    address: z.string().max(500).optional(),
    emergencyContactName: z.string().max(120).optional(),
    emergencyContactPhone: z.string().max(20).optional(),
    /** Opt-in to the public website (doctors only). */
    showOnPublicSite: z.boolean().optional(),
    /**
     * A scanned signature as a `data:image/...;base64,…` URI, for the OPD slip. Bounded and shape-
     * checked so only an image data URI can be stored — never an arbitrary string or a remote URL.
     */
    signature: z
      .string()
      .max(350_000)
      .regex(/^data:image\/(png|jpeg|jpg|webp|gif);base64,/, "must be an image data URI")
      .optional(),
  })
  .strict();

export const createUserSchema = z
  .object({
    email: z.string().email().max(254),
    name: z.string().min(2).max(120),
    phone: z.string().max(20).optional(),
    employeeId: z.string().max(40).optional(),
    profile: staffProfileSchema.optional(),
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
    profile: staffProfileSchema.optional(),
  })
  .strict();

export type StaffProfileBody = z.infer<typeof staffProfileSchema>;

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
    password: z.string().min(env.PASSWORD_MIN_LENGTH).max(512).optional(),
  })
  .strict();

export const idParamSchema = z
  .object({ id: z.string().regex(/^[a-f\d]{24}$/i, "invalid user id") })
  .strict();

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
