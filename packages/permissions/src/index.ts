/**
 * Permission catalog scaffolding (ADR-0010, Doc 09 §2).
 * Codes are `resource:action[:scope]`; routes reference these CONSTANTS —
 * never string literals (Guidelines Never-rule 7). The business catalog is
 * seeded in P1; Sprint 0 defines only the shape and scopes.
 */

export const PERMISSION_SCOPES = ["own", "branch", "tenant", "global"] as const;
export type PermissionScope = (typeof PERMISSION_SCOPES)[number];

export interface PermissionDefinition {
  code: string;
  resource: string;
  action: string;
  scope?: PermissionScope;
  description: string;
}

/**
 * The catalog. P1 populates this from Doc 01/02 permission lists.
 * Kept as a typed constant so `PERMISSIONS.xxx` is compile-time checked.
 */
export const PERMISSIONS = {} as const satisfies Record<string, PermissionDefinition>;

export type PermissionCode = keyof typeof PERMISSIONS;
