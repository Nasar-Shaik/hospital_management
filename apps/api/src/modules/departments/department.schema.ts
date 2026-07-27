/**
 * Department DTOs (Doc 09 §5/§6). `.strict()` — an unexpected field is a 400.
 */
import { z } from "@medicore/validation";
import { DEPARTMENT_KINDS } from "./department.model.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "invalid id");

export const createDepartmentSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    code: z.string().trim().min(1).max(24),
    kind: z.enum(DEPARTMENT_KINDS),
    parentId: objectId.optional(),
    headStaffId: objectId.optional(),
    description: z.string().trim().max(500).optional(),
  })
  .strict();

export const updateDepartmentSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    kind: z.enum(DEPARTMENT_KINDS).optional(),
    status: z.enum(["active", "inactive"]).optional(),
    // `null` detaches the parent/head (back to top-level / no head); omit to leave unchanged.
    parentId: objectId.nullable().optional(),
    headStaffId: objectId.nullable().optional(),
    description: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "nothing to update" });

export const idParamSchema = z.object({ id: objectId }).strict();

export type CreateDepartmentBody = z.infer<typeof createDepartmentSchema>;
export type UpdateDepartmentBody = z.infer<typeof updateDepartmentSchema>;
