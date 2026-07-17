/**
 * First-admin seeding (Doc 04 §7 `seed/`, BUSINESS_WORKFLOWS §13).
 *
 * WHY THIS IS NOT INSIDE `provisionTenant`: the `tenants` module owns the master
 * registry and the tenant database. If it also created users, it would depend on
 * `auth` → `users` → `rbac`, and the platform's most privileged module would
 * import half the system. Instead the COMPOSITION ROOT (the CLI) orchestrates:
 *
 *     provisionTenant()  →  seedTenantAdmin()
 *
 * The tenant module stays a leaf, and this file is the only place that knows a
 * hospital's day-one account exists.
 *
 * Everything here runs inside `runWithContext`, because repositories obtain their
 * connection from the request context and there is no request. That is not a
 * workaround: seeding genuinely acts on one tenant, so binding that tenant's
 * context is exactly right — and it means the tenantScope plugin protects the
 * seed path too.
 */
import type { Connection } from "mongoose";
import { runWithContext } from "../core/context/requestContext.js";
import { createStaff } from "../modules/staff/index.js";
import { assignRoleByCode, seedRbac } from "../modules/rbac/index.js";
import { getByEmail } from "../modules/users/index.js";

export interface SeedTenantAdminInput {
  tenantId: string;
  tenantSlug: string;
  connection: Connection;
  email: string;
  name?: string;
  /** Omit to have one generated and returned once. */
  password?: string;
}

export interface SeedTenantAdminResult {
  userId: string;
  email: string;
  /** Present only when we generated it — it is never recoverable afterwards. */
  generatedPassword?: string;
  /** False when the admin already existed (re-running the seed is safe). */
  created: boolean;
}

/**
 * Idempotent: seeds system roles, then the admin user + credential + role
 * binding. Re-running against an existing tenant re-asserts the roles and leaves
 * the existing admin's password untouched — a repair must never silently reset
 * a live account's credentials.
 */
export async function seedTenantAdmin(input: SeedTenantAdminInput): Promise<SeedTenantAdminResult> {
  return runWithContext(
    {
      traceId: `seed-${input.tenantSlug}`,
      tenantId: input.tenantId,
      tenantSlug: input.tenantSlug,
      connection: input.connection,
    },
    async () => {
      // The permission catalog and the default roles, with their grants (ADR-0010).
      // Idempotent, so this doubles as the repair path for an existing tenant.
      await seedRbac();

      const existing = await getByEmail(input.email);
      if (existing) {
        await assignRoleByCode(existing.id, "TENANT_ADMIN");
        return { userId: existing.id, email: existing.email, created: false };
      }

      // Delegated to the staff module: "how a user comes into existence" has ONE
      // implementation (identity → credential → role binding → activate), and the
      // day-one admin is not a special case of it.
      const result = await createStaff({
        email: input.email,
        name: input.name ?? "Administrator",
        roles: ["TENANT_ADMIN"],
        ...(input.password ? { password: input.password } : {}),
      });

      return {
        userId: result.user.id,
        email: result.user.email,
        ...(result.temporaryPassword ? { generatedPassword: result.temporaryPassword } : {}),
        created: true,
      };
    },
  );
}
