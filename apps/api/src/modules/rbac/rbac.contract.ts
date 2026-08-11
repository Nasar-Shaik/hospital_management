/**
 * RBAC response contracts — permissions, roles, and what a user ended up with.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves } from "../../core/http/contract.js";
import type { Permission, Role } from "./rbac.repository.js";

export const permission = contract(
  "Permission",
  z.object({
    id: z.string(),
    /** `patient:read` — resource, action and scope joined. The code IS the identity. */
    code: z.string(),
    resource: z.string(),
    action: z.string(),
    scope: z.string(),
    description: z.string(),
  }),
);
export type PermissionProof = Proves<Matches<typeof permission, Permission>>;

export const role = contract(
  "Role",
  z.object({
    id: z.string(),
    code: z.string(),
    name: z.string(),
    /** A system role cannot be deleted or renamed — it is part of the product, not the tenant. */
    isSystem: z.boolean(),
    description: z.string().optional(),
  }),
);
export type RoleProof = Proves<Matches<typeof role, Role>>;

/** One role WITH its permission codes — the role editor's payload. */
export const roleDetail = contract(
  "RoleDetail",
  z.object({
    id: z.string(),
    code: z.string(),
    name: z.string(),
    isSystem: z.boolean(),
    description: z.string().optional(),
    permissions: z.array(z.string()),
  }),
);

export const rolePermissions = contract(
  "RolePermissions",
  z.object({ roleId: z.string(), permissions: z.array(z.string()) }),
);

/**
 * What the user can do AFTER the change — roles, the branches they are confined to, and the
 * effective permission codes. Returned so the caller never has to re-read to find out what it did.
 */
export const userRoles = contract(
  "UserRoles",
  z.object({
    roles: z.array(z.string()),
    branchIds: z.array(z.string()),
    permissions: z.array(z.string()),
  }),
);

export const roleDeletedAck = contract("RoleDeletedAck", z.object({ deleted: z.literal(true) }));
