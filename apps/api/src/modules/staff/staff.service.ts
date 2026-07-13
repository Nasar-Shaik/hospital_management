/**
 * Staff directory (Doc 01 Phase 1 §5 "User & Staff Directory", Doc 02 A3/A4).
 *
 * WHY THIS MODULE EXISTS AT ALL — it is an orchestrator, not a store. It owns no
 * collection. Creating a member of staff means doing three things in three
 * different modules:
 *
 *     users  → the identity record
 *     auth   → the credential
 *     rbac   → the role binding
 *
 * `auth` already depends on `users`, so if `users` reached back into `auth` to
 * set a password we would have a cycle — the exact thing the Constitution forbids
 * and CI rejects. The use case therefore lives one level up, in a module that may
 * depend on all three while nothing depends on it.
 *
 * This is the same shape as `seed/seedTenantAdmin` — which now delegates here,
 * so "how a user comes into existence" has exactly ONE implementation.
 */
import { AppError } from "../../core/errors/appError.js";
import { checkPasswordPolicy, generatePassword } from "../../core/crypto/password.js";
import * as auth from "../auth/index.js";
import * as rbac from "../rbac/index.js";
import * as users from "../users/index.js";
import type { User, UserStatus } from "../users/index.js";

export interface StaffMember extends User {
  roles: string[];
  branchIds: string[];
}

export interface CreateStaffInput {
  email: string;
  name: string;
  phone?: string;
  employeeId?: string;
  roles?: string[];
  branchIds?: string[];
  /** Omit to generate a temporary password, returned ONCE and never recoverable. */
  password?: string;
}

export interface CreateStaffResult {
  user: StaffMember;
  /** Present only when we generated it. Show it once; we store only its hash. */
  temporaryPassword?: string;
}

/**
 * Creates a member of staff, ready to log in.
 *
 * A generated password is marked `mustChangePassword`: whoever created the
 * account has seen it, so it is a handover token, not a credential.
 */
export async function createStaff(input: CreateStaffInput): Promise<CreateStaffResult> {
  const password = input.password ?? generatePassword();
  const failures = checkPasswordPolicy(password);
  if (failures.length > 0) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", { password: failures });
  }

  // Roles are validated BEFORE the user exists: a half-created account with a
  // typo'd role is worse than a clean rejection.
  const roleCodes = input.roles ?? [];
  for (const code of roleCodes) {
    if (!(await rbac.getRoleByCode(code))) {
      throw new AppError("HMS-VAL-001", 400, "Validation failed", {
        roles: [`unknown role: ${code}`],
      });
    }
  }

  const user = await users.createUser({
    email: input.email,
    name: input.name,
    ...(input.phone ? { phone: input.phone } : {}),
    ...(input.employeeId ? { employeeId: input.employeeId } : {}),
    status: "invited",
  });

  await auth.setPassword(user.id, password, { mustChangePassword: !input.password });

  for (const code of roleCodes) {
    await rbac.assignRoleByCode(user.id, code, input.branchIds ?? []);
  }

  const active = await users.transitionStatus(user.id, "active");
  const claims = await rbac.getRoleClaims(user.id);

  return {
    user: { ...active, roles: claims.roles, branchIds: claims.branchIds },
    ...(input.password ? {} : { temporaryPassword: password }),
  };
}

export async function listStaff(filter: {
  page: number;
  limit: number;
  q?: string;
  status?: UserStatus;
}): Promise<{ users: StaffMember[]; total: number }> {
  const page = await users.listUsers(filter);

  // Roles are resolved per user. Fine at directory scale (a page of 20); if a
  // hospital ever pages through thousands, this becomes one batched lookup.
  const withRoles = await Promise.all(
    page.users.map(async (user) => {
      const claims = await rbac.getRoleClaims(user.id);
      return { ...user, roles: claims.roles, branchIds: claims.branchIds };
    }),
  );

  return { users: withRoles, total: page.total };
}

export async function getStaff(userId: string): Promise<StaffMember> {
  const user = await users.getById(userId);
  if (!user) throw new AppError("HMS-GEN-404", 404, "User not found", { userId });

  const claims = await rbac.getRoleClaims(userId);
  return { ...user, roles: claims.roles, branchIds: claims.branchIds };
}

export async function updateStaff(
  userId: string,
  input: { name?: string; phone?: string; employeeId?: string },
): Promise<StaffMember> {
  const updated = await users.updateUser(userId, input);
  if (!updated) throw new AppError("HMS-GEN-404", 404, "User not found", { userId });
  return getStaff(userId);
}

/**
 * Enables or disables an account.
 *
 * Disabling ends every session immediately. Without that, a dismissed employee
 * keeps working for up to the refresh window — "disabled" has to mean disabled
 * NOW, which is the entire reason an administrator clicks the button.
 */
export async function setStaffStatus(
  userId: string,
  status: "active" | "disabled",
): Promise<StaffMember> {
  await users.transitionStatus(userId, status);

  if (status === "disabled") {
    await auth.revokeAllSessions(userId);
    await rbac.invalidateUser(userId);
  }

  return getStaff(userId);
}

/** Admin reset: issues a temporary password and ends every existing session. */
export async function resetStaffPassword(
  userId: string,
  password?: string,
): Promise<{ temporaryPassword?: string }> {
  const user = await users.getById(userId);
  if (!user) throw new AppError("HMS-GEN-404", 404, "User not found", { userId });

  const newPassword = password ?? generatePassword();
  await auth.setPassword(userId, newPassword, { mustChangePassword: !password });

  // The old password is gone; sessions minted under it must go too.
  await auth.revokeAllSessions(userId);

  return password ? {} : { temporaryPassword: newPassword };
}
