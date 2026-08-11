/**
 * Department response contracts. TENANT-SCOPED (ADR-0015): one Cardiology, all sites.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves } from "../../core/http/contract.js";
import { DEPARTMENT_KINDS, DEPARTMENT_STATUSES } from "./department.model.js";
import type { Department } from "./department.repository.js";

export const department = contract(
  "Department",
  z.object({
    id: z.string(),
    name: z.string(),
    code: z.string(),
    kind: z.enum(DEPARTMENT_KINDS),
    status: z.enum(DEPARTMENT_STATUSES),
    parentId: z.string().optional(),
    headStaffId: z.string().optional(),
    description: z.string().optional(),
    /** Denormalized from the parent for the tree view — never a stored field. */
    parentName: z.string().optional(),
  }),
);
export type DepartmentProof = Proves<Matches<typeof department, Department>>;
