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
import { getContext } from "../../core/context/requestContext.js";
import { publish } from "../../core/events/outbox.js";
import { EVENTS } from "../../core/events/eventCatalog.js";
import * as auth from "../auth/index.js";
import * as rbac from "../rbac/index.js";
import * as users from "../users/index.js";
import { assertWithinLimit } from "../subscriptions/index.js";
import type { StaffProfile, User, UserStatus } from "../users/index.js";

export type { StaffProfile } from "../users/index.js";

export interface StaffMember extends User {
  roles: string[];
  branchIds: string[];
}

export interface CreateStaffInput {
  email: string;
  name: string;
  phone?: string;
  employeeId?: string;
  profile?: StaffProfile;
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
  // The seat limit is checked BEFORE anything is created (Doc 07): a plan limit
  // must refuse the 26th account cleanly, not half-create it and then fail.
  await assertWithinLimit(getContext().tenantId, "maxUsers");

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
    ...(input.profile && Object.keys(input.profile).length > 0 ? { profile: input.profile } : {}),
    status: "invited",
  });

  await auth.setPassword(user.id, password, { mustChangePassword: !input.password });

  for (const code of roleCodes) {
    await rbac.assignRoleByCode(user.id, code, input.branchIds ?? []);
  }

  const active = await users.transitionStatus(user.id, "active");
  const claims = await rbac.getRoleClaims(user.id);

  /**
   * The account exists; now tell the rest of the platform.
   *
   * Note what is NOT in this payload: the password. The outbox is durable storage
   * that operators can read, so a credential placed here would outlive the
   * handover by years. When notifications (A6) sends the welcome mail it will
   * mint its own single-use invitation link rather than carry a secret through a
   * queue (EVENT_CATALOG: "payloads carry IDs and minimal display fields").
   */
  await publish({
    name: EVENTS.USER_CREATED,
    payload: {
      userId: user.id,
      email: user.email,
      name: user.name,
      roles: claims.roles,
      mustChangePassword: !input.password,
    },
  });

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

/** A doctor, as a dropdown needs them. Nothing else about them. */
export interface DoctorRef {
  id: string;
  name: string;
}

/**
 * Who a patient can be sent to.
 *
 * Deliberately NOT `listStaff` with a filter: this returns two fields, and that is
 * the whole point. The front desk needs a name to put in a dropdown, not a colleague's
 * email, MFA status and last login — and the permission it is gated on
 * (`encounter:read`) reflects the smaller question (staff.controller.ts).
 *
 * `active` only: a doctor who has left must not still be collecting patients.
 */
export async function listDoctors(): Promise<DoctorRef[]> {
  // Directory scale. A hospital with more than a few hundred doctors is a chain, and
  // by then this is a branch-scoped query rather than a bigger page.
  const page = await users.listUsers({ page: 1, limit: 500, status: "active" });

  const doctors = await Promise.all(
    page.users.map(async (user) => {
      const claims = await rbac.getRoleClaims(user.id);
      return claims.roles.includes("DOCTOR") ? { id: user.id, name: user.name } : undefined;
    }),
  );

  return doctors
    .filter((d): d is DoctorRef => d !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * One doctor as a DOCUMENT needs them — the name and (for the OPD slip) their signature and
 * qualification. Kept off `listDoctors`, whose whole point is two fields for a dropdown; the slip
 * fetches exactly one doctor and pays for the signature only then. Gated on `encounter:read`, the
 * same small authority as the directory.
 */
export interface DoctorCard {
  id: string;
  name: string;
  qualification?: string;
  designation?: string;
  signature?: string;
}

export async function getDoctorCard(id: string): Promise<DoctorCard | undefined> {
  const user = await users.getById(id);
  if (!user) return undefined;
  return {
    id: user.id,
    name: user.name,
    ...(user.profile?.qualification ? { qualification: user.profile.qualification } : {}),
    ...(user.profile?.designation ? { designation: user.profile.designation } : {}),
    ...(user.profile?.signature ? { signature: user.profile.signature } : {}),
  };
}

/** A doctor as the PUBLIC website shows them — name, and what they do. Never contact/HR detail. */
export interface PublicDoctor {
  id: string;
  name: string;
  specialty?: string;
  designation?: string;
}

/**
 * The doctors a hospital has chosen to feature on its public website.
 *
 * Opt-in and DOCTOR-only: a person appears only if they carry the DOCTOR role AND their record
 * is flagged `profile.showOnPublicSite`. So the public page never leaks the staff directory —
 * publishing is a deliberate act per person, and un-flagging (or leaving) removes them with no
 * edit to the site itself. `active` only, for the same reason `listDoctors` is: someone who has
 * left must not still be advertised.
 */
export async function listPublicDoctors(): Promise<PublicDoctor[]> {
  const page = await users.listUsers({ page: 1, limit: 500, status: "active" });

  const doctors = await Promise.all(
    page.users.map(async (user) => {
      if (!user.profile?.showOnPublicSite) return undefined;
      const claims = await rbac.getRoleClaims(user.id);
      if (!claims.roles.includes("DOCTOR")) return undefined;
      return {
        id: user.id,
        name: user.name,
        ...(user.profile.specialty ? { specialty: user.profile.specialty } : {}),
        ...(user.profile.designation ? { designation: user.profile.designation } : {}),
      } satisfies PublicDoctor;
    }),
  );

  return doctors
    .filter((d): d is PublicDoctor => d !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function updateStaff(
  userId: string,
  input: { name?: string; phone?: string; employeeId?: string; profile?: StaffProfile },
): Promise<StaffMember> {
  /**
   * The profile is MERGED, not replaced. An admin editing just the phone number must not
   * wipe the specialty and registration number they are not touching. The edit form does
   * send the whole profile today, but the service is the right place to make partial updates
   * safe regardless of what the caller sends.
   */
  let merged = input;
  if (input.profile) {
    const current = await users.getById(userId);
    merged = { ...input, profile: { ...current?.profile, ...input.profile } };
  }

  const updated = await users.updateUser(userId, merged);
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

    // Downstream systems (on-call rotas, integration accounts, the future
    // notification preferences store) hold their own copies of "who works here".
    // The sessions are already dead — this is how the copies catch up.
    await publish({
      name: EVENTS.USER_DISABLED,
      payload: { userId, sessionsRevoked: true },
    });
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
