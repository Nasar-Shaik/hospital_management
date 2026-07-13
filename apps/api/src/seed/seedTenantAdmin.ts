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
import { randomInt } from "node:crypto";
import type { Connection } from "mongoose";
import { runWithContext } from "../core/context/requestContext.js";
import { checkPasswordPolicy } from "../core/crypto/password.js";
import { setPassword } from "../modules/auth/index.js";
import { assignRoleByCode, seedRbac } from "../modules/rbac/index.js";
import { createUser, getByEmail, transitionStatus } from "../modules/users/index.js";

const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I/O — they are misread on paper
const LOWER = "abcdefghijkmnopqrstuvwxyz";
const DIGITS = "23456789";
const SYMBOLS = "!@#$%^&*-_=+";

/**
 * A password an operator will read aloud once and then discard. It satisfies the
 * policy by construction rather than by retrying until it happens to pass.
 */
function generatePassword(length = 20): string {
  const alphabet = UPPER + LOWER + DIGITS + SYMBOLS;
  const required = [
    UPPER[randomInt(UPPER.length)],
    LOWER[randomInt(LOWER.length)],
    DIGITS[randomInt(DIGITS.length)],
    SYMBOLS[randomInt(SYMBOLS.length)],
  ];
  const rest = Array.from(
    { length: length - required.length },
    () => alphabet[randomInt(alphabet.length)],
  );

  // Fisher–Yates with a CSPRNG, so the guaranteed characters are not always in
  // the first four positions.
  const chars = [...required, ...rest];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j] as string, chars[i] as string];
  }
  return chars.join("");
}

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

      const password = input.password ?? generatePassword();
      const failures = checkPasswordPolicy(password);
      if (failures.length > 0) {
        throw new Error(`admin password rejected by policy: ${failures.join("; ")}`);
      }

      const user = await createUser({
        email: input.email,
        name: input.name ?? "Administrator",
        status: "invited",
      });

      // A generated password is a one-time secret: the admin must replace it on
      // first login. An operator-chosen one is assumed to be already private.
      await setPassword(user.id, password, { mustChangePassword: !input.password });
      await assignRoleByCode(user.id, "TENANT_ADMIN");
      await transitionStatus(user.id, "active");

      return {
        userId: user.id,
        email: user.email,
        ...(input.password ? {} : { generatedPassword: password }),
        created: true,
      };
    },
  );
}
